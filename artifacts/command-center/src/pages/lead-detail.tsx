import { useState, useRef, useEffect } from 'react';
import { useParams, useSearch } from 'wouter';
import { 
  useGetLead, 
  useUpdateLead, 
  useListLeadActivities, 
  useCreateLeadActivity, 
  useGetContact,
  useGetProperty,
  getGetLeadQueryKey,
  getGetLeadNextActionQueryKey,
  getListTodayActionsQueryKey,
  getGetContactQueryKey,
  getGetPropertyQueryKey,
  getListLeadActivitiesQueryKey,
  getGetDashboardSummaryQueryKey,
  useListLeadConversations,
  getListLeadConversationsQueryKey,
  useListDuplicateLeads,
  getListDuplicateLeadsQueryKey,
  useMergeLead,
  useListEstimates,
  getListEstimatesQueryKey,
  useListProjects,
  getListProjectsQueryKey,
  useGetMe,
  EstimateStatus,
  ProjectStatus,
  LeadStatus,
  useRequestLeadPhotoUploadUrl,
  useAttachLeadPhotos,
  useDeleteLeadPhoto,
  useGetLeadEnrollment,
  useGetLeadBehavior,
  getGetLeadBehaviorQueryKey,
  getGetLeadEnrollmentQueryKey,
  usePauseEnrollment,
  useResumeEnrollment,
  useSkipEnrollmentStep,
} from '@workspace/api-client-react';
import { Link } from 'wouter';
import { Loader2, Bot, Calendar, Phone, Activity as ActivityIcon, CheckCircle2, User, Home, Zap, MessageSquare, MessageSquareText, Copy, FileText, HardHat, Plus, Pencil, ImageOff, Globe, Camera, X as XIcon, CheckCircle, AlertCircle, Trash2, Info } from 'lucide-react';
import { canWrite } from '@/lib/permissions';
import { useToast } from '@/hooks/use-toast';
import { PhotoLightbox } from '@/components/photo-lightbox';
import { extractPhotoPaths, flattenPhotoPaths, photoUrl } from '@/lib/photos';
import { LeadContactActions } from '@/components/lead-contact-actions';
import { ManualLeadSms } from '@/components/manual-lead-sms';
import { NextBestActionCard } from '@/components/next-best-action-card';
import { SmartSiteLeadOwner } from '@/components/smart-site-lead-owner';
import { LeadAlertCoverage } from '@/components/lead-alert-coverage';
import { LeadMailboxRepliesPanel } from '@/components/lead-mailbox-replies-panel';
import { memberAuthorityScope } from '@/lib/member-authority-scope';
import { customerWorkspacePath } from '@/lib/customer-workspace-links';
import { format } from 'date-fns';
import { useQueryClient } from '@tanstack/react-query';

