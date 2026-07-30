import Stripe from 'stripe';

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

if (!STRIPE_SECRET_KEY) {
  throw new Error('Missing Stripe configuration: set STRIPE_SECRET_KEY');
}

/**
 * Shared Stripe client. `apiVersion` is intentionally omitted so the SDK's
 * pinned default is used; set it explicitly here when upgrading deliberately.
 */
export const stripe = new Stripe(STRIPE_SECRET_KEY);

/**
 * The webhook signing secret, read once at module load. The webhook handler
 * validates its presence before attempting signature verification.
 */
export const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
