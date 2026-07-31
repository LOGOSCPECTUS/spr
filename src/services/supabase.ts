import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import type {
  Account,
  Database,
  FailedPayment,
  FailedPaymentInsert,
  FailedPaymentStatus,
  OutreachMessage,
  OutreachMessageInsert,
  RecoveryCampaign,
  RecoveryCampaignInsert,
} from '../types/database';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    'Missing Supabase configuration: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY',
  );
}

/**
 * Server-side Supabase client using the service-role key.
 *
 * IMPORTANT: the service-role key bypasses Row Level Security. Keep this module
 * server-only and never expose the client (or the key) to browsers.
 */
export const supabase: SupabaseClient<Database> = createClient<Database>(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  },
);

/**
 * Look up the account that owns a given Stripe connected-account id.
 * Returns `null` when no matching account exists.
 *
 * @throws if Supabase returns an unexpected error.
 */
export async function getAccountByStripeAccountId(
  stripeAccountId: string,
): Promise<Account | null> {
  const { data, error } = await supabase
    .from('accounts')
    .select()
    .eq('stripe_account_id', stripeAccountId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to look up account: ${error.message}`);
  }

  return data;
}

/**
 * Insert a new failed payment record and return the created row.
 *
 * @throws if Supabase returns an error.
 */
export async function insertFailedPayment(
  payment: FailedPaymentInsert,
): Promise<FailedPayment> {
  const { data, error } = await supabase
    .from('failed_payments')
    .insert(payment)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to insert failed payment: ${error.message}`);
  }

  return data;
}

/**
 * Fetch recovery campaigns that are pending (created but not yet sent),
 * oldest step first.
 *
 * @param limit maximum number of campaigns to return (default 50).
 * @throws if Supabase returns an error.
 */
export async function fetchPendingCampaigns(
  limit = 50,
): Promise<RecoveryCampaign[]> {
  const { data, error } = await supabase
    .from('recovery_campaigns')
    .select()
    .is('sent_at', null)
    .order('step_number', { ascending: true })
    .limit(limit);

  if (error) {
    throw new Error(`Failed to fetch pending campaigns: ${error.message}`);
  }

  return data ?? [];
}

/**
 * Fetch failed payments that still await recovery and have no campaign yet.
 *
 * The Supabase JS client cannot express a SQL anti-join directly, so this runs
 * two queries: pending payments, then the set of payment ids that already have
 * a campaign, filtering the former by the latter.
 *
 * @param limit maximum number of payments to return (default 25).
 * @throws if Supabase returns an error.
 */
export async function fetchFailedPaymentsNeedingCampaign(
  limit = 25,
): Promise<FailedPayment[]> {
  const { data: pending, error: pendingError } = await supabase
    .from('failed_payments')
    .select()
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(limit);

  if (pendingError) {
    throw new Error(`Failed to fetch pending payments: ${pendingError.message}`);
  }

  const payments = pending ?? [];
  if (payments.length === 0) {
    return [];
  }

  const paymentIds = payments.map((p) => p.id);
  const { data: existing, error: existingError } = await supabase
    .from('recovery_campaigns')
    .select('failed_payment_id')
    .in('failed_payment_id', paymentIds);

  if (existingError) {
    throw new Error(
      `Failed to fetch existing campaigns: ${existingError.message}`,
    );
  }

  const withCampaign = new Set(
    (existing ?? []).map((row) => row.failed_payment_id),
  );

  return payments.filter((p) => !withCampaign.has(p.id));
}

/**
 * Insert a new recovery campaign row and return it.
 *
 * @throws if Supabase returns an error.
 */