export default function LeadDetail() {
  const { id } = useParams<{ id: string }>();
  const { data: lead, isLoading: leadLoading, error: leadError, refetch: refreshLead } = useGetLead(id!, { query: { enabled: !!id, queryKey: getGetLeadQueryKey(id!) } });
  const { data: contact } = useGetContact(lead?.contactId!, { query: { enabled: !!lead?.contactId, queryKey: getGetContactQueryKey(lead?.contactId!) } });
  const { data: property } = useGetProperty(lead?.propertyId!, { query: { enabled: !!lead?.propertyId, queryKey: getGetPropertyQueryKey(lead?.propertyId!) } });
  
  const { data: duplicateGroups } = useListDuplicateLeads();
  const { data: me, isError: memberError } = useGetMe();
  const queryClient = useQueryClient();
  const updateLead = useUpdateLead();
  const { toast } = useToast();

  const search = useSearch();
  const replyDeepLink = new URLSearchParams(search).get('tab') === 'messages';
  const [activeTab, setActiveTab] = useState<'activity' | 'messages'>(() => replyDeepLink ? 'messages' : 'activity');
  useEffect(() => { if (replyDeepLink) setActiveTab('messages'); }, [id, replyDeepLink]);
  const [sampleBannerDismissed, setSampleBannerDismissed] = useState(false);

  const duplicateMatches = (duplicateGroups || [])
    .filter(g => id && g.leadIds.includes(id))
    .map(g => ({ ...g, otherIds: g.leadIds.filter(lid => lid !== id) }))
    .filter(g => g.otherIds.length > 0);

  if (leadLoading) {
    return <div className="p-8 flex justify-center h-full items-center"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>;
  }

  if (leadError) {
    const status = (leadError as { status?: number }).status;
    return <section role="alert" className="p-6 space-y-3">
      <h1 className="text-lg font-bold">Lead unavailable</h1>
      <p>{status === 401 || status === 403 || status === 404 ? 'This lead is unavailable to the account you are signed in with. It may have been removed or your access may have changed.' : 'The lead could not be loaded. Go online and try again; customer details are not saved for offline access.'}</p>
      <button type="button" className="rounded-md border px-3 py-2 text-sm" onClick={() => void refreshLead()}>Try again</button>
      <Link href="/pipeline" className="block text-primary underline">Open my pipeline</Link>
    </section>;
  }
  
  if (!lead) {
    return <div className="p-8 flex flex-col items-center justify-center h-full text-muted-foreground border-2 border-dashed border-border rounded-xl m-6 bg-muted/10">Lead not found.</div>;
  }

  const handleStatusChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newStatus = e.target.value as LeadStatus;
    updateLead.mutate({ id: lead.id, data: { status: newStatus } }, {
      onSuccess: (data) => {
        queryClient.setQueryData(getGetLeadQueryKey(lead.id), (old: any) => old ? { ...old, status: data.status } : old);
        queryClient.invalidateQueries({ queryKey: getGetLeadNextActionQueryKey(lead.id) });
        queryClient.invalidateQueries({ queryKey: getListTodayActionsQueryKey() });
        queryClient.invalidateQueries({ queryKey: ['smart-sites'] });
      },
      onError: (error: unknown) => {
        const serverMessage =
          error && typeof error === 'object' && 'data' in error
            ? (error as { data?: { error?: string } }).data?.error
            : undefined;
        toast({
          variant: 'destructive',
          title: 'Status not updated',
          description:
            serverMessage ||
            'Changing the lead status failed. Check your connection and try again.',
        });
      },
    });
  };

  return (
    <div className="flex flex-col h-full bg-background overflow-hidden relative">

      {/* Sample lead onboarding banner — always full-width above the columns */}
      {lead.sourceDetail === 'onboarding-test-lead' && !sampleBannerDismissed && (
        <div className="w-full shrink-0 flex items-start gap-3 px-4 py-3 bg-primary/8 border-b border-primary/20 text-sm z-20">
          <Info className="w-4 h-4 text-primary shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <span className="font-bold text-foreground">This is your sample lead.</span>{' '}
            <span className="text-muted-foreground">
              It was created during setup so you can explore the timeline.{' '}
              The <span className="font-semibold text-foreground">score</span> shows how the AI rates urgency and fit based on service type, damage description, and other signals.{' '}
              The <span className="font-semibold text-foreground">playbook enrollment</span> (left panel) shows how automated follow-up steps would be scheduled — but no messages were actually sent to this contact.{' '}
              Timeline entries marked <span className="font-mono text-[11px] font-bold text-foreground bg-muted px-1 py-0.5 rounded">[TEST]</span> are narration only.
            </span>
          </div>
          <button
            type="button"
            aria-label="Dismiss sample lead banner"
            onClick={() => setSampleBannerDismissed(true)}
            className="shrink-0 rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-primary/10 transition-colors"
          >
            <XIcon className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Two-column body */}
      <div data-testid="lead-detail-scroll-body" className="flex flex-col md:flex-row flex-1 min-h-0 overflow-y-auto md:overflow-hidden relative">

      {/* Left Column - Details */}
      <div className="w-full md:w-1/3 md:min-w-[320px] md:max-w-[400px] border-b md:border-b-0 md:border-r border-border bg-card md:overflow-y-auto flex flex-col shrink-0">
        
        {/* Header Block */}
        <div className="p-4 md:p-6 border-b border-border bg-primary/5 text-foreground relative">
          <div className="flex justify-between items-start mb-3 md:mb-4">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-widest ${
                lead.urgency === 'emergency' ? 'bg-destructive/10 text-destructive border border-destructive/20 shadow-sm' : 'bg-primary/10 text-primary border border-primary/20 shadow-sm'
              }`}>
                {lead.urgency}
              </span>
              {lead.source === 'nationwide-inquiry' && (
                <span
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-widest bg-indigo-500/15 text-indigo-700 dark:text-indigo-400 border border-indigo-400/30 shadow-sm"
                  title="Lead submitted via the nationwide travel quote form"
                >
                  <Globe className="w-3 h-3" /> Nationwide Inquiry
                </span>
              )}
              <span className="text-[10px] font-mono font-bold text-muted-foreground uppercase tracking-wider bg-background px-2 py-1 rounded-md border border-border/50 shadow-sm opacity-70">ID: {lead.id.substring(0,8)}</span>
            </div>
            
            {lead.score > 0 && (
              <div className="flex flex-col items-end group relative">
                <div className="flex items-center gap-1.5 bg-background border border-border rounded-lg px-2.5 py-1 shadow-sm transition-all group-hover:border-amber-500/40 group-hover:bg-amber-500/5 group-hover:shadow-md cursor-help">
                  <Bot className="w-3.5 h-3.5 text-primary group-hover:text-amber-500 transition-colors" />
                  <span className="font-mono font-bold text-sm">{lead.score}</span>
                </div>
                {/* Score Reason Tooltip */}
                <div className="absolute top-full mt-2 right-0 w-64 bg-popover border border-popover-border p-3 rounded-xl shadow-xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-50 text-xs translate-y-1 group-hover:translate-y-0">
                  <div className="font-bold uppercase tracking-widest text-[10px] text-muted-foreground mb-2">Mock AI Analysis</div>
                  <ul className="space-y-1.5">
                    {lead.scoreReasons.map((r, i) => (
                      <li key={i} className="flex gap-2 items-start"><Zap className="w-3 h-3 shrink-0 text-amber-500 mt-0.5" /> <span className="font-medium">{r}</span></li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
          </div>
          
          <h1 className="text-xl md:text-2xl font-bold tracking-tight mb-3 md:mb-4 leading-tight">{lead.summary || 'Untitled Lead'}</h1>
          
          <div className="mt-2">
            <label className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest block mb-1.5">Stage</label>
            <select 
              className="w-full bg-card border border-border/80 shadow-sm rounded-xl px-3 py-2.5 text-sm focus:ring-2 focus:ring-primary focus:outline-none capitalize font-bold appearance-none bg-[url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20width%3D%2224%22%20height%3D%2224%22%20fill%3D%22none%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Cpath%20d%3D%22M7%2010L12%2015L17%2010%22%20stroke%3D%22%236B7280%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%2F%3E%3C%2Fsvg%3E')] bg-[position:right_0.5rem_center] bg-no-repeat pr-10 cursor-pointer hover:border-border transition-colors"
              value={lead.status}
              onChange={handleStatusChange}
            >
              {Object.values(LeadStatus).map(s => (
                <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Duplicate warning */}
        {duplicateMatches.length > 0 && (
          <DuplicateWarningPanel leadId={lead.id} matches={duplicateMatches} />
        )}

        {/* Contact & Property Info */}
        <div className="p-4 md:p-6 space-y-6">
          {!memberError && me?.isActive && me.organization?.id === lead.organizationId && (
            <SmartSiteLeadOwner organizationId={lead.organizationId} leadId={lead.id} userId={me.id} scopeKey={memberAuthorityScope(me)} canWrite={canWrite(me.role)} />
          )}
          <LeadAlertCoverage organizationId={lead.organizationId} leadId={lead.id}/>
          <NextBestActionCard leadId={lead.id} canWrite={canWrite(me?.role)} />

          <section>
            <h3 className="flex items-center gap-2 text-[10px] md:text-xs font-bold text-muted-foreground uppercase tracking-widest mb-3">
              <User className="w-3.5 h-3.5" /> Contact
            </h3>
            {contact ? (
              <div className="bg-muted/20 border border-border/50 rounded-xl p-3 md:p-4 text-sm shadow-sm relative overflow-hidden">
                <div className="absolute top-0 right-0 w-16 h-16 bg-primary/5 rounded-bl-full -z-10" />
                <div className="font-bold text-foreground text-base mb-2">{contact.firstName} {contact.lastName}</div>
                {!memberError && me?.isActive && me.organization?.id === lead.organizationId && contact.organizationId === lead.organizationId && contact.id === lead.contactId && customerWorkspacePath(contact.id, lead.organizationId) && (
                  <Link href={customerWorkspacePath(contact.id, lead.organizationId)!} className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-primary hover:underline">Open customer work record</Link>
                )}
                <div className="space-y-1.5">
                   {contact.email && <div className="text-muted-foreground flex items-center gap-2 font-medium"><MailIcon className="w-3.5 h-3.5" /> {contact.email}</div>}
                   {contact.phone && <div className="text-foreground font-mono flex items-center gap-2 font-bold"><PhoneIcon className="w-3.5 h-3.5 text-muted-foreground" /> {contact.phone}</div>}
                </div>
                {(contact.email || contact.phone) && (
                  <div className="mt-3">
                    <LeadContactActions leadId={lead.id} email={contact.email} phone={contact.phone} />
                  </div>
                )}
              </div>
            ) : <div className="text-sm text-muted-foreground italic p-4 border border-dashed border-border rounded-xl bg-muted/10">Loading...</div>}
          </section>

          {contact?.phone && <ManualLeadSms key={`${lead.organizationId}:${lead.id}`} leadId={lead.id} organizationId={lead.organizationId} canWrite={canWrite(me?.role)} />}

          {property && (
            <section>
              <h3 className="flex items-center gap-2 text-[10px] md:text-xs font-bold text-muted-foreground uppercase tracking-widest mb-3">
                <Home className="w-3.5 h-3.5" /> Property
              </h3>
              <div className="bg-muted/20 border border-border/50 rounded-xl p-3 md:p-4 text-sm shadow-sm relative overflow-hidden">
                <div className="absolute top-0 right-0 w-16 h-16 bg-secondary/5 rounded-bl-full -z-10" />
                <div className="font-bold text-foreground text-base mb-1">{property.addressLine1}</div>
                {property.addressLine2 && <div className="font-bold text-foreground text-base mb-1">{property.addressLine2}</div>}
                <div className="text-muted-foreground font-medium mb-3">{property.city}, {property.state} {property.postalCode}</div>
                <div className="inline-block px-2.5 py-1 text-[10px] font-bold text-muted-foreground bg-background border border-border/50 rounded-md uppercase tracking-widest shadow-sm">{property.propertyType || 'Unknown Type'}</div>
              </div>
            </section>
          )}

          {lead.scoreReasons.length > 0 && (
            <section>
              <h3 className="flex items-center gap-2 text-[10px] md:text-xs font-bold text-muted-foreground uppercase tracking-widest mb-3">
                <Zap className="w-3.5 h-3.5 text-amber-500" /> Score Breakdown
              </h3>
              <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-3 md:p-4 text-sm space-y-2 shadow-sm">
                {lead.scoreReasons.map((r, i) => (
                  <div key={i} className="flex gap-2 items-start text-amber-900 dark:text-amber-100 font-medium">
                    <Zap className="w-3.5 h-3.5 shrink-0 text-amber-500 mt-0.5" />
                    <span>{r}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          <EstimatesPanel leadId={lead.id} />

          <ProjectPanel leadId={lead.id} />

          <EnrollmentPanel leadId={lead.id} canWrite={canWrite(me?.role)} />

          <ConciergePanel leadId={lead.id} />

          <BehaviorPanel leadId={lead.id} />

          <section>
            <h3 className="text-[10px] md:text-xs font-bold text-muted-foreground uppercase tracking-widest mb-3">
              Lead Details
            </h3>
            <div className="bg-card border border-border/50 rounded-xl shadow-sm overflow-hidden">
               <div className="space-y-0 text-sm">
                 <div className="flex justify-between items-center border-b border-border/50 p-3">
                   <span className="text-muted-foreground font-medium">Service</span>
                   <span className="font-bold">{lead.serviceType || 'Not specified'}</span>
                 </div>
                 <div className="flex justify-between items-center border-b border-border/50 p-3 bg-muted/10">
                   <span className="text-muted-foreground font-medium">Source</span>
                   <span className="font-bold capitalize">{lead.source || 'Unknown'}</span>
                 </div>
                 <div className="flex justify-between items-center border-b border-border/50 p-3">
                   <span className="text-muted-foreground font-medium">Est. Value</span>
                   <span className="font-mono font-bold bg-muted/50 px-2 py-0.5 rounded-md border border-border/50">{lead.estimatedValueCents ? `$${(lead.estimatedValueCents / 100).toLocaleString()}` : '-'}</span>
                 </div>
                 <div className="flex justify-between items-center p-3 bg-muted/10">
                   <span className="text-muted-foreground font-medium">Created</span>
                   <span className="font-mono text-xs font-bold text-muted-foreground">{format(new Date(lead.createdAt), 'MMM d, yyyy')}</span>
                 </div>
               </div>
            </div>
          </section>
        </div>

      </div>

      {/* Right Column - Activity Timeline / Messages */}
      <div className="flex-none md:flex-1 flex flex-col min-w-0 bg-background relative h-[70vh] md:h-auto border-t md:border-t-0 border-border">
        <div className="px-4 md:px-6 pt-4 md:pt-5 pb-0 border-b border-border shrink-0 bg-card/80 backdrop-blur-md sticky top-0 z-10">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setActiveTab('activity')}
              className={`px-4 py-2 text-sm font-bold rounded-t-lg border-b-2 transition-colors ${activeTab === 'activity' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
            >
              Timeline
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('messages')}
              className={`px-4 py-2 text-sm font-bold rounded-t-lg border-b-2 transition-colors flex items-center gap-2 ${activeTab === 'messages' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
            >
              <MessageSquare className="w-3.5 h-3.5" />
              Messages
            </button>
            {activeTab === 'activity' && (
              <div className="ml-auto pb-1">
                <PhotoUploadButton leadId={lead.id} />
              </div>
            )}
          </div>
        </div>

        {activeTab === 'activity' ? (
          <>
            <ActivityFeed leadId={lead.id} />
            <ActivityComposer leadId={lead.id} />
          </>
        ) : (
          <>
            <div className="flex-1 min-h-0 overflow-y-auto">
              {memberError || !me?.id || !me.organization?.id || !me.isActive ? <p role="alert" className="p-4">Current member access could not be verified. Reply evidence and handling are unavailable until access is refreshed.</p> : <LeadMailboxRepliesPanel key={`${memberAuthorityScope(me)}:${lead.id}`} scopeKey={memberAuthorityScope(me)} leadId={lead.id} canReview={canWrite(me.role)} />}
              <MessageThread leadId={lead.id} preserveReplyFocus={replyDeepLink} />
            </div>
            <MessageComposer leadId={lead.id} />
          </>
        )}
      </div>

      </div>{/* end two-column body */}
    </div>
  );
}

// Mail and Phone icons missing from import
import { Mail as MailIcon, Phone as PhoneIcon } from 'lucide-react';

type FileUploadState = 'uploading' | 'done' | 'error';

interface FileEntry {
  name: string;
  state: FileUploadState;
  error?: string;
  objectPath?: string;
}

function PhotoUploadButton({ leadId }: { leadId: string }) {
  const { data: me } = useGetMe();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [open, setOpen] = useState(false);
  const requestUrl = useRequestLeadPhotoUploadUrl();
  const attachPhotos = useAttachLeadPhotos();
  const queryClient = useQueryClient();

  if (!canWrite(me?.role)) return null;

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files ?? []);
    if (!selected.length) return;
    e.target.value = '';

    const entries: FileEntry[] = selected.map(f => ({ name: f.name, state: 'uploading' }));
    setFiles(entries);
    setOpen(true);

    const successPaths: string[] = [];

    await Promise.all(
      selected.map(async (file, i) => {
        try {
          const { uploadURL, objectPath } = await requestUrl.mutateAsync({
            id: leadId,
            data: { name: file.name, size: file.size, contentType: file.type as 'image/jpeg' },
          });
          const putRes = await fetch(uploadURL, {
            method: 'PUT',
            body: file,
            headers: { 'Content-Type': file.type },
          });
          if (!putRes.ok) throw new Error(`Upload failed (${putRes.status})`);
          successPaths.push(objectPath);
          setFiles(prev =>
            prev.map((f, j) => j === i ? { ...f, state: 'done', objectPath } : f),
          );
        } catch (err) {
          const msg =
            err instanceof Error ? err.message : 'Upload failed';
          setFiles(prev =>
            prev.map((f, j) => j === i ? { ...f, state: 'error', error: msg } : f),
          );
        }
      }),
    );

    if (successPaths.length > 0) {
      try {
        await attachPhotos.mutateAsync({ id: leadId, data: { photoPaths: successPaths } });
        queryClient.invalidateQueries({ queryKey: getListLeadActivitiesQueryKey(leadId) });
      } catch {
        setFiles(prev =>
          prev.map(f =>
            f.state === 'done' ? { ...f, state: 'error', error: 'Failed to attach photos' } : f,
          ),
        );
      }
    }
  };

  const allDone = files.length > 0 && files.every(f => f.state === 'done');
  const hasErrors = files.some(f => f.state === 'error');

  return (
    <div className="relative">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
        className="sr-only"
        onChange={handleFileChange}
        aria-label="Upload photos"
      />
      <button
        type="button"
        aria-label="Upload photos to this lead"
        onClick={() => fileInputRef.current?.click()}
        className="flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 bg-primary/10 text-primary border border-primary/20 rounded-lg hover:bg-primary/20 transition-colors active:scale-95 shadow-sm"
      >
        <Camera className="w-3.5 h-3.5" />
        Upload Photos
      </button>

      {open && files.length > 0 && (
        <div
          role="status"
          aria-live="polite"
          className="absolute top-full right-0 mt-1 z-30 bg-card border border-border rounded-xl shadow-xl p-4 w-72 space-y-2"
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
              {allDone ? 'Upload complete' : hasErrors ? 'Upload issues' : 'Uploading…'}
            </span>
            {(allDone || hasErrors) && (
              <button
                type="button"
                aria-label="Dismiss upload status"
                onClick={() => { setOpen(false); setFiles([]); }}
                className="p-1 rounded-full hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
              >
                <XIcon className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          {files.map((f, i) => (
            <div key={i} className="flex items-center gap-2 text-sm">
              {f.state === 'uploading' && (
                <Loader2 className="w-4 h-4 animate-spin text-primary shrink-0" />
              )}
              {f.state === 'done' && (
                <CheckCircle className="w-4 h-4 text-green-500 shrink-0" />
              )}
              {f.state === 'error' && (
                <AlertCircle className="w-4 h-4 text-destructive shrink-0" />
              )}
              <span className="truncate font-medium text-foreground flex-1">{f.name}</span>
              {f.state === 'error' && f.error && (
                <span className="text-[10px] text-destructive font-bold shrink-0">{f.error}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Marketing attribution + linked website behavior. Attribution comes from
 * the lead's touch data; behavior only exists when the visitor identified
 * themselves (anonymous visitors are never linked).
 */
function BehaviorPanel({ leadId }: { leadId: string }) {
  const { data } = useGetLeadBehavior(leadId, {
    query: { queryKey: getGetLeadBehaviorQueryKey(leadId) },
  });
  if (!data || !data.attribution || !data.behavior) return null;
  const a = data.attribution;
  const b = data.behavior;
  const attributionRows = [
    { label: 'Campaign', value: a.campaign },
    { label: 'Landing page', value: a.landingPage },
    { label: 'Referrer', value: a.referrer },
    { label: 'Latest source', value: a.latestSource },
    { label: 'Created via', value: a.creationMethod },
  ].filter(r => r.value);
  if (attributionRows.length === 0 && !data.linked) return null;

  return (
    <section data-testid="behavior-panel">
      <h3 className="flex items-center gap-2 text-[10px] md:text-xs font-bold text-muted-foreground uppercase tracking-widest mb-3">
        <Globe className="w-3.5 h-3.5" /> Visitor Intelligence
      </h3>
      <div className="bg-card border border-border/50 rounded-xl shadow-sm overflow-hidden text-sm">
        {attributionRows.map((r, i) => (
          <div key={r.label} className={`flex justify-between items-center gap-3 border-b border-border/50 p-3 ${i % 2 === 1 ? 'bg-muted/10' : ''}`}>
            <span className="text-muted-foreground font-medium shrink-0">{r.label}</span>
            <span className="font-bold truncate capitalize" title={r.value ?? undefined}>{r.value}</span>
          </div>
        ))}
        {data.linked ? (
          b.highlights.length > 0 ? (
            <div className="p-3 space-y-2" data-testid="behavior-highlights">
              {b.highlights.map((h, i) => (
                <div key={i} className="flex gap-2 items-start font-medium text-foreground">
                  <ActivityIcon className="w-3.5 h-3.5 shrink-0 text-primary mt-0.5" />
                  <span>{h}</span>
                </div>
              ))}
              {b.topPages.length > 0 && (
                <div className="pt-1 text-xs text-muted-foreground">
                  Top pages: {b.topPages.map(p => `${p.path} (${p.views})`).join(', ')}
                </div>
              )}
            </div>
          ) : (
            <div className="p-3 text-xs text-muted-foreground italic">Visitor linked — no website activity recorded yet.</div>
          )
        ) : (
          <div className="p-3 text-xs text-muted-foreground italic">No website visitor linked to this lead.</div>
        )}
      </div>
    </section>
  );
}

const ESTIMATE_STATUS_STYLES: Record<EstimateStatus, string> = {
  draft: 'bg-muted text-muted-foreground border-border',
  sent: 'bg-blue-500/10 text-blue-600 border-blue-500/20 dark:text-blue-400 dark:border-blue-500/30',
  accepted: 'bg-green-500/10 text-green-700 border-green-500/20 dark:text-green-400 dark:border-green-500/30',
  declined: 'bg-destructive/10 text-destructive border-destructive/20 dark:border-destructive/30',
};

function DuplicateWarningPanel({
  leadId,
  matches,
}: {
  leadId: string;
  matches: { field: string; value: string; otherIds: string[] }[];
}) {
  const queryClient = useQueryClient();
  const mergeLead = useMergeLead();
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const otherIds = [...new Set(matches.flatMap(m => m.otherIds))];

  const handleMerge = (sourceLeadId: string) => {
    setError(null);
    mergeLead.mutate({ id: leadId, data: { sourceLeadId } }, {
      onSuccess: () => {
        setConfirmingId(null);
        queryClient.invalidateQueries({ queryKey: getListDuplicateLeadsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListLeadActivitiesQueryKey(leadId) });
        queryClient.invalidateQueries({ queryKey: getGetLeadQueryKey(leadId) });
      },
      onError: () => {
        setError('Merge failed — the other lead may no longer exist. Refresh and try again.');
      },
    });
  };

  return (
    <div className="mx-4 md:mx-6 mt-4 md:mt-6 border border-amber-500/30 bg-amber-500/10 rounded-2xl p-4 md:p-5 shadow-sm">
      <div className="flex items-center gap-2 text-amber-700 dark:text-amber-400 font-bold text-sm mb-3">
        <Copy className="w-4 h-4" /> Possible duplicate lead
      </div>
      <div className="text-xs md:text-sm text-amber-900/80 dark:text-amber-200/80 space-y-2 font-medium">
        {matches.map((m, i) => (
          <div key={i} className="bg-amber-500/10 p-2 rounded-lg border border-amber-500/20">
            <span className="capitalize font-bold text-amber-900 dark:text-amber-100">{m.field}</span> matches <span className="font-mono bg-background/50 px-1.5 py-0.5 rounded border border-amber-500/30 shadow-sm">{m.value}</span> on{' '}
            {m.otherIds.map((lid, j) => (
              <span key={lid}>
                {j > 0 && ', '}
                <Link href={`/leads/${lid}`} className="text-amber-700 dark:text-amber-300 hover:underline font-mono font-bold">{lid.substring(0, 8)}</Link>
              </span>
            ))}
          </div>
        ))}
        <p className="pt-2 text-xs leading-relaxed opacity-80">Review these leads, then merge duplicates into this lead — this lead survives, and the other's activities and tags move here.</p>
      </div>
      <div className="mt-4 space-y-2">
        {otherIds.map(lid => (
          <div key={lid}>
            {confirmingId === lid ? (
              <div className="border border-amber-500/40 bg-background rounded-xl p-3 md:p-4 text-xs space-y-3 shadow-sm">
                <p className="text-foreground font-medium leading-relaxed">
                  Merge lead <span className="font-mono font-bold bg-muted px-1.5 py-0.5 rounded">{lid.substring(0, 8)}</span> into this one?
                  Its activities and tags move here, and it will be marked <span className="font-bold text-destructive">lost</span>. This can't be undone.
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={mergeLead.isPending}
                    onClick={() => handleMerge(lid)}
                    className="bg-primary text-primary-foreground px-4 py-2 rounded-lg font-bold hover:bg-primary/90 disabled:opacity-50 flex items-center gap-2 active:scale-95 transition-all shadow-sm"
                  >
                    {mergeLead.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    Confirm merge
                  </button>
                  <button
                    type="button"
                    disabled={mergeLead.isPending}
                    onClick={() => { setConfirmingId(null); setError(null); }}
                    className="border border-border px-4 py-2 rounded-lg font-bold hover:bg-muted disabled:opacity-50 active:scale-95 transition-all"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => { setConfirmingId(lid); setError(null); }}
                className="text-xs font-bold border-2 border-amber-500/50 text-amber-700 dark:text-amber-400 px-4 py-2 rounded-xl hover:bg-amber-500/20 active:bg-amber-500/30 transition-colors w-full md:w-auto text-center"
              >
                Merge {lid.substring(0, 8)} into this lead
              </button>
            )}
          </div>
        ))}
        {error && <p className="text-xs text-destructive font-medium bg-destructive/10 p-2 rounded-lg mt-2">{error}</p>}
      </div>
    </div>
  );
}

function ConciergePanel({ leadId }: { leadId: string }) {
  const { data: conversations } = useListLeadConversations(leadId, {
    query: { enabled: !!leadId, queryKey: getListLeadConversationsQueryKey(leadId) },
  });
  const [openId, setOpenId] = useState<string | null>(null);

  if (!conversations?.length) return null;

  return (
    <section>
      <h3 className="flex items-center gap-2 text-[10px] md:text-xs font-bold text-muted-foreground uppercase tracking-widest mb-3">
        <Bot className="w-3.5 h-3.5" /> AI Concierge
      </h3>
      <div className="space-y-3">
        {conversations.map((c) => (
          <div key={c.id} className="bg-card border border-border/50 rounded-xl p-3 md:p-4 text-sm shadow-sm transition-all hover:shadow-md">
            <div className="flex items-center justify-between mb-3">
              <span className={`px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-widest border ${
                c.status === 'completed'
                  ? 'bg-green-500/10 text-green-700 border-green-500/20 dark:text-green-400'
                  : c.status === 'abandoned'
                    ? 'bg-red-500/10 text-red-700 border-red-500/20 dark:text-red-400'
                    : 'bg-amber-500/10 text-amber-700 border-amber-500/20 dark:text-amber-400'
              }`}>
                {c.status}
              </span>
              <span className="text-[10px] text-muted-foreground font-mono font-bold bg-muted/50 px-2 py-0.5 rounded border border-border/50">
                {format(new Date(c.createdAt), 'MMM d • h:mm a')}
              </span>
            </div>
            {c.salesSummary ? (
              <div className="mb-3 bg-muted/20 p-3 rounded-lg border border-border/50">
                <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-1.5 flex items-center gap-1.5">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary/50" />
                  {c.status === 'abandoned' ? 'Partial Sales Summary' : 'Sales Summary'}
                </div>
                <div className="whitespace-pre-wrap text-foreground font-medium text-sm leading-relaxed">{c.salesSummary}</div>
              </div>
            ) : (
              <div className="text-muted-foreground mb-3 italic text-sm p-3 bg-muted/10 rounded-lg border border-dashed border-border/50">Conversation in progress — no summary yet.</div>
            )}
            <button
              type="button"
              onClick={() => setOpenId(openId === c.id ? null : c.id)}
              className="flex items-center gap-1.5 text-primary text-xs font-bold hover:text-primary/80 transition-colors bg-primary/5 hover:bg-primary/10 px-3 py-2 rounded-lg w-full md:w-auto justify-center md:justify-start"
            >
              <MessageSquareText className="w-3.5 h-3.5" />
              {openId === c.id ? 'Hide transcript' : `View transcript (${c.messages.length} msgs)`}
            </button>
            {openId === c.id && (
              <div className="mt-4 space-y-3 max-h-72 overflow-y-auto border-t border-border pt-4 pr-1 no-scrollbar">
                {c.messages.map((m) => (
                  <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[85%] md:max-w-[80%] rounded-2xl px-3.5 py-2.5 text-sm whitespace-pre-wrap shadow-sm font-medium ${
                      m.role === 'user'
                        ? 'bg-primary text-primary-foreground rounded-tr-sm'
                        : 'bg-muted text-foreground border border-border/50 rounded-tl-sm'
                    }`}>
                      {m.content}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function ActivityFeed({ leadId }: { leadId: string }) {
  const { data: activities, isLoading } = useListLeadActivities(leadId, { query: { enabled: !!leadId, queryKey: getListLeadActivitiesQueryKey(leadId) } });
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [failedPaths, setFailedPaths] = useState<ReadonlySet<string>>(new Set());
  const { data: me } = useGetMe();
  const deletePhoto = useDeleteLeadPhoto();
  const queryClient = useQueryClient();

  const markPhotoFailed = (path: string) => {
    setFailedPaths(prev => {
      if (prev.has(path)) return prev;
      const next = new Set(prev);
      next.add(path);
      return next;
    });
  };

  const handleDeletePhoto = (objectPath: string) => {
    deletePhoto.mutate({ id: leadId, data: { objectPath } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListLeadActivitiesQueryKey(leadId) });
        queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
      },
    });
  };

  if (isLoading) return <div className="flex-1 p-6 flex items-center justify-center"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>;

  // All photos across all activities, in timeline order, so the lightbox can
  // navigate through every photo on the lead. Photos whose files failed to
  // load are excluded so the lightbox never shows a broken slide.
  const allPhotoPaths = flattenPhotoPaths(activities || []).filter(path => !failedPaths.has(path));
  const allPhotos = allPhotoPaths.map(path => ({ src: photoUrl(path), alt: 'Damage photo attached by homeowner' }));

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-6 pb-20 md:pb-6 relative">
      {!activities?.length ? (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground py-10 text-sm border-2 border-dashed border-border rounded-2xl bg-muted/10 gap-3 m-2">
          <ActivityIcon className="w-8 h-8 opacity-20" />
          <span className="font-medium">No activity recorded yet.</span>
        </div>
      ) : (
        <div className="relative border-l-2 border-border/50 ml-4 md:ml-6 space-y-6 md:space-y-8 pb-4">
          {activities.map(activity => {
            const isPortalMessage = activity.type === 'portal_message';
            const isChatResumed = activity.type === 'conversation_resumed';
            const isTeamReply = activity.type === 'team_message';
            return (
            <div key={activity.id} className="relative pl-6 md:pl-8">
              <div className={`absolute -left-[11px] top-1.5 w-5 h-5 rounded-full bg-card border-4 flex items-center justify-center shadow-sm ${isPortalMessage ? 'border-amber-500' : isChatResumed ? 'border-emerald-500' : isTeamReply ? 'border-sky-500' : 'border-primary'}`}>
                 <div className="w-full h-full rounded-full bg-background" />
              </div>
              
              <div className={`rounded-2xl p-4 md:p-5 shadow-sm border transition-all hover:shadow-md ${isPortalMessage ? 'bg-amber-500/5 border-amber-500/30' : isChatResumed ? 'bg-emerald-500/5 border-emerald-500/30' : isTeamReply ? 'bg-sky-500/5 border-sky-500/30' : 'bg-card border-border'}`}>
                <div className="flex flex-col md:flex-row md:justify-between md:items-start mb-3 gap-2">
                  <div className="font-bold text-[15px] flex items-center gap-2 flex-wrap">
                    {activity.type === 'note' && <div className="w-6 h-6 rounded bg-muted flex items-center justify-center shrink-0"><ActivityIcon className="w-3.5 h-3.5 text-muted-foreground" /></div>}
                    {activity.type === 'status_change' && <div className="w-6 h-6 rounded bg-green-500/10 flex items-center justify-center shrink-0"><CheckCircle2 className="w-3.5 h-3.5 text-green-600 dark:text-green-400" /></div>}
                    {activity.type === 'communication' && <div className="w-6 h-6 rounded bg-blue-500/10 flex items-center justify-center shrink-0"><Phone className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" /></div>}
                    {(activity.type === 'message_bounced' || activity.type === 'message_unsubscribed') && <div className="w-6 h-6 rounded bg-red-500/10 flex items-center justify-center shrink-0"><AlertCircle className="w-3.5 h-3.5 text-red-600 dark:text-red-400" /></div>}
                    {isPortalMessage && <div className="w-6 h-6 rounded bg-amber-500/10 flex items-center justify-center shrink-0"><MessageSquare className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" /></div>}
                    {isChatResumed && <div className="w-6 h-6 rounded bg-emerald-500/10 flex items-center justify-center shrink-0"><MessageSquare className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" /></div>}
                    {isTeamReply && <div className="w-6 h-6 rounded bg-sky-500/10 flex items-center justify-center shrink-0"><MessageSquareText className="w-3.5 h-3.5 text-sky-600 dark:text-sky-400" /></div>}
                    
                    <span className="text-foreground">{activity.title}</span>
                    
                    {isPortalMessage && (
                      <span className="text-[9px] font-bold uppercase tracking-widest px-2 py-1 rounded-md bg-amber-500/20 text-amber-700 dark:text-amber-400 border border-amber-500/30">
                        Homeowner
                      </span>
                    )}
                    {isChatResumed && (
                      <span className="text-[9px] font-bold uppercase tracking-widest px-2 py-1 rounded-md bg-emerald-500/20 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30">
                        Chat resumed
                      </span>
                    )}
                    {isTeamReply && (
                      <span className="text-[9px] font-bold uppercase tracking-widest px-2 py-1 rounded-md bg-sky-500/20 text-sky-700 dark:text-sky-400 border border-sky-500/30">
                        Team Reply
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest font-bold bg-muted/40 px-2 py-1 rounded-md border border-border/50 self-start md:self-auto">
                    {format(new Date(activity.occurredAt), 'MMM d • h:mm a')}
                  </div>
                </div>
                {activity.body && (
                  <div className="text-[15px] text-muted-foreground whitespace-pre-wrap leading-relaxed font-medium bg-background/50 p-3 rounded-xl border border-border/30 mt-2">{activity.body}</div>
                )}
                <ActivityPhotos
                  metadata={activity.metadata}
                  failedPaths={failedPaths}
                  onPhotoError={markPhotoFailed}
                  onOpen={path => {
                    const idx = allPhotoPaths.indexOf(path);
                    if (idx >= 0) setLightboxIndex(idx);
                  }}
                  canDelete={canWrite(me?.role)}
                  onDeletePhoto={handleDeletePhoto}
                  deletePending={deletePhoto.isPending}
                />
                {isPortalMessage && <PortalReplyBox leadId={leadId} activityId={activity.id} />}
              </div>
            </div>
            );
          })}
        </div>
      )}
      {lightboxIndex !== null && allPhotos.length > 0 && (
        <PhotoLightbox
          photos={allPhotos}
          index={Math.min(lightboxIndex, allPhotos.length - 1)}
          onClose={() => setLightboxIndex(null)}
          onNavigate={setLightboxIndex}
        />
      )}
    </div>
  );
}

function ActivityPhotos({
  metadata,
  failedPaths,
  onPhotoError,
  onOpen,
  canDelete,
  onDeletePhoto,
  deletePending,
}: {
  metadata: Record<string, unknown>;
  failedPaths: ReadonlySet<string>;
  onPhotoError: (path: string) => void;
  onOpen: (path: string) => void;
  canDelete?: boolean;
  onDeletePhoto?: (objectPath: string) => void;
  deletePending?: boolean;
}) {
  const [confirmingPath, setConfirmingPath] = useState<string | null>(null);

  const paths = extractPhotoPaths(metadata);
  if (!paths.length) return null;

  return (
    <div className="mt-4 grid grid-cols-3 sm:grid-cols-4 gap-2 md:gap-3 bg-muted/10 p-3 rounded-xl border border-border/30">
      {paths.map(path => {
        const src = photoUrl(path);
        const isConfirming = confirmingPath === path;

        if (failedPaths.has(path)) {
          return (
            <div
              key={path}
              data-testid="photo-unavailable-placeholder"
              className="aspect-square rounded-lg overflow-hidden border-2 border-dashed border-border bg-muted/40 flex flex-col items-center justify-center gap-1 text-muted-foreground p-1 text-center"
            >
              <ImageOff className="w-4 h-4 opacity-60" aria-hidden="true" />
              <span className="text-[9px] font-bold uppercase tracking-wider leading-tight">Photo unavailable</span>
            </div>
          );
        }

        if (isConfirming) {
          return (
            <div
              key={path}
              data-testid="photo-delete-confirm"
              className="aspect-square rounded-lg overflow-hidden border-2 border-destructive/40 bg-destructive/5 flex flex-col items-center justify-center gap-2 p-2 text-center"
            >
              <Trash2 className="w-4 h-4 text-destructive" aria-hidden="true" />
              <span className="text-[9px] font-bold uppercase tracking-wider text-destructive leading-tight">Delete photo?</span>
              <div className="flex gap-1">
                <button
                  type="button"
                  aria-label="Confirm delete photo"
                  disabled={deletePending}
                  onClick={() => {
                    onDeletePhoto?.(path);
                    setConfirmingPath(null);
                  }}
                  className="text-[9px] font-bold px-2 py-1 bg-destructive text-destructive-foreground rounded hover:bg-destructive/90 disabled:opacity-50 transition-colors"
                >
                  Delete
                </button>
                <button
                  type="button"
                  aria-label="Cancel delete photo"
                  onClick={() => setConfirmingPath(null)}
                  className="text-[9px] font-bold px-2 py-1 bg-muted text-muted-foreground rounded hover:bg-muted/80 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          );
        }

        return (
          <div key={path} className="relative group aspect-square">
            <button
              type="button"
              onClick={() => onOpen(path)}
              aria-label="Open photo in full-size viewer"
              className="block w-full h-full rounded-lg overflow-hidden border-2 border-border bg-muted hover:opacity-90 hover:border-primary/50 transition-all cursor-zoom-in shadow-sm active:scale-95"
            >
              <img
                src={src}
                alt="Damage photo attached by homeowner"
                loading="lazy"
                onError={() => onPhotoError(path)}
                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
              />
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors rounded-lg" />
            </button>
            {canDelete && (
              <button
                type="button"
                aria-label="Delete this photo"
                onClick={(e) => { e.stopPropagation(); setConfirmingPath(path); }}
                className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/60 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-destructive focus:opacity-100 shadow-md"
              >
                <Trash2 className="w-3 h-3" aria-hidden="true" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
function PortalReplyBox({ leadId }: { leadId: string; activityId: string }) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState('');
  const createActivity = useCreateLeadActivity();
  const queryClient = useQueryClient();
  const { data: me } = useGetMe();

  if (!canWrite(me?.role)) return null;

  if (!open) {
    return (
      <div className="mt-4 pt-4 border-t border-amber-500/20">
        <button
          type="button"
          onClick={() => setOpen(true)}
          data-testid="button-open-portal-reply"
          className="text-[11px] font-bold text-amber-700 dark:text-amber-400 bg-amber-500/10 hover:bg-amber-500/20 px-3 py-2 rounded-lg flex items-center justify-center md:justify-start gap-2 transition-colors w-full md:w-auto active:scale-95"
        >
          <MessageSquareText className="w-4 h-4" /> Reply in portal
        </button>
      </div>
    );
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = body.trim();
    if (!trimmed || createActivity.isPending) return;
    createActivity.mutate(
      {
        id: leadId,
        data: {
          type: 'team_message',
          title: 'Reply from the team',
          body: trimmed,
          metadata: { source: 'crm-portal-reply' },
        },
      },
      {
        onSuccess: () => {
          setBody('');
          setOpen(false);
          queryClient.invalidateQueries({ queryKey: getListLeadActivitiesQueryKey(leadId) });
          queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
        },
      },
    );
  };

  return (
    <form onSubmit={handleSubmit} className="mt-4 pt-4 border-t border-amber-500/20 flex flex-col gap-3">
      <div className="relative">
         <textarea
           autoFocus
           value={body}
           onChange={e => setBody(e.target.value)}
           maxLength={2000}
           placeholder="Write a reply — the homeowner will see it in their portal..."
           data-testid="input-portal-reply"
           className="w-full bg-background border-2 border-amber-500/40 rounded-xl p-4 pb-8 text-sm focus:outline-none focus:border-amber-500 min-h-[100px] resize-none shadow-inner transition-colors font-medium text-foreground placeholder:text-muted-foreground/60"
         />
         <div className="absolute bottom-3 right-3 text-[10px] font-mono font-bold text-muted-foreground opacity-50 bg-background px-1 rounded">
            {body.length}/2000
         </div>
      </div>
      {createActivity.isError && (
        <p className="text-xs font-bold text-destructive bg-destructive/10 p-2 rounded-lg border border-destructive/20 text-center md:text-left">Couldn't send the reply. Please try again.</p>
      )}
      <div className="flex flex-col-reverse md:flex-row items-center gap-2 justify-end">
        <button
          type="button"
          onClick={() => { setOpen(false); setBody(''); createActivity.reset(); }}
          className="text-xs font-bold text-muted-foreground hover:text-foreground hover:bg-muted px-4 py-2.5 md:py-2 rounded-lg transition-colors w-full md:w-auto text-center active:scale-95"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!body.trim() || createActivity.isPending}
          data-testid="button-send-portal-reply"
          className="bg-amber-500 hover:bg-amber-600 text-white text-xs font-bold px-5 py-2.5 md:py-2 rounded-lg disabled:opacity-50 flex items-center justify-center gap-2 shadow-sm shadow-amber-500/20 transition-all w-full md:w-auto active:scale-95"
        >
          {createActivity.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <MessageSquareText className="w-4 h-4" />}
          Send to portal
        </button>
      </div>
    </form>
  );
}

function ActivityComposer({ leadId }: { leadId: string }) {
  const [body, setBody] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const createActivity = useCreateLeadActivity();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    setIsSubmitting(true);
    
    createActivity.mutate({ 
      id: leadId, 
      data: { type: 'note', title: 'Added Note', body: body.trim() } 
    }, {
      onSuccess: () => {
        setBody('');
        queryClient.invalidateQueries({ queryKey: getListLeadActivitiesQueryKey(leadId) });
        queryClient.invalidateQueries({ queryKey: getGetLeadNextActionQueryKey(leadId) });
        queryClient.invalidateQueries({ queryKey: getListTodayActionsQueryKey() });
        setIsSubmitting(false);
      },
      onError: (error: unknown) => {
        setIsSubmitting(false);
        const serverMessage =
          error && typeof error === 'object' && 'data' in error
            ? (error as { data?: { error?: string } }).data?.error
            : undefined;
        toast({
          variant: 'destructive',
          title: 'Note not saved',
          description:
            serverMessage ||
            'Saving the note failed. Check your connection and try again.',
        });
      },
    });
  };

  return (
    <div className="p-4 md:p-6 border-t border-border bg-card shrink-0 sticky bottom-0 z-20 pb-safe md:pb-6 shadow-[0_-10px_40px_-15px_rgba(0,0,0,0.1)]">
      <form onSubmit={handleSubmit} className="flex flex-col gap-3 max-w-3xl mx-auto">
        <div className="relative group">
           <textarea 
             placeholder="Add a note to this lead..."
             className="w-full bg-background border-2 border-border/80 group-focus-within:border-primary rounded-xl p-4 pr-12 text-sm focus:outline-none min-h-[56px] md:min-h-[80px] resize-none shadow-sm transition-all font-medium placeholder:font-normal"
             value={body}
             onChange={e => setBody(e.target.value)}
           />
           <button 
             type="submit" 
             disabled={!body.trim() || isSubmitting}
             className="absolute right-2 bottom-2 md:bottom-auto md:top-2 p-2 bg-primary text-primary-foreground rounded-lg disabled:opacity-30 disabled:bg-muted disabled:text-muted-foreground transition-all active:scale-95 shadow-sm"
             aria-label="Post Note"
           >
             {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
           </button>
        </div>
      </form>
    </div>
  );
}

function MessageThread({ leadId, preserveReplyFocus = false }: { leadId: string; preserveReplyFocus?: boolean }) {
  const { data: activities, isLoading } = useListLeadActivities(leadId, {
    query: { enabled: !!leadId, queryKey: getListLeadActivitiesQueryKey(leadId) },
  });
  const bottomRef = useRef<HTMLDivElement>(null);

  const messages = (activities ?? [])
    .filter(a => a.type === 'portal_message' || a.type === 'team_message')
    .slice()
    .reverse(); // API returns desc; we want oldest-first for a chat layout

  useEffect(() => {
    if (!preserveReplyFocus) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, preserveReplyFocus]);

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  if (!messages.length) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground py-10 gap-3 m-4 border-2 border-dashed border-border rounded-2xl bg-muted/10">
        <MessageSquare className="w-8 h-8 opacity-20" />
        <p className="text-sm font-medium">No messages yet.</p>
        <p className="text-xs opacity-70">Portal messages from the homeowner and team replies appear here.</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-6 pb-4 flex flex-col gap-3">
      {messages.map(msg => {
        const isHomeowner = msg.type === 'portal_message';
        return (
          <div key={msg.id} className={`flex flex-col ${isHomeowner ? 'items-start' : 'items-end'}`}>
            <div className={`text-[10px] font-bold uppercase tracking-widest mb-1 px-1 ${isHomeowner ? 'text-amber-600 dark:text-amber-400' : 'text-sky-600 dark:text-sky-400'}`}>
              {isHomeowner ? 'Homeowner' : 'Team'}
              <span className="ml-2 font-mono text-muted-foreground normal-case tracking-normal font-normal">
                {format(new Date(msg.occurredAt), 'MMM d · h:mm a')}
              </span>
            </div>
            <div className={`max-w-[85%] md:max-w-[75%] rounded-2xl px-4 py-3 text-sm whitespace-pre-wrap leading-relaxed font-medium shadow-sm ${
              isHomeowner
                ? 'bg-amber-500/10 border border-amber-500/25 text-foreground rounded-tl-sm'
                : 'bg-sky-500/10 border border-sky-500/25 text-foreground rounded-tr-sm'
            }`}>
              {msg.body || msg.title}
            </div>
          </div>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}

function MessageComposer({ leadId }: { leadId: string }) {
  const [body, setBody] = useState('');
  const createActivity = useCreateLeadActivity();
  const queryClient = useQueryClient();
  const { data: me } = useGetMe();
  const { toast } = useToast();

  if (!canWrite(me?.role)) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = body.trim();
    if (!trimmed || createActivity.isPending) return;
    createActivity.mutate(
      {
        id: leadId,
        data: {
          type: 'team_message',
          title: 'Reply from the team',
          body: trimmed,
          metadata: { source: 'crm-messages-thread' },
        },
      },
      {
        onSuccess: () => {
          setBody('');
          queryClient.invalidateQueries({ queryKey: getListLeadActivitiesQueryKey(leadId) });
          queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
        },
        onError: (error: unknown) => {
          const serverMessage =
            error && typeof error === 'object' && 'data' in error
              ? (error as { data?: { error?: string } }).data?.error
              : undefined;
          toast({
            variant: 'destructive',
            title: 'Message not sent',
            description: serverMessage || 'Sending the message failed. Check your connection and try again.',
          });
        },
      },
    );
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e as unknown as React.FormEvent);
    }
  };

  return (
    <div className="p-4 md:p-5 border-t border-border bg-card shrink-0 sticky bottom-0 z-20 pb-safe md:pb-5 shadow-[0_-10px_40px_-15px_rgba(0,0,0,0.1)]">
      <form onSubmit={handleSubmit} className="flex gap-3 items-end max-w-3xl mx-auto">
        <div className="relative flex-1 group">
          <textarea
            placeholder="Reply to homeowner… (Enter to send, Shift+Enter for new line)"
            className="w-full bg-background border-2 border-border/80 group-focus-within:border-sky-500 rounded-xl px-4 py-3 pr-12 text-sm focus:outline-none min-h-[52px] max-h-[160px] resize-none shadow-sm transition-all font-medium placeholder:font-normal"
            value={body}
            onChange={e => setBody(e.target.value)}
            onKeyDown={handleKeyDown}
            maxLength={2000}
            data-testid="input-message-thread-reply"
          />
          <button
            type="submit"
            disabled={!body.trim() || createActivity.isPending}
            aria-label="Send message to homeowner"
            className="absolute right-2 bottom-2 p-2 bg-sky-500 text-white rounded-lg disabled:opacity-30 disabled:bg-muted disabled:text-muted-foreground transition-all active:scale-95 shadow-sm hover:bg-sky-600"
          >
            {createActivity.isPending
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : <MessageSquareText className="w-4 h-4" />}
          </button>
        </div>
      </form>
      {createActivity.isError && (
        <p className="mt-2 text-xs font-bold text-destructive text-center max-w-3xl mx-auto">
          Couldn't send — please try again.
        </p>
      )}
    </div>
  );
}

function EstimatesPanel({ leadId }: { leadId: string }) {
  const { data: estimates, isLoading } = useListEstimates({ leadId }, {
    query: { enabled: !!leadId, queryKey: getListEstimatesQueryKey({ leadId }) },
  });
  const { data: me } = useGetMe();
  const canEdit = canWrite(me?.role);

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h3 className="flex items-center gap-2 text-[10px] md:text-xs font-bold text-muted-foreground uppercase tracking-widest">
          <FileText className="w-3.5 h-3.5" /> Estimates
        </h3>
        {canEdit && (
          <Link
            href={`/estimates?leadId=${leadId}&edit=1`}
            className="flex items-center gap-1 bg-primary/10 text-primary px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-widest hover:bg-primary/20 transition-colors active:scale-95"
          >
            <Plus className="w-3 h-3" /> Create
          </Link>
        )}
      </div>
      {isLoading ? (
        <div className="bg-muted/10 border border-dashed border-border rounded-xl p-6 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
      ) : estimates && estimates.length > 0 ? (
        <div className="space-y-3">
          {estimates.map((est) => (
            <Link key={est.id} href={`/estimates?highlight=${est.id}`} className="block group">
               <div className="bg-card border border-border/80 rounded-xl p-3 md:p-4 shadow-sm group-hover:border-primary/50 group-hover:shadow-md transition-all active:scale-[0.98]">
                 <div className="flex items-start justify-between mb-2 gap-2">
                   <div className="font-bold text-sm text-foreground group-hover:text-primary transition-colors truncate">{est.title}</div>
                   <div className={`px-2 py-0.5 rounded border text-[9px] font-bold uppercase tracking-widest shrink-0 ${ESTIMATE_STATUS_STYLES[est.status]}`}>
                     {est.status}
                   </div>
                 </div>
                 <div className="flex justify-between items-end mt-3">
                    <div className="text-[10px] text-muted-foreground font-mono font-bold bg-muted/30 px-2 py-1 rounded border border-border/50">
                      {format(new Date(est.createdAt), 'MMM d, yyyy')}
                    </div>
                    <div className="font-mono font-bold text-foreground bg-muted/10 px-2 py-1 rounded border border-border/30 shadow-sm">
                      ${(est.totalCents / 100).toLocaleString()}
                    </div>
                 </div>
               </div>
            </Link>
          ))}
        </div>
      ) : (
        <div className="text-xs font-medium text-muted-foreground italic bg-muted/10 border border-dashed border-border rounded-xl p-4 text-center">No estimates yet.</div>
      )}
    </section>
  );
}

function ProjectPanel({ leadId }: { leadId: string }) {
  const { data: projects, isLoading } = useListProjects({ leadId }, {
    query: { enabled: !!leadId, queryKey: getListProjectsQueryKey({ leadId }) },
  });
  const { data: me } = useGetMe();
  const canEdit = canWrite(me?.role);

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h3 className="flex items-center gap-2 text-[10px] md:text-xs font-bold text-muted-foreground uppercase tracking-widest">
          <HardHat className="w-3.5 h-3.5" /> Projects
        </h3>
        {canEdit && (
          <Link
            href={`/projects?leadId=${leadId}&edit=1`}
            className="flex items-center gap-1 bg-secondary/10 text-secondary px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-widest hover:bg-secondary/20 transition-colors active:scale-95"
          >
            <Plus className="w-3 h-3" /> Create
          </Link>
        )}
      </div>
      {isLoading ? (
        <div className="bg-muted/10 border border-dashed border-border rounded-xl p-6 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
      ) : projects && projects.length > 0 ? (
        <div className="space-y-3">
          {projects.map((proj) => (
            <Link key={proj.id} href={`/projects?highlight=${proj.id}`} className="block group">
              <div className="bg-card border border-border/80 rounded-xl p-3 md:p-4 shadow-sm group-hover:border-secondary/50 group-hover:shadow-md transition-all active:scale-[0.98]">
                 <div className="flex items-start justify-between mb-2 gap-2">
                   <div className="font-bold text-sm text-foreground group-hover:text-secondary transition-colors truncate">{proj.name}</div>
                   <div className="px-2 py-0.5 rounded border border-border/50 bg-muted/50 text-muted-foreground text-[9px] font-bold uppercase tracking-widest shrink-0">
                     {proj.status.replace('_', ' ')}
                   </div>
                 </div>
                 {proj.scheduledStart && (
                   <div className="mt-3 text-[10px] text-muted-foreground font-mono font-bold bg-muted/20 px-2.5 py-1.5 rounded-lg border border-border/50 inline-flex items-center gap-1.5">
                     <Calendar className="w-3 h-3" />
                     {format(new Date(proj.scheduledStart), 'MMM d, yyyy')}
                   </div>
                 )}
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <div className="text-xs font-medium text-muted-foreground italic bg-muted/10 border border-dashed border-border rounded-xl p-4 text-center">No projects yet.</div>
      )}
    </section>
  );
}

function EnrollmentPanel({ leadId, canWrite: writable }: { leadId: string; canWrite: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data } = useGetLeadEnrollment(leadId, {
    query: { enabled: !!leadId, queryKey: getGetLeadEnrollmentQueryKey(leadId) },
  });
  const pauseEnrollment = usePauseEnrollment();
  const resumeEnrollment = useResumeEnrollment();
  const skipStep = useSkipEnrollmentStep();

  const enrollment = data?.enrollment;
  if (!enrollment) return null;

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: getGetLeadEnrollmentQueryKey(leadId) });
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await refresh();
    } catch {
      toast({ title: "Couldn't update the outreach sequence. Please try again.", variant: 'destructive' });
    }
  };

  const live = enrollment.status === 'active' || enrollment.status === 'paused';
  const statusStyle =
    enrollment.status === 'active'
      ? 'bg-green-500/10 text-green-700 border-green-500/20 dark:text-green-400'
      : enrollment.status === 'paused'
        ? 'bg-amber-500/10 text-amber-700 border-amber-500/20 dark:text-amber-400'
        : 'bg-muted text-muted-foreground border-border';
  const sentCount = enrollment.history?.filter((h) => h.kind === 'sent').length ?? 0;

  return (
    <section>
      <h3 className="flex items-center gap-2 text-[10px] md:text-xs font-bold text-muted-foreground uppercase tracking-widest mb-3">
        <Zap className="w-3.5 h-3.5" /> Closer Engine
      </h3>
      <div className="bg-card border border-border/50 rounded-xl p-3 md:p-4 text-sm shadow-sm space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="min-w-0">
            <div className="font-semibold text-foreground truncate">{enrollment.playbookName ?? 'Outreach playbook'}</div>
            <div className="text-xs text-muted-foreground">
              {sentCount} of {enrollment.totalSteps ?? '?'} touches sent
              {enrollment.status === 'active' && enrollment.nextRunAt
                ? ` • next ${format(new Date(enrollment.nextRunAt), 'MMM d • h:mm a')}`
                : ''}
              {enrollment.status !== 'active' && enrollment.pauseReason ? ` • ${enrollment.pauseReason}` : ''}
            </div>
          </div>
          <span className={`px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-widest border ${statusStyle}`}>
            {enrollment.status}
          </span>
        </div>
        {writable && live && (
          <div className="flex gap-2 flex-wrap">
            {enrollment.status === 'active' ? (
              <button
                type="button"
                onClick={() => act(() => pauseEnrollment.mutateAsync({ id: enrollment.id }))}
                className="text-xs font-bold px-3 py-1.5 rounded-lg border border-border hover:bg-muted transition-colors"
              >
                Pause outreach
              </button>
            ) : (
              <button
                type="button"
                onClick={() => act(() => resumeEnrollment.mutateAsync({ id: enrollment.id }))}
                className="text-xs font-bold px-3 py-1.5 rounded-lg border border-border hover:bg-muted transition-colors"
              >
                Resume outreach
              </button>
            )}
            <button
              type="button"
              onClick={() => act(() => skipStep.mutateAsync({ id: enrollment.id }))}
              className="text-xs font-bold px-3 py-1.5 rounded-lg border border-border hover:bg-muted transition-colors"
            >
              Skip next touch
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
