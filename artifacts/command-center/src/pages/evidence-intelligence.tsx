import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  BadgeCheck,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  FileCheck2,
  FileSearch2,
  FileText,
  Fingerprint,
  Image as ImageIcon,
  Loader2,
  LockKeyhole,
  Plus,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';

type CaseStatus = 'open' | 'analyzing' | 'review' | 'issued' | 'archived';
type ObservationStatus = 'ai_draft' | 'verified' | 'rejected';

interface EvidenceCase {
  id: string;
  title: string;
  lossType: string | null;
  lossDate: string | null;
  description: string | null;
  status: CaseStatus;
  createdAt: string;
  updatedAt: string;
}

interface EvidenceArtifact {
  id: string;
  kind: 'photo' | 'document' | 'note' | 'weather' | 'property' | 'other';
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  sourceLabel: string | null;
  aiUseApprovedAt: string | null;
  createdAt: string;
}

interface EvidenceRun {
  id: string;
  status: 'running' | 'completed' | 'failed';
  model: string;
  promptVersion: string;
  manifestHash: string;
  error: string | null;
  startedAt: string;
}

interface EvidenceObservation {
  id: string;
  runId: string;
  artifactId: string | null;
  category: string;
  statement: string;
  locator: string | null;
  basis: string | null;
  confidence: number;
  needsHumanReview: boolean;
  status: ObservationStatus;
}

interface CertificateFinding {
  category: string;
  statement: string;
  confidence: number;
  needsHumanReview: boolean;
  citations: Array<{ artifactId: string; locator: string; basis: string; strength: string }>;
}

interface EvidenceCertificate {
  id: string;
  runId: string;
  version: number;
  status: 'draft' | 'issued' | 'superseded';
  executiveSummary: string;
  findings: CertificateFinding[];
  conflicts: Array<{ summary?: string; artifactIds?: string[] }>;
  gaps: Array<{ title?: string; reason?: string; recommendedAction?: string }>;
  limitations: string[];
  recommendedNextSteps: string[];
  contentHash: string;
  integrityVersion: string;
  integrityHash: string;
  createdAt: string;
  issuedAt: string | null;
}

interface EligibleEstimate {
  id: string;
  title: string;
  status: string;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  updatedAt: string;
}

interface ClaimGraph {
  id: string;
  version: number;
  status: 'valid' | 'invalid';
  sourceKind: string;
  sourceReference: string;
  graphHash: string;
  invariantReport: Array<{ code: string; passed: boolean }>;
  createdAt: string;
}

interface LossCorroboration {
  id: string;
  version: number;
  status: 'computed' | 'verified' | 'rejected';
  calculationVersion: string;
  sourceManifestHash: string;
  assessmentHash: string;
  reviewNote: string | null;
  assessment: {
    contradictions?: unknown[];
    limitations?: string[];
    breakdown?: {
      state?: 'insufficient_evidence' | 'mixed_evidence' | 'corroborating_signals' | 'contradicting_signals';
      confidenceScore?: number;
      sourceCoverageScore?: number;
      missingnessScore?: number;
      crossSourceConsistencyScore?: number;
      sourceCount?: number;
      distinctProviderCount?: number;
    };
  };
  createdAt: string;
  reviewedAt: string | null;
}

type CorroborationSourceDraft = {
  artifactId: string;
  sourceKind: 'weather' | 'property' | 'inspection' | 'photo' | 'document' | 'other';
  provider: string;
  providerVersion: string;
  retrievedDate: string;
  coverageStart: string;
  coverageEnd: string;
  signal: 'supporting' | 'contradicting' | 'neutral';
  phenomenon: string;
  eventDate: string;
  magnitudeScore: string;
  qualityScore: string;
  coverageScore: string;
  latitude: string;
  longitude: string;
  directionDegrees: string;
  missingFields: string;
};

interface CaseDetail {
  case: EvidenceCase;
  artifacts: EvidenceArtifact[];
  runs: EvidenceRun[];
  observations: EvidenceObservation[];
  certificates: EvidenceCertificate[];
  eligibleEstimates: EligibleEstimate[];
  graphs: ClaimGraph[];
  corroborations: LossCorroboration[];
  policy: {
    aiDraftOnly: true;
    humanIssuanceRequired: true;
    allArtifactsRequireApproval: true;
  };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || 'Evidence Intelligence could not complete the request.');
  return body;
}

