import Anthropic from '@anthropic-ai/sdk';

import type { FailedPaymentRecord } from '../types/database';

/**
 * Hard guardrails. These are enforced as clamps on every generated campaign and
 * must never be exceeded regardless of input, LLM output, or future logic.
 */
export const MAX_DISCOUNT_PERCENT = 15;
export const MAX_GRACE_PERIOD_DAYS = 14;

/** Claude model used for generation. See note in README on the retired 3.5 id. */
const MODEL = 'claude-sonnet-5';

/** The output of a single recovery-email generation. */
export interface GeneratedRecoveryEmail {
  subject: string;
  html: string;
  /** Discount offered, as a percentage in the range [0, MAX_DISCOUNT_PERCENT]. */
  discountOffered: number;
  /** Grace period in days, in the range [0, MAX_GRACE_PERIOD_DAYS]. */
  gracePeriodDays: number;
}

/**
 * Lazily-constructed Anthropic client. Null when ANTHROPIC_API_KEY is unset, in
 * which case generation falls back to the deterministic template below rather
 * than throwing — the recovery worker should keep running without an AI key.
 */
const anthropic: Anthropic | null = process.env.ANTHROPIC_API_KEY
  ? new Anthropic()
  : null;

/** Clamp a value into an inclusive range, coercing non-finite input to the min. */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

/** Format a smallest-unit amount (e.g. cents) into a localized currency string. */
function formatAmount(amountMinorUnits: number, currency: string): string {
  const major = amountMinorUnits / 100;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).format(major);
  } catch {
    return `${major.toFixed(2)} ${currency.toUpperCase()}`;
  }
}

/** Minimal HTML escaping for values interpolated into a template email body. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Map a Stripe failure code to a conservative recovery strategy. Used only by
 * the deterministic fallback; values are clamped again before use.
 */
function strategyFor(failureCode: string | null): {
  discount: number;
  graceDays: number;
  reason: string;
} {
  switch (failureCode) {
    case 'insufficient_funds':
      return {
        discount: 10,
        graceDays: 14,
        reason: 'it looks like the payment did not go through this time',
      };
    case 'expired_card':
    case 'card_declined':
      return {
        discount: 5,
        graceDays: 7,
        reason: 'your card on file could not be charged',
      };
    case 'processing_error':
      return {
        discount: 0,
        graceDays: 3,
        reason: 'a temporary processing error interrupted your payment',
      };
    default:
      return {
        discount: 5,
        graceDays: 7,
        reason: 'we were unable to process your recent payment',
      };
  }
}

/**
 * Deterministic template generator. Serves as the fallback whenever the LLM
 * path is unavailable or fails. Always returns clamped, safe-to-persist values.
 */
export function buildFallbackEmail(
  payment: FailedPaymentRecord,
): GeneratedRecoveryEmail {
  const { discount, graceDays, reason } = strategyFor(payment.failure_code);

  const discountOffered = clamp(discount, 0, MAX_DISCOUNT_PERCENT);
  const gracePeriodDays = clamp(graceDays, 0, MAX_GRACE_PERIOD_DAYS);

  const amountText = formatAmount(payment.amount, payment.currency);
  const safeEmail = escapeHtml(payment.customer_email);

  const subject = `Action needed: your ${amountText} payment didn't go through`;

  const discountLine =
    discountOffered > 0
      ? `<p>As a thank-you for sorting this out, here's <strong>${discountOffered}% off</strong> your next payment.</p>`
      : '';

  const graceLine =
    gracePeriodDays > 0
      ? `<p>You have <strong>${gracePeriodDays} day${
          gracePeriodDays === 1 ? '' : 's'
        }</strong> to update your details before any interruption to your service.</p>`
      : '';

  const html = [
    '<div style="font-family: Arial, sans-serif; line-height: 1.5;">',
    '<p>Hi there,</p>',
    `<p>We wanted to let you know that ${reason}. The amount due is <strong>${amountText}</strong>.</p>`,
    graceLine,
    discountLine,
    '<p>To keep everything running smoothly, please update your payment method at your earliest convenience.</p>',
    '<p>Thanks,<br/>The Billing Team</p>',
    `<hr/><p style="font-size:12px;color:#888;">This message was sent to ${safeEmail}.</p>`,
    '</div>',
  ]
    .filter(Boolean)
    .join('\n');

  return { subject, html, discountOffered, gracePeriodDays };
}

