import { Resend } from 'resend';

const RESEND_API_KEY = process.env.RESEND_API_KEY;

if (!RESEND_API_KEY) {
  throw new Error('Missing Resend configuration: set RESEND_API_KEY');
}

/**
 * The verified sender address. Resend requires `from` to be an address on a
 * domain you've verified; `onboarding@resend.dev` works for testing only.
 */
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL ?? 'onboarding@resend.dev';

const resend = new Resend(RESEND_API_KEY);

/** Result of a successful send. */
export interface SendRecoveryEmailResult {
  id: string;
}

/**
 * Send a recovery email via Resend.
 *
 * @throws if Resend returns an error or an unexpected empty response.
 */
export async function sendRecoveryEmail(
  to: string,
  subject: string,
  htmlContent: string,
): Promise<SendRecoveryEmailResult> {
  const { data, error } = await resend.emails.send({
    from: RESEND_FROM_EMAIL,
    to,
    subject,
    html: htmlContent,
  });

  if (error) {
    // Resend returns a structured error object rather than throwing.
    throw new Error(`Resend send failed: ${error.name}: ${error.message}`);
  }

  if (!data?.id) {
    throw new Error('Resend send returned no message id');
  }

  return { id: data.id };
}
