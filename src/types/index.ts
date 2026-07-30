/**
 * Shared domain types for Smart Payment Recovery.
 */

export type RecoveryStatus = 'pending' | 'retrying' | 'recovered' | 'failed';

export interface FailedPayment {
  id: string;
  stripeCustomerId: string;
  stripeInvoiceId: string;
  amountDue: number;
  currency: string;
  attemptCount: number;
  status: RecoveryStatus;
  nextAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApiError {
  error: string;
  message: string;
  statusCode: number;
}
