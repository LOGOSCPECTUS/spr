/**
 * Database schema types for Smart Payment Recovery.
 *
 * These types mirror the tables defined in `src/db/schema.sql`.
 * Row types describe a full record as returned by Supabase; the `*Insert`
 * types describe the shape accepted when creating a record (server-generated
 * columns such as `id` and `created_at` are omitted).
 *
 * NOTE: these are `type` aliases rather than `interface`s on purpose.
 * `@supabase/supabase-js` requires each schema member to satisfy
 * `Record<string, unknown>`, and object-literal type aliases have an implicit
 * index signature that satisfies that constraint while `interface`s do not.
 */

export type FailedPaymentStatus =
  | 'pending'
  | 'recovering'
  | 'recovered'
  | 'failed'
  | 'abandoned';

/** `accounts` — a merchant/tenant using the recovery service. */
export type Account = {
  id: string;
  company_name: string;
  email: string;
  stripe_account_id: string | null;
  created_at: string;
};

export type AccountInsert = {
  company_name: string;
  email: string;
  stripe_account_id?: string | null;
};

/** `failed_payments` — a single failed charge to be recovered. */
export type FailedPayment = {
  id: string;
  account_id: string;
  customer_email: string;
  /** Amount in the currency's smallest unit (e.g. cents). */
  amount: number;
  currency: string;
  failure_code: string | null;
  status: FailedPaymentStatus;
  created_at: string;
};

export type FailedPaymentInsert = {
  account_id: string;
  customer_email: string;
  /** Amount in the currency's smallest unit (e.g. cents). */
  amount: number;
  currency: string;
  failure_code?: string | null;
  status?: FailedPaymentStatus;
};

/** Alias for a persisted failed-payment row (as consumed by the services). */
export type FailedPaymentRecord = FailedPayment;

/** `recovery_campaigns` — one outreach step against a failed payment. */
export type RecoveryCampaign = {
  id: string;
  failed_payment_id: string;
  step_number: number;
  generated_content: string | null;
  /** Discount offered as a percentage (0–100), or null when none. */
  discount_offered: number | null;
  sent_at: string | null;
};

export type RecoveryCampaignInsert = {
  failed_payment_id: string;
  step_number: number;
  generated_content?: string | null;
  /** Discount offered as a percentage (0–100), or null when none. */
  discount_offered?: number | null;
  sent_at?: string | null;
};

/**
 * Minimal typed schema surface for `createClient<Database>()`.
 * Extend as additional tables are added.
 */
export type Database = {
  public: {
    Tables: {
      accounts: {
        Row: Account;
        Insert: AccountInsert;
        Update: Partial<AccountInsert>;
        Relationships: [];
      };
      failed_payments: {
        Row: FailedPayment;
        Insert: FailedPaymentInsert;
        Update: Partial<FailedPaymentInsert>;
        Relationships: [
          {
            foreignKeyName: 'failed_payments_account_id_fkey';
            columns: ['account_id'];
            isOneToOne: false;
            referencedRelation: 'accounts';
            referencedColumns: ['id'];
          },
        ];
      };
      recovery_campaigns: {
        Row: RecoveryCampaign;
        Insert: RecoveryCampaignInsert;
        Update: Partial<RecoveryCampaignInsert>;
        Relationships: [
          {
            foreignKeyName: 'recovery_campaigns_failed_payment_id_fkey';
            columns: ['failed_payment_id'];
            isOneToOne: false;
            referencedRelation: 'failed_payments';
            referencedColumns: ['id'];
          },
        ];
      };
    };
    Views: { [_ in never]: never };
    Functions: { [_ in never]: never };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};
