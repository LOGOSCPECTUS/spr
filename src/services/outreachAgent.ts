import Anthropic from '@anthropic-ai/sdk';
import { Resend } from 'resend';

/**
 * Agent-Outreach & Growth
 * -----------------------
 * Cold-outreach agent that estimates a SaaS company's involuntary-churn losses
 * from failed payments, models the revenue Smart Payment Recovery can win back,
 * generates a personalized cold email with Claude (falling back to a
 * deterministic template when no ANTHROPIC_API_KEY is set), and sends it via
 * Resend.
 *
 * All monetary amounts are handled in the smallest currency unit (cents),
 * consistent with the rest of the service and Stripe.
 */

// ---------------------------------------------------------------------------
// Business constants
// ---------------------------------------------------------------------------

/** Low end of the observed failed-payment loss band for SaaS (9% of MRR). */
export const LOSS_RATE_MIN = 0.09;
/** High end of the observed failed-payment loss band for SaaS (15% of MRR). */
export const LOSS_RATE_MAX = 0.15;
/** Average loss rate used for estimates (~12% of MRR). */
export const LOSS_RATE_AVG = 0.12;

/**
 * Share of the lost revenue the recovery service can realistically win back
 * (~50% of losses). Applied to the estimated loss to model recoverable revenue.
 */
export const RECOVERY_RATE = 0.5;

/**
 * Performance fee the platform charges on recovered revenue. Used to model ROI
 * for the prospect: they only pay a slice of what is actually recovered.
 */
export const PLATFORM_FEE_RATE = 0.2;

/** Claude model used for cold-email generation. Matches aiGenerator.ts. */
const MODEL = 'claude-sonnet-5';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Input describing the prospect company to run outreach against. */
export interface OutreachInput {
  /** Company / brand name used to personalize the email. */
  companyName: string;
  /** Recipient email address. */
  contactEmail: string;
  /** Monthly Recurring Revenue in the smallest currency unit (cents). */
  mrrCents: number;
  /** ISO 4217 currency code (defaults to `usd`). */
  currency?: string;
  /** Optional first-name of the recipient for a warmer greeting. */
  contactName?: string;
}

/** Modeled financial impact, all amounts in cents. */
export interface LossEstimate {
  /** MRR the estimate was derived from, in cents. */
  mrrCents: number;
  /** Loss rate applied (LOSS_RATE_AVG). */
  lossRate: number;
  /** Estimated monthly revenue lost to failed payments, in cents. */
  monthlyLossCents: number;
  /** Estimated annual revenue lost to failed payments, in cents. */
  annualLossCents: number;
  /** Revenue recoverable per month (RECOVERY_RATE of the loss), in cents. */
  recoverableMonthlyCents: number;
  /** Revenue recoverable per year, in cents. */
  recoverableAnnualCents: number;
  /** Platform performance fee on the annual recovered revenue, in cents. */
  platformAnnualFeeCents: number;
  /** Net annual gain for the prospect after the platform fee, in cents. */
  netAnnualGainCents: number;
  /** Return on investment as a percentage (net gain / fee * 100). */
  roiPercent: number;
}

/** A generated cold email. */
export interface ColdEmail {
  subject: string;
  html: string;
}

