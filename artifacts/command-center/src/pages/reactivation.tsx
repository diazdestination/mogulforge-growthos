/**
 * Win-back: import old leads from a CSV and reactivate them with throttled
 * playbook campaigns. Flow: import → pick a segment → pick a playbook +
 * pace → preview sample outreach → launch. Running campaigns show live
 * progress and can be paused/resumed/cancelled; finished ones report
 * contacted / replies / bookings / recovered revenue.
 */
import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useListLeadImports,
  useImportLeadsCsv,
  useListReactivationSegments,
  useListReactivationCampaigns,
  useCreateReactivationCampaign,
  usePreviewReactivationOutreach,
  useGetReactivationCampaignReport,
  useLaunchReactivationCampaign,
  usePauseReactivationCampaign,
  useResumeReactivationCampaign,
  useCancelReactivationCampaign,
  useListPlaybooks,
  getListReactivationCampaignsQueryKey,
  getListLeadImportsQueryKey,
  getListReactivationSegmentsQueryKey,
  getGetReactivationCampaignReportQueryKey,
  type ReactivationSegment,
  type ReactivationSegmentPreset,
  type ReactivationCampaign,
  useGetMe,
} from '@workspace/api-client-react';
import { SourceAdoptionPanel } from '@/components/source-adoption-panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import {
  FileUp,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  Upload,
  XCircle,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// CSV import wizard
// ---------------------------------------------------------------------------

const IMPORT_FIELDS: { key: string; label: string; hint?: string }[] = [
  { key: 'firstName', label: 'First name', hint: 'required' },
  { key: 'lastName', label: 'Last name' },
  { key: 'email', label: 'Email', hint: 'email or phone required' },
  { key: 'phone', label: 'Phone' },
  { key: 'status', label: 'Lead status' },
  { key: 'source', label: 'Source' },
  { key: 'serviceType', label: 'Service type' },
  { key: 'notes', label: 'Notes' },
  { key: 'externalOpportunityId', label: 'Opportunity / job ID', hint: 'stable ID, not customer ID' },
  { key: 'externalCustomerId', label: 'Customer ID' },
  { key: 'externalEstimateId', label: 'Estimate ID' },
  { key: 'originalCreatedAt', label: 'Original opportunity date', hint: 'YYYY-MM-DD or ISO timestamp' },
  { key: 'sourceUpdatedAt', label: 'Source updated date', hint: 'required for changed reimports' },
  { key: 'statusChangedAt', label: 'Status changed date' },
  { key: 'lastContactAt', label: 'Last actual customer contact' },
  { key: 'estimatedValue', label: 'Estimate amount', hint: 'USD dollars; blank means unknown' },
  { key: 'currency', label: 'Currency', hint: 'USD required with an amount' },
];

/** Header-name heuristics for auto-mapping columns. */
const AUTO_MAP: Record<string, RegExp> = {
  firstName: /first|fname|^name$/i,
  lastName: /last|lname|surname/i,
  email: /e-?mail/i,
  phone: /phone|mobile|cell/i,
  status: /^(?:lead[ _-]?)?status$|^stage$/i,
  source: /^(?:lead[ _-]?)?source$|^origin$|^channel$/i,
  serviceType: /^(?:service|job|work)[ _-]?type$/i,
  notes: /note|comment|summary|description/i,
  externalOpportunityId: /^(?:external[ _-]?)?(?:opportunity|job)[ _-]?id$/i,
  externalCustomerId: /^(?:external[ _-]?)?customer[ _-]?id$/i,
  externalEstimateId: /^(?:external[ _-]?)?estimate[ _-]?id$/i,
  originalCreatedAt: /^original[ _-]?(?:created[ _-]?at|opportunity[ _-]?date)$/i,
  sourceUpdatedAt: /^source[ _-]?updated[ _-]?(?:at|date)$/i,
  statusChangedAt: /^status[ _-]?changed[ _-]?(?:at|date)$/i,
  lastContactAt: /^last[ _-]?contact[ _-]?(?:at|date)$/i,
  estimatedValue: /^estimate[ _-]?(?:amount|value)$|^estimated[ _-]?value$/i,
  currency: /^currency$/i,
};

function parseHeaderLine(csv: string): string[] {
  const line = csv.split(/\r?\n/, 1)[0] ?? '';
  // Simple header split (quoted headers with embedded commas are rare).
  return line.split(',').map((h) => h.replace(/^"|"$/g, '').trim());
}

