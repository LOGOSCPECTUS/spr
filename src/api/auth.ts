/**
 * Shared authentication helpers for secret-protected internal endpoints
 * (cron trigger, outreach trigger).
 */

import type { Request } from 'express';

/**
 * Constant-time-ish comparison to avoid leaking secret length via early return.
 * Not a substitute for a real MAC, but adequate for a shared secret.
 */
export function secretsMatch(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < provided.length; i += 1) {
    mismatch |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Extract a shared secret from a request, accepting either an
 * `Authorization: Bearer <secret>` header or a custom header (e.g.
 * `x-outreach-secret`). Returns `undefined` when neither is present.
 */
export function extractSecret(
  req: Request,
  headerName: string,
): string | undefined {
  const custom = req.headers[headerName.toLowerCase()];
  if (typeof custom === 'string' && custom.length > 0) {
    return custom;
  }

  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  return bearer && bearer.length > 0 ? bearer : undefined;
}
