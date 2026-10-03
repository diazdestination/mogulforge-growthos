import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ContractorApiError, contractorRequest } from "@/lib/contractor-api";
import { z } from "zod/v4";

interface SourceDetail {
  leadId: string; contactId: string; name: string; recipient: string; status: string; importSourceKey: string; externalOpportunityId: string;
  sourceSha256: string; current: boolean; marketingPermission: boolean; consentId: string | null;
  importedHistory: { originalCreatedAt: string | null; snapshotAsOf: string | null };
  adoption: null | { version: number; state: string; expiresAt: string };
}
interface Review { previewId: string; payloadSha256: string; expiresAt: string; snapshot: { recipient: string; importSourceKey: string; externalOpportunityId: string }; input: { evidence: string; sourceAsOf: string; cutoverAt: string; expiresAt: string } }
interface Campaign {
  id: string; version: number; state: string; payloadSha256: string; expiresAt: string;
  settings: { timezone: string; days: string[]; startHour: number; endHour: number; dailyLimit: number };
  items: { id: string; leadId: string; recipient: string; claimedAt: string | null; snapshot: { subject: string; body: string; sender: { senderEmail: string; provider: string } }; delivery: { state: string; detail: string; executionId: string | null } }[];
}
interface Index { candidates: { id: string; status: string; importSourceKey: string | null; externalOpportunityId: string | null }[]; campaigns: { id: string; state: string; createdAt: string }[]; page: number; campaignPage: number; hasMore: boolean; hasMoreCampaigns: boolean }
const indexSchema = z.object({
  candidates: z.array(z.object({ id: z.uuid(), status: z.string(), importSourceKey: z.string().nullable(), externalOpportunityId: z.string().nullable() })).max(100),
  campaigns: z.array(z.object({ id: z.uuid(), state: z.enum(["draft", "approved", "revoked"]), createdAt: z.iso.datetime() })).max(25),
  page: z.number().int().nonnegative().default(0), campaignPage: z.number().int().nonnegative().default(0), hasMore: z.boolean().default(false), hasMoreCampaigns: z.boolean().default(false),
});
const field = "w-full min-w-0 rounded-md border border-border bg-background px-3 py-2 text-sm";
const button = "rounded-md border border-border px-3 py-2 text-sm disabled:opacity-40 disabled:cursor-not-allowed";
const primary = `${button} bg-primary text-primary-foreground`;
const iso = (value: string) => new Date(value).toISOString();
const localDate = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
function message(error: unknown) {
  if (error instanceof ContractorApiError) return ({
    source_review_changed: "The review changed or expired. Refresh the current source and review again.",
    source_review_required: "The source approval is missing, expired, revoked or no longer matches this opportunity.",
    email_marketing_permission_required: "Record explicit email-marketing permission for this exact current address first. Adoption does not provide it.",
    source_touch_reserved: "This opportunity or address already owns its one email touch. Check the original evidence; a new campaign cannot resend it.",
    source_sender_unavailable: "The selected company/assigned Gmail or Microsoft mailbox is unavailable. Connect that sender; no alternate mailbox is used.",
    source_outreach_held: "Current contact, reply, suppression or company sending rules hold this email. Review those controls before preparing it again.",
    source_reply_review_required: "A customer reply needs review before this opportunity can enter recovery outreach.",
    source_campaign_quiet_hours: "The current time is outside the reviewed campaign window. Nothing was sent.",
    source_campaign_expired: "This campaign expired. Reserved sends cannot be retried.",
    source_daily_limit: "The rolling company reservation limit is reached. Already owned sends still consume their slots.",
    source_invalid_request: "Review the exact fields, dates, evidence, window and required confirmations.",
    capability_unavailable: "This company's current agreed scope does not include this recovery execution capability.",
  } as Record<string, string>)[error.code] ?? "The operation could not be confirmed. Check its saved status; do not create another campaign to retry an email.";
  return error instanceof Error ? error.message : "Could not confirm the operation. Check saved status before any further send.";
}

