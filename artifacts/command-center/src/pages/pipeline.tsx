import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  listLeads,
  useListLeads,
  type Lead,
  type ListLeadsParams,
  useUpdateLead,
  LeadStatus,
  getListLeadsQueryKey,
  useGetMe,
  useListUsers,
  useListTags,
  useBulkUpdateLeads,
  useListDuplicateLeads,
  useListSavedFilters,
  useCreateSavedFilter,
  useDeleteSavedFilter,
  getListSavedFiltersQueryKey,
  updateLead as updateLeadRequest,
  bulkUpdateLeads as bulkUpdateLeadsRequest,
  createSavedFilter as createSavedFilterRequest,
  type BulkLeadActionRequest,
  type BulkLeadActionRequestAction,
} from '@workspace/api-client-react';
import { Loader2, LayoutGrid, List as ListIcon, Search, Download, Bookmark, BookmarkPlus, Trash2, Copy, X, Filter, MessageSquare, Globe, Camera, History } from 'lucide-react';
import { Link, useSearch } from 'wouter';
import { format } from 'date-fns';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { canWrite } from '@/lib/permissions';
import { useToast, toast as globalToast } from '@/hooks/use-toast';
import { ToastAction } from '@/components/ui/toast';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { DuplicateMergeDialog } from '@/components/duplicate-merge-dialog';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { LeadContactActions } from '@/components/lead-contact-actions';
import { TodayActionsPanel } from '@/components/today-actions';

const PIPELINE_STAGES = [
  LeadStatus.new,
  LeadStatus.ai_qualified,
  LeadStatus.contact_attempted,
  LeadStatus.inspection_scheduled,
  LeadStatus.inspection_completed,
  LeadStatus.estimate_preparing,
  LeadStatus.estimate_sent,
  LeadStatus.claim_pending,
  LeadStatus.follow_up,
  LeadStatus.won,
  LeadStatus.production_scheduled,
  LeadStatus.in_progress,
  LeadStatus.final_walkthrough,
  LeadStatus.completed,
  LeadStatus.review_requested,
  LeadStatus.nurture,
  LeadStatus.lost,
];

interface PendingBulk {
  action: BulkLeadActionRequestAction;
  description: string;
}