/** Aggregate result of an outreach run. */
export interface OutreachResult {
  companyName: string;
  contactEmail: string;
  estimate: LossEstimate;
  email: ColdEmail;
  /** Whether the email body came from Claude (`ai`) or the template fallback. */
  source: 'ai' | 'template';
  /** Resend message id when an email was sent; null when sending was skipped. */
  emailId: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a smallest-unit amount (cents) into a localized currency string. */
function formatAmount(amountMinorUnits: number, currency: string): string {
  const major = amountMinorUnits / 100;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency.toUpperCase(),
      maximumFractionDigits: 0,
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

// ---------------------------------------------------------------------------
// Financial modeling
// ---------------------------------------------------------------------------

/**
 * Estimate failed-payment losses and recoverable revenue for a given MRR.
 *
 * @param mrrCents Monthly Recurring Revenue in cents. Must be a finite,
 *   non-negative number.
 * @throws if `mrrCents` is not a finite, non-negative number.
 */
export function estimateLoss(mrrCents: number): LossEstimate {
  if (!Number.isFinite(mrrCents) || mrrCents < 0) {
    throw new Error('mrrCents must be a finite, non-negative number');
  }

  const monthlyLossCents = Math.round(mrrCents * LOSS_RATE_AVG);
  const annualLossCents = monthlyLossCents * 12;

  const recoverableMonthlyCents = Math.round(monthlyLossCents * RECOVERY_RATE);
  const recoverableAnnualCents = recoverableMonthlyCents * 12;

  const platformAnnualFeeCents = Math.round(
    recoverableAnnualCents * PLATFORM_FEE_RATE,
  );
  const netAnnualGainCents = recoverableAnnualCents - platformAnnualFeeCents;

  const roiPercent =
    platformAnnualFeeCents > 0
      ? Math.round((netAnnualGainCents / platformAnnualFeeCents) * 100)
      : 0;

  return {
    mrrCents,
    lossRate: LOSS_RATE_AVG,
    monthlyLossCents,
    annualLossCents,
    recoverableMonthlyCents,
    recoverableAnnualCents,
    platformAnnualFeeCents,
    netAnnualGainCents,
    roiPercent,
  };
}

// ---------------------------------------------------------------------------
// Email generation (Claude + template fallback)
// ---------------------------------------------------------------------------

/**
 * Lazily-constructed Anthropic client. Null when ANTHROPIC_API_KEY is unset, in
 * which case generation falls back to the deterministic template rather than
 * throwing — outreach should keep working without an AI key.
 */
const anthropic: Anthropic | null = process.env.ANTHROPIC_API_KEY
  ? new Anthropic()
  : null;

/** JSON schema Claude must return. `additionalProperties:false` is required. */
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    subject: { type: 'string' },
    html: { type: 'string' },
  },
  required: ['subject', 'html'],
  additionalProperties: false,
} as const;

interface ClaudePayload {
  subject: string;
  html: string;
}

function buildSystemPrompt(): string {
  return [
    'You are a senior B2B SaaS growth copywriter for Smart Payment Recovery,',
    'a service that recovers failed subscription payments (involuntary churn).',
    'Write a short, warm, high-signal cold outreach email to a prospect.',
    'RULES:',
    '- Lead with the concrete money left on the table; be specific, not hypey.',
    '- Use only the figures provided; never invent numbers, links, or claims.',
    '- One clear call to action (a brief intro call). No aggressive pressure.',
    '- "html" must be a self-contained HTML fragment (no <html>/<head>/<body>',
    '  wrapper), inline styles only.',
    '- Keep it under ~160 words.',
  ].join('\n');
}