/** JSON schema Claude must return. `additionalProperties:false` is required. */
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    subject: { type: 'string' },
    html: { type: 'string' },
    discount: { type: 'number' },
    grace_period_days: { type: 'number' },
  },
  required: ['subject', 'html', 'discount', 'grace_period_days'],
  additionalProperties: false,
} as const;

interface ClaudePayload {
  subject: string;
  html: string;
  discount: number;
  grace_period_days: number;
}

function buildSystemPrompt(): string {
  return [
    'You write personalized dunning (failed-payment recovery) emails for a SaaS billing team.',
    'Return a warm, concise, professional email that motivates the customer to update their payment method.',
    'GUARDRAILS (the caller enforces these too, but stay within them):',
    `- The discount you recommend MUST NOT exceed ${MAX_DISCOUNT_PERCENT}%. Use 0 when no incentive is warranted.`,
    `- The grace-period extension MUST NOT exceed ${MAX_GRACE_PERIOD_DAYS} days.`,
    '- "html" must be a self-contained HTML fragment (no <html>/<head>/<body> wrapper), inline styles only.',
    '- Never invent account details, links, or amounts beyond what you are given.',
  ].join('\n');
}

function buildUserPrompt(payment: FailedPaymentRecord): string {
  const amountText = formatAmount(payment.amount, payment.currency);
  return [
    'Generate a recovery email for this failed payment:',
    `- Customer email: ${payment.customer_email}`,
    `- Amount due: ${amountText} (${payment.amount} in ${payment.currency.toUpperCase()} minor units)`,
    `- Stripe failure code: ${payment.failure_code ?? 'unknown'}`,
    '',
    'Choose a discount and grace period appropriate to the failure reason, within the guardrails.',
  ].join('\n');
}

/**
 * Generate a personalized dunning email for a failed payment using Claude,
 * falling back to a deterministic template if the LLM path is unavailable or
 * fails for any reason.
 *
 * The returned discount and grace period are ALWAYS clamped to the guardrails
 * ({@link MAX_DISCOUNT_PERCENT}, {@link MAX_GRACE_PERIOD_DAYS}) — the clamp wraps
 * the LLM response so a model that ignores the instructions still cannot breach
 * the limits.
 */
export async function generateRecoveryEmail(
  payment: FailedPaymentRecord,
): Promise<GeneratedRecoveryEmail> {
  if (!anthropic) {
    return buildFallbackEmail(payment);
  }

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1500,
      system: buildSystemPrompt(),
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: OUTPUT_SCHEMA },
      },
      messages: [{ role: 'user', content: buildUserPrompt(payment) }],
    });

    if (response.stop_reason === 'refusal') {
      throw new Error('Claude refused to generate the recovery email');
    }

    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      throw new Error('Claude returned no text content');
    }

    const parsed = JSON.parse(textBlock.text) as ClaudePayload;

    // Guardrails wrap the (untrusted) model output.
    const discountOffered = clamp(
      Number(parsed.discount),
      0,
      MAX_DISCOUNT_PERCENT,
    );
    const gracePeriodDays = clamp(
      Number(parsed.grace_period_days),
      0,
      MAX_GRACE_PERIOD_DAYS,
    );

    if (!parsed.subject?.trim() || !parsed.html?.trim()) {
      throw new Error('Claude returned an empty subject or body');
    }

    return {
      subject: parsed.subject,
      html: parsed.html,
      discountOffered,
      gracePeriodDays,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unexpected error';
    // eslint-disable-next-line no-console
    console.warn(
      `[ai-generator] LLM generation failed, using fallback: ${message}`,
    );
    return buildFallbackEmail(payment);
  }
}
