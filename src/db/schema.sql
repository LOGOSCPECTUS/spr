-- Smart Payment Recovery — database schema
-- Target: Supabase (PostgreSQL)
--
-- Run in the Supabase SQL editor or via migration tooling.
-- gen_random_uuid() is provided by the built-in pgcrypto extension.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- accounts: a merchant/tenant using the recovery service
-- ---------------------------------------------------------------------------
create table if not exists public.accounts (
  id                uuid primary key default gen_random_uuid(),
  company_name      text        not null,
  email             text        not null unique,
  stripe_account_id text        unique,
  created_at        timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- failed_payments: a single failed charge to be recovered
-- ---------------------------------------------------------------------------
create table if not exists public.failed_payments (
  id             uuid primary key default gen_random_uuid(),
  account_id     uuid        not null references public.accounts (id) on delete cascade,
  customer_email text        not null,
  amount         bigint      not null check (amount >= 0), -- smallest currency unit (e.g. cents)
  currency       text        not null default 'usd',
  failure_code   text,
  status         text        not null default 'pending'
                   check (status in ('pending', 'recovering', 'recovered', 'failed', 'abandoned')),
  created_at     timestamptz not null default now()
);

create index if not exists idx_failed_payments_account_id on public.failed_payments (account_id);
create index if not exists idx_failed_payments_status on public.failed_payments (status);

-- ---------------------------------------------------------------------------
-- recovery_campaigns: one outreach step against a failed payment
-- ---------------------------------------------------------------------------
create table if not exists public.recovery_campaigns (
  id                uuid primary key default gen_random_uuid(),
  failed_payment_id uuid        not null references public.failed_payments (id) on delete cascade,
  step_number       integer     not null default 1 check (step_number >= 1),
  generated_content text,
  discount_offered  numeric(5, 2) check (discount_offered >= 0 and discount_offered <= 100),
  sent_at           timestamptz,
  unique (failed_payment_id, step_number)
);

create index if not exists idx_recovery_campaigns_failed_payment_id
  on public.recovery_campaigns (failed_payment_id);

-- Pending campaigns = created but not yet sent.
create index if not exists idx_recovery_campaigns_pending
  on public.recovery_campaigns (sent_at)
  where sent_at is null;

-- ---------------------------------------------------------------------------
-- outreach_messages: the cold-outreach send QUEUE
--
-- Each row is one prospect email waiting to be (or already) delivered. The
-- dispatcher drains rows with status 'queued', respecting an hourly rate cap,
-- generates the email, sends it via Resend, and stamps sent_at.
-- ---------------------------------------------------------------------------
create table if not exists public.outreach_messages (
  id                uuid        primary key default gen_random_uuid(),
  company_name      text        not null,
  contact_email     text        not null,
  contact_name      text,
  mrr_cents         bigint      not null check (mrr_cents >= 0), -- smallest currency unit (cents)
  currency          text        not null default 'usd',
  subject           text,       -- filled at send time
  html              text,       -- filled at send time
  status            text        not null default 'queued'
                      check (status in ('queued', 'sent', 'failed', 'skipped', 'cancelled')),
  unsubscribe_token text        not null unique,
  resend_message_id text,
  error             text,
  attempts          integer     not null default 0 check (attempts >= 0),
  created_at        timestamptz not null default now(),
  sent_at           timestamptz
);

create index if not exists idx_outreach_messages_status on public.outreach_messages (status);
create index if not exists idx_outreach_messages_sent_at on public.outreach_messages (sent_at);

-- Queued messages = awaiting dispatch, drained oldest-first.
create index if not exists idx_outreach_messages_queued
  on public.outreach_messages (created_at)
  where status = 'queued';

-- ---------------------------------------------------------------------------
-- unsubscribes: suppression list (GDPR / CAN-SPAM opt-out)
--
-- An email present here must never receive outreach. `email` is stored
-- lowercased by the application layer for case-insensitive matching.
-- ---------------------------------------------------------------------------
create table if not exists public.unsubscribes (
  id         uuid        primary key default gen_random_uuid(),
  email      text        not null unique,
  token      text,       -- the unsubscribe token used, when known (audit)
  reason     text,
  created_at timestamptz not null default now()
);
