import 'dotenv/config';
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from 'express';

import { extractSecret, secretsMatch } from './api/auth';
import { analyticsRouter } from './api/routes/analytics';
import { cronRouter } from './api/routes/cron';
import { stripeWebhookRouter } from './api/webhooks/stripe';
import { estimateLoss, previewOutreach, type OutreachInput } from './services/outreachAgent';
import {
  dispatchOutreachQueue,
  enqueueOutreach,
} from './services/outreachDispatcher';
import { addUnsubscribe, getOutreachMessageByToken } from './services/supabase';
import type { ApiError } from './types';

const app: Express = express();
const PORT: number = Number(process.env.PORT ?? 3000);

/**
 * Stripe webhooks require the raw request body to verify signatures, so the
 * raw parser is mounted on the webhook path BEFORE the global JSON parser.
 */
app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }));
app.use(express.json());

/**
 * Stripe webhook routes (signature verification + event handling).
 */
app.use('/api/webhooks/stripe', stripeWebhookRouter);

/**
 * Internal cron trigger routes (secret-protected).
 */
app.use('/api/v1/cron', cronRouter);

/**
 * Analytics dashboard routes.
 */
app.use('/api/v1/analytics', analyticsRouter);

/**
 * Guard a request with the outreach shared secret. Returns `true` and sends an
 * error response when the request is unauthorized (caller should stop).
 */
function outreachSecretRejected(req: Request, res: Response): boolean {
  const expected = process.env.OUTREACH_SECRET ?? process.env.CRON_SECRET;
  if (!expected) {
    console.error('[outreach] OUTREACH_SECRET/CRON_SECRET is not configured');
    res.status(500).json({
      error: 'ConfigurationError',
      message: 'Outreach secret not configured',
      statusCode: 500,
    } satisfies ApiError);
    return true;
  }

  const provided = extractSecret(req, 'x-outreach-secret');
  if (!provided || !secretsMatch(provided, expected)) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing or invalid outreach secret',
      statusCode: 401,
    } satisfies ApiError);
    return true;
  }

  return false;
}

/**
 * POST /api/v1/outreach/trigger
 *
 * Agent-Outreach & Growth entrypoint. Estimates a prospect's failed-payment
 * losses and ENQUEUES a cold email for rate-limited delivery. By default a
 * dispatch pass runs immediately (bounded by the hourly cap), so a single call
 * sends when budget is available; pass `enqueueOnly: true` to only queue, or
 * `dryRun: true` to preview the estimate + email without persisting or sending.
 *
 * Secured with a shared secret passed as `Authorization: Bearer <secret>` (or
 * the `x-outreach-secret` header), compared against OUTREACH_SECRET (falling
 * back to CRON_SECRET when OUTREACH_SECRET is unset).
 *
 * Body: { companyName, contactEmail, mrrCents, currency?, contactName?,
 *         enqueueOnly?, dryRun? }
 */
app.post('/api/v1/outreach/trigger', async (req: Request, res: Response) => {
  try {
    if (outreachSecretRejected(req, res)) return;

    const body = (req.body ?? {}) as Partial<OutreachInput> & {
      enqueueOnly?: boolean;
      dryRun?: boolean;
    };

    const { companyName, contactEmail, mrrCents, currency, contactName } = body;

    if (typeof companyName !== 'string' || companyName.trim() === '') {
      res.status(400).json({
        error: 'BadRequest',
        message: 'companyName is required and must be a non-empty string',
        statusCode: 400,
      } satisfies ApiError);
      return;
    }

    if (typeof contactEmail !== 'string' || !contactEmail.includes('@')) {
      res.status(400).json({
        error: 'BadRequest',
        message: 'contactEmail is required and must be a valid email address',
        statusCode: 400,
      } satisfies ApiError);
      return;
    }

    if (typeof mrrCents !== 'number' || !Number.isFinite(mrrCents) || mrrCents < 0) {
      res.status(400).json({
        error: 'BadRequest',
        message: 'mrrCents is required and must be a non-negative number of cents',
        statusCode: 400,
      } satisfies ApiError);
      return;
    }

    const input: OutreachInput = {
      companyName,
      contactEmail,
      mrrCents,
      currency,
      contactName,
    };

    // Dry run: preview only, nothing persisted or sent.
    if (body.dryRun === true) {
      const preview = await previewOutreach(input);
      res.status(200).json({ dryRun: true, ...preview });
      return;
    }

    const queued = await enqueueOutreach(input);
    const estimate = estimateLoss(mrrCents);

    // Immediately run a rate-limited dispatch pass unless enqueue-only.
    const dispatch =
      body.enqueueOnly === true ? null : await dispatchOutreachQueue();

    res.status(202).json({ queued, estimate, dispatch });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unexpected error';
    console.error('[outreach] trigger failed:', message);
    res.status(500).json({
      error: 'InternalServerError',
      message,
      statusCode: 500,
    } satisfies ApiError);
  }
});

