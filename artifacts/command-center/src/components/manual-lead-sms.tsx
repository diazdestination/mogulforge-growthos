import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Copy, MessageSquareText } from 'lucide-react';
import { isAppleMobile, manualSmsHref, singleSmsPhone } from '@/lib/mobile-lead';

type Template = { id: string; title: string; body: string };
type ManualSms = {
  allowed: boolean;
  reason: string | null;
  phoneE164: string | null;
  templates: Template[];
  orgId: string;
  prepared?: boolean;
  templateId?: string;
  preparedAt?: string;
};

export function manualSmsBlockedReason(reason: string | null | undefined): string {
  const explanations: Record<string, string> = {
    no_sms_consent: 'SMS permission has not been recorded. Confirm and record the customer’s permission before preparing a text.',
    do_not_contact: 'This customer is marked do not contact. No text draft can be prepared.',
    do_not_contact_sms: 'This customer is marked do not text. No text draft can be prepared.',
    'suppressed:stop_keyword': 'This customer opted out of text messages. Do not text this number.',
    'suppressed:unsubscribed': 'This customer opted out of messages. No text draft can be prepared.',
    'suppressed:manual': 'Your company has blocked outreach to this number. Ask an administrator to review the contact record.',
    'suppressed:invalid': 'This phone number was rejected or marked invalid. Verify the contact record before texting.',
    'suppressed:hard_bounce': 'Outreach to this contact is blocked after a delivery failure. Ask an administrator to review it.',
    no_phone: 'No phone number is recorded for this customer.',
    invalid_phone: 'The phone number is incomplete or invalid. Update the contact with one valid phone number.',
    quiet_hours: 'This contact is outside the permitted messaging hours. Review and prepare again during allowed hours.',
    frequency_cap: 'This contact has reached the current follow-up limit. Do not send another text right now.',
  };
  return explanations[reason ?? ''] ?? 'Text outreach is not available for this contact right now. Review current contact permissions before trying again.';
}

async function request(leadId: string, input?: { templateId: string; confirmedServiceReply: true }): Promise<ManualSms> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
  const response = await fetch(`/api/v1/leads/${encodeURIComponent(leadId)}/manual-sms${input ? '/draft-opened' : ''}`, {
    credentials: 'include', cache: 'no-store', signal: controller.signal,
    ...(input ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) } : {}),
  });
  const data = await response.json() as ManualSms;
  if (!Array.isArray(data.templates) || typeof data.allowed !== 'boolean' || typeof data.orgId !== 'string') throw new Error('Text eligibility is unavailable.');
  if (!response.ok && !(response.status === 409 && data.allowed === false)) throw new Error('Could not verify permission to prepare this text. Reload online and try again.');
  return data;
  } finally { clearTimeout(timeout); }
}

