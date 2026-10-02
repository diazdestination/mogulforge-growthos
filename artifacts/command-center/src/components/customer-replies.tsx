import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

export interface CustomerReply {
  id: string; messageId: string | null; state: 'needs_review' | 'confirmed' | 'dismissed'; reason: string;
  leadId: string | null; replyAt: string | null; receivedAt: string; holdActive: boolean;
  subject: string | null; fromEmail: string | null; leadSummary: string | null; releasedAt: string | null;
  effectSummary: { pausedEnrollments: number; cancelledActions: number; blockedProposals: number; reconciliationRequired: number } | null;
}
interface ReplyPage { items: CustomerReply[]; total: number; page: number; pageSize: number }
interface Opportunity { id: string; contactName: string | null; summary: string | null; status: string; createdAt: string }

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/v1${path}`, { credentials: 'include', ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Customer replies could not be loaded. Try again.');
  return result as T;
}
const originalTime = (value: string | null) => value ? new Date(value).toLocaleString() : 'Original reply time unknown';
const reasons: Record<string, string> = {
  no_verified_parent: 'Choose the opportunity after checking the original conversation.',
  parent_not_found: 'The original sent message could not be verified.',
  unverified_outbound_evidence: 'The original send lacks server-verified identity. Check the conversation before linking it.',
  ambiguous_parent: 'The message points to more than one conversation. Staff review is required.',
  participant_mismatch: 'The sender or recipient differs from the original conversation.',
  missing_sent_time: 'Confirm when the customer originally replied.',
  future_sent_time: 'The source time is in the future. Check the source; it cannot be replaced here.',
  reply_predates_parent: 'This message is older than the sent message it references.',
  historical_reply: 'Historical reply linked. Later follow-up was left unchanged.',
  legacy_message_requires_review: 'This older inbox record has no verified reply link.',
  synthetic_fixture: 'Demonstration only. It cannot change customer follow-up.',
};

function ReplyItem({ reply, canReview }: { reply: CustomerReply; canReview: boolean }) {
  const client = useQueryClient();
  const [editing, setEditing] = useState(false), [search, setSearch] = useState(''), [leadId, setLeadId] = useState('');
  const [note, setNote] = useState(''), [replyAt, setReplyAt] = useState(''), [checked, setChecked] = useState(false);
  const options = useQuery({ queryKey: ['reply-opportunity-search', search], queryFn: () => request<Opportunity[]>(`/leads?search=${encodeURIComponent(search.trim())}&limit=10`), enabled: editing && reply.state === 'needs_review' && search.trim().length >= 2 });
  const mutation = useMutation({
    mutationFn: (decision: 'confirm' | 'dismiss' | 'resolve') => request(`/email-intelligence/replies/${reply.id}/${decision === 'resolve' ? 'resolve' : 'review'}`, {
      note, ...(decision === 'resolve' ? {} : { decision }), ...(decision === 'confirm' ? { leadId, ...(!reply.replyAt && replyAt ? { replyAt: new Date(replyAt).toISOString() } : {}) } : {}),
    }),
    onSuccess: async () => { setEditing(false); setNote(''); await Promise.all([client.invalidateQueries({ queryKey: ['customer-replies'] }), client.invalidateQueries({ queryKey: ['bie'] }), client.invalidateQueries({ queryKey: ['email-intelligence'] })]); },
  });
  const canConfirm = Boolean(leadId && checked && note.trim().length >= 10 && (reply.replyAt || replyAt));
  const selectedOpportunity = options.data?.find(item => item.id === leadId);
  return <article className="min-w-0 py-5 first:pt-0 last:pb-0">
    <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
      <div className="min-w-0 space-y-1">
        <h3 className="break-words text-base font-semibold">{reply.subject || 'Email content removed'}</h3>
        <p className="break-words text-sm text-muted-foreground">{reply.fromEmail || 'Source content no longer retained'} · {originalTime(reply.replyAt)}</p>
        <p className="text-sm font-medium">{reply.holdActive ? 'Follow-up held for staff review' : reply.state === 'needs_review' ? 'Opportunity not confirmed' : reply.state === 'dismissed' ? 'Dismissed' : reply.releasedAt ? 'Reply handled' : 'Historical reply'}</p>
        {reply.state === 'needs_review' && <p className="text-sm text-muted-foreground">Follow-up is unchanged until the correct opportunity is confirmed.</p>}
        <p className="max-w-prose text-sm text-muted-foreground">{reasons[reply.reason] || (reply.holdActive ? 'Check the customer’s reply, then record how the office handled it.' : 'Review decision saved.')}</p>
        {reply.leadId && <Link href={`/leads/${reply.leadId}`} className="inline-block max-w-full break-words text-sm font-semibold underline underline-offset-4">Open opportunity{reply.leadSummary ? `: ${reply.leadSummary}` : ''}</Link>}
        {reply.effectSummary && <p className="text-sm text-muted-foreground">{reply.effectSummary.pausedEnrollments} sequences paused · {reply.effectSummary.cancelledActions} pending follow-ups cancelled · {reply.effectSummary.blockedProposals} proposed actions blocked</p>}
        {Boolean(reply.effectSummary?.reconciliationRequired) && <p className="max-w-prose text-sm font-medium">{reply.effectSummary!.reconciliationRequired} already claimed or uncertain action(s) still need reconciliation in Revenue Desk. A message may already have been sent.</p>}
      </div>
      {canReview && (reply.state === 'needs_review' || reply.holdActive) && <Button variant="outline" className="min-h-10 shrink-0 self-start" onClick={() => setEditing(value => !value)} aria-expanded={editing} aria-controls={`reply-form-${reply.id}`}>{editing ? 'Close review' : reply.holdActive ? 'Handle reply' : 'Review reply'}</Button>}
    </div>
    {editing && <form id={`reply-form-${reply.id}`} className="mt-4 max-w-2xl space-y-4" onSubmit={event => { event.preventDefault(); mutation.mutate(reply.holdActive ? 'resolve' : 'confirm'); }}>
      {reply.state === 'needs_review' && <>
        <div className="space-y-2"><label htmlFor={`reply-search-${reply.id}`} className="block text-sm font-medium">Find the customer’s opportunity</label><Input id={`reply-search-${reply.id}`} value={search} onChange={event => { setSearch(event.target.value); setLeadId(''); setChecked(false); }} placeholder="Search customer or job (at least 2 characters)" /></div>
        {options.isFetching && <p role="status" className="text-sm text-muted-foreground">Searching opportunities…</p>}
        {options.isError && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{options.error.message}</p>}
        {search.trim().length >= 2 && options.data && <div className="space-y-2"><label htmlFor={`reply-lead-${reply.id}`} className="block text-sm font-medium">Select one opportunity</label><select id={`reply-lead-${reply.id}`} value={leadId} onChange={event => { setLeadId(event.target.value); setChecked(false); }} className="min-h-11 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm"><option value="">Choose an opportunity</option>{options.data.map(item => <option key={item.id} value={item.id}>{item.contactName || 'Unnamed customer'} — {item.summary || item.status.replaceAll('_', ' ')} — {new Date(item.createdAt).toLocaleDateString()} · {item.id.slice(-6)}</option>)}</select><p className="text-xs text-muted-foreground">{options.data.length === 10 ? 'Showing 10 results. Refine the search if the correct job is missing.' : `${options.data.length} matching opportunities.`}</p></div>}
        {selectedOpportunity && <p className="break-words text-sm">Selected: {selectedOpportunity.contactName || 'Unnamed customer'} — {selectedOpportunity.summary || selectedOpportunity.status.replaceAll('_', ' ')} · {selectedOpportunity.id.slice(-6)}. <Link href={`/leads/${selectedOpportunity.id}`} target="_blank" rel="noopener noreferrer" className="font-semibold underline underline-offset-4">Check this opportunity (new tab)</Link></p>}
        {!reply.replyAt && <div className="space-y-2"><label htmlFor={`reply-time-${reply.id}`} className="block text-sm font-medium">Original reply time (your local time)</label><Input id={`reply-time-${reply.id}`} type="datetime-local" value={replyAt} onChange={event => setReplyAt(event.target.value)} /><p className="text-xs text-muted-foreground">Use the original conversation time. Import or forwarding time is not the customer’s reply time.</p></div>}
        <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-primary" checked={checked} onChange={event => setChecked(event.target.checked)} />I checked the original conversation and confirmed this is the selected opportunity.</label>
      </>}
      <div className="space-y-2"><label htmlFor={`reply-note-${reply.id}`} className="block text-sm font-medium">{reply.holdActive ? 'How did the office handle this reply?' : 'Review note'}</label><Textarea id={`reply-note-${reply.id}`} value={note} onChange={event => setNote(event.target.value)} maxLength={1000} aria-describedby={`reply-note-help-${reply.id}`} /><p id={`reply-note-help-${reply.id}`} className="text-xs text-muted-foreground">Use at least 10 characters. Your decision and identity are recorded.</p></div>
      {reply.holdActive && <p className="max-w-prose text-sm text-muted-foreground">Handling this reply allows staff to plan new follow-up. Cancelled actions and paused sequences stay unchanged. Company pauses and imported-data holds still apply.</p>}
      {mutation.isError && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{mutation.error.message}</p>}
      <div className="flex flex-wrap gap-2"><Button type="submit" className="min-h-10 dark:text-slate-950" disabled={mutation.isPending || (reply.holdActive ? note.trim().length < 10 : !canConfirm)}>{mutation.isPending ? 'Saving…' : reply.holdActive ? 'Mark reply handled' : 'Confirm opportunity'}</Button>{reply.state === 'needs_review' && <Button type="button" variant="outline" className="min-h-10" disabled={mutation.isPending || note.trim().length < 10} onClick={() => mutation.mutate('dismiss')}>Dismiss as unrelated</Button>}</div>
    </form>}
  </article>;
}

export function CustomerReplies({ canReview }: { canReview: boolean }) {
  const [page, setPage] = useState(0), [scope, setScope] = useState('attention');
  const query = useQuery({ queryKey: ['customer-replies', scope, page], queryFn: () => request<ReplyPage>(`/email-intelligence/replies?scope=${scope}&page=${page}`) });
  useEffect(() => {
    if (query.data && page > 0 && page * query.data.pageSize >= query.data.total)
      setPage(Math.max(0, Math.ceil(query.data.total / query.data.pageSize) - 1));
  }, [query.data, page]);
  return <section id="customer-replies" aria-labelledby="customer-replies-heading" className="rounded-xl border border-border bg-card p-4 sm:p-5">
    <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start"><div><h2 id="customer-replies-heading" className="text-lg font-semibold">Customer replies</h2><p className="mt-1 max-w-prose text-sm text-muted-foreground">Match uncertain replies to the correct job and keep follow-up on hold while the office responds.</p></div><div className="flex flex-wrap items-center gap-2"><label htmlFor="customer-replies-scope" className="sr-only">Replies to show</label><select id="customer-replies-scope" value={scope} onChange={event => { setScope(event.target.value); setPage(0); }} className="min-h-10 rounded-md border border-input bg-background px-2 text-sm"><option value="attention">Needs attention</option><option value="all">All replies</option></select><Button variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>Refresh</Button></div></div>
    {query.isPending ? <p role="status" className="mt-5 text-sm text-muted-foreground">Loading customer replies…</p> : query.isError ? <p role="alert" className="mt-5 text-sm text-red-700 dark:text-red-300">{query.error.message} Use Refresh to try again.</p> : <>
      <div className="mt-5 divide-y divide-border">{query.data.items.length ? query.data.items.map(reply => <ReplyItem key={reply.id} reply={reply} canReview={canReview} />) : <p className="text-sm text-muted-foreground">{scope === 'attention' ? 'No replies currently need attention. This queue uses only received evidence; it does not prove a mailbox is connected.' : 'No reply records have been received.'}</p>}</div>
      {query.data.total > query.data.pageSize && <nav aria-label="Customer reply pages" className="mt-5 flex flex-wrap items-center gap-3"><Button variant="outline" disabled={page === 0} onClick={() => setPage(value => value - 1)}>Previous</Button><p className="text-sm text-muted-foreground">Page {page + 1} of {Math.ceil(query.data.total / query.data.pageSize)}</p><Button variant="outline" disabled={(page + 1) * query.data.pageSize >= query.data.total} onClick={() => setPage(value => value + 1)}>Next</Button></nav>}
    </>}
  </section>;
}
