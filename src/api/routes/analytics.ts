import { Router, type Request, type Response } from 'express';

import { getAnalyticsData } from '../../services/supabase';
import type { ApiError } from '../../types';

export const analyticsRouter: Router = Router();

/** Response shape for the dashboard, per the frontend spec. */
interface DashboardResponse {
  /** Total recovered revenue, in the smallest currency unit (e.g. cents). */
  totalRecoveredRevenue: number;
  /** Recovery conversion rate as a percentage, rounded to 2 decimals. */
  conversionRate: number;
  /** Number of active (unsent) recovery campaigns. */
  activeWorkflows: number;
}

/**
 * GET /api/v1/analytics/dashboard
 *
 * Returns aggregate recovery metrics. Scope is determined by the caller's
 * account: pass an account id via the `x-account-id` header (or `?account_id=`)
 * to scope to one account; omit it to get global stats (default account view).
 */
analyticsRouter.get('/dashboard', async (req: Request, res: Response) => {
  const headerAccount = req.headers['x-account-id'];
  const queryAccount = req.query.account_id;
  const accountId =
    (typeof headerAccount === 'string' && headerAccount) ||
    (typeof queryAccount === 'string' && queryAccount) ||
    undefined;

  try {
    const data = await getAnalyticsData(accountId);

    const response: DashboardResponse = {
      totalRecoveredRevenue: data.totalRecoveredAmount,
      conversionRate: Math.round(data.recoveryRatePercentage * 100) / 100,
      activeWorkflows: data.activeCampaignsCount,
    };

    res.status(200).json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unexpected error';
    console.error('[analytics] dashboard query failed:', message);
    res.status(500).json({
      error: 'InternalServerError',
      message,
      statusCode: 500,
    } satisfies ApiError);
  }
});
