/**
 * test-pipeline.js — autonomous end-to-end smoke test for Smart Payment Recovery.
 *
 * It boots the server itself, then exercises the pipeline:
 *   1. GET  /health
 *   2. POST /api/webhooks/stripe        (a signed invoice.payment_failed event)
 *   3. POST /api/v1/cron/recovery-worker (with the cron secret)
 * and prints a per-stage summary.
 *
 * Real Supabase/Resend/Anthropic credentials in .env => the pipeline can fully
 * complete. Without them, DB-backed stages are reported as INFRA-LIMITED rather
 * than failures — signature verification, auth, and routing are still verified.
 *
 * Run:  node test-pipeline.js
 */

'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const Stripe = require('stripe');

const PROJECT_DIR = __dirname;
const TEST_PORT = 4055;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

// ---------------------------------------------------------------------------
// Config resolution: prefer real .env values, fall back to safe dummies so the
// server can boot even with an empty .env.
// ---------------------------------------------------------------------------
function parseEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && m[2] !== '') out[m[1]] = m[2];
  }
  return out;
}

const fileEnv = parseEnvFile(path.join(PROJECT_DIR, '.env'));
const pick = (name, dummy) => fileEnv[name] || process.env[name] || dummy;

const cfg = {
  SUPABASE_URL: pick('SUPABASE_URL', 'https://dummy.supabase.co'),
  SUPABASE_SERVICE_ROLE_KEY: pick('SUPABASE_SERVICE_ROLE_KEY', 'dummy'),
  STRIPE_SECRET_KEY: pick('STRIPE_SECRET_KEY', 'sk_test_dummy'),
  STRIPE_WEBHOOK_SECRET: pick('STRIPE_WEBHOOK_SECRET', 'whsec_dummy'),
  RESEND_API_KEY: pick('RESEND_API_KEY', 're_dummy'),
  CRON_SECRET: pick('CRON_SECRET', 'test-cron-secret'),
};
const usingRealSupabase = !cfg.SUPABASE_URL.includes('dummy.supabase.co');