export async function insertRecoveryCampaign(
  campaign: RecoveryCampaignInsert,
): Promise<RecoveryCampaign> {
  const { data, error } = await supabase
    .from('recovery_campaigns')
    .insert(campaign)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to insert recovery campaign: ${error.message}`);
  }

  return data;
}

/**
 * Mark a recovery campaign as sent by stamping `sent_at`.
 *
 * @param campaignId the campaign row id.
 * @param sentAt ISO-8601 timestamp; defaults to now.
 * @throws if Supabase returns an error.
 */
export async function markCampaignSent(
  campaignId: string,
  sentAt: string = new Date().toISOString(),
): Promise<RecoveryCampaign> {
  const { data, error } = await supabase
    .from('recovery_campaigns')
    .update({ sent_at: sentAt })
    .eq('id', campaignId)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to mark campaign sent: ${error.message}`);
  }

  return data;
}

/**
 * Update the status of a failed payment.
 *
 * @throws if Supabase returns an error.
 */
export async function updateFailedPaymentStatus(
  paymentId: string,
  status: FailedPaymentStatus,
): Promise<void> {
  const { error } = await supabase
    .from('failed_payments')
    .update({ status })
    .eq('id', paymentId);

  if (error) {
    throw new Error(`Failed to update payment status: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Outreach queue + suppression list
// ---------------------------------------------------------------------------

/**
 * Insert a new outreach message into the send queue and return the created row.
 *
 * @throws if Supabase returns an error.
 */
export async function enqueueOutreachMessage(
  message: OutreachMessageInsert,
): Promise<OutreachMessage> {
  const { data, error } = await supabase
    .from('outreach_messages')
    .insert(message)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to enqueue outreach message: ${error.message}`);
  }

  return data;
}

/**
 * Fetch queued outreach messages, oldest first, up to `limit`.
 *
 * @throws if Supabase returns an error.
 */
export async function fetchQueuedOutreachMessages(
  limit: number,
): Promise<OutreachMessage[]> {
  const { data, error } = await supabase
    .from('outreach_messages')
    .select()
    .eq('status', 'queued')
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) {
    throw new Error(`Failed to fetch queued outreach messages: ${error.message}`);
  }

  return data ?? [];
}

/**
 * Count outreach messages actually sent at/after `sinceIso`. Used by the
 * rate limiter to enforce the hourly send cap.
 *
 * @throws if Supabase returns an error.
 */
export async function countOutreachSentSince(sinceIso: string): Promise<number> {
  const { count, error } = await supabase
    .from('outreach_messages')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'sent')
    .gte('sent_at', sinceIso);

  if (error) {
    throw new Error(`Failed to count sent outreach messages: ${error.message}`);
  }

  return count ?? 0;
}

/**
 * Apply a partial update to an outreach message (status transitions, send
 * stamping, error recording).
 *
 * @throws if Supabase returns an error.
 */
export async function updateOutreachMessage(
  id: string,
  fields: Partial<OutreachMessageInsert>,
): Promise<void> {
  const { error } = await supabase
    .from('outreach_messages')
    .update(fields)
    .eq('id', id);

  if (error) {
    throw new Error(`Failed to update outreach message: ${error.message}`);
  }
}

/**
 * Look up a queued/sent outreach message by its unsubscribe token.
 * Returns `null` when no matching row exists.
 *
 * @throws if Supabase returns an unexpected error.
 */
export async function getOutreachMessageByToken(
  token: string,
): Promise<OutreachMessage | null> {
  const { data, error } = await supabase
    .from('outreach_messages')
    .select()
    .eq('unsubscribe_token', token)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to look up outreach message: ${error.message}`);
  }

  return data;
}

/**
 * Whether an email address is on the suppression list. Matching is
 * case-insensitive (the address is stored lowercased).
 *
 * @throws if Supabase returns an unexpected error.
 */
export async function isEmailUnsubscribed(email: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('unsubscribes')
    .select('id')
    .eq('email', email.toLowerCase())
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to check suppression list: ${error.message}`);
  }

  return data !== null;
}

/**
 * Add an email to the suppression list. Idempotent — a repeat opt-out for an
 * already-suppressed address is a no-op (no error).
 *
 * @throws if Supabase returns an error other than a duplicate.
 */
