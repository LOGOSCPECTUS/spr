import 'dotenv/config';
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from 'express';

import { analyticsRouter } from './api/routes/analytics';
import { cronRouter } from './api/routes/cron';
import { stripeWebhookRouter } from './api/webhooks/stripe';
import { runOutreach, type OutreachInput } from './services/outreachAgent';
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
 * POST /api/v1/outreach/trigger
 *
 * Agent-Outreach & Growth entrypoint. Estimates a prospect's failed-payment
 * losses, generates a cold email (Claude with template fallback), and — unless
 * `send: false` is passed — delivers it via Resend.
 *
 * Body: { companyName, contactEmail, mrrCents, currency?, contactName?, send? }
 */
app.post('/api/v1/outreach/trigger', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Partial<OutreachInput> & {
      send?: boolean;
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

    const result = await runOutreach(
      { companyName, contactEmail, mrrCents, currency, contactName },
      { send: body.send ?? true },
    );

    res.status(200).json(result);
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
