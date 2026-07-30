import { Router, type Request, type Response } from 'express';

import { extractSecret, secretsMatch } from '../auth';
import { processPendingRecoveryCampaigns } from '../../services/recoveryWorker';
import type { ApiError } from '../../types';

export const cronRouter: Router = Router();

/**
 * POST /api/v1/cron/recovery-worker
 *
 * Triggers a pass of the recovery worker. Secured with a shared secret passed in
 * the `x-cron-secret` header (or `Authorization: Bearer <secret>`), compared
 * against CRON_SECRET.
 */
cronRouter.post('/recovery-worker', async (req: Request, res: Response) => {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    console.error('[cron] CRON_SECRET is not configured');
    res.status(500).json({
      error: 'ConfigurationError',
      message: 'Cron secret not configured',
      statusCode: 500,
    } satisfies ApiError);
    return;
  }

  const provided = extractSecret(req, 'x-cron-secret');

  if (!provided || !secretsMatch(provided, expected)) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing or invalid cron secret',
      statusCode: 401,
    } satisfies ApiError);
    return;
  }

  try {
    const summary = await processPendingRecoveryCampaigns();
    res.status(200).json(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unexpected error';
    console.error('[cron] recovery worker run failed:', message);
    res.status(500).json({
      error: 'InternalServerError',
      message,
      statusCode: 500,
    } satisfies ApiError);
  }
});