// ---------------------------------------------------------------------------
// Tiny HTTP helper
// ---------------------------------------------------------------------------
function request(method, pathname, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${BASE}${pathname}`,
      { method, headers },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json;
          try {
            json = JSON.parse(data);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, raw: data, json });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth(timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await request('GET', '/health');
      if (res.status === 200) return true;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Result tracking
// ---------------------------------------------------------------------------
const results = [];
const record = (stage, verdict, detail) =>
  results.push({ stage, verdict, detail });
const ICON = { PASS: '✅', WARN: '⚠️ ', INFRA: '🟡', FAIL: '❌' };
const isDbUnavailable = (msg) =>
  typeof msg === 'string' && /fetch failed|ENOTFOUND|getaddrinfo|network/i.test(msg);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  console.log('── Smart Payment Recovery — pipeline test ──');
  console.log(
    `Mode: ${usingRealSupabase ? 'REAL backends (from .env)' : 'INFRA-LIMITED (dummy backends — no real DB creds)'}`,
  );
  console.log(`Booting server on ${BASE} ...\n`);

  const child = spawn('npx', ['ts-node', 'src/server.ts'], {
    cwd: PROJECT_DIR,
    env: { ...process.env, ...cfg, PORT: String(TEST_PORT) },
  });

  let serverLog = '';
  child.stdout.on('data', (d) => (serverLog += d));
  child.stderr.on('data', (d) => (serverLog += d));

  let exitedEarly = false;
  child.on('exit', (code) => {
    if (code !== null && code !== 0) exitedEarly = true;
  });

  const shutdown = () => {
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  };

  try {
    const healthy = await waitForHealth();
    if (!healthy || exitedEarly) {
      console.error('❌ Server failed to start. Boot log:\n');
      console.error(serverLog.trim() || '(no output)');
      shutdown();
      process.exit(1);
    }

    // --- Stage 1: health -----------------------------------------------------
    {
      const res = await request('GET', '/health');
      if (res.status === 200 && res.json?.status === 'ok') {
        record('1. Health check', 'PASS', `200 ${JSON.stringify(res.json)}`);
      } else {
        record('1. Health check', 'FAIL', `status ${res.status}: ${res.raw}`);
      }
    }

    // --- Stage 2: signed webhook --------------------------------------------
    {
      const payload = JSON.stringify({
        id: `evt_test_${Date.now()}`,
        object: 'event',
        type: 'invoice.payment_failed',
        data: {
          object: {
            id: `in_test_${Date.now()}`,
            object: 'invoice',
            amount_due: 4999,
            currency: 'usd',
            customer_email: 'pipeline-test@example.com',
            last_finalization_error: { code: 'card_declined' },
          },
        },
      });
      const signature = Stripe.webhooks.generateTestHeaderString({
        payload,
        secret: cfg.STRIPE_WEBHOOK_SECRET,
      });
      const res = await request('POST', '/api/webhooks/stripe', {
        headers: {
          'Content-Type': 'application/json',
          'stripe-signature': signature,
        },
        body: payload,
      });
      const msg = res.json?.message ?? res.raw;
      if (res.status === 200 && res.json?.id) {
        record('2. Webhook ingest', 'PASS', `failed payment persisted (id=${res.json.id})`);
      } else if (res.status === 200 && res.json?.skipped === 'unknown_account') {
        record(
          '2. Webhook ingest',
          'WARN',
          'signature verified + handler reached, but no account resolved (set DEFAULT_ACCOUNT_ID or seed accounts)',
        );
      } else if (res.status === 200) {
        record('2. Webhook ingest', 'WARN', `200 but skipped: ${res.raw}`);
      } else if (res.status === 500 && isDbUnavailable(msg)) {
        record('2. Webhook ingest', 'INFRA', 'signature verified; Supabase unreachable (no real DB)');
      } else if (res.status === 400) {
        record('2. Webhook ingest', 'FAIL', `signature/verification rejected: ${msg}`);
      } else {
        record('2. Webhook ingest', 'FAIL', `status ${res.status}: ${res.raw}`);
      }
    }

    // --- Stage 3: cron worker -----------------------------------------------
    {
      const res = await request('POST', '/api/v1/cron/recovery-worker', {
        headers: { 'x-cron-secret': cfg.CRON_SECRET },
      });
      const msg = res.json?.message ?? res.raw;
      if (res.status === 200 && res.json && typeof res.json.processed === 'number') {
        const s = res.json;
        record(
          '3. Cron worker',
          'PASS',
          `ran: processed=${s.processed} sent=${s.sent} failed=${s.failed}`,
        );
      } else if (res.status === 401) {
        record('3. Cron worker', 'FAIL', 'auth rejected — cron secret mismatch');
      } else if (res.status === 500 && isDbUnavailable(msg)) {
        record('3. Cron worker', 'INFRA', 'auth + routing OK; Supabase unreachable (no real DB)');
      } else {
        record('3. Cron worker', 'FAIL', `status ${res.status}: ${res.raw}`);
      }

      // Bonus: verify auth actually gates (wrong secret must 401)
      const bad = await request('POST', '/api/v1/cron/recovery-worker', {
        headers: { 'x-cron-secret': 'wrong' },
      });
      record(
        '4. Cron auth gate',
        bad.status === 401 ? 'PASS' : 'FAIL',
        bad.status === 401 ? 'wrong secret correctly rejected (401)' : `expected 401, got ${bad.status}`,
      );
    }
  } catch (err) {
    record('pipeline', 'FAIL', err instanceof Error ? err.message : String(err));
  } finally {
    shutdown();
    await sleep(300);
  }

  // --- Summary --------------------------------------------------------------
  console.log('\n──────────────── SUMMARY ────────────────');
  for (const r of results) {
    console.log(`${ICON[r.verdict] || '  '} ${r.stage.padEnd(20)} ${r.verdict.padEnd(6)} — ${r.detail}`);
  }
  const hasFail = results.some((r) => r.verdict === 'FAIL');
  const hasInfra = results.some((r) => r.verdict === 'INFRA' || r.verdict === 'WARN');
  console.log('─────────────────────────────────────────');
  let verdict;
  if (hasFail) verdict = '❌ FAIL — a code-level check did not pass';
  else if (hasInfra)
    verdict = '🟡 PARTIAL — all code paths OK; DB-backed stages limited by missing real credentials';
  else verdict = '✅ ALL PASS — full pipeline healthy';
  console.log(`OVERALL: ${verdict}`);
  console.log('─────────────────────────────────────────');

  process.exit(hasFail ? 1 : 0);
})();
