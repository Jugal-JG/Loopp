import { db } from './store';

export async function deliverEmail(id: string) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.NOTIFICATION_FROM;
  try {
    if (!key || !from) {
      const pending = await db().query('SELECT 1 FROM ticket_email WHERE id=$1 AND sent_at IS NULL', [id]);
      return pending.rowCount ? 'queued' : 'unchanged';
    }
    const result = await db().query(`UPDATE ticket_email SET send_until=now()+interval '30 seconds'
      WHERE id=$1 AND sent_at IS NULL AND (send_until IS NULL OR send_until<now())
      RETURNING recipient,subject,body`, [id]);
    const mail = result.rows[0];
    if (!mail) return 'unchanged';
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST', signal: AbortSignal.timeout(4500),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Idempotency-Key': id },
      body: JSON.stringify({ from, to: [mail.recipient], subject: mail.subject, text: mail.body }),
    });
    if (!response.ok) {
      await db().query('UPDATE ticket_email SET send_until=NULL,last_error=$2 WHERE id=$1', [id, `provider_${response.status}`]);
      return 'queued';
    }
    await db().query('UPDATE ticket_email SET sent_at=now(),send_until=NULL,last_error=NULL WHERE id=$1', [id]);
    return 'sent';
  } catch {
    return 'queued';
  }
}
