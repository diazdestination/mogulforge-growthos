import { formatSchedulingWallTime, timeZoneSchema } from '@workspace/scheduling-core';
import type { SchedulingTravelReviewProps } from '@/lib/scheduling-ui-contract';
function time(value: string | null, zone: string) {
  if (!value) return 'Empty';
  try {
    const wall = formatSchedulingWallTime(value, zone);
    return `${wall.localDateTime.replace('T', ' ')} UTC${wall.offset}`;
  } catch { return 'Invalid endpoint'; }
}
export function SchedulingIntervalReview({ companyTimeZone: zone, interval, proposal, resources, conflict }: SchedulingTravelReviewProps) {
  const validZone = !!zone && timeZoneSchema.safeParse(zone).success;
  const saved = interval.reservation;
  const start = proposal?.startAt ?? interval.startAt;
  const end = proposal?.endAt ?? interval.endAt;
  const assigned = proposal?.resourceUserIds ?? saved?.resourceUserIds ?? [];
  function endpoint(value: string | null) { return time(value, zone!); }
  function gate(cap: number | null, name: string) {
    const retained = proposal?.basis === 'saved_release' || proposal?.basis === 'saved_preservation';
    return <div><p>{name} capacity: {retained ? 'Recorded work retained' : cap ?? 'Not configured'}</p><p>{retained ? 'Recorded work is retained; no new capacity admission is requested.' : cap === null ? 'No configured capacity gate' : 'Rechecked when saving'}</p></div>;
  }
  return <section aria-label="Interval and travel review" className="w-full min-w-0 space-y-3 rounded-lg border p-4 text-sm">
    <h3 className="font-semibold">Interval and travel review</h3>
    {!validZone ? <p role="alert">Current company time zone is unavailable or invalid. Review held.</p> : interval.evidence === 'invalid' ? <p role="alert">Saved scheduling evidence is invalid. Review held for recovery.</p> : <>
      <p className="break-words">Current company time zone: {zone}</p>
      <p>Service start: {endpoint(start)}</p><p>Service end: {endpoint(end)}</p>
      <p className="text-muted-foreground">Service endpoints exclude travel. Travel is a required gap between adjacent assigned work.</p>
      {!proposal && <p role="status">Review pending. Final checks run when saving.</p>}
      {proposal && <><p>{proposal.basis === 'saved_release' ? 'Resource release; surviving saved protection retained.' : proposal.basis === 'saved_preservation' ? 'Saved protection preserved.' : 'New admission proposal.'}</p><p>Travel gap: {proposal.appliedTravelGapMinutes} minutes</p><div className="grid gap-3 sm:grid-cols-2">{gate(proposal.companyCeiling, 'Company')}{gate(proposal.inspectionCeiling, 'Inspection')}</div></>}
      <p className="break-words">Assigned resources: {assigned.length ? assigned.map(id => resources.find(resource => resource.id === id)?.label ?? `Assigned staff (${id})`).join(', ') : 'Unassigned'}. This does not establish availability.</p>
      {conflict && <div role="alert" className="space-y-1 rounded-lg border border-destructive p-3"><p>Staff resource conflict: {conflict.resourceLabel}</p><p>{conflict.reason}</p><p className="break-all">Authorized adjacent reference: {conflict.reservationKind} {conflict.reservationId}</p><p>{endpoint(conflict.startAt)} – {endpoint(conflict.endAt)}</p></div>}
      {saved ? <div className="space-y-1 border-t pt-3"><p>Historical approved zone: {saved.approvedTimeZone}</p><p>Saved service end: {endpoint(saved.endAt)}</p><p>Saved travel gap: {saved.minimumTravelGapMinutes} minutes</p><p>Source policy revision: {saved.sourcePolicyRevision} · Reservation revision: {saved.reservationRevision}</p><p className="break-all">Source policy digest: {saved.sourcePolicyDigest}</p><p>Saved duration: {saved.duration.preset ? `${saved.duration.preset.label} · ${saved.duration.preset.elapsedMinutes} elapsed minutes` : saved.duration.kind.replaceAll('_', ' ')}</p>{saved.inspection && <><p className="break-words">Inspection rule time zone: {saved.inspection.ruleTimeZone} · Source: {saved.inspection.sourceState}</p><p className="break-all">Inspection availability digest: {saved.inspection.availabilityDigest}</p></>}</div> : interval.startAt !== null ? <div className="border-t pt-3"><p>Legacy travel gap: 0 minutes</p>{interval.endAt === null && <><p>Stored end: Empty</p><p>Legacy effective end: {endpoint(interval.legacyEffectiveEnd)}</p></>}</div> : <p className="border-t pt-3">No saved reservation snapshot.</p>}
    </>}
  </section>;
}