function buildUserPrompt(input: OutreachInput, estimate: LossEstimate): string {
  const currency = input.currency ?? 'usd';
  return [
    'Write a cold outreach email using these facts:',
    `- Company: ${input.companyName}`,
    input.contactName ? `- Contact first name: ${input.contactName}` : '',
    `- Estimated monthly revenue lost to failed payments: ${formatAmount(
      estimate.monthlyLossCents,
      currency,
    )} (~${Math.round(estimate.lossRate * 100)}% of MRR)`,
    `- Estimated annual loss: ${formatAmount(estimate.annualLossCents, currency)}`,
    `- Revenue we can typically recover per year: ${formatAmount(
      estimate.recoverableAnnualCents,
      currency,
    )}`,
    `- Prospect's projected ROI: ${estimate.roiPercent}%`,
    '',
    'Return the subject and HTML body.',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Deterministic template cold email. Serves as the fallback whenever the LLM
 * path is unavailable or fails.
 */
export function buildFallbackColdEmail(
  input: OutreachInput,
  estimate: LossEstimate,
): ColdEmail {
  const currency = input.currency ?? 'usd';
  const company = escapeHtml(input.companyName);
  const greeting = input.contactName
    ? `Hi ${escapeHtml(input.contactName)},`
    : 'Hi there,';

  const monthlyLoss = formatAmount(estimate.monthlyLossCents, currency);
  const annualLoss = formatAmount(estimate.annualLossCents, currency);
  const recoverableAnnual = formatAmount(
    estimate.recoverableAnnualCents,
    currency,
  );

  const subject = `${company}: you're likely losing ${monthlyLoss}/mo to failed payments`;

  const html = [
    '<div style="font-family: Arial, sans-serif; line-height: 1.5; color: #1a1a1a;">',
    `<p>${greeting}</p>`,
    `<p>Most SaaS companies lose <strong>9–15% of MRR</strong> to failed subscription payments. Based on ${company}'s scale, that's roughly <strong>${monthlyLoss} per month</strong> (about <strong>${annualLoss} per year</strong>) slipping away as involuntary churn.</p>`,
    `<p>Smart Payment Recovery automatically wins back around half of that — an estimated <strong>${recoverableAnnual} in recovered revenue per year</strong>, at a projected <strong>${estimate.roiPercent}% ROI</strong>. You only pay on what we actually recover.</p>`,
    '<p>Worth a quick 15-minute call to see the numbers for your account?</p>',
    '<p>Best,<br/>The Smart Payment Recovery Team</p>',
    `<hr/><p style="font-size:12px;color:#888;">Sent to ${escapeHtml(
      input.contactEmail,
    )}. Reply "unsubscribe" to opt out.</p>`,
    '</div>',
  ].join('\n');

  return { subject, html };
}

/**
 * Generate a cold outreach email for a prospect using Claude, falling back to
 * a deterministic template if the LLM path is unavailable or fails for any
 * reason. The second element reports which path produced the email.
 */
export async function generateColdEmail(
  input: OutreachInput,
  estimate: LossEstimate,
): Promise<{ email: ColdEmail; source: 'ai' | 'template' }> {
  if (!anthropic) {
    return { email: buildFallbackColdEmail(input, estimate), source: 'template' };
  }

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1200,
      system: buildSystemPrompt(),
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: OUTPUT_SCHEMA },
      },
      messages: [{ role: 'user', content: buildUserPrompt(input, estimate) }],
    });

    if (response.stop_reason === 'refusal') {
      throw new Error('Claude refused to generate the outreach email');
    }

    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      throw new Error('Claude returned no text content');
    }

    const parsed = JSON.parse(textBlock.text) as ClaudePayload;

    if (!parsed.subject?.trim() || !parsed.html?.trim()) {
      throw new Error('Claude returned an empty subject or body');
    }

    return {
      email: { subject: parsed.subject, html: parsed.html },
      source: 'ai',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unexpected error';
    // eslint-disable-next-line no-console
    console.warn(
      `[outreach-agent] LLM generation failed, using fallback: ${message}`,
    );
    return { email: buildFallbackColdEmail(input, estimate), source: 'template' };
  }
}

// ---------------------------------------------------------------------------
// Email delivery (Resend)
// ---------------------------------------------------------------------------

/**
 * Lazily-constructed Resend client. Null when RESEND_API_KEY is unset; sending
 * then throws with a clear message rather than failing at module load.
 */
const resend: Resend | null = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

/** Verified sender address for outreach; overridable via RESEND_FROM_EMAIL. */
const OUTREACH_FROM_EMAIL =
  process.env.RESEND_FROM_EMAIL ?? 'billing@quilogos.com';

/**
 * Send a cold outreach email via Resend.
 *
 * @returns the Resend message id.
 * @throws if Resend is not configured or returns an error.
 */
export async function sendOutreachEmail(
  to: string,
  email: ColdEmail,
): Promise<string> {
  if (!resend) {
    throw new Error('Missing Resend configuration: set RESEND_API_KEY');
  }

  const { data, error } = await resend.emails.send({
    from: OUTREACH_FROM_EMAIL,
    to,
    subject: email.subject,
    html: email.html,
  });

  if (error) {
    throw new Error(`Resend send failed: ${error.name}: ${error.message}`);
  }

  if (!data?.id) {
    throw new Error('Resend send returned no message id');
  }

  return data.id;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Run the full outreach flow: estimate losses → generate a cold email → send it.
 *
 * @param input Prospect details.
 * @param options.send When `false`, generate the email but skip delivery (dry
 *   run). Defaults to `true`.
 * @throws if the input is invalid or (when sending) delivery fails.
 */
export async function runOutreach(
  input: OutreachInput,
  options: { send?: boolean } = {},
): Promise<OutreachResult> {
  const send = options.send ?? true;

  const estimate = estimateLoss(input.mrrCents);
  const { email, source } = await generateColdEmail(input, estimate);

  let emailId: string | null = null;
  if (send) {
    emailId = await sendOutreachEmail(input.contactEmail, email);
  }

  return {
    companyName: input.companyName,
    contactEmail: input.contactEmail,
    estimate,
    email,
    source,
    emailId,
  };
}
