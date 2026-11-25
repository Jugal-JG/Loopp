import { useEffect, useState } from 'react';

type Ticket = {
  reference: string; reason: string; profile: string; status: 'pending' | 'accepted' | 'rejected';
  created_at: string; reviewed_at: string | null; request_text: string | null;
  email?: string; queued?: number; email_error?: string | null; messages?: { id: string; body: string }[];
};
const endpoint = '/api/support?action=';

function emailFailure(code?: string | null) {
  if (code === 'provider_unreachable') return 'Loopp could not reach Resend. Retry email.';
  if (code === 'provider_401' || code === 'provider_403') return 'Resend denied the send. Check the API key, verified sender domain, and Resend Logs.';
  const status = code?.match(/^provider_(\d{3})$/)?.[1];
  return status ? `Resend rejected the email (HTTP ${status}). Check Resend Logs.` : '';
}

export function Tickets() {
  const [tickets, setTickets] = useState<Ticket[]>();
  const [error, setError] = useState('');
  const [reviewing, setReviewing] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');
  const [emailConfigured, setEmailConfigured] = useState<boolean>();

  async function load(signal?: AbortSignal) {
    setError('');
    try {
      const response = await fetch(endpoint + 'tickets', { signal });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message);
      setTickets(body.tickets);
      setEmailConfigured(body.emailConfigured);
    } catch (problem) { if (!signal?.aborted) setError((problem as Error).message); }
  }
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, []);

  async function review(reference: string, status: 'accepted' | 'rejected') {
    setReviewing(reference);
    setError('');
    try {
      const response = await fetch(endpoint + 'review-ticket', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reference, status }),
      });
      const body = await response.json();
      if (!response.ok) {
        if (response.status === 409) await load();
        throw new Error(body.message);
      }
      setTickets(items => items?.map(ticket => ticket.reference === reference ? { ...ticket, ...body.ticket } : ticket));
    } catch (problem) { setError((problem as Error).message); }
    finally { setReviewing(''); }
  }
  async function ticketAction(reference: string, action: 'reply-ticket' | 'retry-email') {
    setReviewing(reference);
    setNotice('');
    setError('');
    try {
      const response = await fetch(endpoint + action, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reference, id: crypto.randomUUID(), message: drafts[reference] }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message);
      if (action === 'reply-ticket') {
        setDrafts(items => ({ ...items, [reference]: '' }));
        setNotice(body.delivery === 'sent' ? 'Reply saved and email accepted by the provider.' : body.delivery === 'queued' ? 'Reply saved. Email is queued.' : 'Reply saved.');
      } else {
        setNotice(body.accepted ? `Resend accepted ${body.accepted} queued email(s).` : 'No queued emails were accepted. Check the delivery status on the ticket.');
      }
      await load();
    } catch (problem) { setError((problem as Error).message); }
    finally { setReviewing(''); }
  }
  async function deleteTicket(reference: string) {
    if (!window.confirm(`Delete ticket ${reference} from the escalation inbox?`)) return;
    setReviewing(reference);
    setError('');
    setNotice('');
    try {
      const response = await fetch(endpoint + 'delete-ticket', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reference }),
      });
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.message ?? 'Could not delete this ticket.');
      setTickets(items => items?.filter(ticket => ticket.reference !== reference));
      setNotice(`Ticket ${reference} deleted.`);
    } catch (problem) { setError((problem as Error).message); }
    finally { setReviewing(''); }
  }

  return <section className="ticket-panel" aria-label="Human escalations">
    <div className="toolbar"><div><h1>Human escalations</h1><small>Customer tickets</small></div>
      <button className="secondary" onClick={() => void load()} disabled={!!reviewing}>Refresh</button></div>
    {error && <p className="notice" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {!tickets && !error && <p>Loading tickets…</p>}
    {tickets?.length === 0 && <p>No escalations yet.</p>}
    {tickets?.map(ticket => <article className="ticket" key={ticket.reference}>
      <div className="ticket-heading"><strong>{ticket.reference}</strong><span className="source">{ticket.status}</span>
        <button className="secondary ticket-delete" type="button" aria-label={`Delete ticket ${ticket.reference}`} disabled={!!reviewing}
          onClick={() => void deleteTicket(ticket.reference)}>Delete</button></div>
      <p>{ticket.request_text ?? 'Customer message unavailable'}</p>
      <small>{ticket.profile} · {ticket.reason.replaceAll('_', ' ')} · {new Date(ticket.created_at).toLocaleString()}</small>
      {ticket.email && <p><small>{ticket.email}</small></p>}
      {ticket.messages?.map(message => <p key={message.id}><small>Admin reply</small> {message.body}</p>)}
      {!!ticket.queued && emailConfigured === false && <p><small>Email is queued. Set RESEND_API_KEY and NOTIFICATION_FROM on the server, then retry.</small></p>}
      {!!ticket.queued && emailConfigured === true && ticket.email_error && <p><small>{emailFailure(ticket.email_error)}</small></p>}
      <form className="ticket-actions" onSubmit={event => { event.preventDefault(); void ticketAction(ticket.reference, 'reply-ticket'); }}>
        {ticket.status === 'pending' && <>
          <button type="button" disabled={!!reviewing} onClick={() => void review(ticket.reference, 'accepted')}>Accept</button>
          <button type="button" className="secondary" disabled={!!reviewing} onClick={() => void review(ticket.reference, 'rejected')}>Reject</button>
        </>}
        <input aria-label={`Reply to ${ticket.reference}`} placeholder="Write a reply…" maxLength={2000} value={drafts[ticket.reference] ?? ''} onChange={event => setDrafts(items => ({ ...items, [ticket.reference]: event.target.value }))} />
        <button disabled={!!reviewing || !drafts[ticket.reference]?.trim()}>Send reply</button>
        {!!ticket.queued && <button type="button" className="secondary" disabled={!!reviewing} onClick={() => void ticketAction(ticket.reference, 'retry-email')}>Retry email ({ticket.queued})</button>}
      </form>
    </article>)}
  </section>;
}