export function ManualLeadSms({ leadId, organizationId, canWrite }: { leadId: string; organizationId: string; canWrite: boolean }) {
  const eligibility = useQuery({ queryKey: ['manual-sms', organizationId, leadId], queryFn: () => request(leadId), enabled: canWrite, retry: false, staleTime: 0 });
  const [selected, setSelected] = useState<Template | null>(null);
  const [body, setBody] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [prepared, setPrepared] = useState<{ href: string; phone: string; until: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [freshBlock, setFreshBlock] = useState<string | null>(null);
  const version = useRef(0);
  const allowed = canWrite && !freshBlock && eligibility.data?.allowed === true && eligibility.data.orgId === organizationId;

  useEffect(() => {
    version.current += 1;
    setSelected(null); setBody(''); setConfirmed(false); setPrepared(null); setMessage(''); setFreshBlock(null);
  }, [leadId, organizationId]);
  useEffect(() => {
    if (!allowed) { version.current += 1; setPrepared(null); setSelected(null); setBody(''); setConfirmed(false); }
  }, [allowed]);
  useEffect(() => {
    if (!prepared) return;
    const expire = () => { if (Date.now() >= prepared.until) { setPrepared(null); setMessage('Review the draft and prepare again before returning to your phone messages.'); } };
    const timer = setTimeout(expire, Math.max(0, prepared.until - Date.now()));
    window.addEventListener('focus', expire);
    return () => { clearTimeout(timer); window.removeEventListener('focus', expire); };
  }, [prepared]);

  function select(template: Template) {
    version.current += 1;
    setSelected(template); setBody(template.body); setPrepared(null); setConfirmed(false); setMessage('');
  }

  async function prepare() {
    if (!allowed || !selected || !confirmed || busy || !body.trim()) return;
    if (!navigator.onLine) { setMessage('Go online to check current contact permissions before preparing a text.'); return; }
    setBusy(true); setPrepared(null); setMessage('');
    const expectedVersion = version.current;
    try {
      const result = await request(leadId, { templateId: selected.id, confirmedServiceReply: true });
      if (version.current !== expectedVersion) return;
      if (!result.allowed || result.orgId !== organizationId || !result.prepared || result.templateId !== selected.id || !result.phoneE164) {
        setFreshBlock(manualSmsBlockedReason(result.reason)); return;
      }
      const phone = singleSmsPhone(result.phoneE164);
      const href = phone && manualSmsHref(phone, body, isAppleMobile());
      if (!phone || !href) throw new Error('The phone number or message is invalid. Review the contact and draft.');
      setPrepared({ href, phone, until: Date.now() + 60_000 });
      setMessage('Draft prepared only. Review the recipient and message in your phone, then press Send yourself.');
    } catch { setFreshBlock('Contact permission could not be verified. Go online and check permission again before preparing or copying another draft.'); }
    finally { setBusy(false); }
  }

  async function recheck() {
    setBusy(true);
    const result = await eligibility.refetch();
    if (!result.error && result.data?.allowed && result.data.orgId === organizationId) setFreshBlock(null);
    else setFreshBlock(result.error ? 'Contact permission could not be verified. Go online and try again.' : manualSmsBlockedReason(result.data?.reason));
    setBusy(false);
  }

  async function copy() {
    if (!allowed || !selected) return;
    try { await navigator.clipboard.writeText(body); setMessage('Draft copied. Nothing was sent. Paste it into your phone messages and review it.'); }
    catch { setMessage('Copy is unavailable. Select and copy the draft text below manually.'); }
  }

  return <section id="manual-sms" aria-labelledby="manual-sms-title" className="rounded-xl border border-border p-4 space-y-3 scroll-mt-4">
    <h3 id="manual-sms-title" className="font-semibold flex gap-2 items-center"><MessageSquareText className="w-4 h-4" /> Reply from your phone</h3>
    <p className="text-xs text-muted-foreground">Three editable service-reply drafts. GrowthOS does not send these texts or mark them sent, delivered, or contacted.</p>
    {!canWrite && <p className="text-sm">Your role cannot prepare customer outreach.</p>}
    {canWrite && eligibility.isPending && <p className="text-sm">Checking contact permissions…</p>}
    {canWrite && eligibility.isError && <p role="alert" className="text-sm">Text eligibility could not be checked. No phone composer is available.</p>}
    {canWrite && eligibility.data && !allowed && <p className="text-sm" role="status">{eligibility.data.orgId !== organizationId ? 'This contact belongs to a different account.' : freshBlock || manualSmsBlockedReason(eligibility.data.reason)}</p>}
    {canWrite && !allowed && !eligibility.isPending && <button type="button" disabled={busy} onClick={recheck} className="text-sm underline">Check contact permission again</button>}
    {allowed && <>
      <div className="grid gap-2">
        {eligibility.data?.templates.slice(0, 3).map(template => <button key={template.id} type="button" aria-pressed={selected?.id === template.id} onClick={() => select(template)} className={`border rounded-md px-3 py-2 text-left text-sm font-semibold ${selected?.id === template.id ? 'border-primary bg-primary/10' : 'border-border'}`}>{template.title}</button>)}
      </div>
      {selected && <>
        <label htmlFor={`manual-sms-body-${leadId}`} className="block text-xs font-semibold">Review and edit your message</label>
        <textarea id={`manual-sms-body-${leadId}`} value={body} maxLength={1600} rows={5} onChange={event => { version.current += 1; setBody(event.target.value); setPrepared(null); }} className="w-full rounded-md border border-border bg-background p-2 text-sm" />
        <button type="button" onClick={copy} className="inline-flex items-center gap-1 text-sm underline"><Copy className="w-3 h-3" /> Copy message</button>
        <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={confirmed} onChange={event => { version.current += 1; setConfirmed(event.target.checked); setPrepared(null); }} className="mt-0.5" />This is a requested service reply or follow-up. I will review contact permission, the recipient and the wording, then press Send myself.</label>
        <button type="button" disabled={busy || !confirmed || !body.trim()} onClick={prepare} className="rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">{busy ? 'Checking…' : 'Prepare phone text'}</button>
        {prepared && <div className="space-y-2 rounded-md bg-muted/30 p-3">
          <p className="text-xs">Recipient: <span className="font-mono">{prepared.phone}</span></p>
          <a href={prepared.href} onClick={event => { if (Date.now() >= prepared.until) { event.preventDefault(); setPrepared(null); setMessage('Prepare again to refresh contact permissions.'); } }} className="inline-flex rounded-md border border-primary px-3 py-2 text-sm font-semibold text-primary">Open phone messages</a>
          <p className="text-xs">If the message is not filled in, use Copy message above and paste it into your phone. Body prefill varies by phone and app.</p>
        </div>}
      </>}
    </>}
    {message && <p role="status" className="text-sm">{message}</p>}
    <p className="text-xs text-muted-foreground">Texts use the number/SIM chosen in your phone, not a GrowthOS or Twilio number. Carrier fees and your phone's messaging settings apply. Replies remain in that phone's Messages app; they do not sync back automatically. Recheck permission if returning later; GrowthOS cannot recall a draft once it is in your phone.</p>
  </section>;
}
