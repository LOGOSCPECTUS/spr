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