/**
 * POST /api/v1/outreach/dispatch
 *
 * Drain the outreach queue, sending up to the remaining hourly budget. Intended
 * to be called on a schedule (e.g. a Render cron job every few minutes) to work
 * through any backlog while respecting the rate limit. Secret-protected, same as
 * the trigger endpoint.
 */
app.post('/api/v1/outreach/dispatch', async (req: Request, res: Response) => {
  try {
    if (outreachSecretRejected(req, res)) return;

    const summary = await dispatchOutreachQueue();
    res.status(200).json(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unexpected error';
    console.error('[outreach] dispatch failed:', message);
    res.status(500).json({
      error: 'InternalServerError',
      message,
      statusCode: 500,
    } satisfies ApiError);
  }
});

/**
 * GET|POST /api/v1/outreach/unsubscribe?token=<token>
 *
 * Public opt-out endpoint (GDPR / CAN-SPAM). Recipients reach it via the link in
 * the email footer or a one-click List-Unsubscribe POST. Records the recipient's
 * address on the suppression list and shows a confirmation page. Idempotent, and
 * intentionally does not reveal whether a token/email was recognized.
 */
async function handleUnsubscribe(req: Request, res: Response): Promise<void> {
  try {
    const token =
      typeof req.query.token === 'string' ? req.query.token : undefined;
    const emailParam =
      typeof req.query.email === 'string' ? req.query.email : undefined;

    let email: string | null = null;
    if (token) {
      const message = await getOutreachMessageByToken(token);
      email = message?.contact_email ?? null;
    }
    if (!email && emailParam && emailParam.includes('@')) {
      email = emailParam;
    }

    if (email) {
      await addUnsubscribe(email, token ?? null, 'user_unsubscribe');
    }

    res.status(200).type('html').send(unsubscribeConfirmationPage(email));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unexpected error';
    console.error('[outreach] unsubscribe failed:', message);
    res
      .status(500)
      .type('html')
      .send(
        '<!doctype html><meta charset="utf-8"><p>Sorry, something went wrong. Please try again later.</p>',
      );
  }
}

app.get('/api/v1/outreach/unsubscribe', handleUnsubscribe);
app.post('/api/v1/outreach/unsubscribe', handleUnsubscribe);

/** Minimal HTML escaping for the confirmation page. */
function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Render the unsubscribe confirmation page. */
function unsubscribeConfirmationPage(email: string | null): string {
  const who = email ? `<strong>${escapeHtmlText(email)}</strong>` : 'this address';
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"/>',
    '<meta name="viewport" content="width=device-width, initial-scale=1"/>',
    '<title>Unsubscribed</title></head>',
    '<body style="font-family: Arial, sans-serif; max-width: 480px; margin: 64px auto; padding: 0 16px; line-height: 1.6; color: #1a1a1a;">',
    '<h1 style="font-size:20px;">You’re unsubscribed</h1>',
    `<p>${who} has been removed from our outreach list and won’t receive further emails from Smart Payment Recovery.</p>`,
    '<p style="color:#888;font-size:13px;">If you did this by mistake, simply reply to any previous email and we’ll help.</p>',
    '</body></html>',
  ].join('\n');
}

/**
 * Health check.
 */
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', service: 'smart-payment-recovery' });
});

/**
 * 404 fallback for unmatched routes.
 */
app.use((_req: Request, res: Response) => {
  res.status(404).json({
    error: 'NotFound',
    message: 'Resource not found',
    statusCode: 404,
  } satisfies ApiError);
});

/**
 * Centralized error handler. Express identifies this by its four arguments.
 */
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : 'Unexpected error';
  // eslint-disable-next-line no-console
  console.error('[error]', message);

  res.status(500).json({
    error: 'InternalServerError',
    message,
    statusCode: 500,
  } satisfies ApiError);
});

/**
 * Boot the server, guarding startup so failures surface clearly.
 */
function start(): void {
  try {
    app.listen(PORT, () => {
      // eslint-disable-next-line no-console
      console.log(`Smart Payment Recovery listening on port ${PORT}`);
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[fatal] Failed to start server:', err);
    process.exit(1);
  }
}

start();

export { app };