function shortHash(value: string): string {
  return `${value.slice(0, 10)}…${value.slice(-6)}`;
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024 / (bytes > 1024 * 1024 ? 1024 : 1)).toFixed(1)} ${bytes > 1024 * 1024 ? 'MB' : 'KB'}`;
}

function moneyLabel(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

function isoDate(value: string): string {
  if (!value) throw new Error('Enter every source date before computing corroboration.');
  return `${value}T12:00:00.000Z`;
}

function blankCorroborationSource(date = new Date().toISOString().slice(0, 10)): CorroborationSourceDraft {
  return {
    artifactId: '', sourceKind: 'weather', provider: '', providerVersion: '1.0', retrievedDate: date,
    coverageStart: date, coverageEnd: date, signal: 'supporting', phenomenon: 'hail', eventDate: date,
    magnitudeScore: '75', qualityScore: '80', coverageScore: '80', latitude: '', longitude: '', directionDegrees: '', missingFields: '',
  };
}

function statusLabel(status: CaseStatus): string {
  return { open: 'Intake', analyzing: 'Analyzing', review: 'Human review', issued: 'Issued', archived: 'Archived' }[status];
}

function StatusPill({ status }: { status: CaseStatus }) {
  return (
    <span className={cn(
      'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold',
      status === 'issued' && 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
      status === 'review' && 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
      status === 'analyzing' && 'border-primary/30 bg-primary/10 text-primary',
      (status === 'open' || status === 'archived') && 'border-border bg-muted text-muted-foreground',
    )}>
      {status === 'issued' && <CheckCircle2 className="h-3 w-3" />}
      {statusLabel(status)}
    </span>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('The selected file could not be read.'));
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.readAsDataURL(file);
  });
}

function WorkflowStrip({ detail }: { detail: CaseDetail }) {
  const steps = [
    { title: 'Evidence intake', done: detail.artifacts.length > 0, active: detail.case.status === 'open' },
    { title: 'AI grounded draft', done: detail.certificates.length > 0, active: detail.case.status === 'analyzing' },
    { title: 'Contractor issue', done: detail.certificates.some((item) => item.status === 'issued'), active: detail.case.status === 'review' },
  ];
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      {steps.map((step, index) => (
        <div key={step.title} className={cn('flex items-center gap-3 rounded-lg border p-3', step.active ? 'border-primary/35 bg-primary/[0.06]' : 'border-border bg-background/40')}>
          <div className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold', step.done ? 'bg-emerald-500 text-white' : step.active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground')}>
            {step.done ? <Check className="h-4 w-4" /> : index + 1}
          </div>
          <div><p className="text-xs font-semibold">{step.title}</p><p className="text-[10px] text-muted-foreground">{step.done ? 'Complete' : step.active ? 'In progress' : 'Waiting'}</p></div>
        </div>
      ))}
    </div>
  );
}

export default function EvidenceIntelligence() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [caseTitle, setCaseTitle] = useState('');
  const [lossType, setLossType] = useState('');
  const [lossDate, setLossDate] = useState('');
  const [description, setDescription] = useState('');
  const [artifactKind, setArtifactKind] = useState<EvidenceArtifact['kind']>('photo');
  const [artifactFile, setArtifactFile] = useState<File | null>(null);
  const [noteText, setNoteText] = useState('');
  const [sourceLabel, setSourceLabel] = useState('');
  const [approved, setApproved] = useState(false);
  const [corroborationSources, setCorroborationSources] = useState<CorroborationSourceDraft[]>(() => [blankCorroborationSource(), blankCorroborationSource()]);
  const [propertyLatitude, setPropertyLatitude] = useState('');
  const [propertyLongitude, setPropertyLongitude] = useState('');
  const [roofFacetId, setRoofFacetId] = useState('');
  const [roofFacetAzimuth, setRoofFacetAzimuth] = useState('');

  const casesQuery = useQuery({
    queryKey: ['evidence-cases'],
    queryFn: () => request<EvidenceCase[]>('/bie/claims'),
  });
  useEffect(() => {
    if (!selectedId && casesQuery.data?.[0]) setSelectedId(casesQuery.data[0].id);
  }, [casesQuery.data, selectedId]);

  const detailQuery = useQuery({
    queryKey: ['evidence-case', selectedId],
    queryFn: () => request<CaseDetail>(`/bie/claims/${selectedId}`),
    enabled: Boolean(selectedId),
  });

  async function refresh(id = selectedId) {
    await queryClient.invalidateQueries({ queryKey: ['evidence-cases'] });
    if (id) await queryClient.invalidateQueries({ queryKey: ['evidence-case', id] });
  }

  const createMutation = useMutation({
    mutationFn: () => request<EvidenceCase>('/bie/claims', {
      method: 'POST',
      body: JSON.stringify({ title: caseTitle, lossType: lossType || null, lossDate: lossDate || null, description: description || null }),
    }),
    onSuccess: async (created) => {
      setSelectedId(created.id);
      setShowCreate(false);
      setCaseTitle(''); setLossType(''); setLossDate(''); setDescription('');
      setNotice('Evidence case created. Add the source material the contractor should review.');
      setError(null);
      await refresh(created.id);
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'The evidence case could not be created.'),
  });

  const uploadMutation = useMutation({
    mutationFn: async () => {
      if (!selectedId) throw new Error('Select a case first.');
      if (!approved) throw new Error('Confirm that you are authorized to use this evidence with AI.');
      if (artifactKind === 'note') {
        if (!noteText.trim()) throw new Error('Enter an evidence note.');
        return request<EvidenceArtifact>(`/bie/claims/${selectedId}/artifacts`, {
          method: 'POST',
          body: JSON.stringify({ kind: 'note', filename: 'contractor-note.txt', mimeType: 'text/plain', text: noteText, sourceLabel, approveForAi: true }),
        });
      }
      if (!artifactFile) throw new Error('Choose a photo or PDF.');
      if (artifactFile.size > 5 * 1024 * 1024) throw new Error('Evidence files must be 5MB or smaller.');
      const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
      if (!allowed.includes(artifactFile.type)) throw new Error('Use a JPG, PNG, WebP, or PDF file.');
      return request<EvidenceArtifact>(`/bie/claims/${selectedId}/artifacts`, {
        method: 'POST',
        body: JSON.stringify({
          kind: artifactFile.type === 'application/pdf' ? 'document' : artifactKind,
          filename: artifactFile.name,
          mimeType: artifactFile.type,
          dataBase64: await fileToBase64(artifactFile),
          sourceLabel,
          approveForAi: true,
        }),
      });
    },
    onSuccess: async () => {
      setArtifactFile(null); setNoteText(''); setSourceLabel(''); setApproved(false);
      setNotice('Evidence added, hashed, and approved for this case.'); setError(null);
      await refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'The evidence could not be added.'),
  });

  const analyzeMutation = useMutation({
    mutationFn: () => request<CaseDetail>(`/bie/claims/${selectedId}/analyze`, { method: 'POST' }),
    onSuccess: async () => { setNotice('Grounded AI draft created. Contractor review is required before issuance.'); setError(null); await refresh(); },
    onError: (err) => setError(err instanceof Error ? err.message : 'The analysis could not be completed.'),
  });

  const reviewMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'verified' | 'rejected' }) =>
      request(`/bie/claims/${selectedId}/observations/${id}/review`, { method: 'POST', body: JSON.stringify({ status }) }),
    onSuccess: async () => { setNotice('Contractor review recorded in the audit trail.'); setError(null); await refresh(); },
    onError: (err) => setError(err instanceof Error ? err.message : 'The review could not be saved.'),
  });

  const issueMutation = useMutation({
    mutationFn: (certificateId: string) => request(`/bie/claims/${selectedId}/certificates/${certificateId}/issue`, { method: 'POST' }),
    onSuccess: async () => { setNotice('Loss Evidence Certificate issued by the authorized contractor.'); setError(null); await refresh(); },
    onError: (err) => setError(err instanceof Error ? err.message : 'The certificate could not be issued.'),
  });

  const compileGraphMutation = useMutation({
    mutationFn: (estimateId: string) => request<ClaimGraph>(`/bie/claims/${selectedId}/graphs/native-estimate`, {
      method: 'POST', body: JSON.stringify({ estimateId }),
    }),
    onSuccess: async (graph) => { setNotice(graph.status === 'valid' ? 'Canonical claim graph compiled with every financial invariant intact.' : 'Claim graph recorded with invariant failures. It is blocked from target compilation.'); setError(null); await refresh(); },
    onError: (err) => setError(err instanceof Error ? err.message : 'The claim graph could not be compiled.'),
  });

  const compileCorroborationMutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) => request<LossCorroboration>(`/bie/claims/${selectedId}/corroborations`, {
      method: 'POST', body: JSON.stringify(payload),
    }),
    onSuccess: async (record) => {
      setNotice(`Deterministic corroboration v${record.version} computed. It remains decision support until a contractor reviews the linked sources.`);
      setError(null);
      await refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Loss corroboration could not be computed.'),
  });

  const reviewCorroborationMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'verified' | 'rejected' }) => request<LossCorroboration>(`/bie/claims/${selectedId}/corroborations/${id}/review`, {
      method: 'POST', body: JSON.stringify({ status }),
    }),
    onSuccess: async (record) => {
      setNotice(record.status === 'verified' ? 'Corroboration inputs and limitations were verified in the audit trail.' : 'Corroboration assessment was rejected and remains excluded from any future execution path.');
      setError(null);
      await refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'The corroboration review could not be saved.'),
  });

  const detail = detailQuery.data;
  const currentCertificate = detail?.certificates.find((item) => item.status === 'draft') ?? detail?.certificates.find((item) => item.status === 'issued') ?? detail?.certificates[0];
  const currentObservations = useMemo(
    () => detail?.observations.filter((item) => item.runId === currentCertificate?.runId) ?? [],
    [detail?.observations, currentCertificate?.runId],
  );
  const readyToIssue = Boolean(
    currentCertificate?.status === 'draft' &&
    currentObservations.length > 0 &&
    currentObservations.every((item) => item.status !== 'ai_draft') &&
    currentObservations.some((item) => item.status === 'verified'),
  );
  const busy = createMutation.isPending || uploadMutation.isPending || analyzeMutation.isPending || reviewMutation.isPending || issueMutation.isPending || compileGraphMutation.isPending || compileCorroborationMutation.isPending || reviewCorroborationMutation.isPending;

  function createCase(event: FormEvent) {
    event.preventDefault(); setNotice(null); setError(null); createMutation.mutate();
  }

  function updateCorroborationSource(index: number, field: keyof CorroborationSourceDraft, value: string) {
    setCorroborationSources((current) => current.map((source, sourceIndex) => sourceIndex === index ? { ...source, [field]: value } : source));
  }

  function computeCorroboration() {
    try {
      const graph = detail?.graphs.find((item) => item.status === 'valid');
      if (!graph) throw new Error('Compile a valid canonical claim graph before corroborating loss evidence.');
      const supplied = corroborationSources.filter((source) => source.artifactId.trim() || source.provider.trim());
      if (!supplied.length) throw new Error('Add at least one source-linked observation.');
      const numberValue = (value: string, field: string) => {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) throw new Error(`${field} must be a number.`);
        return parsed;
      };
      const coordinateValue = (latitude: string, longitude: string, label: string) => {
        if (!latitude.trim() && !longitude.trim()) return null;
        if (!latitude.trim() || !longitude.trim()) throw new Error(`${label} needs both latitude and longitude.`);
        return { latitude: numberValue(latitude, `${label} latitude`), longitude: numberValue(longitude, `${label} longitude`) };
      };
      const payload = {
        canonicalGraphId: graph.id,
        propertyCoordinates: coordinateValue(propertyLatitude, propertyLongitude, 'Property location'),
        roofFacets: roofFacetId.trim() || roofFacetAzimuth.trim()
          ? (() => {
              if (!roofFacetId.trim() || !roofFacetAzimuth.trim()) throw new Error('Roof facet ID and azimuth must be supplied together.');
              return [{ id: roofFacetId.trim(), azimuthDegrees: numberValue(roofFacetAzimuth, 'Roof facet azimuth') }];
            })()
          : [],
        sources: supplied.map((source) => {
          if (!source.artifactId || !source.provider.trim() || !source.providerVersion.trim() || !source.phenomenon.trim()) {
            throw new Error('Every supplied source needs an artifact, provider, version, and phenomenon.');
          }
          return {
            sourceArtifactId: source.artifactId,
            sourceKind: source.sourceKind,
            provider: source.provider.trim(),
            providerVersion: source.providerVersion.trim(),
            retrievedAt: isoDate(source.retrievedDate),
            qualityScore: numberValue(source.qualityScore, 'Source quality'),
            coverageScore: numberValue(source.coverageScore, 'Source coverage'),
            missingFields: source.missingFields.split(',').map((field) => field.trim()).filter(Boolean),
            temporalCoverage: { startsAt: isoDate(source.coverageStart), endsAt: isoDate(source.coverageEnd) },
            observations: [{
              id: `${source.artifactId}:${source.phenomenon.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'observation'}`,
              signal: source.signal,
              phenomenon: source.phenomenon.trim(),
              observedAt: isoDate(source.eventDate),
              magnitudeScore: numberValue(source.magnitudeScore, 'Observation magnitude'),
              coordinates: coordinateValue(source.latitude, source.longitude, 'Source location'),
              directionDegrees: source.directionDegrees.trim() ? numberValue(source.directionDegrees, 'Source direction') : null,
            }],
          };
        }),
      };
      setNotice(null); setError(null); compileCorroborationMutation.mutate(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Loss corroboration input is invalid.');
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1500px] space-y-5 p-4 pb-28 md:p-7 md:pb-8">
      <section className="overflow-hidden rounded-2xl border border-primary/25 bg-gradient-to-br from-primary/[0.14] via-card to-card p-5 md:p-7">
        <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-start">
          <div className="max-w-3xl">
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-background/70 px-3 py-1 text-xs font-semibold text-primary">
              <ScanSearch className="h-3.5 w-3.5" /> GROWTHOS · EVIDENCE INTELLIGENCE
            </div>
            <h1 className="text-3xl font-bold tracking-tight md:text-4xl">Turn field evidence into defensible action.</h1>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground md:text-base">
              Upload authorized source material, generate a citation-locked AI draft, and let the contractor verify every observation before issuing a tamper-evident Loss Evidence Certificate.
            </p>
          </div>
          <button onClick={() => setShowCreate((value) => !value)} className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-sm">
            {showCreate ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />} {showCreate ? 'Close' : 'New evidence case'}
          </button>
        </div>
        <div className="mt-5 grid gap-2 sm:grid-cols-3">
          <div className="flex items-start gap-2 rounded-lg border border-border/70 bg-background/60 p-3"><LockKeyhole className="mt-0.5 h-4 w-4 shrink-0 text-primary" /><div><p className="text-xs font-semibold">Explicit AI approval</p><p className="mt-0.5 text-[11px] text-muted-foreground">No artifact is analyzed without operator authorization.</p></div></div>
          <div className="flex items-start gap-2 rounded-lg border border-border/70 bg-background/60 p-3"><Fingerprint className="mt-0.5 h-4 w-4 shrink-0 text-primary" /><div><p className="text-xs font-semibold">SHA-256 integrity</p><p className="mt-0.5 text-[11px] text-muted-foreground">Sources and certificates carry content fingerprints.</p></div></div>
          <div className="flex items-start gap-2 rounded-lg border border-border/70 bg-background/60 p-3"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" /><div><p className="text-xs font-semibold">Human issuance gate</p><p className="mt-0.5 text-[11px] text-muted-foreground">AI drafts. An authorized contractor decides.</p></div></div>
        </div>
      </section>

      {showCreate && (
        <form onSubmit={createCase} className="grid gap-3 rounded-xl border border-primary/25 bg-card p-4 shadow-sm md:grid-cols-2 lg:grid-cols-4">
          <div className="lg:col-span-2"><label className="text-xs font-semibold" htmlFor="case-title">Case title</label><input id="case-title" required maxLength={240} value={caseTitle} onChange={(e) => setCaseTitle(e.target.value)} placeholder="Hail loss · 418 Ridgeview Dr" className="mt-1 h-10 w-full rounded-md border border-border bg-background px-3 text-sm" /></div>
          <div><label className="text-xs font-semibold" htmlFor="loss-type">Loss type</label><input id="loss-type" value={lossType} onChange={(e) => setLossType(e.target.value)} placeholder="Hail / wind / water" className="mt-1 h-10 w-full rounded-md border border-border bg-background px-3 text-sm" /></div>
          <div><label className="text-xs font-semibold" htmlFor="loss-date">Reported loss date</label><input id="loss-date" type="date" value={lossDate} onChange={(e) => setLossDate(e.target.value)} className="mt-1 h-10 w-full rounded-md border border-border bg-background px-3 text-sm" /></div>
          <div className="md:col-span-2 lg:col-span-3"><label className="text-xs font-semibold" htmlFor="case-description">Operator context <span className="font-normal text-muted-foreground">(not treated as proven fact)</span></label><textarea id="case-description" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="What the contractor knows before reviewing the evidence…" className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm" /></div>
          <div className="flex items-end"><button disabled={createMutation.isPending || !caseTitle.trim()} className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-50">{createMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />} Create case</button></div>
        </form>
      )}

      {(notice || error) && (
        <div role={error ? 'alert' : 'status'} className={cn('flex items-start gap-2 rounded-lg border px-4 py-3 text-sm', error ? 'border-destructive/30 bg-destructive/5 text-destructive' : 'border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300')}>
          {error ? <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" /> : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />}{error || notice}
        </div>
      )}

      <div className="grid gap-5 xl:grid-cols-[310px_minmax(0,1fr)]">
        <aside className="overflow-hidden rounded-xl border border-border bg-card shadow-sm xl:sticky xl:top-5 xl:self-start">
          <div className="border-b border-border p-4"><div className="flex items-center justify-between"><h2 className="font-semibold">Evidence cases</h2><span className="text-xs text-muted-foreground">{casesQuery.data?.length ?? 0}</span></div><p className="mt-1 text-xs text-muted-foreground">Tenant-private contractor workspaces</p></div>
          <div className="max-h-[440px] overflow-y-auto p-2">
            {casesQuery.isLoading && <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading cases…</div>}
            {!casesQuery.isLoading && !casesQuery.data?.length && <div className="p-5 text-center"><Archive className="mx-auto h-6 w-6 text-muted-foreground" /><p className="mt-2 text-sm font-medium">No evidence cases yet</p><p className="mt-1 text-xs text-muted-foreground">Create one to prove value on the first contractor login.</p></div>}
            {casesQuery.data?.map((item) => (
              <button key={item.id} onClick={() => { setSelectedId(item.id); setNotice(null); setError(null); }} className={cn('mb-1 w-full rounded-lg border p-3 text-left transition-colors', selectedId === item.id ? 'border-primary/30 bg-primary/[0.07]' : 'border-transparent hover:bg-muted/60')}>
                <div className="flex items-start justify-between gap-2"><p className="line-clamp-2 text-sm font-semibold">{item.title}</p><ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" /></div>
                <div className="mt-2 flex flex-wrap items-center gap-2"><StatusPill status={item.status} /><span className="text-[10px] text-muted-foreground">{new Date(item.updatedAt).toLocaleDateString()}</span></div>
              </button>
            ))}
          </div>
        </aside>

        <main className="min-w-0 space-y-5">
          {detailQuery.isLoading && <div className="flex min-h-[320px] items-center justify-center rounded-xl border border-border bg-card"><Loader2 className="h-7 w-7 animate-spin text-primary" /></div>}
          {!selectedId && !detailQuery.isLoading && <div className="flex min-h-[320px] flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card p-8 text-center"><FileSearch2 className="h-9 w-9 text-primary" /><h2 className="mt-3 text-lg font-semibold">Create the first evidence case</h2><p className="mt-1 max-w-md text-sm text-muted-foreground">The AI workflow stays dormant until the contractor supplies and explicitly approves evidence.</p></div>}
          {detail && (
            <>
              <section className="rounded-xl border border-border bg-card p-4 shadow-sm md:p-5">
                <div className="flex flex-col justify-between gap-3 md:flex-row md:items-start"><div><div className="flex flex-wrap items-center gap-2"><h2 className="text-xl font-bold">{detail.case.title}</h2><StatusPill status={detail.case.status} /></div><p className="mt-1 text-sm text-muted-foreground">{[detail.case.lossType, detail.case.lossDate ? `reported ${new Date(detail.case.lossDate).toLocaleDateString()}` : null].filter(Boolean).join(' · ') || 'Loss details not supplied'}</p></div><div className="rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground"><span className="font-semibold text-foreground">Case privacy:</span> tenant-scoped · no shared training claim</div></div>
                <div className="mt-4"><WorkflowStrip detail={detail} /></div>
              </section>

              <div className="grid gap-5 lg:grid-cols-2">
                <section className="rounded-xl border border-border bg-card p-4 shadow-sm md:p-5">
                  <div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold">1 · Add authorized evidence</h3><p className="mt-1 text-xs text-muted-foreground">JPG, PNG, WebP, PDF, or a locally redacted note · 5MB max</p></div><Upload className="h-5 w-5 text-primary" /></div>
                  <div className="mt-4 grid grid-cols-3 gap-2">
                    {(['photo', 'document', 'note'] as const).map((kind) => <button key={kind} onClick={() => { setArtifactKind(kind); setArtifactFile(null); }} className={cn('rounded-md border px-3 py-2 text-xs font-semibold capitalize', artifactKind === kind ? 'border-primary/35 bg-primary/10 text-primary' : 'border-border bg-background')}>{kind}</button>)}
                  </div>
                  {artifactKind === 'note' ? <textarea value={noteText} onChange={(e) => setNoteText(e.target.value)} rows={5} placeholder="Paste the field note. Emails, phone numbers, SSNs, and policy-like identifiers are redacted locally before AI use." className="mt-3 w-full rounded-md border border-border bg-background px-3 py-2 text-sm" /> : <label className="mt-3 flex min-h-28 cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-border bg-background/50 p-4 text-center hover:border-primary/40"><input type="file" className="sr-only" accept={artifactKind === 'document' ? 'application/pdf' : 'image/jpeg,image/png,image/webp,application/pdf'} onChange={(e) => setArtifactFile(e.target.files?.[0] ?? null)} />{artifactKind === 'document' ? <FileText className="h-6 w-6 text-primary" /> : <ImageIcon className="h-6 w-6 text-primary" />}<p className="mt-2 text-sm font-medium">{artifactFile?.name || 'Choose evidence file'}</p>{artifactFile && <p className="mt-1 text-xs text-muted-foreground">{sizeLabel(artifactFile.size)}</p>}</label>}
                  <input value={sourceLabel} onChange={(e) => setSourceLabel(e.target.value)} placeholder="Source label (e.g. field inspection · Diego)" className="mt-3 h-10 w-full rounded-md border border-border bg-background px-3 text-sm" />
                  <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-lg border border-border bg-muted/40 p-3"><input type="checkbox" checked={approved} onChange={(e) => setApproved(e.target.checked)} className="mt-0.5" /><span className="text-xs leading-relaxed"><strong>I am authorized to use this evidence with AI.</strong> I understand the artifact will be sent to OpenAI only for this case analysis.</span></label>
                  <button disabled={busy || !approved} onClick={() => { setNotice(null); setError(null); uploadMutation.mutate(); }} className="mt-3 inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-50">{uploadMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Hash and add evidence</button>
                </section>

                <section className="rounded-xl border border-border bg-card p-4 shadow-sm md:p-5">
                  <div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold">Evidence ledger</h3><p className="mt-1 text-xs text-muted-foreground">Immutable source fingerprints for this case</p></div><Fingerprint className="h-5 w-5 text-primary" /></div>
                  <div className="mt-4 max-h-[360px] space-y-2 overflow-y-auto">
                    {!detail.artifacts.length && <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">No evidence added yet.</div>}
                    {detail.artifacts.map((artifact) => (
                      <a key={artifact.id} href={`/api/v1/bie/claims/${detail.case.id}/artifacts/${artifact.id}/content`} target="_blank" rel="noreferrer" className="block rounded-lg border border-border bg-background/50 p-3 hover:border-primary/30">
                        <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate text-sm font-semibold">{artifact.filename}</p><p className="mt-1 text-xs text-muted-foreground">{artifact.kind} · {sizeLabel(artifact.sizeBytes)}{artifact.sourceLabel ? ` · ${artifact.sourceLabel}` : ''}</p></div>{artifact.aiUseApprovedAt ? <BadgeCheck className="h-5 w-5 shrink-0 text-emerald-600" /> : <CircleAlert className="h-5 w-5 shrink-0 text-amber-600" />}</div>
                        <p className="mt-2 font-mono text-[10px] text-muted-foreground">SHA-256 {shortHash(artifact.sha256)}</p>
                      </a>
                    ))}
                  </div>
                </section>
              </div>

              {(detail.eligibleEstimates.length > 0 || detail.graphs.length > 0) && <section className="rounded-xl border border-border bg-card p-4 shadow-sm md:p-5"><div className="flex flex-col justify-between gap-3 md:flex-row md:items-start"><div><div className="flex items-center gap-2"><Fingerprint className="h-5 w-5 text-primary" /><h3 className="font-semibold">1b · Canonical claim compiler</h3></div><p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">Compile a native MogulForge estimate into a source-ledger claim graph. Every line total, subtotal, and grand total is checked before any target representation can be produced.</p></div><span className="rounded-full border border-primary/20 bg-primary/[0.05] px-2 py-1 text-[10px] font-semibold text-primary">DETERMINISTIC · NO AI REQUIRED</span></div><div className="mt-4 grid gap-3 lg:grid-cols-2">{detail.eligibleEstimates.map((estimate) => <div key={estimate.id} className="rounded-lg border border-border bg-background/50 p-3"><div className="flex items-start justify-between gap-3"><div><p className="text-sm font-semibold">{estimate.title}</p><p className="mt-1 text-xs text-muted-foreground">{estimate.status.replace(/_/g, ' ')} · {moneyLabel(estimate.totalCents)}</p></div><button disabled={busy} onClick={() => { setNotice(null); setError(null); compileGraphMutation.mutate(estimate.id); }} className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-primary/30 px-3 text-xs font-semibold text-primary disabled:opacity-50">{compileGraphMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Fingerprint className="h-3.5 w-3.5" />} Compile</button></div></div>)}{!detail.eligibleEstimates.length && <div className="rounded-lg border border-dashed border-border p-4 text-xs text-muted-foreground">Link this claim to a lead with an estimate to compile its first canonical graph.</div>}{detail.graphs.map((graph) => <div key={graph.id} className={cn('rounded-lg border p-3', graph.status === 'valid' ? 'border-emerald-500/25 bg-emerald-500/[0.04]' : 'border-destructive/25 bg-destructive/[0.04]')}><div className="flex items-start justify-between gap-3"><div><p className="text-sm font-semibold">Claim graph · v{graph.version}</p><p className="mt-1 text-xs text-muted-foreground">{graph.status === 'valid' ? `${graph.invariantReport.length} invariants intact` : `${graph.invariantReport.filter((item) => !item.passed).length} invariant failure${graph.invariantReport.filter((item) => !item.passed).length === 1 ? '' : 's'} · target compilation blocked`}</p></div>{graph.status === 'valid' ? <CheckCircle2 className="h-5 w-5 text-emerald-600" /> : <CircleAlert className="h-5 w-5 text-destructive" />}</div><p className="mt-3 font-mono text-[10px] text-muted-foreground">Graph SHA-256 {shortHash(graph.graphHash)}</p></div>)}</div></section>}

              {(detail.graphs.some((graph) => graph.status === 'valid') || detail.corroborations.length > 0) && <section className="rounded-xl border border-primary/25 bg-card p-4 shadow-sm md:p-5">
                <div className="flex flex-col justify-between gap-3 md:flex-row md:items-start"><div><div className="flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-primary" /><h3 className="font-semibold">1c · Deterministic loss corroboration</h3></div><p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">Link independently captured source artifacts to the canonical claim graph. MogulForge exposes time, distance, directional exposure, coverage, and missing-data effects instead of asking an AI to guess.</p></div><span className="rounded-full border border-primary/20 bg-primary/[0.05] px-2 py-1 text-[10px] font-semibold text-primary">REPLAYABLE · HUMAN REVIEW</span></div>

                {detail.graphs.some((graph) => graph.status === 'valid') && detail.artifacts.length > 0 ? <div className="mt-4 space-y-3 rounded-lg border border-border bg-background/40 p-3"><div className="grid gap-3 md:grid-cols-3"><div><label className="text-[11px] font-semibold">Property latitude <span className="font-normal text-muted-foreground">(optional)</span></label><input value={propertyLatitude} onChange={(event) => setPropertyLatitude(event.target.value)} inputMode="decimal" placeholder="32.7767" className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2 text-xs" /></div><div><label className="text-[11px] font-semibold">Property longitude <span className="font-normal text-muted-foreground">(optional)</span></label><input value={propertyLongitude} onChange={(event) => setPropertyLongitude(event.target.value)} inputMode="decimal" placeholder="-96.7970" className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2 text-xs" /></div><div><label className="text-[11px] font-semibold">Roof facet / azimuth <span className="font-normal text-muted-foreground">(optional)</span></label><div className="mt-1 flex gap-2"><input value={roofFacetId} onChange={(event) => setRoofFacetId(event.target.value)} placeholder="south" className="h-9 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs" /><input value={roofFacetAzimuth} onChange={(event) => setRoofFacetAzimuth(event.target.value)} inputMode="decimal" placeholder="180°" className="h-9 w-20 rounded-md border border-border bg-background px-2 text-xs" /></div></div></div>
                  <p className="text-[11px] text-muted-foreground">Use source documents already attached to this claim. Leave geographic or roof data blank only when it is genuinely unavailable—the resulting missingness is shown and penalized explicitly.</p>
                  <div className="space-y-3">{corroborationSources.map((source, index) => <div key={`${index}-${source.artifactId}`} className="rounded-lg border border-border bg-card p-3"><div className="mb-2 flex items-center justify-between gap-2"><p className="text-xs font-semibold">Source {index + 1}</p>{corroborationSources.length > 1 && <button type="button" onClick={() => setCorroborationSources((current) => current.filter((_, sourceIndex) => sourceIndex !== index))} className="text-[11px] font-medium text-muted-foreground hover:text-destructive">Remove</button>}</div><div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4"><label className="text-[11px] font-semibold">Artifact<select value={source.artifactId} onChange={(event) => updateCorroborationSource(index, 'artifactId', event.target.value)} className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2 text-xs"><option value="">Select evidence…</option>{detail.artifacts.map((artifact) => <option key={artifact.id} value={artifact.id}>{artifact.kind} · {artifact.filename}</option>)}</select></label><label className="text-[11px] font-semibold">Source kind<select value={source.sourceKind} onChange={(event) => updateCorroborationSource(index, 'sourceKind', event.target.value)} className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2 text-xs">{['weather','property','inspection','photo','document','other'].map((kind) => <option key={kind} value={kind}>{kind}</option>)}</select></label><label className="text-[11px] font-semibold">Provider<input value={source.provider} onChange={(event) => updateCorroborationSource(index, 'provider', event.target.value)} placeholder="Provider / inspector" className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2 text-xs" /></label><label className="text-[11px] font-semibold">Provider version<input value={source.providerVersion} onChange={(event) => updateCorroborationSource(index, 'providerVersion', event.target.value)} className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2 text-xs" /></label><label className="text-[11px] font-semibold">Finding<select value={source.signal} onChange={(event) => updateCorroborationSource(index, 'signal', event.target.value)} className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2 text-xs"><option value="supporting">Supporting</option><option value="contradicting">Contradicting</option><option value="neutral">Neutral</option></select></label><label className="text-[11px] font-semibold">Phenomenon<input value={source.phenomenon} onChange={(event) => updateCorroborationSource(index, 'phenomenon', event.target.value)} placeholder="hail" className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2 text-xs" /></label><label className="text-[11px] font-semibold">Event date<input type="date" value={source.eventDate} onChange={(event) => updateCorroborationSource(index, 'eventDate', event.target.value)} className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2 text-xs" /></label><label className="text-[11px] font-semibold">Magnitude 0–100<input type="number" min="0" max="100" value={source.magnitudeScore} onChange={(event) => updateCorroborationSource(index, 'magnitudeScore', event.target.value)} className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2 text-xs" /></label><label className="text-[11px] font-semibold">Quality 0–100<input type="number" min="0" max="100" value={source.qualityScore} onChange={(event) => updateCorroborationSource(index, 'qualityScore', event.target.value)} className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2 text-xs" /></label><label className="text-[11px] font-semibold">Coverage 0–100<input type="number" min="0" max="100" value={source.coverageScore} onChange={(event) => updateCorroborationSource(index, 'coverageScore', event.target.value)} className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2 text-xs" /></label><label className="text-[11px] font-semibold">Coverage starts<input type="date" value={source.coverageStart} onChange={(event) => updateCorroborationSource(index, 'coverageStart', event.target.value)} className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2 text-xs" /></label><label className="text-[11px] font-semibold">Coverage ends<input type="date" value={source.coverageEnd} onChange={(event) => updateCorroborationSource(index, 'coverageEnd', event.target.value)} className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2 text-xs" /></label></div><div className="mt-2 grid gap-2 sm:grid-cols-4"><label className="text-[11px] font-semibold">Source latitude<input value={source.latitude} onChange={(event) => updateCorroborationSource(index, 'latitude', event.target.value)} inputMode="decimal" className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2 text-xs" /></label><label className="text-[11px] font-semibold">Source longitude<input value={source.longitude} onChange={(event) => updateCorroborationSource(index, 'longitude', event.target.value)} inputMode="decimal" className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2 text-xs" /></label><label className="text-[11px] font-semibold">Direction °<input value={source.directionDegrees} onChange={(event) => updateCorroborationSource(index, 'directionDegrees', event.target.value)} inputMode="decimal" placeholder="180" className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2 text-xs" /></label><label className="text-[11px] font-semibold">Missing fields<input value={source.missingFields} onChange={(event) => updateCorroborationSource(index, 'missingFields', event.target.value)} placeholder="comma separated" className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2 text-xs" /></label></div></div>)}</div>
                  <div className="flex flex-col gap-2 sm:flex-row"><button type="button" onClick={() => setCorroborationSources((current) => [...current, blankCorroborationSource(detail.case.lossDate?.slice(0, 10) || undefined)])} className="inline-flex h-9 items-center justify-center rounded-md border border-border px-3 text-xs font-semibold">Add independent source</button><button type="button" disabled={busy} onClick={computeCorroboration} className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-primary px-3 text-xs font-semibold text-primary-foreground disabled:opacity-50">{compileCorroborationMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />} Compute corroboration</button></div>
                </div> : <div className="mt-4 rounded-lg border border-dashed border-border p-4 text-xs text-muted-foreground">Compile a valid claim graph and attach at least one source artifact before creating a deterministic corroboration assessment.</div>}

                {detail.corroborations.length > 0 && <div className="mt-4 space-y-3">{detail.corroborations.map((record) => <article key={record.id} className={cn('rounded-lg border p-4', record.status === 'verified' ? 'border-emerald-500/30 bg-emerald-500/[0.04]' : record.status === 'rejected' ? 'border-destructive/25 bg-destructive/[0.04]' : 'border-amber-500/25 bg-amber-500/[0.04]')}><div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start"><div><div className="flex flex-wrap items-center gap-2"><p className="text-sm font-semibold">Loss corroboration · v{record.version}</p><span className="rounded-full border border-border bg-background px-2 py-0.5 text-[10px] font-semibold uppercase">{record.status}</span><span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium">{(record.assessment.breakdown?.state || 'insufficient_evidence').replace(/_/g, ' ')}</span></div><p className="mt-2 text-xs text-muted-foreground">Confidence {record.assessment.breakdown?.confidenceScore ?? 0}/100 · Coverage {record.assessment.breakdown?.sourceCoverageScore ?? 0}/100 · Missingness {record.assessment.breakdown?.missingnessScore ?? 0}/100 · Consistency {record.assessment.breakdown?.crossSourceConsistencyScore ?? 0}/100</p><p className="mt-1 text-xs text-muted-foreground">{record.assessment.breakdown?.sourceCount ?? 0} sources / {record.assessment.breakdown?.distinctProviderCount ?? 0} providers · {record.assessment.contradictions?.length ?? 0} explicit contradiction{record.assessment.contradictions?.length === 1 ? '' : 's'}</p></div>{record.status === 'computed' && <div className="flex shrink-0 gap-2"><button disabled={busy} onClick={() => reviewCorroborationMutation.mutate({ id: record.id, status: 'verified' })} className="inline-flex h-8 items-center gap-1 rounded-md bg-emerald-600 px-3 text-xs font-semibold text-white disabled:opacity-50"><Check className="h-3.5 w-3.5" /> Verify inputs</button><button disabled={busy} onClick={() => reviewCorroborationMutation.mutate({ id: record.id, status: 'rejected' })} className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-3 text-xs font-semibold disabled:opacity-50"><X className="h-3.5 w-3.5" /> Reject</button></div>}</div><div className="mt-3 grid gap-2 rounded-md bg-background/50 p-3 font-mono text-[10px] text-muted-foreground sm:grid-cols-2"><p>Source manifest · {shortHash(record.sourceManifestHash)}</p><p>Assessment proof · {shortHash(record.assessmentHash)}</p></div>{record.assessment.limitations?.length ? <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">{record.assessment.limitations.join(' ')}</p> : null}</article>)}</div>}
              </section>}

              <section className="rounded-xl border border-primary/25 bg-card p-4 shadow-sm md:p-5">
                <div className="flex flex-col justify-between gap-4 md:flex-row md:items-start"><div><div className="flex items-center gap-2"><Sparkles className="h-5 w-5 text-primary" /><h3 className="font-semibold">2 · Build the grounded AI draft</h3></div><p className="mt-1 max-w-3xl text-sm text-muted-foreground">GPT-5.6 Sol receives only approved artifacts. Every finding must cite this case’s run-local evidence manifest or the entire draft is rejected.</p></div><button disabled={busy || detail.artifacts.length === 0 || detail.artifacts.some((item) => !item.aiUseApprovedAt)} onClick={() => { setNotice(null); setError(null); analyzeMutation.mutate(); }} className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-50">{analyzeMutation.isPending ? <><Loader2 className="h-4 w-4 animate-spin" /> Analyzing evidence…</> : <><ScanSearch className="h-4 w-4" /> Generate evidence draft</>}</button></div>
                {detail.runs[0]?.status === 'failed' && <p className="mt-3 rounded-lg border border-destructive/25 bg-destructive/5 p-3 text-sm text-destructive">Latest run failed: {detail.runs[0].error}</p>}
              </section>

              {currentCertificate && (
                <section className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
                  <div className="border-b border-border bg-muted/30 p-4 md:p-5"><div className="flex flex-col justify-between gap-3 md:flex-row md:items-start"><div><div className="flex flex-wrap items-center gap-2"><FileCheck2 className="h-5 w-5 text-primary" /><h3 className="font-semibold">Loss Evidence Certificate · v{currentCertificate.version}</h3><span className={cn('rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase', currentCertificate.status === 'issued' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700' : 'border-amber-500/30 bg-amber-500/10 text-amber-700')}>{currentCertificate.status === 'draft' ? 'AI draft · not issued' : currentCertificate.status}</span></div><p className="mt-2 max-w-4xl text-sm leading-relaxed text-muted-foreground">{currentCertificate.executiveSummary}</p></div><div className="shrink-0 rounded-lg border border-border bg-background px-3 py-2"><p className="text-[10px] font-semibold uppercase text-muted-foreground">{currentCertificate.status === 'issued' && currentCertificate.integrityHash ? 'Issued proof hash' : 'Draft content hash'}</p><p className="mt-1 font-mono text-[10px]">{shortHash(currentCertificate.status === 'issued' && currentCertificate.integrityHash ? currentCertificate.integrityHash : currentCertificate.contentHash)}</p></div></div></div>
                  <div className="space-y-4 p-4 md:p-5">
                    <div className="flex items-center justify-between"><div><h4 className="font-semibold">3 · Contractor observation review</h4><p className="mt-1 text-xs text-muted-foreground">Verify or reject every statement. Unreviewed AI output cannot be issued.</p></div><span className="text-xs text-muted-foreground">{currentObservations.filter((item) => item.status !== 'ai_draft').length}/{currentObservations.length} reviewed</span></div>
                    <div className="space-y-3">
                      {currentObservations.map((observation) => (
                        <article key={observation.id} className={cn('rounded-lg border p-4', observation.status === 'verified' ? 'border-emerald-500/30 bg-emerald-500/[0.05]' : observation.status === 'rejected' ? 'border-destructive/25 bg-destructive/[0.04]' : 'border-border bg-background/40')}>
                          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start"><div><div className="flex flex-wrap items-center gap-2"><span className="text-[10px] font-semibold uppercase tracking-wide text-primary">{observation.category}</span><span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium">{observation.confidence}% AI confidence</span>{observation.needsHumanReview && <span className="text-[10px] font-medium text-amber-700 dark:text-amber-300">Human review required</span>}</div><p className="mt-2 text-sm font-medium leading-relaxed">{observation.statement}</p>{observation.locator && <p className="mt-2 text-xs text-muted-foreground"><strong>Locator:</strong> {observation.locator}</p>}{observation.basis && <p className="mt-1 text-xs text-muted-foreground"><strong>Basis:</strong> {observation.basis}</p>}</div><div className="flex shrink-0 gap-2">{observation.status === 'ai_draft' ? <><button disabled={busy} onClick={() => reviewMutation.mutate({ id: observation.id, status: 'verified' })} className="inline-flex h-8 items-center gap-1 rounded-md bg-emerald-600 px-3 text-xs font-semibold text-white disabled:opacity-50"><Check className="h-3.5 w-3.5" /> Verify</button><button disabled={busy} onClick={() => reviewMutation.mutate({ id: observation.id, status: 'rejected' })} className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-3 text-xs font-semibold disabled:opacity-50"><X className="h-3.5 w-3.5" /> Reject</button></> : <span className={cn('inline-flex h-8 items-center gap-1 rounded-md px-3 text-xs font-semibold', observation.status === 'verified' ? 'bg-emerald-600 text-white' : 'bg-muted text-muted-foreground')}>{observation.status === 'verified' ? <Check className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}{observation.status}</span>}</div></div>
                        </article>
                      ))}
                    </div>

                    {(currentCertificate.conflicts.length > 0 || currentCertificate.gaps.length > 0 || currentCertificate.limitations.length > 0) && <div className="grid gap-3 lg:grid-cols-3">{currentCertificate.conflicts.length > 0 && <div className="rounded-lg border border-amber-500/25 bg-amber-500/[0.05] p-3"><p className="text-xs font-semibold text-amber-800 dark:text-amber-300">Conflicts</p>{currentCertificate.conflicts.map((item, index) => <p key={index} className="mt-2 text-xs text-muted-foreground">{item.summary}</p>)}</div>}{currentCertificate.gaps.length > 0 && <div className="rounded-lg border border-border p-3"><p className="text-xs font-semibold">Evidence gaps</p>{currentCertificate.gaps.map((item, index) => <p key={index} className="mt-2 text-xs text-muted-foreground"><strong>{item.title}</strong> · {item.reason}</p>)}</div>}{currentCertificate.limitations.length > 0 && <div className="rounded-lg border border-border p-3"><p className="text-xs font-semibold">Limitations</p>{currentCertificate.limitations.map((item, index) => <p key={index} className="mt-2 text-xs text-muted-foreground">{item}</p>)}</div>}</div>}

                    {currentCertificate.integrityHash && <div className="rounded-lg border border-primary/25 bg-primary/[0.04] p-4"><div className="flex items-start gap-2"><Fingerprint className="mt-0.5 h-5 w-5 shrink-0 text-primary" /><div><p className="text-sm font-semibold">Replayable proof package</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">This {currentCertificate.status === 'issued' ? 'issued' : 'draft'} certificate binds its content, frozen evidence manifest, model/prompt version, and contractor review ledger into one deterministic integrity package.</p><div className="mt-3 grid gap-2 font-mono text-[10px] text-muted-foreground sm:grid-cols-2"><p>Evidence manifest · {detail.runs.find((run) => run.id === currentCertificate.runId)?.manifestHash ? shortHash(detail.runs.find((run) => run.id === currentCertificate.runId)!.manifestHash) : 'legacy run'}</p><p>Integrity package · {shortHash(currentCertificate.integrityHash)}</p></div></div></div></div>}

                    <div className="flex flex-col justify-between gap-3 rounded-lg border border-primary/25 bg-primary/[0.05] p-4 md:flex-row md:items-center"><div className="flex items-start gap-2"><ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" /><div><p className="text-sm font-semibold">Authorized contractor issuance</p><p className="mt-1 text-xs text-muted-foreground">Issuing attests that the contractor reviewed the observations. It does not make this an insurance, engineering, legal, or coverage determination.</p></div></div>{currentCertificate.status === 'draft' ? <button disabled={busy || !readyToIssue} onClick={() => issueMutation.mutate(currentCertificate.id)} className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-50">{issueMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <BadgeCheck className="h-4 w-4" />} Issue certificate</button> : <span className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-md bg-emerald-600 px-4 text-sm font-semibold text-white"><BadgeCheck className="h-4 w-4" /> Issued {currentCertificate.issuedAt ? new Date(currentCertificate.issuedAt).toLocaleDateString() : ''}</span>}</div>
                  </div>
                </section>
              )}
            </>
          )}
        </main>
      </div>
      <p className="text-center text-xs text-muted-foreground">MogulForge Evidence Intelligence is a decision-support workflow. AI drafts remain visibly provisional until an authorized contractor reviews and issues them.</p>
    </div>
  );
}