/** Deliberately separate management adoption, customer permission, review and send. */
export function SourceAdoptionPanel({ organizationId, businessName, timezone, canManage, scopeKey = organizationId }: {
  organizationId: string; businessName: string; timezone: string; canManage: boolean; scopeKey?: string;
}) {
  const cache = useQueryClient();
  const [leadId, setLeadId] = useState(""), [review, setReview] = useState<Review | null>(null), [campaign, setCampaign] = useState<Campaign | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [statusRequired, setStatusRequired] = useState(false);
  const [sourceAsOf, setSourceAsOf] = useState(""), [cutoverAt, setCutoverAt] = useState(""), [adoptionExpiry, setAdoptionExpiry] = useState(localDate(new Date(Date.now() + 7 * 86_400_000)));
  const [evidence, setEvidence] = useState(""), [attest, setAttest] = useState(false), [approveAdoption, setApproveAdoption] = useState(false);
  const [permissionEvidence, setPermissionEvidence] = useState(""), [observedAt, setObservedAt] = useState(""), [permissionConfirmed, setPermissionConfirmed] = useState(false);
  const [mailingAddress, setMailingAddress] = useState(""), [subject, setSubject] = useState(""), [body, setBody] = useState("");
  const [emailConfirmed, setEmailConfirmed] = useState(false), [sendConfirmed, setSendConfirmed] = useState(false), [reason, setReason] = useState("");
  const [campaignExpiry, setCampaignExpiry] = useState(localDate(new Date(Date.now() + 6 * 3_600_000))), [cohort, setCohort] = useState<string[]>([]);
  const [sendDays, setSendDays] = useState<string[]>([]), [startHour, setStartHour] = useState(9), [endHour, setEndHour] = useState(18), [dailyLimit, setDailyLimit] = useState(10);
  const [page, setPage] = useState(0), [campaignPage, setCampaignPage] = useState(0);
  const index = useQuery({ queryKey: ["source-adoption", organizationId, scopeKey, page, campaignPage], queryFn: async ({ signal }): Promise<Index> =>
    indexSchema.parse(await contractorRequest<unknown>(page || campaignPage ? `/source-adoption?page=${page}&campaignPage=${campaignPage}` : "/source-adoption", { signal })), retry: false });
  const detail = useQuery({ queryKey: ["source-adoption-lead", organizationId, scopeKey, leadId], enabled: !!leadId,
    queryFn: ({ signal }) => contractorRequest<SourceDetail>(`/source-adoption/leads/${leadId}`, { signal }), retry: false });
  useEffect(() => { setLeadId(""); setReview(null); setCampaign(null); setCohort([]); setSendDays([]); setPage(0); setCampaignPage(0); setStatusRequired(false); setError(""); }, [organizationId]);
  const clearReview = () => { setReview(null); setApproveAdoption(false); };
  const clearCampaign = () => { setCampaign(null); setEmailConfirmed(false); setSendConfirmed(false); };
  async function action(work: () => Promise<void>) {
    setBusy(true); setError("");
    try { await work(); await cache.invalidateQueries({ queryKey: ["source-adoption", organizationId, scopeKey] }); await cache.invalidateQueries({ queryKey: ["source-adoption-lead", organizationId, scopeKey, leadId] }); }
    catch (failure) { setError(message(failure)); } finally { setBusy(false); }
  }
  const post = <T,>(path: string, payload: unknown) => contractorRequest<T>(path, { method: "POST", body: payload });
  const leadPath = `/source-adoption/leads/${leadId}`;
  const locked = busy || !canManage;
  function checkCampaignStatus() {
    if (!campaign) return;
    void action(async () => { setCampaign(await contractorRequest<Campaign>(`/source-adoption/outreach/${campaign.id}`)); setStatusRequired(false); setEmailConfirmed(false); setSendConfirmed(false); });
  }
  return <section aria-labelledby="source-adoption-title" className="min-w-0 space-y-4 rounded-xl border border-border p-4">
    <div><h2 id="source-adoption-title" className="text-lg font-semibold">Reviewed source cutover &amp; recovery email</h2>
      <p className="mt-1 text-sm text-muted-foreground">Keep the original import history. Adoption is not consent or a new inquiry. No generic playbooks or SMS are enabled here.</p></div>
    {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
    {index.isLoading && <p role="status">Loading imported opportunities…</p>}
    {index.isError && <div role="alert">Imported opportunities are unavailable. <button className={button} onClick={() => void index.refetch()}>Try loading again</button></div>}
    {index.data && <>
      {!index.data.candidates.length ? <p>No imported opportunities yet. Import a reconciled source export with stable opportunity IDs first.</p> : <label className="block space-y-1 text-sm">Imported opportunity
        <select className={field} value={leadId} onChange={event => { setLeadId(event.target.value); clearReview(); setEvidence(""); setAttest(false); setPermissionConfirmed(false); setPermissionEvidence(""); setReason(""); }}>
          <option value="">Choose an opportunity</option>{index.data.candidates.map(item => <option key={item.id} value={item.id}>{item.importSourceKey ?? "Unidentified source"} · {item.externalOpportunityId ?? "Missing source ID"} · {item.status}</option>)}
        </select></label>}
      {!canManage && <p className="text-sm">Read-only: an active company owner or administrator must approve cutover, permission evidence and email.</p>}
      {(page > 0 || index.data.hasMore) && <div className="flex flex-wrap items-center gap-2 text-sm"><button className={button} disabled={busy || page === 0} onClick={() => { setPage(page - 1); setLeadId(""); clearReview(); }}>Previous opportunities</button>
        <span>Opportunity page {page + 1} · up to 100 per page</span><button className={button} disabled={busy || !index.data.hasMore} onClick={() => { setPage(page + 1); setLeadId(""); clearReview(); }}>More opportunities</button></div>}
      {leadId && detail.isLoading && <p role="status">Loading current source evidence…</p>}
      {detail.isError && <p role="alert">This source cannot be reviewed yet. Reconcile its stable source identity or refresh the current opportunity.</p>}
      {detail.data && <div className="space-y-4">
        <div className="break-words rounded-md bg-muted p-3 text-sm"><p className="font-medium">{detail.data.name} · {detail.data.recipient || "No email"}</p>
          <p>Original opportunity: {detail.data.importedHistory.originalCreatedAt ?? "Unknown — not the upload date"}</p>
          <p>Source snapshot: {detail.data.importedHistory.snapshotAsOf ?? "Not recorded"}</p>
          <p>Native management: {detail.data.current ? `Approved, version ${detail.data.adoption?.version}` : "Current review required"}</p>
          <p>Email-marketing permission: {detail.data.marketingPermission ? "Staff-recorded evidence present (not provider verified)" : "Not evidenced for this address"}</p></div>
        {canManage && <>
          <fieldset disabled={locked} className="space-y-3 rounded-md border p-3"><legend className="px-1 font-medium">1. Review source management</legend>
            <div className="grid min-w-0 gap-3 md:grid-cols-3">
              <label className="min-w-0 text-sm">Source verified as of<input className={field} type="datetime-local" value={sourceAsOf} onChange={e => { setSourceAsOf(e.target.value); clearReview(); }} /></label>
              <label className="min-w-0 text-sm">Completed cutover time<input className={field} type="datetime-local" value={cutoverAt} onChange={e => { setCutoverAt(e.target.value); clearReview(); }} /></label>
              <label className="min-w-0 text-sm">Review valid until<input className={field} type="datetime-local" value={adoptionExpiry} onChange={e => { setAdoptionExpiry(e.target.value); clearReview(); }} /></label>
            </div>
            <label className="block text-sm">Reconciliation evidence<textarea className={field} value={evidence} onChange={e => { setEvidence(e.target.value); clearReview(); }} placeholder="Approved export, count/exception review, source owner and decision reference. No passwords." /></label>
            <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={attest} onChange={e => { setAttest(e.target.checked); clearReview(); }} /><span>I verified the current status, reviewed outstanding replies, and stopped the old workflow from sending for this opportunity.</span></label>
            <button className={button} disabled={!attest || evidence.trim().length < 20 || !sourceAsOf || !cutoverAt || !adoptionExpiry} onClick={() => void action(async () => {
              setReview(await post<Review>(`${leadPath}/preview`, { expectedVersion: detail.data!.adoption?.version ?? 0, sourceAsOf: iso(sourceAsOf), cutoverAt: iso(cutoverAt), expiresAt: iso(adoptionExpiry), evidence,
                sourceWriterStopped: true, currentStatusVerified: true, noUnreviewedReplies: true })); setApproveAdoption(false);
            })}>Preview adoption decision</button>
            {review && <div className="space-y-2 rounded-md bg-muted p-3 text-sm"><p>Reviewing {review.snapshot.importSourceKey} / {review.snapshot.externalOpportunityId} for {review.snapshot.recipient}.</p>
              <p className="break-words">{review.input.evidence}</p><p>Cutover {review.input.cutoverAt}; expires {review.input.expiresAt}.</p>
              <label className="flex gap-2"><input type="checkbox" checked={approveAdoption} onChange={e => setApproveAdoption(e.target.checked)} />I approve this exact management decision, not customer contact.</label>
              <button className={primary} disabled={!approveAdoption} onClick={() => void action(async () => {
                await post(`${leadPath}/approve`, { previewId: review.previewId, payloadSha256: review.payloadSha256, confirmed: true }); clearReview();
              })}>Approve source management</button></div>}
          </fieldset>
          <fieldset disabled={locked} className="space-y-3 rounded-md border p-3"><legend className="px-1 font-medium">2. Record independent email permission</legend>
            <p className="text-sm">An import, past purchase or source approval is not permission. Record what this customer explicitly authorized for this exact address. This is a staff attestation, not independent provider verification.</p>
            <label className="block text-sm">Permission observed at<input className={field} type="datetime-local" value={observedAt} onChange={e => setObservedAt(e.target.value)} /></label>
            <label className="block text-sm">Permission evidence<textarea className={field} value={permissionEvidence} onChange={e => setPermissionEvidence(e.target.value)} placeholder="Where, when and how the customer explicitly permitted promotional email from this business, or withdrew it." /></label>
            <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={permissionConfirmed} onChange={e => setPermissionConfirmed(e.target.checked)} /><span>I checked the customer's explicit email-marketing permission or withdrawal and the current address.</span></label>
            <div className="flex flex-wrap gap-2">{[true, false].map(granted => <button key={String(granted)} className={button} disabled={!permissionConfirmed || !observedAt || permissionEvidence.trim().length < 20} onClick={() => void action(async () => {
              await post(`${leadPath}/email-permission`, { expectedSourceSha256: detail.data!.sourceSha256, expectedRecipient: detail.data!.recipient, expectedConsentId: detail.data!.consentId, granted,
                observedAt: iso(observedAt), evidence: permissionEvidence, marketingPermissionConfirmed: true }); setPermissionConfirmed(false);
            })}>{granted ? "Record explicit permission" : "Record permission withdrawn"}</button>)}</div>
          </fieldset>
          <div className="space-y-2"><label className="block text-sm">Revocation reason<textarea className={field} value={reason} onChange={e => setReason(e.target.value)} /></label>
            <button className={button} disabled={locked || detail.data.adoption?.state !== "active" || reason.trim().length < 20} onClick={() => void action(async () => { await post(`${leadPath}/revoke`, { expectedVersion: detail.data!.adoption!.version, reason }); clearReview(); })}>Revoke source approval</button></div>
        </>}
      </div>}
      {canManage && index.data.candidates.length > 0 && <fieldset disabled={locked || statusRequired} className="space-y-3 rounded-md border p-3"><legend className="px-1 font-medium">3. Prepare exact one-touch email</legend>
        <p className="text-sm">Select up to 10 currently adopted, independently permitted opportunities. One address gets at most one email through this initial workflow. Business: {businessName}. Choose this campaign's window in {timezone}; these are not assumed business hours, and the company's stricter sending rules still apply.</p>
        <p className="text-sm">Selected: {cohort.length} / 10 across all pages. Every complete message is shown before approval.</p>
        <button className={button} disabled={!cohort.length} onClick={() => { setCohort([]); clearCampaign(); }}>Clear selected opportunities</button>
        <div className="max-h-48 space-y-2 overflow-y-auto">{index.data.candidates.map(item => <label key={item.id} className="flex items-start gap-2 break-all text-sm">
          <input type="checkbox" checked={cohort.includes(item.id)} disabled={!cohort.includes(item.id) && cohort.length >= 10} onChange={e => { setCohort(e.target.checked ? [...cohort, item.id] : cohort.filter(id => id !== item.id)); clearCampaign(); }} />
          <span>{item.importSourceKey} / {item.externalOpportunityId ?? "Missing identity"}</span></label>)}</div>
        <label className="block text-sm">Business mailing address<input className={field} value={mailingAddress} onChange={e => { setMailingAddress(e.target.value); clearCampaign(); }} /></label>
        <label className="block text-sm">Email subject<input className={field} value={subject} onChange={e => { setSubject(e.target.value); clearCampaign(); }} /></label>
        <label className="block text-sm">Exact message<textarea className={field} rows={5} value={body} onChange={e => { setBody(e.target.value); clearCampaign(); }} /></label>
        <div className="flex flex-wrap gap-3" aria-label="Approved campaign days">{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(day => <label key={day} className="flex gap-1 text-sm"><input type="checkbox" checked={sendDays.includes(day)} onChange={e => { setSendDays(e.target.checked ? [...sendDays, day] : sendDays.filter(value => value !== day)); clearCampaign(); }} />{day}</label>)}</div>
        <div className="grid min-w-0 gap-3 sm:grid-cols-3"><label className="min-w-0 text-sm">Start hour (24-hour)<input className={field} type="number" min={8} max={19} value={startHour} onChange={e => { setStartHour(Number(e.target.value)); clearCampaign(); }} /></label>
          <label className="min-w-0 text-sm">End hour (24-hour)<input className={field} type="number" min={9} max={20} value={endHour} onChange={e => { setEndHour(Number(e.target.value)); clearCampaign(); }} /></label>
          <label className="min-w-0 text-sm">Company 24-hour cap<input className={field} type="number" min={1} max={25} value={dailyLimit} onChange={e => { setDailyLimit(Number(e.target.value)); clearCampaign(); }} /></label></div>
        <label className="block text-sm">Campaign expires (within 24 hours)<input className={field} type="datetime-local" value={campaignExpiry} onChange={e => { setCampaignExpiry(e.target.value); clearCampaign(); }} /></label>
        <button className={button} disabled={!cohort.length || !sendDays.length || endHour <= startHour || dailyLimit < cohort.length || mailingAddress.trim().length < 10 || subject.trim().length < 3 || body.trim().length < 10 || !campaignExpiry} onClick={() => void action(async () => {
          setCampaign(await post<Campaign>("/source-adoption/outreach/preview", { leadIds: cohort, businessName, mailingAddress, subject, body, timezone,
            days: sendDays, startHour, endHour, dailyLimit, expiresAt: iso(campaignExpiry) })); setEmailConfirmed(false); setSendConfirmed(false);
        })}>Preview complete emails</button>
      </fieldset>}
      {!!index.data.campaigns.length && <label className="block text-sm">Saved campaign
        <select className={field} value={campaign?.id ?? ""} disabled={busy} onChange={e => { const id = e.target.value; if (id) void action(async () => { setCampaign(await contractorRequest<Campaign>(`/source-adoption/outreach/${id}`)); setStatusRequired(false); setEmailConfirmed(false); setSendConfirmed(false); }); }}>
          <option value="">Choose saved campaign</option>{index.data.campaigns.map(row => <option key={row.id} value={row.id}>{row.state} · {new Date(row.createdAt).toLocaleString()}</option>)}
        </select></label>}
      {(campaignPage > 0 || index.data.hasMoreCampaigns) && <div className="flex flex-wrap items-center gap-2 text-sm"><button className={button} disabled={busy || campaignPage === 0} onClick={() => setCampaignPage(campaignPage - 1)}>Newer campaigns</button>
        <span>Campaign page {campaignPage + 1} · up to 25 per page</span><button className={button} disabled={busy || !index.data.hasMoreCampaigns} onClick={() => setCampaignPage(campaignPage + 1)}>Older campaigns and evidence</button></div>}
      {campaign && <div className="space-y-3 rounded-md border p-3">
        <h3 className="font-medium">4. Review, approve, then explicitly send</h3><p className="text-sm">State: {campaign.state}. Expires: {campaign.expiresAt}. Limit: {campaign.settings.dailyLimit} reserved company emails per 24 hours.</p>
        {campaign.items.map(item => <article key={item.id} className="min-w-0 space-y-2 rounded-md bg-muted p-3 text-sm">
          <p className="break-all">To: {item.recipient} · From: {item.snapshot.sender.senderEmail} ({item.snapshot.sender.provider})</p>
          <p className="font-medium">{item.snapshot.subject}</p><pre className="whitespace-pre-wrap break-words font-sans [overflow-wrap:anywhere]">{item.snapshot.body}</pre>
          <p>{item.delivery.state === "accepted" ? "Provider accepted — delivery unconfirmed" : item.delivery.state}: {item.delivery.detail}</p>
        </article>)}
        {statusRequired && <p role="alert">The result is unconfirmed. Check saved status before any further action. Do not create another campaign to retry.</p>}
        <button className={button} disabled={busy} onClick={checkCampaignStatus}>Check saved status</button>
        {canManage && campaign.state === "draft" && <div className="space-y-2"><label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={emailConfirmed} onChange={e => setEmailConfirmed(e.target.checked)} /><span>I approve every exact recipient, selected sender, message, mailing address, unsubscribe link and bounded window above.</span></label>
          <button className={primary} disabled={locked || statusRequired || !emailConfirmed} onClick={() => void action(async () => { setStatusRequired(true); setCampaign(await post<Campaign>(`/source-adoption/outreach/${campaign.id}/approve`, { expectedVersion: campaign.version, payloadSha256: campaign.payloadSha256, confirmed: true })); setStatusRequired(false); setSendConfirmed(false); })}>Approve exact emails — does not send</button></div>}
        {canManage && campaign.state === "approved" && campaign.items.some(item => !item.claimedAt && item.delivery.state === "not_sent") && <div className="space-y-2"><label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={sendConfirmed} onChange={e => setSendConfirmed(e.target.checked)} /><span>Send the remaining approved one-touch emails now, subject to all current holds.</span></label>
          <button className={primary} disabled={locked || statusRequired || !sendConfirmed} onClick={() => void action(async () => { setStatusRequired(true); setSendConfirmed(false); setCampaign(await post<Campaign>(`/source-adoption/outreach/${campaign.id}/send`, { expectedVersion: campaign.version, payloadSha256: campaign.payloadSha256, confirmed: true })); setStatusRequired(false); })}>Send approved emails</button></div>}
        {canManage && campaign.state !== "revoked" && <div className="space-y-2"><label className="block text-sm">Campaign revocation reason<textarea className={field} value={reason} onChange={e => setReason(e.target.value)} /></label>
          <button className={button} disabled={locked || statusRequired || reason.trim().length < 20} onClick={() => void action(async () => { setCampaign(await post<Campaign>(`/source-adoption/outreach/${campaign.id}/revoke`, { expectedVersion: campaign.version, reason })); setSendConfirmed(false); })}>Revoke remaining campaign sends</button></div>}
        <p className="text-sm text-muted-foreground">No delivery or revenue is claimed. Revocation stops unsent work; already handed-off messages cannot be recalled. Accepted, held-after-reservation and unknown sends are retained and cannot be rearmed.</p>
      </div>}
    </>}
  </section>;
}
