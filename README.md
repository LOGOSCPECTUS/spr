# Smart Payment Recovery

[![CI](https://github.com/LOGOSCPECTUS/spr/actions/workflows/ci.yml/badge.svg)](https://github.com/LOGOSCPECTUS/spr/actions/workflows/ci.yml)

A backend micro-SaaS that automatically recovers failed subscription payments.
It ingests Stripe `invoice.payment_failed` webhooks, generates a personalized
dunning (recovery) email with **Claude**, sends it via **Resend**, and exposes
recovery analytics — all with hard business guardrails baked in.

> **Guardrails:** every generated campaign is clamped to **≤ 15% discount** and
> **≤ 14 days grace period**, enforced in code around the LLM output (and the
> template fallback), so the model can never breach the business limits.

## Tech Stack

| Concern              | Technology                       |
| -------------------- | -------------------------------- |
| Runtime              | Node.js                          |
| Language             | TypeScript (strict mode)         |
| HTTP framework       | Express 4                        |
| Database             | Supabase (PostgreSQL)            |
| AI generation        | Anthropic Claude (`@anthropic-ai/sdk`) |
| Transactional email  | Resend                           |
| Payments / webhooks  | Stripe                           |
| Config               | dotenv                           |

## Architecture

```
Stripe invoice.payment_failed
        │  (signature verified)
        ▼
Webhook ingestion  ──►  failed_payments (status: pending)
        │
        ▼
Cron trigger  POST /api/v1/cron/recovery-worker   (secret-protected)
        │
        ▼
AI campaign generation   (Claude → guardrail clamp → template fallback)  ──►  recovery_campaigns
        │
        ▼
Resend execution         (send email, stamp sent_at)
        │
        ▼
Analytics    GET /api/v1/analytics/dashboard
```

## Getting Started

### Prerequisites

- Node.js 18+
- A Supabase project (run `src/db/schema.sql` in the SQL editor to provision the
  `accounts`, `failed_payments`, and `recovery_campaigns` tables)
- API keys for Stripe, Resend, and (optionally) Anthropic

### Install & run

```bash
# 1. Install dependencies
npm install

# 2. Create your local env file and fill in the values
cp .env.example .env

# 3. Run in development (ts-node)
npm run dev
```

The server starts on `http://localhost:3000` (or `PORT`). It **fails fast** on
startup if a required Supabase / Stripe / Resend variable is missing.

### Other commands

```bash
npm run build      # compile TypeScript to dist/
npm start          # run the compiled build (node dist/server.js)
npm run typecheck  # type-check only, no emit (tsc --noEmit)
```

### Smoke test

`test-pipeline.js` boots the server and exercises the full pipeline (health →
signed webhook → cron worker), reporting a per-stage status:

```bash
node test-pipeline.js
```

## Environment Variables

Copy `.env.example` to `.env` and fill in the values. All are server-side
secrets — never expose them to a browser.

| Variable                    | Required | Purpose                                                                 |
| --------------------------- | -------- | ----------------------------------------------------------------------- |
| `PORT`                      | no       | HTTP port (default `3000`).                                             |
| `SUPABASE_URL`              | yes      | Supabase project URL.                                                   |
| `SUPABASE_SERVICE_ROLE_KEY` | yes      | Service-role key. **Bypasses RLS — keep server-only.**                  |
| `STRIPE_SECRET_KEY`         | yes      | Stripe API secret key (`sk_...`).                                       |
| `STRIPE_WEBHOOK_SECRET`     | yes      | Webhook signing secret (`whsec_...`) for verifying Stripe webhooks.     |
| `DEFAULT_ACCOUNT_ID`        | no       | Single-tenant fallback account when a webhook has no connected account. |
| `RESEND_API_KEY`            | yes      | Resend API key.                                                         |
| `RESEND_FROM_EMAIL`         | no       | Verified sender address (defaults to Resend's test address).           |
| `ANTHROPIC_API_KEY`         | no\*     | Claude API key. \*If unset, generation falls back to a template.       |
| `CRON_SECRET`               | yes\*\*  | Shared secret for the cron trigger endpoint. \*\*Required to run it.    |

## API Endpoints

| Method | Path                             | Auth                       | Description                                                                 |
| ------ | -------------------------------- | -------------------------- | --------------------------------------------------------------------------- |
| `GET`  | `/health`                        | —                          | Liveness check. Returns `{ status: "ok", service }`.                        |
| `POST` | `/api/webhooks/stripe`           | Stripe signature           | Ingests `invoice.payment_failed`; persists a `failed_payments` row.         |
| `POST` | `/api/v1/cron/recovery-worker`   | `x-cron-secret` header     | Runs one recovery pass; returns `{ processed, sent, failed, results }`.     |
| `GET`  | `/api/v1/analytics/dashboard`    | `x-account-id` (optional)  | Aggregate metrics: `{ totalRecoveredRevenue, conversionRate, activeWorkflows }`. |

### Notes

- **`/api/webhooks/stripe`** requires the raw request body — `express.raw` is
  mounted on this path *before* the global JSON parser so signature
  verification sees the exact bytes Stripe signed.
- **`/api/v1/cron/recovery-worker`** is secret-gated: pass the shared secret via
  the `x-cron-secret` header (or `Authorization: Bearer <secret>`), matched
  against `CRON_SECRET`.
- **`/api/v1/analytics/dashboard`** scopes to one account via the `x-account-id`
  header or `?account_id=` query param; omit it for global stats.

## Project Structure

```
src/
├── server.ts                 # Express app, routing, error handling, boot
├── api/
│   ├── webhooks/stripe.ts     # Stripe webhook: verify + persist failed payment
│   └── routes/
│       ├── cron.ts            # POST /api/v1/cron/recovery-worker
│       └── analytics.ts       # GET  /api/v1/analytics/dashboard
├── services/
│   ├── supabase.ts            # client + DB helpers + getAnalyticsData
│   ├── stripe.ts              # Stripe client + webhook secret
│   ├── aiGenerator.ts         # Claude generation + guardrails + template fallback
│   ├── emailService.ts        # Resend client + sendRecoveryEmail
│   └── recoveryWorker.ts      # generate → persist → send → mark sent
├── types/                     # Row/Insert types + shared API types
└── db/schema.sql              # DDL for the three tables
```

See [CLAUDE.md](./CLAUDE.md) for deeper contributor guidance (design notes, code
style, and the guardrail constraints).

## License

UNLICENSED — private.
