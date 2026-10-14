import type { SchedulingTravelReviewProps } from "@/lib/scheduling-ui-contract";
import { isoSchema, reservationSnapshotSchema, timeZoneSchema } from "@workspace/scheduling-core";

function endpoint(value: string, zone: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "longOffset" }).format(new Date(value));
}

/** A display of root-authorized evidence, never a client-side availability check. */
export function SchedulingReservationSummary({ companyTimeZone, interval, proposal, resources, conflict }: SchedulingTravelReviewProps) {
  const frame = "mt-3 space-y-2 rounded-lg border border-border bg-muted/30 p-3 text-xs leading-relaxed break-words";
  if (!timeZoneSchema.safeParse(companyTimeZone).success) {
    return <div role="alert" className={frame}>A valid current company time zone is required. Scheduling display is held.</div>;
  }
  const zone = companyTimeZone!;
  const saved = interval.reservation;
  const corrupt = interval.evidence === "invalid" ||
    (interval.evidence === "versioned" && (!saved || !reservationSnapshotSchema.safeParse(saved).success)) ||
    (interval.evidence === "legacy" && saved !== null);
  const start = proposal?.startAt ?? saved?.startAt ?? interval.startAt;
  const end = proposal?.endAt ?? saved?.endAt ?? interval.endAt ?? interval.legacyEffectiveEnd;
  const invalidInterval = (start !== null && !isoSchema.safeParse(start).success) ||
    (end !== null && !isoSchema.safeParse(end).success) ||
    (start !== null && end !== null && new Date(end).getTime() <= new Date(start).getTime()) ||
    (start === null && end !== null);
  if (corrupt || invalidInterval) {
    return <div role="alert" className={frame}>Scheduling evidence is invalid. Review is held; saved protection cannot be assumed.</div>;
  }
  const staff = proposal?.resourceUserIds ?? saved?.resourceUserIds ?? [];
  const labels = [...new Set(staff)].map(id => resources.find(item => item.id === id)?.label || "Assigned staff (name unavailable)");
  const legacyWindow = !proposal && !saved && interval.endAt === null && interval.legacyEffectiveEnd !== null;
  return (
    <div role="group" aria-label="Scheduling reservation" className={frame}>
      <p className="font-medium">{proposal?.basis === "new_admission" ? "Proposed service interval" : proposal ? "Retained service interval" : legacyWindow ? "Legacy compatibility window" : "Service interval"}</p>
      <p>Current company zone: {zone}</p>
      {start && end ? <>
        <p>Service start: <time dateTime={start}>{endpoint(start, zone)}</time></p>
        <p>Service end: <time dateTime={end}>{endpoint(end, zone)}</time></p>
        <p>{(new Date(end).getTime() - new Date(start).getTime()) / 60_000} elapsed minutes. Travel does not extend the service interval.</p>
      </> : <p>{start ? <>Service start: <time dateTime={start}>{endpoint(start, zone)}</time>. End not recorded.</> : "Service dates not set."}</p>}
      {!saved && !proposal && interval.endAt === null && <p>Saved end: Not recorded (legacy)</p>}
      <p>{labels.length ? `Resources: ${labels.join(", ")}. Technician availability has not been checked.` : !saved && !proposal ? "Technician availability has not been checked." : "Unassigned — technician availability has not been checked."}</p>
      {saved ? <>
        <p>Saved travel gap: {saved.minimumTravelGapMinutes} minutes. Retained independently of current policy changes.</p>
        <p>Saved end: {saved.endAt}</p>
        {saved.duration.preset && <p>Saved preset: {saved.duration.preset.label} · {saved.duration.preset.elapsedMinutes} minutes · {saved.duration.preset.id}</p>}
        <p>Reservation revision: {saved.reservationRevision} · {saved.lastTransition.kind === "release" ? "Saved release" : "Saved admission"}</p>
        <p>Source policy revision: {saved.sourcePolicyRevision}</p>
        <p className="break-all">Source policy digest: {saved.sourcePolicyDigest}</p>
        <p>Approved company zone: {saved.approvedTimeZone} (historical)</p>
        {saved.inspection && <>
          <p>Inspection rule zone: {saved.inspection.ruleTimeZone} · {saved.inspection.sourceState.replaceAll("_", " ")}</p>
          <p className="break-all">Inspection availability digest: {saved.inspection.availabilityDigest}</p>
        </>}
      </> : !proposal && <p>Legacy travel gap: 0 minutes. No saved scheduling policy or preset evidence.</p>}
      {proposal?.basis === "new_admission" && <>
        <p>Proposed travel gap: {proposal.appliedTravelGapMinutes} minutes</p>
        <div><p>Company reservation cap: {proposal.companyCeiling ?? "Not configured"}</p>{proposal.companyCeiling !== null && <p>Rechecked when saving{proposal.companyGate.message && proposal.companyGate.message !== "Rechecked when saving" ? ` · ${proposal.companyGate.message}` : ""}</p>}</div>
        <div><p>Inspection reservation cap: {proposal.inspectionCeiling ?? "Not configured"}</p>{proposal.inspectionCeiling !== null && <p>Rechecked when saving{proposal.inspectionGate.message && proposal.inspectionGate.message !== "Rechecked when saving" ? ` · ${proposal.inspectionGate.message}` : ""}</p>}</div>
      </>}
      {proposal && proposal.basis !== "new_admission" && <p>Recorded work is retained; no new capacity admission is requested.</p>}
      {conflict && isoSchema.safeParse(conflict.startAt).success && isoSchema.safeParse(conflict.endAt).success && <div role="alert">
        <p>Staff resource conflict: {conflict.resourceLabel}</p>
        <p>{conflict.reservationKind} · {conflict.reservationId} · {endpoint(conflict.startAt, zone)} – {endpoint(conflict.endAt, zone)}</p>
        <p>{conflict.reason}</p>
      </div>}
    </div>
  );
}
