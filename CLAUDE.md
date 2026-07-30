# CLAUDE.md

Guidance for Claude Code (and human contributors) working in this repository.

## 1. Project Overview & Tech Stack

**Smart Payment Recovery** is a backend service that recovers failed subscription
payments. It ingests Stripe `invoice.payment_failed` webhooks, generates a
personalized dunning (recovery) email with Claude, sends it via Resend, and
exposes recovery analytics.

| Concern            | Technology                          |
| ------------------ | ----------------------------------- |
| Runtime            | Node.js                             |
| Language           | TypeScript (strict mode)            |
| HTTP framework     | Express 4                           |
| Database           | Supabase (PostgreSQL)               |
| AI generation      | Claude API (`@anthropic-ai/sdk`)    |
| Transactional email| Resend                              |
| Payments / webhooks| Stripe                              |
| Config             | dotenv                              |

## 2. Environment Variables

Copy `.env.example` to `.env` and fill in the values. All server-side secrets —
never expose them to a browser.

| Variable                    | Required | Purpose                                                                 |
| --------------------------- | -------- | ----------------------------------------------------------------------- |
| `PORT`                      | no       | HTTP port (default `3000`).                                             |
| `SUPABASE_URL`              | yes      | Supabase project URL.                                                   |
| `SUPABASE_SERVICE_ROLE_KEY` | yes      | Service-role key. **Bypasses RLS — keep server-only.**                  |
| `STRIPE_SECRET_KEY`         | yes      | Stripe API key.                                                         |
| `STRIPE_WEBHOOK_SECRET`     | yes      | Signing secret for verifying Stripe webhooks.                           |
| `DEFAULT_ACCOUNT_ID`        | no       | Single-tenant fallback account when a webhook has no connected account. |
| `RESEND_API_KEY`            | yes      | Resend API key.                                                         |
| `RESEND_FROM_EMAIL`         | no       | Verified sender address (defaults to Resend's test address).           |
| `ANTHROPIC_API_KEY`         | no*      | Claude API key. *If unset, generation falls back to a template.        |
| `CRON_SECRET`               | yes**    | Shared secret for the cron trigger endpoint. **Required to run it.      |

The service is designed to degrade gracefully: a missing `ANTHROPIC_API_KEY`
falls back to the deterministic template generator rather than crashing.

## 3. Common Commands

```bash
npm install          # install dependencies
npm run dev          # run from source with ts-node (development)
npm run build        # compile TypeScript to dist/
npm start            # run the compiled build (node dist/server.js)
npm run typecheck    # type-check only, no emit (tsc --noEmit)
```

Database schema lives in `src/db/schema.sql` — run it in the Supabase SQL editor
or via migration tooling to provision `accounts`, `failed_payments`, and
`recovery_campaigns`.

## 4. Architecture

End-to-end recovery flow:

```
Stripe invoice.payment_failed
        │  (signature verified)
        ▼
Webhook ingestion  ──►  failed_payments (status: pending)
  src/api/webhooks/stripe.ts
        │
        ▼
Cron trigger  POST /api/v1/cron/recovery-worker   (secret-protected)
  src/api/routes/cron.ts  ──►  src/services/recoveryWorker.ts
        │
        ▼
AI campaign generation   (guardrails clamp the model output)
  src/services/aiGenerator.ts  ──►  recovery_campaigns
        │
        ▼
Resend execution         (send email, stamp sent_at)
  src/services/emailService.ts
        │
        ▼
Analytics    GET /api/v1/analytics/dashboard
  src/api/routes/analytics.ts  ──►  src/services/supabase.ts (getAnalyticsData)
```

### Layout

```
src/
├── server.ts                 # Express app, routing, error handling, boot
├── api/
│   ├── webhooks/stripe.ts     # Stripe webhook: verify + persist failed payment
│   └── routes/
│       ├── cron.ts            # POST /api/v1/cron/recovery-worker (secret-gated)
│       └── analytics.ts       # GET  /api/v1/analytics/dashboard
├── services/
│   ├── supabase.ts            # client + all DB helpers + getAnalyticsData
│   ├── stripe.ts              # Stripe client + webhook secret
│   ├── aiGenerator.ts         # Claude generation + guardrails + template fallback
│   ├── emailService.ts        # Resend client + sendRecoveryEmail
│   └── recoveryWorker.ts      # orchestrates generate → persist → send → mark sent
├── types/
│   ├── database.ts            # Row/Insert types + typed Database for supabase-js
│   └── index.ts               # ApiError and shared API types
└── db/schema.sql              # DDL for the three tables
```

### Key design notes

- **Stripe raw body:** `express.raw` is mounted on `/api/webhooks/stripe`
  *before* the global `express.json`, so signature verification sees the exact
  bytes Stripe signed. Don't reorder this.
- **Account resolution:** webhooks resolve the tenant via Stripe Connect
  (`event.account` → `accounts.stripe_account_id`), falling back to
  `DEFAULT_ACCOUNT_ID` for single-tenant setups. Unresolvable events are ack'd
  with `200` (so Stripe stops retrying) and skipped.
- **Idempotency of runs:** the worker processes `pending` failed payments that
  have no campaign yet; if sending fails after the campaign row exists, the row
  keeps `sent_at = null` for a later retry.
- **Typed Supabase schema:** `src/types/database.ts` uses `type` aliases (not
  `interface`s) and `{ [_ in never]: never }` empty members. This is required —
  otherwise supabase-js silently degrades its `Schema` generic to `never`, which
  surfaces as a cryptic "not assignable to `never[]`" error on `.insert()`.

## 5. Code Style & Guardrails

### Style

- **TypeScript strict mode is on** (`noUnusedLocals`, `noUnusedParameters`,
  `noImplicitReturns`, etc.). Unused imports/vars fail the build — remove them.
- Prefer explicit return types on exported functions.
- Services throw `Error`s with contextual messages; route/handler layers catch
  and translate to `ApiError` JSON (`{ error, message, statusCode }`).
- HTTP handlers use per-route `try/catch`; a centralized 4-arg Express error
  handler and a 404 fallback live in `server.ts`.
- Escape any user/model-supplied value interpolated into HTML.
- Monetary amounts are stored and passed in the **smallest currency unit**
  (e.g. cents), matching Stripe.

### Guardrails (hard constraints)

The AI campaign generator must never exceed these limits, defined in
`src/services/aiGenerator.ts`:

- **Dynamic discount MUST NOT exceed 15%** (`MAX_DISCOUNT_PERCENT = 15`).
- **Grace-period extension MUST NOT exceed 14 days** (`MAX_GRACE_PERIOD_DAYS = 14`).

These are enforced by clamping **every** generated value with `clamp()` after
parsing the model response — the clamp wraps the LLM output, so a model that
ignores the prompt still cannot breach the limits. The same clamp applies to the
template fallback. **Do not remove or loosen these clamps.** If the business
limits change, update the two constants (and the system-prompt text that states
them) together.