export default function Pipeline() {
  const rawSearch = useSearch();

  const [view, setView] = useState<'board' | 'table'>('board');
  const [statusFilter, setStatusFilter] = useState<LeadStatus | undefined>(() => {
    const p = new URLSearchParams(rawSearch);
    return (p.get('status') || undefined) as LeadStatus | undefined;
  });
  const [search, setSearch] = useState(() => {
    const p = new URLSearchParams(rawSearch);
    return p.get('search') ?? '';
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pendingBulk, setPendingBulk] = useState<PendingBulk | null>(null);
  const [filterName, setFilterName] = useState('');
  const [savePopoverOpen, setSavePopoverOpen] = useState(false);
  const [dupLeadId, setDupLeadId] = useState<string | null>(null);
  const [needsReplyFilter, setNeedsReplyFilter] = useState(() => {
    const p = new URLSearchParams(rawSearch);
    return p.get('needsReply') === '1';
  });
  const [nationwideOnly, setNationwideOnly] = useState(() => {
    const p = new URLSearchParams(rawSearch);
    return p.get('nationwide') === '1';
  });
  // Completed or lost jobs imported from Housecall Pro stay off the board unless asked for.
  const [showImportedHistory, setShowImportedHistory] = useState(() => {
    const p = new URLSearchParams(rawSearch);
    return p.get('imported') === '1';
  });
  // '' = all owners, 'me' = current user, otherwise a specific user id.
  const [ownerFilter, setOwnerFilter] = useState<string>(() => {
    const p = new URLSearchParams(rawSearch);
    return p.get('owner') ?? '';
  });

  // Sync filter state → URL (replace so filters don't pollute history).
  // Use replaceState directly so wouter's useSearch() subscription is NOT
  // triggered — that prevents the feedback loop with the URL→state effect
  // below and avoids resetting the debounce timer on every keystroke.
  useEffect(() => {
    const p = new URLSearchParams();
    if (statusFilter) p.set('status', statusFilter);
    if (search) p.set('search', search);
    if (needsReplyFilter) p.set('needsReply', '1');
    if (nationwideOnly) p.set('nationwide', '1');
    if (showImportedHistory) p.set('imported', '1');
    if (ownerFilter) p.set('owner', ownerFilter);
    const qs = p.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, search, needsReplyFilter, nationwideOnly, showImportedHistory, ownerFilter]);

  // Sync URL → state for back/forward navigation
  useEffect(() => {
    const p = new URLSearchParams(rawSearch);
    const urlStatus = (p.get('status') || undefined) as LeadStatus | undefined;
    const urlSearch = p.get('search') ?? '';
    const urlNeedsReply = p.get('needsReply') === '1';
    const urlNationwide = p.get('nationwide') === '1';
    setStatusFilter(urlStatus);
    setSearch(urlSearch);
    setNeedsReplyFilter(urlNeedsReply);
    setNationwideOnly(urlNationwide);
    setShowImportedHistory(p.get('imported') === '1');
    setOwnerFilter(p.get('owner') ?? '');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawSearch]);

  const debouncedSearch = useDebouncedValue(search.trim(), 300);
  const { data: me } = useGetMe();
  const ownerUserId = ownerFilter === 'me' ? me?.id : ownerFilter || undefined;
  const leadParams: ListLeadsParams = {
    ...(statusFilter ? { status: statusFilter } : {}),
    ...(nationwideOnly ? { source: 'nationwide-inquiry' } : {}),
    ...(debouncedSearch ? { search: debouncedSearch } : {}),
    ...(needsReplyFilter ? { hasUnreadPortalMessage: true } : {}),
    ...(ownerUserId ? { assignedUserId: ownerUserId } : {}),
    ...(showImportedHistory ? { importedHistory: 'include' as const } : {}),
  };
  const { data: leads, isLoading, dataUpdatedAt } = useListLeads(leadParams);

  const PAGE_SIZE = 200;
  const [extraLeads, setExtraLeads] = useState<Lead[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reachedEnd, setReachedEnd] = useState(false);
  const paramsKey = JSON.stringify(leadParams);
  const loadTokenRef = useRef(0);
  useEffect(() => {
    loadTokenRef.current += 1;
    setExtraLeads([]);
    setReachedEnd(false);
    setLoadingMore(false);
  }, [paramsKey, dataUpdatedAt]);

  const firstPage = leads ?? [];
  const hasMore = !reachedEnd && firstPage.length >= PAGE_SIZE;
  const loadMore = useCallback(async () => {
    if (loadingMore || reachedEnd || firstPage.length < PAGE_SIZE) return;
    const token = loadTokenRef.current;
    setLoadingMore(true);
    try {
      const next = await listLeads({
        ...leadParams,
        offset: firstPage.length + extraLeads.length,
      });
      if (token !== loadTokenRef.current) return;
      setExtraLeads(prev => {
        const seen = new Set([...firstPage, ...prev].map(l => l.id));
        return [...prev, ...next.filter(l => !seen.has(l.id))];
      });
      if (next.length < PAGE_SIZE) setReachedEnd(true);
    } catch {
      // Leave state untouched; scrolling again retries.
    } finally {
      if (token === loadTokenRef.current) setLoadingMore(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadingMore, reachedEnd, firstPage, extraLeads.length, paramsKey]);

  const allLeads = useMemo(() => [...firstPage, ...extraLeads], [firstPage, extraLeads]);
  const { data: users } = useListUsers();
  const { data: tags } = useListTags();
  const { data: duplicateGroups } = useListDuplicateLeads();
  const { data: savedFilters } = useListSavedFilters();
  const updateLead = useUpdateLead();
  const bulkUpdate = useBulkUpdateLeads();
  const createSavedFilter = useCreateSavedFilter();
  const deleteSavedFilter = useDeleteSavedFilter();
  const queryClient = useQueryClient();
  const canEdit = canWrite(me?.role);
  const { toast } = useToast();

  const duplicateLeadIds = useMemo(() => {
    const ids = new Set<string>();
    (duplicateGroups || []).forEach(g => g.leadIds.forEach(id => ids.add(id)));
    return ids;
  }, [duplicateGroups]);

  const dupDialogData = useMemo(() => {
    if (!dupLeadId) return null;
    const groups = (duplicateGroups || []).filter(g => g.leadIds.includes(dupLeadId));
    if (!groups.length) return null;
    const ids = [...new Set(groups.flatMap(g => g.leadIds))];
    return {
      leadIds: ids,
      matches: groups.map(g => ({ field: g.field, value: g.value })),
    };
  }, [dupLeadId, duplicateGroups]);

  const openDuplicates = (id: string) => {
    if (!canEdit) return;
    setDupLeadId(id);
  };

  const filteredLeads = needsReplyFilter ? allLeads.filter(l => l.hasUnreadPortalMessage) : allLeads;

  const handleStatusChange = (id: string, newStatus: LeadStatus) => {
    if (!canEdit) return;
    updateLead.mutate({ id, data: { status: newStatus } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListLeadsQueryKey() });
      },
      onError: () => {
        queryClient.invalidateQueries({ queryKey: getListLeadsQueryKey() });
        showStatusChangeFailedToast(id, newStatus, queryClient);
      },
    });
  };

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelected(prev =>
      prev.size === filteredLeads.length
        ? new Set()
        : new Set(filteredLeads.map(l => l.id)),
    );
  };

  const confirmBulk = () => {
    if (!pendingBulk) return;
    const request: BulkLeadActionRequest = { leadIds: [...selected], action: pendingBulk.action };
    bulkUpdate.mutate(
      { data: request },
      {
        onSuccess: (result) => {
          toast({ title: 'Bulk action applied', description: `${result.updated} lead${result.updated === 1 ? '' : 's'} updated${result.skipped ? `, ${result.skipped} skipped` : ''}.` });
          setSelected(new Set());
          queryClient.invalidateQueries({ queryKey: getListLeadsQueryKey() });
        },
        onError: () => {
          showBulkActionFailedToast(request, queryClient);
        },
      },
    );
    setPendingBulk(null);
  };

  const exportCsv = () => {
    const userName = (id?: string | null) => {
      const u = (users || []).find(u => u.id === id);
      return u ? `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || u.email || u.id : '';
    };
    const esc = (v: unknown) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ['id', 'summary', 'status', 'urgency', 'score', 'estimatedValue', 'source', 'assignedTo', 'createdAt'];
    const rows = filteredLeads.map(l => [
      l.id,
      l.summary ?? '',
      l.status,
      l.urgency,
      l.score,
      l.estimatedValueCents != null ? (l.estimatedValueCents / 100).toFixed(2) : '',
      l.source ?? '',
      userName(l.assignedUserId),
      new Date(l.createdAt).toISOString(),
    ]);
    const csv = [header, ...rows].map(r => r.map(esc).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `leads-${format(new Date(), 'yyyy-MM-dd')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: 'CSV exported', description: `${filteredLeads.length} leads exported.` });
  };

  const saveCurrentFilter = () => {
    const name = filterName.trim();
    if (!name) return;
    createSavedFilter.mutate(
      { data: { name, filters: { status: statusFilter ?? null, search: search || null, needsReply: needsReplyFilter || null, nationwideOnly: nationwideOnly || null, owner: ownerFilter || null } } },
      {
        onSuccess: () => {
          toast({ title: 'Filter saved', description: `"${name}" will be here next time you sign in.` });
          setFilterName('');
          setSavePopoverOpen(false);
          queryClient.invalidateQueries({ queryKey: getListSavedFiltersQueryKey() });
        },
        onError: () => showSaveFilterFailedToast({ name, filters: { status: statusFilter ?? null, search: search || null, needsReply: needsReplyFilter || null, nationwideOnly: nationwideOnly || null, owner: ownerFilter || null } }, queryClient),
      },
    );
  };

  const applySavedFilter = (filters: Record<string, unknown>) => {
    setStatusFilter((filters.status as LeadStatus) || undefined);
    setSearch(typeof filters.search === 'string' ? filters.search : '');
    setNeedsReplyFilter(filters.needsReply === true);
    setNationwideOnly(filters.nationwideOnly === true);
    setOwnerFilter(typeof filters.owner === 'string' ? filters.owner : '');
  };

  const removeSavedFilter = (id: string, name: string) => {
    deleteSavedFilter.mutate({ id }, {
      onSuccess: () => {
        toast({ title: 'Filter deleted', description: `"${name}" removed.` });
        queryClient.invalidateQueries({ queryKey: getListSavedFiltersQueryKey() });
      },
    });
  };

  return (
    <div className="flex flex-col h-full bg-background overflow-hidden">
      <header className="px-4 py-3 md:px-6 md:py-4 border-b border-border flex items-center justify-between bg-card shrink-0 gap-3 flex-wrap sticky top-0 z-10">
        <div>
          <h1 className="text-xl md:text-2xl font-bold tracking-tight text-foreground">Pipeline</h1>
          <p className="hidden md:block text-sm text-muted-foreground">Manage and track leads through the lifecycle.</p>
        </div>
        
        <div className="flex items-center gap-2 flex-wrap ml-auto">
          {/* Mobile Filters Trigger */}
          <Sheet>
            <SheetTrigger asChild>
              <button className="md:hidden flex items-center gap-1.5 text-sm px-3 py-2 bg-muted/50 border border-border rounded-lg hover:bg-muted transition-colors active:scale-95">
                <Filter className="w-4 h-4" />
                Filter
              </button>
            </SheetTrigger>
            <SheetContent side="bottom" className="h-[80vh] rounded-t-2xl sm:max-w-md">
              <SheetHeader className="text-left mb-6">
                <SheetTitle>Filter Pipeline</SheetTitle>
              </SheetHeader>
              <div className="flex flex-col gap-5">
                <div className="space-y-2">
                  <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Search</label>
                  <div className="relative">
                    <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                    <input
                      type="search"
                      value={search}
                      onChange={e => setSearch(e.target.value)}
                      placeholder="Search leads..."
                      className="w-full pl-9 pr-4 py-3 text-base bg-background border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary shadow-sm"
                    />
                  </div>
                </div>
                
                <div className="space-y-2">
                  <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Stage</label>
                  <select
                    value={statusFilter ?? ''}
                    onChange={e => setStatusFilter((e.target.value || undefined) as LeadStatus | undefined)}
                    className="w-full bg-background border border-border rounded-xl py-3 px-3 text-base focus:outline-none focus:ring-2 focus:ring-primary shadow-sm capitalize"
                  >
                    <option value="">All stages</option>
                    {PIPELINE_STAGES.map(s => (
                      <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
                    ))}
                  </select>
                </div>

                <div className="space-y-2">
                  <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Quick filters</label>
                  <button
                    data-testid="needs-reply-filter-mobile"
                    onClick={() => setNeedsReplyFilter(v => !v)}
                    aria-pressed={needsReplyFilter}
                    className={`w-full flex items-center gap-2 px-4 py-3 rounded-xl border text-sm font-medium transition-colors ${
                      needsReplyFilter
                        ? 'bg-amber-500/15 border-amber-400/60 text-amber-700 dark:text-amber-400'
                        : 'bg-background border-border hover:bg-muted'
                    }`}
                  >
                    <MessageSquare className="w-4 h-4" />
                    Needs reply
                    {needsReplyFilter && <span className="ml-auto text-xs font-bold">ON</span>}
                  </button>
                  <button
                    type="button"
                    onClick={() => setNationwideOnly(v => !v)}
                    aria-pressed={nationwideOnly}
                    className={`w-full flex items-center gap-2 px-4 py-3 rounded-xl border text-sm font-medium transition-colors ${nationwideOnly ? 'bg-indigo-500/15 border-indigo-400/40 text-indigo-700 dark:text-indigo-400' : 'bg-background border-border hover:bg-muted'}`}
                  >
                    <Globe className="w-4 h-4" />
                    Nationwide Inquiry only
                    {nationwideOnly && <span className="ml-auto text-xs font-bold">ON</span>}
                  </button>
                  <button
                    type="button"
                    data-testid="imported-history-filter-mobile"
                    onClick={() => setShowImportedHistory(v => !v)}
                    aria-pressed={showImportedHistory}
                    className={`w-full flex items-center gap-2 px-4 py-3 rounded-xl border text-sm font-medium transition-colors ${showImportedHistory ? 'bg-slate-500/15 border-slate-400/40 text-foreground' : 'bg-background border-border hover:bg-muted'}`}
                  >
                    <History className="w-4 h-4" />
                    Show imported history
                    {showImportedHistory && <span className="ml-auto text-xs font-bold">ON</span>}
                  </button>
                </div>

                <div className="space-y-2 pt-4 border-t border-border">
                  <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-1 block">Saved Filters</label>
                  {(savedFilters || []).length === 0 && (
                    <div className="px-2 py-3 text-sm text-muted-foreground bg-muted/30 rounded-lg text-center border border-dashed border-border">No saved filters yet.</div>
                  )}
                  <div className="space-y-2">
                    {(savedFilters || []).map(f => (
                      <div key={f.id} className="flex items-center justify-between gap-2 p-3 bg-card border border-border rounded-xl shadow-sm">
                        <button onClick={() => applySavedFilter(f.filters as Record<string, unknown>)} className="flex-1 text-left font-medium text-sm truncate">{f.name}</button>
                        <button
                          onClick={() => removeSavedFilter(f.id, f.name)}
                          className="w-8 h-8 flex items-center justify-center rounded-full bg-muted/50 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </SheetContent>
          </Sheet>

          {/* Desktop Filters */}
          <div className="hidden md:flex items-center gap-2">
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search leads..."
                className="pl-9 pr-4 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary w-56 shadow-sm"
              />
            </div>

            <select
              value={statusFilter ?? ''}
              onChange={e => setStatusFilter((e.target.value || undefined) as LeadStatus | undefined)}
              className="text-sm bg-background border border-border rounded-lg py-2 px-3 focus:outline-none focus:ring-2 focus:ring-primary max-w-[160px] shadow-sm capitalize"
            >
              <option value="">All stages</option>
              {PIPELINE_STAGES.map(s => (
                <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
              ))}
            </select>

            <select
              data-testid="owner-filter"
              value={ownerFilter}
              onChange={e => setOwnerFilter(e.target.value)}
              aria-label="Filter by owner"
              className="text-sm bg-background border border-border rounded-lg py-2 px-3 focus:outline-none focus:ring-2 focus:ring-primary max-w-[160px] shadow-sm"
            >
              <option value="">All owners</option>
              <option value="me">Mine</option>
              {(users || []).filter(u => u.id !== me?.id).map(u => (
                <option key={u.id} value={u.id}>{`${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || u.email}</option>
              ))}
            </select>

            <button
              data-testid="needs-reply-filter"
              onClick={() => setNeedsReplyFilter(v => !v)}
              aria-pressed={needsReplyFilter}
              title={needsReplyFilter ? 'Showing only leads needing a reply — click to clear' : 'Show only leads waiting for a reply'}
              className={`flex items-center gap-1.5 text-sm px-3 py-2 border rounded-lg transition-colors shadow-sm ${
                needsReplyFilter
                  ? 'bg-amber-500/15 border-amber-400/60 text-amber-700 dark:text-amber-400 font-semibold'
                  : 'bg-card border-border hover:bg-muted'
              }`}
            >
              <MessageSquare className="w-4 h-4" />
              Needs reply
            </button>

            <button
              type="button"
              data-testid="nationwide-filter"
              onClick={() => setNationwideOnly(v => !v)}
              aria-pressed={nationwideOnly}
              title={nationwideOnly ? 'Showing Nationwide Inquiry leads only — click to clear' : 'Filter: Nationwide Inquiry leads only'}
              className={`flex items-center gap-1.5 text-sm px-3 py-2 border rounded-lg transition-colors shadow-sm font-semibold ${nationwideOnly ? 'bg-indigo-500/15 border-indigo-400/40 text-indigo-700 dark:text-indigo-400 hover:bg-indigo-500/25' : 'bg-card border-border text-muted-foreground hover:bg-muted hover:text-foreground'}`}
            >
              <Globe className="w-4 h-4" />
              Nationwide
              {nationwideOnly && <X className="w-3.5 h-3.5 ml-0.5" aria-hidden />}
            </button>

            <button
              type="button"
              data-testid="imported-history-filter"
              onClick={() => setShowImportedHistory(v => !v)}
              aria-pressed={showImportedHistory}
              title={showImportedHistory ? 'Showing completed and lost jobs imported from Housecall Pro — click to hide them' : 'Show completed and lost jobs imported from Housecall Pro'}
              className={`flex items-center gap-1.5 text-sm px-3 py-2 border rounded-lg transition-colors shadow-sm ${showImportedHistory ? 'bg-slate-500/15 border-slate-400/40 text-foreground font-semibold hover:bg-slate-500/25' : 'bg-card border-border text-muted-foreground hover:bg-muted hover:text-foreground'}`}
            >
              <History className="w-4 h-4" />
              Show imported history
              {showImportedHistory && <X className="w-3.5 h-3.5 ml-0.5" aria-hidden />}
            </button>

            {/* Saved filters */}
            <DropdownMenu>
              <DropdownMenuTrigger className="flex items-center gap-1.5 text-sm px-3 py-2 bg-card border border-border rounded-lg hover:bg-muted transition-colors shadow-sm">
                <Bookmark className="w-4 h-4" />
                Saved
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64 rounded-xl">
                <DropdownMenuLabel>Saved filters</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {(savedFilters || []).length === 0 && (
                  <div className="px-2 py-3 text-xs text-muted-foreground">No saved filters yet.</div>
                )}
                {(savedFilters || []).map(f => (
                  <DropdownMenuItem key={f.id} className="flex items-center justify-between gap-2 rounded-lg cursor-pointer" onSelect={() => applySavedFilter(f.filters as Record<string, unknown>)}>
                    <span className="truncate">{f.name}</span>
                    <button
                      data-testid="delete-saved-filter"
                      onClick={e => { e.stopPropagation(); removeSavedFilter(f.id, f.name); }}
                      className="text-muted-foreground hover:text-destructive shrink-0 p-1"
                      aria-label={`Delete ${f.name}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <Popover open={savePopoverOpen} onOpenChange={setSavePopoverOpen}>
              <PopoverTrigger data-testid="save-filter" className="flex items-center gap-1.5 text-sm px-3 py-2 bg-card border border-border rounded-lg hover:bg-muted transition-colors shadow-sm" title="Save current filters">
                <BookmarkPlus className="w-4 h-4" />
              </PopoverTrigger>
              <PopoverContent align="end" className="w-64 space-y-3 rounded-xl">
                <p className="text-sm font-bold">Save current filters</p>
                <input
                  value={filterName}
                  onChange={e => setFilterName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && saveCurrentFilter()}
                  placeholder="Filter name"
                  className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary shadow-sm"
                />
                <button
                  onClick={saveCurrentFilter}
                  disabled={!filterName.trim() || createSavedFilter.isPending}
                  className="w-full py-2 text-sm font-semibold bg-primary text-primary-foreground rounded-lg disabled:opacity-50 transition-transform active:scale-95"
                >
                  Save Filter
                </button>
              </PopoverContent>
            </Popover>

            <button
              onClick={exportCsv}
              disabled={filteredLeads.length === 0}
              className="flex items-center gap-1.5 text-sm px-3 py-2 bg-card border border-border rounded-lg hover:bg-muted transition-colors disabled:opacity-50 shadow-sm"
              title="Export current view as CSV"
            >
              <Download className="w-4 h-4" />
              CSV
            </button>
          </div>

          <div className="flex items-center bg-muted/50 border border-border rounded-lg p-1 shadow-sm">
            <button
              onClick={() => setView('board')}
              aria-label="Board view"
              className={`p-1.5 rounded-md transition-all ${view === 'board' ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            >
              <LayoutGrid className="w-4 h-4" />
            </button>
            <button
              data-testid="view-table-button"
              aria-label="Table view"
              onClick={() => { setView('table'); }}
              className={`p-1.5 rounded-md transition-all ${view === 'table' ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            >
              <ListIcon className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      <TodayActionsPanel />

      {/* Bulk action bar */}
      {canEdit && view === 'table' && selected.size > 0 && (
        <div className="px-4 py-3 bg-primary/10 border-b border-primary/20 flex items-center gap-3 shrink-0 flex-wrap z-10 shadow-sm">
          <span className="text-sm font-bold text-primary">{selected.size} selected</span>
          <select
            data-testid="bulk-stage-select"
            value=""
            onChange={e => e.target.value && setPendingBulk({
              action: { status: e.target.value as LeadStatus },
              description: `Move ${selected.size} lead${selected.size === 1 ? '' : 's'} to "${e.target.value.replace(/_/g, ' ')}".`,
            })}
            className="text-sm bg-card border border-border rounded-lg py-1.5 px-3 shadow-sm focus:ring-2 focus:ring-primary"
          >
            <option value="">Change stage…</option>
            {PIPELINE_STAGES.map(s => (
              <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
            ))}
          </select>
          <select
            value=""
            onChange={e => {
              if (!e.target.value) return;
              const u = (users || []).find(u => u.id === e.target.value);
              const name = u ? `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || u.email : e.target.value;
              setPendingBulk({
                action: { assignedUserId: e.target.value },
                description: `Assign ${selected.size} lead${selected.size === 1 ? '' : 's'} to ${name}.`,
              });
            }}
            className="text-sm bg-card border border-border rounded-lg py-1.5 px-3 shadow-sm focus:ring-2 focus:ring-primary"
          >
            <option value="">Assign to…</option>
            {(users || []).map(u => (
              <option key={u.id} value={u.id}>{`${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || u.email}</option>
            ))}
          </select>
          <select
            value=""
            onChange={e => {
              if (!e.target.value) return;
              const tag = (tags || []).find(t => t.id === e.target.value);
              setPendingBulk({
                action: { tagId: e.target.value },
                description: `Add tag "${tag?.name ?? ''}" to ${selected.size} lead${selected.size === 1 ? '' : 's'}.`,
              });
            }}
            className="text-sm bg-card border border-border rounded-lg py-1.5 px-3 shadow-sm focus:ring-2 focus:ring-primary"
          >
            <option value="">Add tag…</option>
            {(tags || []).map(t => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
          <button
            onClick={() => setSelected(new Set())}
            className="flex items-center gap-1.5 text-sm font-semibold text-primary hover:text-primary/80 ml-auto px-2 py-1"
          >
            <X className="w-4 h-4" /> Clear
          </button>
        </div>
      )}

      <div className="flex-1 overflow-hidden relative">
        {isLoading ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        ) : (
          view === 'board'
            ? <BoardView leads={filteredLeads} onStatusChange={handleStatusChange} canEdit={canEdit} duplicateLeadIds={duplicateLeadIds} onDuplicateClick={openDuplicates} onNearEnd={hasMore ? loadMore : undefined} loadingMore={loadingMore} />
            : <TableView
                leads={filteredLeads}
                onStatusChange={handleStatusChange}
                canEdit={canEdit}
                duplicateLeadIds={duplicateLeadIds}
                selected={selected}
                onToggle={toggleSelect}
                onToggleAll={toggleSelectAll}
                onDuplicateClick={openDuplicates}
                onNearEnd={hasMore ? loadMore : undefined}
                loadingMore={loadingMore}
              />
        )}
      </div>

      {dupDialogData && (
        <DuplicateMergeDialog
          leadIds={dupDialogData.leadIds}
          matches={dupDialogData.matches}
          open={!!dupLeadId}
          onClose={() => setDupLeadId(null)}
        />
      )}

      <AlertDialog open={!!pendingBulk} onOpenChange={open => !open && setPendingBulk(null)}>
        <AlertDialogContent className="rounded-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Apply bulk action?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingBulk?.description} This will be recorded in the audit log.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-lg">Cancel</AlertDialogCancel>
            <AlertDialogAction className="rounded-lg" onClick={confirmBulk} disabled={bulkUpdate.isPending}>
              {bulkUpdate.isPending ? 'Applying…' : 'Confirm'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function showStatusChangeFailedToast(leadId: string, status: LeadStatus, queryClient: QueryClient) {
  const { dismiss } = globalToast({
    variant: 'destructive',
    title: 'Lead status not updated',
    description: `Moving the lead to "${status.replace(/_/g, ' ')}" failed. Retry below or try again from the board.`,
    action: (
      <ToastAction
        altText="Retry lead status update"
        onClick={async () => {
          try {
            await updateLeadRequest(leadId, { status });
            queryClient.invalidateQueries({ queryKey: getListLeadsQueryKey() });
            dismiss();
          } catch {
            queryClient.invalidateQueries({ queryKey: getListLeadsQueryKey() });
            showStatusChangeFailedToast(leadId, status, queryClient);
          }
        }}
      >
        Retry
      </ToastAction>
    ),
  });
}

function showBulkActionFailedToast(request: BulkLeadActionRequest, queryClient: QueryClient) {
  const { dismiss } = globalToast({
    variant: 'destructive',
    title: 'Bulk action failed',
    description: `Updating ${request.leadIds.length} lead${request.leadIds.length === 1 ? '' : 's'} failed. Retry below.`,
    action: (
      <ToastAction
        altText="Retry bulk action"
        onClick={async () => {
          try {
            const result = await bulkUpdateLeadsRequest(request);
            queryClient.invalidateQueries({ queryKey: getListLeadsQueryKey() });
            dismiss();
            globalToast({
              title: 'Bulk action applied',
              description: `${result.updated} lead${result.updated === 1 ? '' : 's'} updated${result.skipped ? `, ${result.skipped} skipped` : ''}.`,
            });
          } catch {
            showBulkActionFailedToast(request, queryClient);
          }
        }}
      >
        Retry
      </ToastAction>
    ),
  });
}

function showSaveFilterFailedToast(
  input: { name: string; filters: Record<string, unknown> },
  queryClient: QueryClient,
) {
  const { dismiss } = globalToast({
    variant: 'destructive',
    title: 'Could not save filter',
    description: `Saving "${input.name}" failed. Retry below.`,
    action: (
      <ToastAction
        altText="Retry saving filter"
        onClick={async () => {
          try {
            await createSavedFilterRequest(input);
            queryClient.invalidateQueries({ queryKey: getListSavedFiltersQueryKey() });
            dismiss();
            globalToast({ title: 'Filter saved', description: `"${input.name}" will be here next time you sign in.` });
          } catch {
            showSaveFilterFailedToast(input, queryClient);
          }
        }}
      >
        Retry
      </ToastAction>
    ),
  });
}

function UnreadMessageBadge() {
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-700 dark:text-amber-400"
      title="Homeowner sent a message that hasn't been replied to yet"
      aria-label="Unread homeowner message"
    >
      <MessageSquare className="w-3 h-3" /> New msg
    </span>
  );
}

function NationwideInquiryBadge() {
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-700 dark:text-indigo-400"
      title="Lead submitted via the nationwide travel quote form"
      aria-label="Nationwide inquiry"
    >
      <Globe className="w-3 h-3" /> Nationwide
    </span>
  );
}
function DuplicateBadge({ onClick }: { onClick?: () => void }) {
  const className = "inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-secondary/15 text-secondary transition-colors";
  if (onClick) {
    return (
      <button
        type="button"
        onClick={e => { e.stopPropagation(); onClick(); }}
        className={`${className} hover:bg-secondary/25 cursor-pointer active:scale-95`}
        title="Another lead shares this contact's phone, email, or address — click to compare and merge"
      >
        <Copy className="w-3 h-3" /> Dup
      </button>
    );
  }
  return (
    <span
      className={className}
      title="Another lead shares this contact's phone, email, or address"
    >
      <Copy className="w-3 h-3" /> Dup
    </span>
  );
}

function nearEndHandler(onNearEnd?: () => void) {
  if (!onNearEnd) return undefined;
  return (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 300) onNearEnd();
  };
}

function BoardView({ leads, onStatusChange, canEdit, duplicateLeadIds, onDuplicateClick, onNearEnd, loadingMore }: { leads: any[], onStatusChange: (id: string, s: LeadStatus) => void, canEdit: boolean, duplicateLeadIds: Set<string>, onDuplicateClick: (id: string) => void, onNearEnd?: () => void, loadingMore?: boolean }) {
  return (
    <div className="h-full overflow-x-auto overflow-y-hidden flex p-4 md:p-6 gap-4 md:gap-6 snap-x snap-mandatory pb-8">
      {PIPELINE_STAGES.map(stage => {
        const stageLeads = leads.filter(l => l.status === stage);
        return (
          <div key={stage} className="flex flex-col w-[85vw] max-w-[320px] shrink-0 h-full snap-center">
            <div className="flex items-center justify-between mb-3 px-2 bg-muted/40 py-2.5 rounded-xl border border-border/50">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-primary" />
                <h3 className="font-bold text-sm uppercase tracking-wide text-foreground truncate">
                  {stage.replace(/_/g, ' ')}
                </h3>
              </div>
              <span className="text-xs font-mono font-bold bg-background shadow-sm text-muted-foreground px-2.5 py-0.5 rounded-md border border-border">
                {stageLeads.length}
              </span>
            </div>
            <div className="flex-1 overflow-y-auto space-y-3 pb-6 px-1 no-scrollbar" onScroll={nearEndHandler(onNearEnd)}>
              {loadingMore && stageLeads.length > 0 && (
                <div className="flex justify-center py-2">
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                </div>
              )}
              {stageLeads.map(lead => (
                <LeadCard key={lead.id} lead={lead} onStatusChange={onStatusChange} canEdit={canEdit} isDuplicate={duplicateLeadIds.has(lead.id)} onDuplicateClick={onDuplicateClick} />
              ))}
              {stageLeads.length === 0 && (
                <div className="h-28 rounded-xl border-2 border-dashed border-border/60 bg-muted/10 flex flex-col items-center justify-center text-xs font-medium text-muted-foreground gap-2">
                  <LayoutGrid className="w-5 h-5 opacity-20" />
                  Empty
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PhotoCountBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-700 dark:text-violet-400"
      title={`${count} photo${count === 1 ? '' : 's'} attached`}
      aria-label={`${count} photo${count === 1 ? '' : 's'}`}
    >
      <Camera className="w-3 h-3" /> {count}
    </span>
  );
}

function LeadCard({ lead, onStatusChange, canEdit, isDuplicate, onDuplicateClick }: { lead: any, onStatusChange: (id: string, s: LeadStatus) => void, canEdit: boolean, isDuplicate: boolean, onDuplicateClick: (id: string) => void }) {
  return (
    <div className="bg-card border border-border rounded-xl p-4 shadow-sm hover:shadow-md transition-all group relative cursor-pointer active:scale-[0.98]">
      <div className="flex justify-between items-start mb-3 gap-2">
        <Link href={`/leads/${lead.id}`} className="font-semibold text-[15px] text-foreground hover:text-primary transition-colors line-clamp-2 block leading-snug">
          {lead.contactName || lead.summary || 'Untitled Lead'}
        </Link>
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          {lead.source === 'nationwide-inquiry' && <NationwideInquiryBadge />}
          {lead.hasUnreadPortalMessage && <UnreadMessageBadge />}
          {isDuplicate && <DuplicateBadge onClick={canEdit ? () => onDuplicateClick(lead.id) : undefined} />}
          {(lead.photoCount ?? 0) > 0 && <PhotoCountBadge count={lead.photoCount} />}
          {lead.score > 0 && (
            <span className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded-md ${lead.score >= 80 ? 'bg-green-500/15 text-green-600 dark:text-green-400' : 'bg-primary/10 text-primary'}`}>
              {lead.score}
            </span>
          )}
        </div>
      </div>

      <div className="text-xs text-muted-foreground mb-4 space-y-1.5">
        {lead.urgency === 'emergency' ? (
          <div className="flex items-center gap-1.5 text-destructive font-bold bg-destructive/10 px-2 py-1 rounded-md w-fit">
            <span className="w-1.5 h-1.5 rounded-full bg-destructive animate-pulse" />
            EMERGENCY
          </div>
        ) : (
          <div className="flex items-center gap-1.5 uppercase tracking-widest text-[10px] font-semibold">
            <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/30" />
            {lead.urgency}
          </div>
        )}
        
        {lead.estimatedValueCents > 0 && (
          <div className="font-mono font-bold text-foreground bg-muted/40 px-2 py-1 rounded-md w-fit mt-2 border border-border/50">
            ${(lead.estimatedValueCents / 100).toLocaleString()}
          </div>
        )}
      </div>

      {(lead.contactEmail || lead.contactPhone) && (
        <div className="mb-3">
          <LeadContactActions leadId={lead.id} email={lead.contactEmail} phone={lead.contactPhone} compact />
        </div>
      )}

      {canEdit && (
        <select
          data-testid="lead-status-select"
          className="text-xs font-medium bg-muted/40 hover:bg-muted border border-border rounded-lg w-full p-2.5 transition-colors focus:ring-2 focus:ring-primary focus:outline-none appearance-none cursor-pointer"
          value={lead.status}
          onChange={(e) => onStatusChange(lead.id, e.target.value as LeadStatus)}
          onClick={(e) => e.stopPropagation()}
        >
          {PIPELINE_STAGES.map(s => (
            <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
          ))}
        </select>
      )}
    </div>
  );
}

function TableView({ leads, onStatusChange, canEdit, duplicateLeadIds, selected, onToggle, onToggleAll, onDuplicateClick, onNearEnd, loadingMore }: { leads: any[], onStatusChange: (id: string, s: LeadStatus) => void, canEdit: boolean, duplicateLeadIds: Set<string>, selected: Set<string>, onToggle: (id: string) => void, onToggleAll: () => void, onDuplicateClick: (id: string) => void, onNearEnd?: () => void, loadingMore?: boolean }) {
  
  // Mobile list view
  const MobileCardList = () => (
    <div className="md:hidden flex-1 overflow-y-auto p-4 space-y-3 pb-8" onScroll={nearEndHandler(onNearEnd)}>
      <div className="flex items-center justify-between mb-2 px-1">
        <label className="flex items-center gap-3">
          <input type="checkbox" aria-label="Select all lead cards" className="w-5 h-5 rounded-md border-border text-primary focus:ring-primary accent-primary" checked={leads.length > 0 && selected.size === leads.length} onChange={onToggleAll} />
          <span className="text-sm font-bold text-muted-foreground">Select All</span>
        </label>
        <span className="text-xs font-mono font-bold bg-muted px-2 py-1 rounded-md border border-border text-muted-foreground">{leads.length} Leads</span>
      </div>
      
      {leads.map(lead => (
        <div key={lead.id} className={`bg-card border ${selected.has(lead.id) ? 'border-primary shadow-sm ring-1 ring-primary/20' : 'border-border'} rounded-xl p-4 transition-all relative`}>
          <div className="flex items-start gap-3">
            <input type="checkbox" className="mt-1 w-5 h-5 rounded-md border-border text-primary focus:ring-primary accent-primary shrink-0" checked={selected.has(lead.id)} onChange={() => onToggle(lead.id)} />
            <div className="flex-1 min-w-0">
               <div className="flex justify-between items-start gap-2 mb-1">
                  <Link href={`/leads/${lead.id}`} className="font-semibold text-[15px] text-foreground truncate">
                    {lead.contactName || lead.summary || 'Untitled Lead'}
                  </Link>
                  {duplicateLeadIds.has(lead.id) && <DuplicateBadge onClick={canEdit ? () => onDuplicateClick(lead.id) : undefined} />}
               </div>
               
               <div className="flex flex-wrap items-center gap-2 mb-3">
                  {lead.source === 'nationwide-inquiry' && <NationwideInquiryBadge />}
                  {lead.hasUnreadPortalMessage && <UnreadMessageBadge />}
                  <span className="text-[10px] font-bold uppercase tracking-widest bg-muted px-2 py-0.5 rounded-md text-muted-foreground">
                    {lead.status.replace(/_/g, ' ')}
                  </span>
                  {lead.urgency === 'emergency' && (
                    <span className="text-[10px] font-bold uppercase tracking-widest bg-destructive/10 text-destructive px-2 py-0.5 rounded-md">
                      Emergency
                    </span>
                  )}
                  {lead.score > 0 && (
                    <span className="text-[10px] font-mono font-bold bg-primary/10 text-primary px-2 py-0.5 rounded-md">
                      Score: {lead.score}
                    </span>
                  )}
               </div>

               <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground border-t border-border pt-3 mt-1">
                  <div>
                    <span className="block text-[10px] uppercase tracking-widest opacity-70 mb-0.5">Created</span>
                    <span className="font-mono text-foreground">{format(new Date(lead.createdAt), 'MMM d, yy')}</span>
                  </div>
                  {lead.estimatedValueCents > 0 && (
                    <div>
                      <span className="block text-[10px] uppercase tracking-widest opacity-70 mb-0.5">Value</span>
                      <span className="font-mono font-bold text-foreground">${(lead.estimatedValueCents / 100).toLocaleString()}</span>
                    </div>
                  )}
               </div>
            </div>
          </div>
        </div>
      ))}
      {loadingMore && leads.length > 0 && (
        <div className="flex justify-center py-4">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
        </div>
      )}
      {!leads.length && (
         <div className="h-32 rounded-xl border-2 border-dashed border-border flex flex-col items-center justify-center text-sm font-medium text-muted-foreground gap-2">
            No leads match.
         </div>
      )}
    </div>
  );

  return (
    <>
      <MobileCardList />
      <div className="hidden md:block flex-1 overflow-auto bg-card" onScroll={nearEndHandler(onNearEnd)}>
        <table className="w-full text-sm text-left whitespace-nowrap">
          <thead className="text-xs text-muted-foreground uppercase bg-muted/20 border-b border-border sticky top-0 z-10 backdrop-blur-md">
            <tr>
              <th className="px-6 py-4 w-12 font-bold tracking-widest">
                <input type="checkbox" aria-label="Select all leads" className="w-4 h-4 rounded border-border text-primary focus:ring-primary" checked={leads.length > 0 && selected.size === leads.length} onChange={onToggleAll} />
              </th>
              <th className="px-6 py-4 font-bold tracking-widest">Lead</th>
              <th className="px-6 py-4 font-bold tracking-widest">Stage</th>
              <th className="px-6 py-4 font-bold tracking-widest">Urgency & Score</th>
              <th className="px-6 py-4 font-bold tracking-widest text-right">Est. Value</th>
              <th className="px-6 py-4 font-bold tracking-widest text-right">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {leads.map(lead => (
              <tr key={lead.id} className={`hover:bg-muted/30 transition-colors group ${selected.has(lead.id) ? 'bg-primary/5' : ''}`}>
                <td className="px-6 py-4">
                  <input type="checkbox" className="w-4 h-4 rounded border-border text-primary focus:ring-primary" checked={selected.has(lead.id)} onChange={() => onToggle(lead.id)} />
                </td>
                <td className="px-6 py-4">
                  <div className="flex items-center gap-2">
                    <Link href={`/leads/${lead.id}`} className="font-semibold text-foreground hover:text-primary transition-colors">
                      {lead.contactName || lead.summary || 'Untitled Lead'}
                    </Link>
                    {lead.source === 'nationwide-inquiry' && <NationwideInquiryBadge />}
                    {lead.hasUnreadPortalMessage && <UnreadMessageBadge />}
                    {duplicateLeadIds.has(lead.id) && <DuplicateBadge onClick={canEdit ? () => onDuplicateClick(lead.id) : undefined} />}
                    {(lead.photoCount ?? 0) > 0 && <PhotoCountBadge count={lead.photoCount} />}
                  </div>
                  <div className="text-[11px] text-muted-foreground font-mono mt-1 opacity-60">ID: {lead.id.substring(0,8)}</div>
                </td>
                <td className="px-6 py-4">
                  {canEdit ? (
                    <select
                      className="text-xs bg-muted/40 border border-border rounded-lg py-1.5 px-2 hover:bg-muted transition-colors focus:ring-2 focus:ring-primary focus:outline-none cursor-pointer"
                      value={lead.status}
                      onChange={(e) => onStatusChange(lead.id, e.target.value as LeadStatus)}
                    >
                      {PIPELINE_STAGES.map(s => (
                        <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
                      ))}
                    </select>
                  ) : (
                    <span className="text-xs uppercase tracking-wider font-semibold text-muted-foreground">{lead.status.replace(/_/g, ' ')}</span>
                  )}
                </td>
                <td className="px-6 py-4">
                  <div className="flex items-center gap-3">
                    <span className={`text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-md ${lead.urgency === 'emergency' ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground'}`}>
                      {lead.urgency}
                    </span>
                    {lead.score > 0 && (
                      <span className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded-md ${lead.score >= 80 ? 'bg-green-500/10 text-green-600' : 'bg-primary/10 text-primary'}`}>
                        {lead.score}
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-6 py-4 text-right font-mono font-bold text-foreground">
                  {lead.estimatedValueCents > 0 ? `$${(lead.estimatedValueCents / 100).toLocaleString()}` : <span className="text-muted-foreground font-normal">-</span>}
                </td>
                <td className="px-6 py-4 text-right text-xs text-muted-foreground font-mono">
                  {format(new Date(lead.createdAt), 'MMM d, yyyy')}
                </td>
              </tr>
            ))}
            {loadingMore && leads.length > 0 && (
              <tr>
                <td colSpan={6} className="px-6 py-4 text-center">
                  <Loader2 className="w-5 h-5 animate-spin text-primary inline-block" />
                </td>
              </tr>
            )}
            {!leads.length && (
              <tr>
                <td colSpan={6} className="px-6 py-12 text-center text-muted-foreground">
                  No leads found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