export function ImportCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [csv, setCsv] = useState<string | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string, number>>({});
  const [defaultStatus, setDefaultStatus] = useState('nurture');
  const [sourceKey, setSourceKey] = useState('');
  const [snapshotAsOf, setSnapshotAsOf] = useState('');
  const { data: imports } = useListLeadImports();
  const importMutation = useImportLeadsCsv({
    mutation: {
      onSuccess: (result) => {
        toast({
          title: 'Import finished',
          description: `${result.imported} added, ${result.updated} updated, ${result.duplicates} unchanged, ${result.conflicts} need review, ${result.skipped} invalid${result.suppressed ? `, ${result.suppressed} on the do-not-send list` : ''}.`,
        });
        setCsv(null);
        setFileName(null);
        setHeaders([]);
        setMapping({});
        if (fileRef.current) fileRef.current.value = '';
        queryClient.invalidateQueries({ queryKey: getListLeadImportsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListReactivationSegmentsQueryKey() });
      },
      onError: (err) =>
        toast({
          title: 'Import failed',
          description: err instanceof Error ? err.message : 'Please check the file and mapping.',
          variant: 'destructive',
        }),
    },
  });

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 5_000_000) {
      toast({ title: 'File is too large', description: 'Choose a CSV smaller than 5 MB.', variant: 'destructive' });
      return;
    }
    let text: string;
    try { text = await file.text(); }
    catch {
      toast({ title: 'File could not be read', description: 'Choose the file again. Your current mapping has been kept.', variant: 'destructive' });
      return;
    }
    const hs = parseHeaderLine(text);
    const auto: Record<string, number> = {};
    for (const f of IMPORT_FIELDS) {
      const idx = hs.findIndex((h) => AUTO_MAP[f.key]?.test(h));
      if (idx >= 0 && !Object.values(auto).includes(idx)) auto[f.key] = idx;
    }
    setFileName(file.name);
    setCsv(text);
    setHeaders(hs);
    setMapping(auto);
  };

  const canImport =
    csv !== null &&
    mapping.firstName !== undefined &&
    (mapping.email !== undefined || mapping.phone !== undefined) &&
    (mapping.externalOpportunityId === undefined || /^[a-z0-9][a-z0-9._-]{0,99}$/.test(sourceKey));

  const mappingControl = (f: (typeof IMPORT_FIELDS)[number]) => (
    <div key={f.key} className="min-w-0 space-y-1">
      <Label htmlFor={`map-${f.key}`}>
        {f.label}
        {f.hint && <span className="ml-1 font-normal text-muted-foreground">({f.hint})</span>}
      </Label>
      <Select value={mapping[f.key] !== undefined ? String(mapping[f.key]) : 'none'} disabled={importMutation.isPending}
        onValueChange={(v) => setMapping((m) => {
          const next = { ...m };
          if (v === 'none') delete next[f.key];
          else next[f.key] = Number(v);
          return next;
        })}>
        <SelectTrigger id={`map-${f.key}`} aria-label={`Column for ${f.label}`} className="min-w-0">
          <SelectValue placeholder="Not mapped" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">Not mapped</SelectItem>
          {headers.map((h, i) => <SelectItem key={`${h}-${i}`} value={String(i)}>{h || `Column ${i + 1}`}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileUp className="h-5 w-5" aria-hidden="true" />
          Import opportunity history (CSV)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Bring in an approved export for analysis and staff tasks. A CSV is a snapshot, not live sync.
          Importing alone never enables outreach. Review source cutover and independent customer permission below before preparing exact recovery emails; automatic playbooks and SMS remain held.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            disabled={importMutation.isPending}
            aria-label="Choose a CSV file"
            className="max-w-xs"
            onChange={(e) => onFile(e.target.files?.[0])}
          />
          {fileName && <Badge variant="outline" className="max-w-full whitespace-normal break-all">{fileName}</Badge>}
        </div>
        {csv !== null && (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {IMPORT_FIELDS.slice(0, 8).map(mappingControl)}
              <div className="space-y-1">
                <Label htmlFor="import-default-status">Default status</Label>
                <Select value={defaultStatus} onValueChange={setDefaultStatus} disabled={importMutation.isPending}>
                  <SelectTrigger id="import-default-status" aria-label="Default lead status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="nurture">Nurture</SelectItem>
                    <SelectItem value="lost">Lost</SelectItem>
                    <SelectItem value="follow_up">Follow up</SelectItem>
                    <SelectItem value="completed">Past customer</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <details className="space-y-3" open={mapping.externalOpportunityId !== undefined || undefined}>
              <summary className="cursor-pointer font-medium">Source identity, dates and estimate value</summary>
              <p className="text-sm text-muted-foreground">
                Map an opportunity or job ID to keep repeat jobs for the same customer separate.
                Without it, existing contacts are skipped. Changed reimports need a newer source updated date;
                conflicting history or staff edits are held for review. Leave unknown dates and amounts blank.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="import-source-key">Source account key</Label>
                  <Input id="import-source-key" value={sourceKey} disabled={importMutation.isPending}
                    placeholder="e.g. housecallpro-main" maxLength={100}
                    onChange={(event) => setSourceKey(event.target.value.trim())}
                    aria-describedby="import-source-key-help" />
                  <p id="import-source-key-help" className="text-sm text-muted-foreground">Use the same lowercase key for each export from this account.</p>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="import-snapshot-date">Export snapshot date, if known</Label>
                  <Input id="import-snapshot-date" value={snapshotAsOf} disabled={importMutation.isPending}
                    placeholder="YYYY-MM-DD or ISO timestamp" onChange={(event) => setSnapshotAsOf(event.target.value)}
                    aria-describedby="import-snapshot-help" />
                  <p id="import-snapshot-help" className="text-sm text-muted-foreground">When the export was captured. Upload time does not establish freshness.</p>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{IMPORT_FIELDS.slice(8).map(mappingControl)}</div>
            </details>
            <Button
              className="dark:text-slate-950"
              disabled={!canImport || importMutation.isPending}
              onClick={() =>
                importMutation.mutate({
                  data: {
                    csv: csv!,
                    mapping,
                    fileName: fileName ?? undefined,
                    defaultStatus,
                    sourceKey: sourceKey || undefined,
                    snapshotAsOf: snapshotAsOf.trim() || undefined,
                  },
                })
              }
            >
              {importMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Upload className="mr-2 h-4 w-4" aria-hidden="true" />
              )}
              Import opportunities
            </Button>
            {!canImport && (
              <p className="text-sm text-muted-foreground">
                Map First name plus Email or Phone. When mapping an opportunity ID, provide a stable source account key.
              </p>
            )}
          </>
        )}
        {imports && imports.length > 0 && (
          <div className="space-y-1 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">Recent imports</p>
            {imports.slice(0, 3).map((imp) => (
              <div key={imp.id} className="space-y-1 break-words">
                <p>{imp.fileName ?? 'CSV'} — {imp.imported} added, {imp.updated} updated, {imp.duplicates} unchanged, {imp.conflicts} need review, {imp.skipped} invalid</p>
                <p>Source: {imp.sourceKey ?? 'not specified'} · Snapshot: {imp.snapshotAsOf ? new Date(imp.snapshotAsOf).toLocaleString() : 'unknown'} · Uploaded: {new Date(imp.createdAt).toLocaleString()}</p>
                {imp.errors.length > 0 && <details><summary className="cursor-pointer text-foreground">Review row issues</summary><ul className="list-disc space-y-1 pl-5">{imp.errors.map((error, index) => <li key={index}>{error}</li>)}</ul></details>}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Campaign builder
// ---------------------------------------------------------------------------

function CampaignBuilder() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: segments, isLoading: segmentsLoading } = useListReactivationSegments();
  const { data: playbooks } = useListPlaybooks();
  const [selected, setSelected] = useState<ReactivationSegmentPreset | null>(null);
  const [name, setName] = useState('');
  const [playbookId, setPlaybookId] = useState('');
  const [rate, setRate] = useState('20');
  const [preview, setPreview] = useState<
    { contactName?: string | null; channel: string; subject?: string | null; body: string }[] | null
  >(null);

  const previewMutation = usePreviewReactivationOutreach({
    mutation: {
      onSuccess: (r) => setPreview(r.samples),
      onError: (err) =>
        toast({
          title: 'Preview failed',
          description: err instanceof Error ? err.message : 'Try another segment.',
          variant: 'destructive',
        }),
    },
  });
  const createMutation = useCreateReactivationCampaign();
  const launchMutation = useLaunchReactivationCampaign();

  const launch = async () => {
    if (!selected || !playbookId) return;
    try {
      const created = await createMutation.mutateAsync({
        data: {
          name: name.trim() || `${selected.name} win-back`,
          playbookId,
          segment: selected.segment,
          ratePerHour: Number(rate) || 20,
        },
      });
      await launchMutation.mutateAsync({ id: created.id });
      toast({
        title: 'Campaign launched',
        description: 'Leads will enter the sequence at your configured pace.',
      });
      setSelected(null);
      setName('');
      setPreview(null);
      queryClient.invalidateQueries({ queryKey: getListReactivationCampaignsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListReactivationSegmentsQueryKey() });
    } catch (err) {
      toast({
        title: 'Launch failed',
        description: err instanceof Error ? err.message : 'Please try again.',
        variant: 'destructive',
      });
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Start a win-back campaign</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {segmentsLoading ? (
          <Loader2 className="h-5 w-5 animate-spin" aria-label="Loading segments" />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {(segments ?? []).map((seg) => (
              <button
                key={seg.key}
                type="button"
                onClick={() => setSelected(seg)}
                className={`rounded-lg border p-3 text-left transition-colors hover:bg-accent ${
                  selected?.key === seg.key ? 'border-primary bg-accent' : ''
                }`}
              >
                <p className="font-medium">{seg.name}</p>
                <p className="text-sm text-muted-foreground">{seg.description}</p>
                <Badge variant="secondary" className="mt-2">
                  {seg.count} lead{seg.count === 1 ? '' : 's'}
                </Badge>
              </button>
            ))}
          </div>
        )}
        {selected && (
          <div className="space-y-3 rounded-lg border p-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1">
                <Label htmlFor="campaign-name">Campaign name</Label>
                <Input
                  id="campaign-name"
                  value={name}
                  placeholder={`${selected.name} win-back`}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="campaign-playbook">Playbook</Label>
                <Select value={playbookId} onValueChange={setPlaybookId}>
                  <SelectTrigger id="campaign-playbook" aria-label="Playbook">
                    <SelectValue placeholder="Choose a playbook" />
                  </SelectTrigger>
                  <SelectContent>
                    {(playbooks ?? []).map((pb) => (
                      <SelectItem key={pb.id} value={pb.id}>
                        {pb.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="campaign-rate">Leads per hour</Label>
                <Input
                  id="campaign-rate"
                  type="number"
                  min={1}
                  max={500}
                  value={rate}
                  onChange={(e) => setRate(e.target.value)}
                />
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={!playbookId || previewMutation.isPending}
                onClick={() =>
                  previewMutation.mutate({
                    data: { playbookId, segment: selected.segment as ReactivationSegment },
                  })
                }
              >
                {previewMutation.isPending && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                )}
                Preview sample outreach
              </Button>
              <Button
                disabled={
                  !playbookId ||
                  selected.count === 0 ||
                  createMutation.isPending ||
                  launchMutation.isPending
                }
                onClick={launch}
              >
                {(createMutation.isPending || launchMutation.isPending) && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                )}
                Launch campaign
              </Button>
            </div>
          </div>
        )}
        <Dialog open={preview !== null} onOpenChange={(open) => !open && setPreview(null)}>
          <DialogContent className="max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Sample outreach</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              {(preview ?? []).map((s, i) => (
                <div key={i} className="rounded-lg border p-3">
                  <p className="text-sm font-medium">
                    {s.contactName ?? 'Lead'} — {s.channel.toUpperCase()}
                  </p>
                  {s.subject && (
                    <p className="text-sm text-muted-foreground">Subject: {s.subject}</p>
                  )}
                  <p className="mt-1 whitespace-pre-wrap text-sm">{s.body}</p>
                </div>
              ))}
            </div>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Campaign list + report
// ---------------------------------------------------------------------------

const STATUS_BADGE: Record<string, string> = {
  draft: 'bg-muted text-muted-foreground',
  running: 'bg-green-100 text-green-800',
  paused: 'bg-yellow-100 text-yellow-800',
  completed: 'bg-blue-100 text-blue-800',
  cancelled: 'bg-red-100 text-red-800',
};

function CampaignRow({ campaign }: { campaign: ReactivationCampaign }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [reportOpen, setReportOpen] = useState(false);
  const { data: report } = useGetReactivationCampaignReport(campaign.id, {
    query: {
      enabled: reportOpen,
      queryKey: getGetReactivationCampaignReportQueryKey(campaign.id),
    },
  });
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: getListReactivationCampaignsQueryKey() });
    queryClient.invalidateQueries({
      queryKey: getGetReactivationCampaignReportQueryKey(campaign.id),
    });
  };
  const onError = (err: unknown) =>
    toast({
      title: 'Action failed',
      description: err instanceof Error ? err.message : 'Please try again.',
      variant: 'destructive',
    });
  const pauseM = usePauseReactivationCampaign({ mutation: { onSuccess: refresh, onError } });
  const resumeM = useResumeReactivationCampaign({ mutation: { onSuccess: refresh, onError } });
  const cancelM = useCancelReactivationCampaign({ mutation: { onSuccess: refresh, onError } });

  const progress =
    campaign.totalLeads > 0
      ? Math.round(((campaign.enrolledCount ?? 0) / campaign.totalLeads) * 100)
      : 0;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
      <div className="min-w-0">
        <button
          type="button"
          className="font-medium underline-offset-2 hover:underline"
          onClick={() => setReportOpen(true)}
        >
          {campaign.name}
        </button>
        <p className="text-sm text-muted-foreground">
          {campaign.playbookName ?? 'Playbook'} · {campaign.ratePerHour}/hr ·{' '}
          {campaign.enrolledCount ?? 0}/{campaign.totalLeads} enrolled ({progress}%)
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Badge className={STATUS_BADGE[campaign.status] ?? ''}>{campaign.status}</Badge>
        {campaign.status === 'running' && (
          <Button
            size="sm"
            variant="outline"
            aria-label={`Pause ${campaign.name}`}
            disabled={pauseM.isPending}
            onClick={() => pauseM.mutate({ id: campaign.id })}
          >
            <Pause className="h-4 w-4" aria-hidden="true" />
          </Button>
        )}
        {campaign.status === 'paused' && (
          <Button
            size="sm"
            variant="outline"
            aria-label={`Resume ${campaign.name}`}
            disabled={resumeM.isPending}
            onClick={() => resumeM.mutate({ id: campaign.id })}
          >
            <Play className="h-4 w-4" aria-hidden="true" />
          </Button>
        )}
        {['draft', 'running', 'paused'].includes(campaign.status) && (
          <Button
            size="sm"
            variant="outline"
            aria-label={`Cancel ${campaign.name}`}
            disabled={cancelM.isPending}
            onClick={() => {
              if (window.confirm('Cancel this campaign and stop its sequences?')) {
                cancelM.mutate({ id: campaign.id });
              }
            }}
          >
            <XCircle className="h-4 w-4" aria-hidden="true" />
          </Button>
        )}
      </div>
      <Dialog open={reportOpen} onOpenChange={setReportOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{campaign.name}</DialogTitle>
          </DialogHeader>
          {report ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {[
                { label: 'Enrolled', value: report.enrolled },
                { label: 'Waiting', value: report.pending },
                { label: 'Skipped', value: report.skipped },
                { label: 'Contacted', value: report.contacted },
                { label: 'Replies', value: report.replied },
                { label: 'Bookings', value: report.booked },
              ].map((m) => (
                <div key={m.label} className="rounded-lg border p-3 text-center">
                  <p className="text-2xl font-semibold">{m.value}</p>
                  <p className="text-sm text-muted-foreground">{m.label}</p>
                </div>
              ))}
              <div className="col-span-2 rounded-lg border p-3 text-center sm:col-span-3">
                <p className="text-2xl font-semibold">
                  ${(report.recoveredRevenueCents / 100).toLocaleString()}
                </p>
                <p className="text-sm text-muted-foreground">Recovered revenue</p>
              </div>
            </div>
          ) : (
            <Loader2 className="h-5 w-5 animate-spin" aria-label="Loading report" />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CampaignList() {
  const { data: campaigns, isLoading, refetch } = useListReactivationCampaigns();
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle>Campaigns</CardTitle>
        <Button size="sm" variant="ghost" aria-label="Refresh campaigns" onClick={() => refetch()}>
          <RotateCcw className="h-4 w-4" aria-hidden="true" />
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <Loader2 className="h-5 w-5 animate-spin" aria-label="Loading campaigns" />
        ) : (campaigns ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No campaigns yet. Pick a segment above to start one.
          </p>
        ) : (
          (campaigns ?? []).map((c) => <CampaignRow key={c.id} campaign={c} />)
        )}
      </CardContent>
    </Card>
  );
}

export default function Reactivation() {
  const { data: me } = useGetMe();
  return (
      <div className="min-w-0 space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Win-back</h1>
          <p className="text-muted-foreground">
            Review imported opportunities, preserve their history, and prepare approved follow-up.
          </p>
        </div>
        <ImportCard />
        {me?.organization && <SourceAdoptionPanel key={me.organization.id} organizationId={me.organization.id} businessName={me.organization.name} timezone={me.organization.timezone || 'America/New_York'} canManage={Boolean(me.isActive && ['owner', 'admin'].includes(me.role ?? ''))} />}
        <CampaignBuilder />
        <CampaignList />
      </div>
  );
}
