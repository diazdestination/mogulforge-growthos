import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearch } from 'wouter';
import ProjectFormModal from '@/components/project-form-modal';
import {
  useListEstimates,
  useCreateEstimate,
  useUpdateEstimate,
  useDeleteEstimate,
  getListEstimatesQueryKey,
  getListProjectsQueryKey,
  useGetMe,
  useListProjects,
  EstimateStatus,
  Estimate,
  EstimateLineItem,
  updateEstimate as updateEstimateRequest,
  deleteEstimate as deleteEstimateRequest,
  listEstimates,
  type MemberProfile,
} from '@workspace/api-client-react';
import { Loader2, Plus, Trash2, Edit, FileText, Send, CheckCircle, XCircle, HardHat, X } from 'lucide-react';
import { EstimateDelivery } from '@/components/estimate-delivery';
import { EstimateMarginPanel, PriceBookPicker } from '@/components/estimate-margin-panel';
import LeadSelect from '@/components/lead-select';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useToast, toast as globalToast } from '@/hooks/use-toast';
import { ToastAction } from '@/components/ui/toast';
import { canWrite, canDelete } from '@/lib/permissions';
import { format } from 'date-fns';
import { memberAuthorityScope } from '@/lib/member-authority-scope';
import { customerWorkLocation, customerWorkPath } from '@/lib/customer-work-links';
import { customerWorkspacePath } from '@/lib/customer-workspace-links';
import { useExactCustomerWork } from '@/hooks/use-exact-customer-work';
import { CustomerWorkForm, returningEstimate, type CustomerWorkActor } from '@/components/customer-work-form';
import { customerWorkCommandKey } from '@/hooks/use-customer-work-command';

const STATUS_STYLES: Record<EstimateStatus, string> = {
  draft: 'bg-muted text-muted-foreground border-border',
  sent: 'bg-blue-500/10 text-blue-600 border-blue-500/20 dark:text-blue-400 dark:border-blue-500/30',
  accepted: 'bg-green-500/10 text-green-700 border-green-500/20 dark:text-green-400 dark:border-green-500/30',
  declined: 'bg-destructive/10 text-destructive border-destructive/20 dark:border-destructive/30',
};

