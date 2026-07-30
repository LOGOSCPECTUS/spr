import { generateRecoveryEmail } from './aiGenerator';
import { sendRecoveryEmail } from './emailService';
import {
  fetchFailedPaymentsNeedingCampaign,
  insertRecoveryCampaign,
  markCampaignSent,
  updateFailedPaymentStatus,
} from './supabase';
import type { FailedPaymentRecord } from '../types/database';

/** The step number used for the first recovery outreach. */
const FIRST_STEP = 1;

/** Per-payment outcome of a worker run. */
export interface RecoveryResult {
  paymentId: string;
  status: 'sent' | 'failed';
  campaignId?: string;
  emailId?: string;
  error?: string;
}

/** Aggregate summary of a worker run. */
export interface RecoveryRunSummary {
  processed: number;
  sent: number;
  failed: number;
  results: RecoveryResult[];
}

/**
 * Serialize the generated email for storage in `recovery_campaigns.generated_content`.
 * The grace period has no dedicated column, so it is preserved here.
 */
function serializeContent(email: {
  subject: string;
  html: string;
  gracePeriodDays: number;
}): string {
  return JSON.stringify({
    subject: email.subject,
    html: email.html,
    gracePeriodDays: email.gracePeriodDays,
  });
}

/**
 * Process a single failed payment: generate, persist, send, and mark sent.
 * Throws on any failure so the caller can record it per-payment.
 */
async function processOne(payment: FailedPaymentRecord): Promise<RecoveryResult> {
  const email = await generateRecoveryEmail(payment);

  // Persist the campaign first so we retain a record even if sending fails.
  const campaign = await insertRecoveryCampaign({
    failed_payment_id: payment.id,
    step_number: FIRST_STEP,
    generated_content: serializeContent(email),
    discount_offered: email.discountOffered,
  });

  // Mark the payment as actively recovering.
  await updateFailedPaymentStatus(payment.id, 'recovering');

  // Send the email, then stamp sent_at.
  const { id: emailId } = await sendRecoveryEmail(
    payment.customer_email,
    email.subject,
    email.html,
  );
  await markCampaignSent(campaign.id);

  return {
    paymentId: payment.id,
    status: 'sent',
    campaignId: campaign.id,
    emailId,
  };
}

/**
 * Fetch failed payments that lack a campaign, generate and send a recovery
 * email for each, and record the campaign. Failures are isolated per payment so
 * one bad record does not halt the batch.
 *
 * @param limit maximum number of payments to process in this run.
 */
export async function processPendingRecoveryCampaigns(
  limit = 25,
): Promise<RecoveryRunSummary> {
  const payments = await fetchFailedPaymentsNeedingCampaign(limit);

  const results: RecoveryResult[] = [];
  for (const payment of payments) {
    try {
      results.push(await processOne(payment));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unexpected error';
      console.error(
        `[recovery-worker] failed to process payment ${payment.id}:`,
        message,
      );
      results.push({
        paymentId: payment.id,
        status: 'failed',
        error: message,
      });
    }
  }

  const sent = results.filter((r) => r.status === 'sent').length;
  const summary: RecoveryRunSummary = {
    processed: results.length,
    sent,
    failed: results.length - sent,
    results,
  };

  console.log(
    `[recovery-worker] run complete: processed=${summary.processed} ` +
      `sent=${summary.sent} failed=${summary.failed}`,
  );
  return summary;
}
