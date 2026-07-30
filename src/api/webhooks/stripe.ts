import { Router, type Request, type Response } from 'express';
import type Stripe from 'stripe';

import { stripe, STRIPE_WEBHOOK_SECRET } from '../../services/stripe';
import {
  getAccountByStripeAccountId,
  insertFailedPayment,
} from '../../services/supabase';
import type { ApiError } from '../../types';

export const stripeWebhookRouter: Router = Router();

/**
 * Extract a best-effort card/payment failure code from a failed invoice.
 *
 * The definitive decline code lives on the associated PaymentIntent's
 * `last_payment_error`, which is only present when the webhook payload is
 * configured to expand it. We fall back to the invoice's finalization error,
 * then to `null`.
 */
function extractFailureCode(invoice: Stripe.Invoice): string | null {
  const paymentIntent = invoice.payment_intent;
  if (paymentIntent && typeof paymentIntent !== 'string') {
    const code = paymentIntent.last_payment_error?.code;
    if (code) return code;
  }
  return invoice.last_finalization_error?.code ?? null;
}

/**
 * POST /api/webhooks/stripe
 *
 * Verifies the Stripe signature, then handles `invoice.payment_failed` by
 * persisting a failed-payment record. Requires the raw request body, which is
 * mounted via `express.raw(...)` on this path in `server.ts`.
 */
stripeWebhookRouter.post('/', async (req: Request, res: Response) => {
  // --- 1. Validate configuration and signature header -----------------------
  if (!STRIPE_WEBHOOK_SECRET) {
    // Misconfiguration, not a client error: log loudly and fail closed.
    console.error('[stripe-webhook] STRIPE_WEBHOOK_SECRET is not set');
    res.status(500).json({
      error: 'ConfigurationError',
      message: 'Webhook secret not configured',
      statusCode: 500,
    } satisfies ApiError);
    return;
  }

  const signature = req.headers['stripe-signature'];
  if (!signature) {
    res.status(400).json({
      error: 'BadRequest',
      message: 'Missing Stripe signature header',
      statusCode: 400,
    } satisfies ApiError);
    return;
  }

  // --- 2. Verify the signature against the raw body -------------------------
  let event: Stripe.Event;
  try {
    // With express.raw(), req.body is a Buffer of the exact bytes Stripe signed.
    event = stripe.webhooks.constructEvent(
      req.body as Buffer,
      signature,
      STRIPE_WEBHOOK_SECRET,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid signature';
    console.error('[stripe-webhook] Signature verification failed:', message);
    res.status(400).json({
      error: 'SignatureVerificationError',
      message,
      statusCode: 400,
    } satisfies ApiError);
    return;
  }

  // --- 3. Only act on invoice.payment_failed; ack everything else -----------
  if (event.type !== 'invoice.payment_failed') {
    res.status(200).json({ received: true, ignored: event.type });
    return;
  }

  const invoice = event.data.object as Stripe.Invoice;

  // --- 4. Resolve the owning account ----------------------------------------
  // Connect webhooks carry the connected-account id on `event.account`.
  const stripeAccountId = event.account;
  const customerEmail = invoice.customer_email;

  try {
    let accountId: string | undefined;

    if (stripeAccountId) {
      // Multi-tenant (Connect): resolve the account by its Stripe account id.
      const account = await getAccountByStripeAccountId(stripeAccountId);
      if (account) {
        accountId = account.id;
      }
    } else if (process.env.DEFAULT_ACCOUNT_ID) {
      // Single-tenant fallback: attribute to the configured default account
      // rather than dropping the event.
      accountId = process.env.DEFAULT_ACCOUNT_ID;
    }

    if (!accountId) {
      // Cannot attribute the payment to a tenant. Ack so Stripe stops retrying.
      console.warn(
        `[stripe-webhook] could not resolve account for invoice ${invoice.id} ` +
          `(event.account=${stripeAccountId ?? 'none'}); skipping`,
      );
      res.status(200).json({ received: true, skipped: 'unknown_account' });
      return;
    }

    if (!customerEmail) {
      // No email means no way to run recovery outreach; ack and skip.
      console.warn(
        `[stripe-webhook] invoice ${invoice.id} has no customer_email; skipping`,
      );
      res.status(200).json({ received: true, skipped: 'no_customer_email' });
      return;
    }

    // --- 5. Persist the failed payment --------------------------------------
    const record = await insertFailedPayment({
      account_id: accountId,
      customer_email: customerEmail,
      amount: invoice.amount_due,
      currency: invoice.currency,
      failure_code: extractFailureCode(invoice),
      status: 'pending',
    });

    console.log(
      `[stripe-webhook] recorded failed payment ${record.id} for invoice ${invoice.id}`,
    );
    res.status(200).json({ received: true, id: record.id });
  } catch (err) {
    // DB or lookup failure: return 5xx so Stripe retries with backoff.
    const message = err instanceof Error ? err.message : 'Unexpected error';
    console.error(
      `[stripe-webhook] failed to persist invoice ${invoice.id}:`,
      message,
    );
    res.status(500).json({
      error: 'PersistenceError',
      message,
      statusCode: 500,
    } satisfies ApiError);
  }
});