function formatMoney(cents: number) {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export default function Estimates() {
  const search = useSearch();
  const profile = useGetMe();
  if (profile.isError) return <p role="alert" className="p-5">Company access could not be verified. No estimate record is shown.</p>;
  if (profile.isLoading) return <p role="status" className="p-5">Checking estimate access…</p>;
  if (!profile.data?.isActive || !profile.data.organization) return <p role="alert" className="p-5">Active company access is required.</p>;
  const scopeKey = memberAuthorityScope(profile.data);
  return <EstimatesContent key={`${scopeKey}:${search}`} me={profile.data} scopeKey={scopeKey} />;
}
function EstimatesContent({ me, scopeKey }: { me: MemberProfile; scopeKey: string }) {
  const search = useSearch();
  const target = customerWorkLocation('estimates', search, me.organization!.id);
  const exact = useExactCustomerWork('estimates', target.kind === 'record' ? target.id : undefined, me.organization!.id, scopeKey);
  const actor = { id: me.id, organizationId: me.organization!.id, scopeKey };
  const prefillLeadId = new URLSearchParams(search).get('leadId') || undefined;
  const highlightId = target.kind === 'record' ? target.id : new URLSearchParams(search).get('highlight') || undefined;
  const wantsEdit = new URLSearchParams(search).get('edit') === '1';
  const highlightRef = useRef<HTMLDivElement | null>(null);
  const hasScrolledToHighlight = useRef(false);
  const hasAutoOpenedEdit = useRef(false);
  const [statusFilter, setStatusFilter] = useState<EstimateStatus | ''>('');
  const estimateParams = { status: statusFilter || undefined };
  const { data: estimates, isLoading, isError, dataUpdatedAt } = useListEstimates(estimateParams, { query: { queryKey: [...getListEstimatesQueryKey(estimateParams), scopeKey], enabled: !['invalid', 'different-company'].includes(target.kind) } });
  const { data: projects } = useListProjects(undefined, { query: { queryKey: [...getListProjectsQueryKey(), scopeKey], enabled: !['invalid', 'different-company'].includes(target.kind) } });
  const queryClient = useQueryClient();

  const canEdit = canWrite(me?.role);
  const canDel = canDelete(me?.role);

  const [isFormOpen, setIsFormOpen] = useState(!!prefillLeadId || target.kind === 'new');
  const [returningMode, setReturningMode] = useState(() => { try { return target.kind === 'new' || !!sessionStorage.getItem(customerWorkCommandKey(me.id, me.organization!.id, 'estimates:new')); } catch { return target.kind === 'new'; } });
  const [editingEstimate, setEditingEstimate] = useState<Estimate | null>(null);
  const [startProjectEstimate, setStartProjectEstimate] = useState<Estimate | null>(null);

  const updateEstimate = useUpdateEstimate();
  const deleteEstimate = useDeleteEstimate();
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; loadTokenRef.current++; }; }, []);

  // Extra pages loaded as the rep scrolls past the first server page (200 rows).
  const PAGE_SIZE = 200;
  const [extraEstimates, setExtraEstimates] = useState<Estimate[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reachedEnd, setReachedEnd] = useState(false);
  const paramsKey = JSON.stringify(estimateParams);
  const loadTokenRef = useRef(0);
  useEffect(() => {
    // Filter changed or the first page refetched: drop stale extra pages.
    loadTokenRef.current += 1;
    setExtraEstimates([]);
    setReachedEnd(false);
    setLoadingMore(false);
  }, [paramsKey, dataUpdatedAt]);

  const firstPage = estimates ?? [];
  const hasMore = !reachedEnd && firstPage.length >= PAGE_SIZE;
  const loadMore = useCallback(async () => {
    if (loadingMore || reachedEnd || firstPage.length < PAGE_SIZE) return;
    const token = loadTokenRef.current;
    setLoadingMore(true);
    try {
      const next = await listEstimates({
        ...estimateParams,
        offset: firstPage.length + extraEstimates.length,
      });
      if (token !== loadTokenRef.current) return; // filter changed mid-flight
      setExtraEstimates(prev => {
        const seen = new Set([...firstPage, ...prev].map(e => e.id));
        return [...prev, ...next.filter(e => !seen.has(e.id))];
      });
      if (next.length < PAGE_SIZE) setReachedEnd(true);
    } catch {
      // Leave state untouched; scrolling again retries.
    } finally {
      if (token === loadTokenRef.current) setLoadingMore(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadingMore, reachedEnd, firstPage, extraEstimates.length, paramsKey]);

  const allLoadedEstimates = useMemo(() => { const list = [...firstPage, ...extraEstimates]; return exact.data && 'title' in exact.data ? [exact.data as Estimate, ...list.filter(item => item.id !== exact.data!.id)] : list; }, [firstPage, extraEstimates, exact.data]);
  const allEstimates = allLoadedEstimates.filter(item => (!item.organizationId || item.organizationId === me.organization!.id) && (!(item.customerWorkId || item.leadId === null) || !!returningEstimate(item)));
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (!hasMore) return;
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 300) loadMore();
  };

  useEffect(() => {
    if (highlightId && !isLoading && highlightRef.current && !hasScrolledToHighlight.current) {
      hasScrolledToHighlight.current = true;
      highlightRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [highlightId, isLoading, estimates]);

  useEffect(() => {
    if (!wantsEdit || !highlightId || hasAutoOpenedEdit.current) return;
    if (isLoading || !me) return;
    if (!canWrite(me.role)) return;
    const target = allEstimates.find(e => e.id === highlightId);
    if (!target) return;
    hasAutoOpenedEdit.current = true;
    setEditingEstimate(target);
    setIsFormOpen(true);
  }, [wantsEdit, highlightId, isLoading, me, estimates]);

  // Lead labels are resolved server-side on the estimate itself, so they stay
  // correct in orgs with more leads than the capped lead-list download.
  const leadLabel = (estimate: Estimate) =>
    returningEstimate(estimate)?.customerLabel || estimate.leadLabel || estimate.leadId?.substring(0, 8) || 'Returning customer work';

  const projectForEstimate = (estimateId: string) =>
    projects?.find(p => p.estimateId === estimateId);

  const invalidate = () => { if (target.kind === 'record') void exact.refetch(); return queryClient.invalidateQueries({ queryKey: getListEstimatesQueryKey() }); };

  const setStatus = (estimate: Estimate, status: EstimateStatus) => {
    if (returningEstimate(estimate)) { setEditingEstimate(estimate); setIsFormOpen(true); return; }
    updateEstimate.mutate({ id: estimate.id, data: { status } }, {
      onSuccess: invalidate,
      onError: () => { if (alive.current) showEstimateStatusFailedToast(estimate.id, status, queryClient, () => alive.current); },
    });
  };

  const handleDelete = (id: string) => {
    if (!confirm('Delete this estimate?')) return;
    deleteEstimate.mutate({ id }, {
      onSuccess: invalidate,
      onError: () => { if (alive.current) showEstimateDeleteFailedToast(id, queryClient, () => alive.current); },
    });
  };

  if (target.kind === 'invalid' || target.kind === 'different-company') return <p role="alert" className="p-5">This estimate link is invalid or belongs to another company. No company was switched.</p>;
  return (
    <div className="flex flex-col h-full bg-background overflow-hidden">
      <header className="px-4 py-3 md:px-6 md:py-4 border-b border-border flex flex-col md:flex-row items-start md:items-center justify-between bg-card shrink-0 gap-4 sticky top-0 z-10">
        <div>
          <h1 className="text-xl md:text-2xl font-bold tracking-tight text-foreground">Estimates</h1>
          <p className="hidden md:block text-sm text-muted-foreground">Price jobs and track proposal status.</p>
        </div>
        <div className="flex items-center gap-3 w-full md:w-auto">
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value as EstimateStatus | '')}
            className="flex-1 md:w-48 bg-muted/50 border border-border rounded-xl px-4 py-2.5 md:py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary shadow-sm appearance-none bg-[url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20width%3D%2224%22%20height%3D%2224%22%20fill%3D%22none%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Cpath%20d%3D%22M7%2010L12%2015L17%2010%22%20stroke%3D%22%236B7280%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%2F%3E%3C%2Fsvg%3E')] bg-[position:right_0.5rem_center] bg-no-repeat pr-10"
          >
            <option value="">All Statuses</option>
            <option value="draft">Draft</option>
            <option value="sent">Sent</option>
            <option value="accepted">Accepted</option>
            <option value="declined">Declined</option>
          </select>
          {canEdit && (
            <button
              aria-label="New Estimate"
              onClick={() => { setEditingEstimate(null); setIsFormOpen(true); }}
              className="bg-primary text-primary-foreground hover:bg-primary/90 px-4 py-2.5 md:px-3 md:py-2 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 transition-transform active:scale-95 shrink-0 shadow-sm shadow-primary/20"
            >
              <Plus className="w-4 h-4" /> <span className="hidden md:inline">New Estimate</span>
            </button>
          )}
        </div>
      </header>

      <div className="flex-1 overflow-auto p-4 md:p-6 pb-20 md:pb-6" onScroll={handleScroll}>
        {target.kind === 'record' && <section aria-label="Selected estimate" className="mx-auto mb-4 max-w-5xl rounded-lg border p-3">{exact.isPending ? <p role="status">Opening exact estimate…</p> : exact.isError ? <p role="alert">The exact estimate is unavailable. The list below is separate and has not replaced it.</p> : <p>Selected estimate: {'title' in exact.data! ? exact.data.title : ''}</p>}</section>}
        {isError && <p role="alert">The estimate list could not load. No empty result is assumed.</p>}
        {allEstimates.length !== allLoadedEstimates.length && <p role="alert">Some estimate source contexts could not be verified. No actions are available for those records.</p>}
        {isLoading ? (
          <div className="flex items-center justify-center py-12 h-full">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        ) : (
          <div className="space-y-4 max-w-5xl mx-auto w-full">
            {allEstimates.map(estimate => (
              <div
                key={estimate.id}
                ref={estimate.id === highlightId ? highlightRef : undefined}
                className={`bg-card border rounded-2xl p-4 md:p-5 shadow-sm hover:shadow-md transition-all flex flex-col ${
                  estimate.id === highlightId ? 'border-primary ring-2 ring-primary/20 bg-primary/5' : 'border-border'
                }`}
              >
                <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
                  <div className="flex items-start gap-3 min-w-0">
                    <div className="w-10 h-10 md:w-12 md:h-12 rounded-xl bg-muted/50 border border-border flex items-center justify-center shrink-0">
                      <FileText className="w-5 h-5 md:w-6 md:h-6 text-muted-foreground" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 mb-1">
                        <h3 className="font-bold text-base md:text-lg text-foreground truncate">{estimate.title}</h3>
                        <span className={`text-[10px] font-bold uppercase tracking-widest px-2.5 py-0.5 rounded-md border ${STATUS_STYLES[estimate.status]}`}>
                          {estimate.status}
                        </span>
                      </div>
                      <div className="text-sm font-medium text-muted-foreground mt-0.5 flex flex-wrap gap-x-2 gap-y-1">
                        <span className="flex items-center gap-1.5"><div className="w-1 h-1 rounded-full bg-primary" /> {leadLabel(estimate)}</span>
                        <span className="opacity-40">•</span>
                        <span>{estimate.lineItems.length} line item{estimate.lineItems.length === 1 ? '' : 's'}</span>
                      </div>
                      {returningEstimate(estimate) && <p className="mt-2 text-sm">Existing customer work · {returningEstimate(estimate)!.propertyLabel || 'No property linked'} · Staff-recorded status, not signature or delivery. <Link className="inline-flex min-h-11 items-center underline" href={customerWorkspacePath(returningEstimate(estimate)!.contactId, me.organization!.id, 'estimates')!}>Customer history</Link></p>}
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[10px] md:text-[11px] font-mono text-muted-foreground uppercase tracking-wider mt-3 bg-muted/20 p-2 rounded-lg border border-border/50 inline-flex">
                        <span>Created {format(new Date(estimate.createdAt), 'MMM d, yy')}</span>
                        {estimate.sentAt && <><span className="opacity-30">|</span><span>Sent {format(new Date(estimate.sentAt), 'MMM d, yy')}</span></>}
                        {estimate.acceptedAt && <><span className="opacity-30">|</span><span className="text-green-600 dark:text-green-400 font-bold">Accepted {format(new Date(estimate.acceptedAt), 'MMM d, yy')}</span></>}
                      </div>
                    </div>
                  </div>
                  <div className="md:text-right shrink-0 bg-muted/30 md:bg-transparent p-3 md:p-0 rounded-xl md:rounded-none border border-border/50 md:border-none flex flex-row md:flex-col justify-between md:justify-start items-center md:items-end">
                    <div>
                      <div className="text-[10px] uppercase tracking-widest font-bold text-muted-foreground md:hidden mb-0.5">Total</div>
                      <div className="text-xl md:text-2xl font-bold text-foreground font-mono">{formatMoney(estimate.totalCents)}</div>
                    </div>
                    {estimate.taxCents > 0 && (
                      <div className="text-xs md:text-[11px] font-mono font-medium text-muted-foreground">
                        incl. tax {formatMoney(estimate.taxCents)}
                      </div>
                    )}
                  </div>
                </div>
                <EstimateDelivery estimate={estimate} organizationId={me.organization!.id} authorityScope={scopeKey} canSend={canEdit && ["office", "admin", "owner"].includes(me.role)} />
                <p className="mt-3 text-xs text-muted-foreground">External send records are staff-reported status, separate from provider evidence.</p>
                {(canEdit || canDel) && (
                  <div className="flex flex-wrap items-center gap-2 mt-4 pt-4 border-t border-border">
                    {canEdit && !returningEstimate(estimate) && estimate.status === 'draft' && (
                      <button onClick={() => setStatus(estimate, 'sent')} className="text-xs font-bold flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-blue-500/10 text-blue-700 hover:bg-blue-500/20 dark:text-blue-400 transition-colors flex-1 md:flex-none active:scale-95">
                        <Send className="w-3.5 h-3.5" /> Record external send
                      </button>
                    )}
                    {canEdit && !returningEstimate(estimate) && estimate.status === 'sent' && (
                      <>
                        <button onClick={() => setStatus(estimate, 'accepted')} className="text-xs font-bold flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-green-500/10 text-green-700 hover:bg-green-500/20 dark:text-green-400 transition-colors flex-1 md:flex-none active:scale-95">
                          <CheckCircle className="w-3.5 h-3.5" /> Accept
                        </button>
                        <button onClick={() => setStatus(estimate, 'declined')} className="text-xs font-bold flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors flex-1 md:flex-none active:scale-95">
                          <XCircle className="w-3.5 h-3.5" /> Decline
                        </button>
                      </>
                    )}
                    {canEdit && estimate.status === 'accepted' && (
                      projectForEstimate(estimate.id) ? (
                        <Link
                          href={customerWorkPath('projects', projectForEstimate(estimate.id)!.id, me.organization!.id) || `/projects?highlight=${projectForEstimate(estimate.id)!.id}`}
                          className="text-xs font-bold flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-secondary/15 text-secondary hover:bg-secondary/25 transition-colors flex-1 md:flex-none active:scale-95"
                        >
                          <HardHat className="w-3.5 h-3.5" /> View Project
                        </Link>
                      ) : (
                        <button onClick={() => setStartProjectEstimate(estimate)} className="text-xs font-bold flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors shadow-sm shadow-primary/20 flex-1 md:flex-none active:scale-95">
                          <HardHat className="w-3.5 h-3.5" /> Start Project
                        </button>
                      )
                    )}
                    <div className="hidden md:block flex-1" />
                    <div className="flex gap-2 w-full md:w-auto mt-2 md:mt-0 justify-end">
                      {canEdit && (
                        <button aria-label={`Edit ${estimate.title}`} onClick={() => { setEditingEstimate(estimate); setIsFormOpen(true); }} className="flex-1 md:flex-none w-auto md:w-10 h-10 flex items-center justify-center text-muted-foreground hover:text-primary transition-colors rounded-xl bg-muted/50 border border-border hover:bg-muted active:scale-95">
                          <Edit className="w-4 h-4" /> <span className="md:hidden ml-2 text-xs font-bold uppercase tracking-widest">Edit</span>
                        </button>
                      )}
                      {canDel && !returningEstimate(estimate) && (
                        <button onClick={() => handleDelete(estimate.id)} className="flex-1 md:flex-none w-auto md:w-10 h-10 flex items-center justify-center text-muted-foreground hover:text-destructive transition-colors rounded-xl bg-muted/50 border border-border hover:bg-destructive/10 active:scale-95">
                          <Trash2 className="w-4 h-4" /> <span className="md:hidden ml-2 text-xs font-bold uppercase tracking-widest">Delete</span>
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
            {loadingMore && (
              <div className="flex justify-center py-3">
                <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
              </div>
            )}
            {!allEstimates.length && (
              <div className="py-12 text-center text-muted-foreground border-2 border-dashed border-border rounded-2xl bg-muted/10">
                No estimates yet. Create one for an opportunity or an existing customer.
              </div>
            )}
          </div>
        )}
      </div>

      {isFormOpen && canEdit && (
        returningEstimate(editingEstimate) || (!editingEstimate && returningMode)
          ? <CustomerWorkForm key={`${scopeKey}:${search}:${editingEstimate?.id ?? 'new'}`} kind="estimates" actor={actor} record={returningEstimate(editingEstimate) ?? undefined} contactId={target.kind === 'new' ? target.contactId : ''} onOpportunity={() => setReturningMode(false)} onClose={() => setIsFormOpen(false)} onSaved={() => { void invalidate(); }} />
          : <EstimateFormModal actor={actor} onReturning={() => setReturningMode(true)} estimate={editingEstimate} initialLeadId={editingEstimate ? undefined : prefillLeadId} onClose={() => setIsFormOpen(false)} />
      )}

      {startProjectEstimate && (
        returningEstimate(startProjectEstimate) ? <CustomerWorkForm kind="projects" actor={actor} fromEstimate={returningEstimate(startProjectEstimate)!} onClose={() => setStartProjectEstimate(null)} /> : <ProjectFormModal
          project={null}
          defaults={{
            leadId: startProjectEstimate.leadId ?? undefined,
            leadLabel: leadLabel(startProjectEstimate),
            estimateId: startProjectEstimate.id,
            name: startProjectEstimate.title,
            offerLeadAdvance: true,
          }}
          onClose={() => setStartProjectEstimate(null)}
          authority={actor}
        />
      )}
    </div>
  );
}
/**
 * Error toasts with a Retry action for the page's one-shot mutations. Module
 * level (global toast store + plain fetch client) so retrying keeps working
 * across re-renders — same pattern as pipeline.tsx / project-form-modal.tsx.
 */
function showEstimateStatusFailedToast(estimateId: string, status: EstimateStatus, queryClient: QueryClient, current = () => true) {
  const { dismiss } = globalToast({
    variant: 'destructive',
    title: 'Estimate not updated',
    description: `Marking the estimate "${status}" failed. Retry below.`,
    action: (
      <ToastAction
        altText="Retry estimate status update"
        onClick={async () => {
          if (!current()) return;
          try {
            await updateEstimateRequest(estimateId, { status });
            queryClient.invalidateQueries({ queryKey: getListEstimatesQueryKey() });
            dismiss();
          } catch {
            if (current()) showEstimateStatusFailedToast(estimateId, status, queryClient, current);
          }
        }}
      >
        Retry
      </ToastAction>
    ),
  });
}
interface LineItemDraft {
  description: string;
  quantity: string;
  unitPrice: string;
  /** Draft-only link to the ESTI price book; never saved on the estimate. */
  priceBookItemId?: string | null;
}

function EstimateFormModal({ estimate, initialLeadId, onClose, onReturning, actor }: { estimate: Estimate | null; initialLeadId?: string; onClose: () => void; onReturning: () => void; actor: CustomerWorkActor }) {
  const alive = useRef(true); useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [title, setTitle] = useState(estimate?.title || '');
  const [leadId, setLeadId] = useState(estimate?.leadId || initialLeadId || '');
  const [notes, setNotes] = useState(estimate?.notes || '');
  const [tax, setTax] = useState(estimate ? (estimate.taxCents / 100).toString() : '0');
  const [items, setItems] = useState<LineItemDraft[]>(
    estimate?.lineItems.length
      ? estimate.lineItems.map(item => ({
          description: item.description,
          quantity: String(item.quantity),
          unitPrice: (item.unitPriceCents / 100).toString(),
        }))
      : [{ description: '', quantity: '1', unitPrice: '' }],
  );

  const createEstimate = useCreateEstimate();
  const updateEstimate = useUpdateEstimate();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const isSubmitting = createEstimate.isPending || updateEstimate.isPending;

  const parsedItems: EstimateLineItem[] = items
    .filter(item => item.description.trim())
    .map(item => {
      const quantity = parseFloat(item.quantity) || 0;
      const unitPriceCents = Math.round((parseFloat(item.unitPrice) || 0) * 100);
      return {
        description: item.description.trim(),
        quantity,
        unitPriceCents,
        totalCents: Math.round(quantity * unitPriceCents),
      };
    });

  const subtotalCents = parsedItems.reduce((sum, item) => sum + item.totalCents, 0);
  const taxCents = Math.round((parseFloat(tax) || 0) * 100);

  const setItem = (index: number, patch: Partial<LineItemDraft>) => {
    setItems(prev => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  };

  const marginRows = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.description.trim());
  const marginLines = marginRows.map(({ item }) => ({
    description: item.description.trim(),
    quantity: parseFloat(item.quantity) || 0,
    unitPriceCents: Math.round((parseFloat(item.unitPrice) || 0) * 100),
    priceBookItemId: item.priceBookItemId ?? null,
  }));
  const addFromPriceBook = (entry: { id: string; name: string; unitPriceCents: number }) => {
    const line: LineItemDraft = { description: entry.name, quantity: '1', unitPrice: (entry.unitPriceCents / 100).toString(), priceBookItemId: entry.id };
    setItems(prev => (prev.length === 1 && !prev[0]!.description.trim() && !prev[0]!.unitPrice ? [line] : [...prev, line]));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title || (!estimate && !leadId)) return;

    const shared = { title, lineItems: parsedItems, taxCents, notes: notes || undefined };

    const handleSaveError = (error: unknown) => {
      const serverMessage =
        error && typeof error === 'object' && 'data' in error
          ? (error as { data?: { error?: string } }).data?.error
          : undefined;
      toast({
        variant: 'destructive',
        title: estimate ? 'Estimate not saved' : 'Estimate not created',
        description: serverMessage || 'Saving the estimate failed. Check your connection and try again.',
      });
    };

    if (estimate) {
      updateEstimate.mutate({ id: estimate.id, data: shared }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListEstimatesQueryKey() });
          if (alive.current) onClose();
        },
        onError: handleSaveError,
      });
    } else {
      createEstimate.mutate({ data: { ...shared, leadId } }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListEstimatesQueryKey() });
          if (alive.current) onClose();
        },
        onError: handleSaveError,
      });
    }
  };

  return (
    <div className="fixed inset-0 bg-background/90 backdrop-blur-sm z-50 flex items-end md:items-center justify-center p-0 md:p-4 animate-in fade-in duration-200">
      <div className="bg-card border-t md:border border-border shadow-2xl md:rounded-2xl rounded-t-2xl w-full max-w-2xl overflow-hidden max-h-[90vh] md:max-h-[85vh] flex flex-col mt-auto md:my-auto animate-in slide-in-from-bottom-8 md:slide-in-from-bottom-0 md:zoom-in-95 duration-300">
        <div className="p-4 md:p-6 border-b border-border flex justify-between items-center bg-muted/20 shrink-0">
          <h2 className="text-lg font-bold text-foreground">{estimate ? 'Edit Estimate' : 'New Estimate'}</h2>
          <button onClick={onClose} aria-label="Close" className="w-8 h-8 flex items-center justify-center rounded-full bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground active:scale-95 transition-all">
            <X className="w-4 h-4" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-4 md:p-6 space-y-5 overflow-y-auto pb-safe md:pb-6">
          {!estimate && <div className="flex flex-wrap items-center gap-3 rounded border p-3"><p className="text-sm">Work source: Customer opportunity</p><button type="button" className="min-h-11 underline" disabled={isSubmitting} onClick={onReturning}>Use existing customer instead</button></div>}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-[10px] md:text-xs font-bold text-muted-foreground uppercase tracking-widest">Title *</label>
              <input required className="w-full bg-background border border-border rounded-xl px-4 py-3 md:py-2.5 text-base md:text-sm focus:ring-2 focus:ring-primary focus:outline-none shadow-sm transition-all" value={title} onChange={e => setTitle(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] md:text-xs font-bold text-muted-foreground uppercase tracking-widest">Lead *</label>
              {estimate ? (
                <div className="w-full bg-muted/40 border border-border rounded-xl px-4 py-3 md:py-2.5 text-base md:text-sm text-muted-foreground font-medium flex items-center h-[50px] md:h-[42px]">
                  {estimate.leadLabel || estimate.leadId?.substring(0, 8) || 'Returning customer work'}
                </div>
              ) : (
                <div className="shadow-sm rounded-xl overflow-hidden">
                   <LeadSelect required withStatus queryScope={actor.scopeKey} value={leadId} onChange={setLeadId} />
                </div>
              )}
            </div>
          </div>

          <div className="space-y-3 bg-muted/10 p-3 md:p-4 rounded-2xl border border-border">
            <div className="flex items-center justify-between">
              <label className="text-[10px] md:text-xs font-bold text-muted-foreground uppercase tracking-widest flex items-center gap-2">
                 <div className="w-1.5 h-1.5 rounded-full bg-primary" /> Line Items
              </label>
              <div className="flex items-center gap-2">
                <PriceBookPicker onPick={addFromPriceBook} disabled={isSubmitting} />
                <button type="button" onClick={() => setItems(prev => [...prev, { description: '', quantity: '1', unitPrice: '' }])} className="text-xs font-bold text-primary hover:text-primary/80 bg-primary/10 px-3 py-1.5 rounded-lg flex items-center gap-1 transition-colors active:scale-95">
                  <Plus className="w-3 h-3" /> Add Item
                </button>
              </div>
            </div>
            <div className="space-y-2">
              {items.map((item, index) => (
                <div key={index} className="flex flex-col md:flex-row gap-2 items-start md:items-center bg-card p-3 rounded-xl border border-border shadow-sm">
                  <input placeholder="Description" className="w-full md:flex-1 bg-background border border-border rounded-lg px-3 py-2.5 text-base md:text-sm focus:ring-2 focus:ring-primary focus:outline-none transition-all font-medium" value={item.description} onChange={e => setItem(index, { description: e.target.value })} />
                  <div className="flex gap-2 w-full md:w-auto mt-2 md:mt-0">
                     <div className="relative flex-1 md:w-20">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs font-bold text-muted-foreground opacity-50 uppercase">Qty</span>
                        <input type="number" min="0" step="any" className="w-full bg-background border border-border rounded-lg pl-9 pr-3 py-2.5 text-base md:text-sm font-mono font-bold focus:ring-2 focus:ring-primary focus:outline-none transition-all" value={item.quantity} onChange={e => setItem(index, { quantity: e.target.value })} />
                     </div>
                     <div className="relative flex-1 md:w-28">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs font-bold text-muted-foreground opacity-50">$</span>
                        <input type="number" min="0" step="0.01" className="w-full bg-background border border-border rounded-lg pl-7 pr-3 py-2.5 text-base md:text-sm font-mono font-bold focus:ring-2 focus:ring-primary focus:outline-none transition-all" value={item.unitPrice} onChange={e => setItem(index, { unitPrice: e.target.value })} />
                     </div>
                     <button type="button" onClick={() => setItems(prev => prev.filter((_, i) => i !== index))} aria-label={`Remove line item ${index + 1}`} className="w-11 md:w-10 flex items-center justify-center shrink-0 bg-muted/50 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-lg transition-colors active:scale-95 border border-border" disabled={items.length === 1}>
                       <Trash2 className="w-4 h-4" />
                     </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <EstimateMarginPanel
            lines={marginLines}
            onUsePrice={(lineIndex, cents) => {
              const row = marginRows[lineIndex];
              if (row) setItem(row.index, { unitPrice: (cents / 100).toString() });
            }}
          />

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-muted/10 p-4 rounded-2xl border border-border">
            <div className="space-y-1.5">
              <label className="text-[10px] md:text-xs font-bold text-muted-foreground uppercase tracking-widest">Tax ($)</label>
              <input type="number" min="0" step="0.01" className="w-full bg-background border border-border rounded-xl px-4 py-3 md:py-2.5 text-base md:text-sm font-mono font-bold focus:ring-2 focus:ring-primary focus:outline-none shadow-sm transition-all" value={tax} onChange={e => setTax(e.target.value)} />
            </div>
            <div className="flex flex-col justify-end gap-1 pb-1 md:pb-0 pt-2 md:pt-0 border-t border-border/50 md:border-none mt-2 md:mt-0">
              <div className="flex justify-between items-center md:block">
                 <div className="md:hidden text-xs font-bold uppercase tracking-widest text-muted-foreground">Subtotal</div>
                 <div className="text-sm font-medium text-muted-foreground md:text-right">
                   <span className="hidden md:inline">Subtotal:</span> <span className="font-mono bg-background px-2 py-0.5 rounded border border-border ml-2 shadow-sm">{formatMoney(subtotalCents)}</span>
                 </div>
              </div>
              <div className="flex justify-between items-end md:block mt-1">
                 <div className="md:hidden text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-1">Total</div>
                 <div className="text-xl font-bold text-foreground md:text-right">
                   <span className="hidden md:inline text-sm mr-2 text-muted-foreground uppercase tracking-widest font-bold">Total</span>
                   <span className="font-mono bg-card px-3 py-1 rounded-lg border border-border shadow-sm">{formatMoney(subtotalCents + taxCents)}</span>
                 </div>
              </div>
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-[10px] md:text-xs font-bold text-muted-foreground uppercase tracking-widest">Notes</label>
            <textarea className="w-full bg-background border border-border rounded-xl px-4 py-3 md:py-2.5 text-base md:text-sm focus:ring-2 focus:ring-primary focus:outline-none min-h-[80px] resize-none shadow-sm transition-all font-medium" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Terms, timeline, or special instructions..." />
          </div>

          <div className="pt-2 flex flex-col-reverse md:flex-row justify-end gap-3 pb-2 md:pb-0">
            <button type="button" onClick={onClose} className="w-full md:w-auto px-4 py-3 md:py-2 text-base md:text-sm font-semibold hover:bg-muted rounded-xl border border-transparent hover:border-border transition-all active:scale-95">Cancel</button>
            <button type="submit" disabled={isSubmitting} className="w-full md:w-auto bg-primary text-primary-foreground px-6 py-3 md:py-2 rounded-xl text-base md:text-sm font-bold shadow-sm shadow-primary/20 hover:shadow-primary/40 hover:bg-primary/90 transition-all active:scale-95 disabled:opacity-50 flex items-center justify-center min-w-[140px]">
              {isSubmitting ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Save Estimate'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function showEstimateDeleteFailedToast(estimateId: string, queryClient: QueryClient, current = () => true) {
  const { dismiss } = globalToast({
    variant: 'destructive',
    title: 'Estimate not deleted',
    description: 'Deleting the estimate failed. Retry below.',
    action: (
      <ToastAction
        altText="Retry estimate delete"
        onClick={async () => {
          if (!current()) return;
          try {
            await deleteEstimateRequest(estimateId);
            queryClient.invalidateQueries({ queryKey: getListEstimatesQueryKey() });
            dismiss();
          } catch {
            if (current()) showEstimateDeleteFailedToast(estimateId, queryClient, current);
          }
        }}
      >
        Retry
      </ToastAction>
    ),
  });
}