export async function addUnsubscribe(
  email: string,
  token: string | null = null,
  reason: string | null = null,
): Promise<void> {
  const { error } = await supabase.from('unsubscribes').upsert(
    { email: email.toLowerCase(), token, reason },
    { onConflict: 'email', ignoreDuplicates: true },
  );

  if (error) {
    throw new Error(`Failed to record unsubscribe: ${error.message}`);
  }
}

/** Aggregate recovery metrics, optionally scoped to a single account. */
export interface AnalyticsData {
  /** Sum of `amount` across all failed payments, in the smallest currency unit. */
  totalFailedAmount: number;
  /** Sum of `amount` across recovered payments, in the smallest currency unit. */
  totalRecoveredAmount: number;
  /** Recovered / total * 100, in [0, 100]. Zero when there are no failed payments. */
  recoveryRatePercentage: number;
  /** Count of campaigns not yet sent (pending / in progress). */
  activeCampaignsCount: number;
}

/**
 * Compute aggregate recovery analytics. When `accountId` is provided, results
 * are scoped to that account; otherwise they span every account (global stats).
 *
 * Amounts are summed in the smallest currency unit (e.g. cents). Note this mixes
 * currencies if the data set is multi-currency — callers should scope by account
 * (typically single-currency) when that matters.
 *
 * @throws if Supabase returns an error.
 */
export async function getAnalyticsData(
  accountId?: string,
): Promise<AnalyticsData> {
  // Fetch the amount + status for the relevant failed payments and aggregate
  // in-process (Supabase's JS client has no SUM aggregate helper).
  let paymentsQuery = supabase
    .from('failed_payments')
    .select('amount, status');
  if (accountId) {
    paymentsQuery = paymentsQuery.eq('account_id', accountId);
  }

  const { data: payments, error: paymentsError } = await paymentsQuery;
  if (paymentsError) {
    throw new Error(`Failed to load analytics payments: ${paymentsError.message}`);
  }

  let totalFailedAmount = 0;
  let totalRecoveredAmount = 0;
  for (const p of payments ?? []) {
    totalFailedAmount += p.amount;
    if (p.status === 'recovered') {
      totalRecoveredAmount += p.amount;
    }
  }

  const recoveryRatePercentage =
    totalFailedAmount > 0
      ? (totalRecoveredAmount / totalFailedAmount) * 100
      : 0;

  // Active campaigns = created but not yet sent. The Supabase JS client can't
  // express a join filter, so to scope by account we first collect that
  // account's failed_payment ids, then count unsent campaigns against them.
  let activeCampaignsCount = 0;
  if (accountId) {
    const { data: idRows, error: idError } = await supabase
      .from('failed_payments')
      .select('id')
      .eq('account_id', accountId);
    if (idError) {
      throw new Error(`Failed to load account payments: ${idError.message}`);
    }
    const ids = (idRows ?? []).map((p) => p.id);

    if (ids.length > 0) {
      const { count, error: campaignsError } = await supabase
        .from('recovery_campaigns')
        .select('id', { count: 'exact', head: true })
        .is('sent_at', null)
        .in('failed_payment_id', ids);
      if (campaignsError) {
        throw new Error(
          `Failed to count active campaigns: ${campaignsError.message}`,
        );
      }
      activeCampaignsCount = count ?? 0;
    }
  } else {
    const { count, error: campaignsError } = await supabase
      .from('recovery_campaigns')
      .select('id', { count: 'exact', head: true })
      .is('sent_at', null);
    if (campaignsError) {
      throw new Error(
        `Failed to count active campaigns: ${campaignsError.message}`,
      );
    }
    activeCampaignsCount = count ?? 0;
  }

  return {
    totalFailedAmount,
    totalRecoveredAmount,
    recoveryRatePercentage,
    activeCampaignsCount,
  };
}
