import { env } from '../env/env';

/** Sends one transactional email through Brevo's HTTPS API (free tier, no SMTP ports). */
export async function sendMail(to: string, subject: string, html: string): Promise<boolean> {
  if (!env.BREVO_API_KEY || !env.MAIL_FROM) return false;
  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': env.BREVO_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({
        sender: { email: env.MAIL_FROM, name: env.MAIL_FROM_NAME },
        to: [{ email: to }],
        subject,
        htmlContent: html,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
