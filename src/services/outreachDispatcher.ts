import { randomBytes } from 'node:crypto';

import {
  buildUnsubscribeUrl,
  estimateLoss,
  generateColdEmail,
  sendOutreachEmail,
  type OutreachInput,
} from './outreachAgent';
import {
  countOutreachSentSince,
  enqueueOutreachMessage,
  fetchQueuedOutreachMessages,
  isEmailUnsubscribed,
  updateOutreachMessage,
} from './supabase';
import type { OutreachMessage } from '../types/database';

/**
 * Outreach dispatcher
 * -------------------
 * Owns the send QUEUE and RATE LIMITING. Prospects are enqueued by the trigger
 * endpoint; `dispatchOutreachQueue` drains queued rows respecting an hourly
 * send cap (5–10/hour), skips suppressed (unsubscribed) recipients, generates
 * each email, and sends it via Resend.
 *
 * The rate limit is DB-backed (a count of messages sent in the last hour) so it
 * holds across process restarts on Render, where the service runs single-instance.
 */

/** Default hourly send cap when OUTREACH_MAX_PER_HOUR is unset/invalid. */
export const DEFAULT_MAX_EMAILS_PER_HOUR = 10;

/** Hard ceiling — the configured cap is clamped to this to honor the 5–10/h policy. */
export const MAX_EMAILS_PER_HOUR_CEILING = 10;

const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * Resolve the hourly send cap from OUTREACH_MAX_PER_HOUR, clamped to
 * [1, {@link MAX_EMAILS_PER_HOUR_CEILING}]. Defaults to
 * {@link DEFAULT_MAX_EMAILS_PER_HOUR}.
 */
export function maxEmailsPerHour(): number {
  const raw = Number(process.env.OUTREACH_MAX_PER_HOUR);
  if (!Number.isFinite(raw) || raw < 1) {
    return DEFAULT_MAX_EMAILS_PER_HOUR;
  }
  return Math.min(Math.floor(raw), MAX_EMAILS_PER_HOUR_CEILING);
}

/** Generate an opaque, unguessable unsubscribe token (192 bits of entropy). */
function newUnsubscribeToken(): string {
  return randomBytes(24).toString('hex');
}

/**
 * Enqueue a prospect for outreach. Validates the financials up-front and mints
 * a unique unsubscribe token. The email body is generated later, at dispatch
 * time, so suppression and rate limits are honored just before sending.
 *
 * @throws if the input is invalid or the insert fails.
 */
export async function enqueueOutreach(
  input: OutreachInput,
): Promise<OutreachMessage> {
  // Throws on invalid MRR before we persist anything.
  estimateLoss(input.mrrCents);

  return enqueueOutreachMessage({
    company_name: input.companyName,
    contact_email: input.contactEmail,
    contact_name: input.contactName ?? null,
    mrr_cents: input.mrrCents,
    currency: input.currency ?? 'usd',
    unsubscribe_token: newUnsubscribeToken(),
    status: 'queued',
  });
}

/** Per-message outcome of a dispatch pass. */
export interface OutreachDispatchItem {
  id: string;
  contactEmail: string;
  status: 'sent' | 'skipped' | 'failed';
  emailId?: string;
  reason?: string;
}

/** Aggregate result of a dispatch pass. */
export interface OutreachDispatchSummary {
  /** Hourly send cap in effect. */
  cap: number;
  /** How many emails were already sent in the trailing hour. */
  sentInLastHour: number;
  /** Emails still allowed to send this pass (cap − sentInLastHour). */
  availableBudget: number;
  /** Budget left after this pass. */
  remainingBudget: number;
  /** True when the cap was already exhausted and nothing was sent. */
  rateLimited: boolean;
  processed: number;
  sent: number;
  skipped: number;
  failed: number;
  results: OutreachDispatchItem[];
}

/**
 * Drain the outreach queue, sending at most `cap − sentInLastHour` emails so the
 * hourly rate limit is never breached. Suppressed recipients are marked
 * `skipped` and do NOT consume send budget.
 *
 * @throws if the rate-limit count or queue fetch fails. Per-message send errors
 *   are captured on the row (status `failed`) and do not abort the pass.
 */
export async function dispatchOutreachQueue(): Promise<OutreachDispatchSummary> {
  const cap = maxEmailsPerHour();
  const sinceIso = new Date(Date.now() - ONE_HOUR_MS).toISOString();
  const sentInLastHour = await countOutreachSentSince(sinceIso);
  const availableBudget = Math.max(0, cap - sentInLastHour);

  const results: OutreachDispatchItem[] = [];

  if (availableBudget <= 0) {
    return {
      cap,
      sentInLastHour,
      availableBudget,
      remainingBudget: 0,
      rateLimited: true,
      processed: 0,
      sent: 0,
      skipped: 0,
      failed: 0,
      results,
    };
  }

  const queued = await fetchQueuedOutreachMessages(availableBudget);

  let remaining = availableBudget;
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const msg of queued) {
    if (remaining <= 0) break;

    // Suppression check — never email an unsubscribed recipient.
    if (await isEmailUnsubscribed(msg.contact_email)) {
      await updateOutreachMessage(msg.id, {
        status: 'skipped',
        error: 'recipient unsubscribed',
      });
      skipped += 1;
      results.push({
        id: msg.id,
        contactEmail: msg.contact_email,
        status: 'skipped',
        reason: 'unsubscribed',
      });
      continue;
    }

    try {
      const estimate = estimateLoss(msg.mrr_cents);
      const unsubscribeUrl = buildUnsubscribeUrl(msg.unsubscribe_token);
      const { email } = await generateColdEmail(
        {
          companyName: msg.company_name,
          contactEmail: msg.contact_email,
          mrrCents: msg.mrr_cents,
          currency: msg.currency,
          contactName: msg.contact_name ?? undefined,
        },
        estimate,
        unsubscribeUrl,
      );

      const emailId = await sendOutreachEmail(msg.contact_email, email, {
        headers: {
          // RFC 8058 one-click unsubscribe for compliant mail clients.
          'List-Unsubscribe': `<${unsubscribeUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      });

      await updateOutreachMessage(msg.id, {
        status: 'sent',
        subject: email.subject,
        html: email.html,
        resend_message_id: emailId,
        error: null,
        sent_at: new Date().toISOString(),
      });

      remaining -= 1;
      sent += 1;
      results.push({
        id: msg.id,
        contactEmail: msg.contact_email,
        status: 'sent',
        emailId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unexpected error';
      await updateOutreachMessage(msg.id, {
        status: 'failed',
        error: message,
        attempts: msg.attempts + 1,
      });
      failed += 1;
      results.push({
        id: msg.id,
        contactEmail: msg.contact_email,
        status: 'failed',
        reason: message,
      });
    }
  }

  return {
    cap,
    sentInLastHour,
    availableBudget,
    remainingBudget: remaining,
    rateLimited: false,
    processed: results.length,
    sent,
    skipped,
    failed,
    results,
  };
}
