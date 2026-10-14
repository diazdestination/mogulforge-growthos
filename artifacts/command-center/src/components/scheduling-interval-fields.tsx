import { useEffect, useId, useRef, useState } from 'react';
import { addElapsedMinutes, formatSchedulingWallTime, resolveWallTime, schedulingMutationReviewSchema, schedulingReviewContextSchema, shiftElapsedInterval, timeZoneSchema, validateWallTime, type DurationChoice, type WallTimeEvidence } from '@workspace/scheduling-core';
import type { SchedulingDraft, SchedulingIntervalFieldsProps, SchedulingMutationReview } from '@/lib/scheduling-ui-contract';

const field = 'mt-1 block min-h-11 w-full min-w-0 rounded-lg border bg-background p-2 text-base';
const button = 'min-h-11 rounded-lg border px-4 py-2 text-sm font-medium disabled:opacity-50';
function controlledDraftKey(draft: SchedulingDraft) {
  return JSON.stringify([draft.startAt, draft.endAt, draft.resourceUserIds]);
}
function wallDisplay(instant: string | null, zone: string | null) {
  if (!instant || !zone) return '';
  try { return formatSchedulingWallTime(instant, zone).localDateTime; } catch { return ''; }
}
function resolve(local: string, zone: string | null) {
  try { return zone && local ? resolveWallTime(local, zone) : null; } catch { return null; }
}
function evidence(instant: string | null, local: string, zone: string | null): WallTimeEvidence | null {
  if (!instant || !zone) return null;
  try {
    const value = { ...formatSchedulingWallTime(instant, zone), localDateTime: local };
    validateWallTime(instant, value);
    return value;
  } catch { return null; }
}

export function SchedulingIntervalFields(props: SchedulingIntervalFieldsProps) {
  // Closed schema output orders known fields consistently; callbacks keep original context.
  const parsedContext = schedulingReviewContextSchema.safeParse(props.context);
  const contextKey = JSON.stringify([props.context === null ? null : parsedContext.success ? parsedContext.data : 'invalid_context', props.companyTimeZone, props.startOnlyBehavior ?? 'preserve_elapsed']);
  const previousContext = useRef(contextKey);
  useEffect(() => {
    if (previousContext.current !== contextKey) {
      previousContext.current = contextKey;
      props.onReviewChange(null);
      props.onDraftChange(props.draft);
    }
  }, [contextKey, props]);
  return <IntervalFields key={contextKey} {...props} />;
}

function IntervalFields(props: SchedulingIntervalFieldsProps) {
  const { context, companyTimeZone: zone, interval, draft, resources, presets, disabled } = props;
  const preserveAbsoluteEnd = props.startOnlyBehavior === 'preserve_absolute_end';
  const id = useId();
  const [startLocal, setStartLocal] = useState(() => wallDisplay(draft.startAt, zone));
  const [endLocal, setEndLocal] = useState(() => wallDisplay(draft.endAt, zone));
  const [endEdited, setEndEdited] = useState(false);
  const [duration, setDuration] = useState<DurationChoice>(() => ({ kind: draft.startAt === interval.startAt && draft.endAt === interval.endAt ? 'preserved_interval' : 'explicit', preset: null }));
  const [shiftError, setShiftError] = useState('');
  const [awaitingDraft, setAwaitingDraft] = useState<string | null>(null);
  const lastDraft = useRef(controlledDraftKey(draft));
  const pendingInterval = useRef<{ startAt: string; endAt: string } | null>(null);
  const incomingDraft = controlledDraftKey(draft);
  useEffect(() => {
    // A different draft in the same context is neither acknowledgement nor reset.
    if (awaitingDraft !== null && awaitingDraft !== incomingDraft) return;
    if (lastDraft.current !== incomingDraft) {
      lastDraft.current = incomingDraft;
      setStartLocal(wallDisplay(draft.startAt, zone));
      setEndLocal(wallDisplay(draft.endAt, zone));
      setDuration({ kind: 'explicit', preset: null });
      pendingInterval.current = null;
      setShiftError('');
    }
  }, [incomingDraft, draft, zone, awaitingDraft]);
  useEffect(() => { if (awaitingDraft === incomingDraft) setAwaitingDraft(null); }, [awaitingDraft, incomingDraft]);
  const authorityHeld = disabled || !context || !zone || context.companyTimeZone !== zone || interval.evidence === 'invalid' || !timeZoneSchema.safeParse(zone).success;
  const legacyNull = interval.evidence === 'legacy' && interval.endAt === null && interval.legacyEffectiveEnd !== null && !endEdited;
  const unchangedLegacyStart = legacyNull && !!draft.startAt && !!interval.startAt && new Date(draft.startAt).getTime() === new Date(interval.startAt).getTime();
  function reviewFor(next: SchedulingDraft, start: string, end: string, choice: DurationChoice, allowLegacyNull = unchangedLegacyStart): SchedulingMutationReview | null {
    if (authorityHeld || !context || !next.startAt) return null;
    const startWallTime = evidence(next.startAt, start, zone);
    const endWallTime = evidence(next.endAt, end, zone);
    if (!startWallTime || (next.endAt ? !endWallTime || new Date(next.endAt).getTime() <= new Date(next.startAt).getTime() : !allowLegacyNull)) return null;
    const value = { context, duration: choice, startWallTime, endWallTime };
    return schedulingMutationReviewSchema.safeParse(value).success ? value : null;
  }
  function publish(next: SchedulingDraft) {
    props.onReviewChange(null);
    lastDraft.current = controlledDraftKey(next);
    setAwaitingDraft(lastDraft.current);
    props.onDraftChange(next);
  }
  function editStart(local: string, selectedInstant?: string) {
    if (authorityHeld) return;
    setStartLocal(local);
    if (selectedInstant === undefined && (draft.startAt || !pendingInterval.current)) {
      const end = draft.endAt;
      const start = draft.startAt;
      pendingInterval.current = start && end ? { startAt: start, endAt: end } : null;
    }
    const resolved = resolve(local, zone);
    let start = selectedInstant ? resolved?.choices.find(choice => choice.instant === selectedInstant)?.instant ?? null : resolved?.kind === 'unique' ? resolved.choices[0].instant : null;
    let end = draft.endAt, error = '';
    const preserved = pendingInterval.current;
    if (!preserveAbsoluteEnd && start && (duration.preset || preserved)) {
      try {
        if (duration.preset) { end = addElapsedMinutes(start, duration.preset.elapsedMinutes); setEndLocal(wallDisplay(end, zone)); }
        else if (preserved) {
          const shifted = shiftElapsedInterval(preserved.startAt, preserved.endAt, start);
          start = shifted.startAt;
          end = shifted.endAt; setEndLocal(wallDisplay(end, zone));
        }
      } catch { error = 'This interval could not be shifted. Enter valid endpoints for review.'; }
    }
    setShiftError(error);
    const choice: DurationChoice = preserveAbsoluteEnd ? { kind: 'explicit', preset: null } : duration.kind === 'preset' ? duration : { kind: preserved ? 'preserved_interval' : 'explicit', preset: null };
    setDuration(choice);
    publish({ ...draft, startAt: start, endAt: end });
  }
  function editEnd(local: string, selectedInstant?: string) {
    if (authorityHeld) return;
    setEndLocal(local); setEndEdited(true); setShiftError(''); pendingInterval.current = null;
    const resolved = resolve(local, zone);
    const endAt = selectedInstant ? resolved?.choices.find(choice => choice.instant === selectedInstant)?.instant ?? null : resolved?.kind === 'unique' ? resolved.choices[0].instant : null;
    const choice: DurationChoice = { kind: 'explicit', preset: null };
    setDuration(choice);
    publish({ ...draft, endAt });
  }
  function selectPreset(presetId: string) {
    if (authorityHeld) return;
    const preset = presets.find(preset => preset.id === presetId);
    const choice: DurationChoice = preset ? { kind: 'preset', preset: { ...preset } } : { kind: 'explicit', preset: null };
    let end = draft.endAt;
    if (preset && draft.startAt) {
      try { end = addElapsedMinutes(draft.startAt, preset.elapsedMinutes); } catch { end = null; }
    }
    const local = wallDisplay(end, zone);
    setDuration(choice); setEndLocal(local); setEndEdited(!!preset || endEdited); setShiftError(''); pendingInterval.current = null;
    publish({ ...draft, endAt: end });
  }
  function timeError(local: string, instant: string | null, name: string, optional = false) {
    const resolved = resolve(local, zone);
    if (!local && optional) return '';
    if (!resolved) return `${name}: Enter a valid local date and time.`;
    if (resolved.kind === 'nonexistent') return `${name}: This local time does not exist in ${zone}.`;
    if (resolved.kind === 'ambiguous' && !evidence(instant, local, zone)) return `${name}: Choose an explicit occurrence and offset.`;
    return '';
  }
  const error = interval.evidence === 'invalid' ? 'Saved scheduling evidence is invalid. Review held for recovery.' : authorityHeld ? 'Scheduling held: Current company time zone and matching review context are required.' : shiftError || timeError(startLocal, draft.startAt, 'Start') || (legacyNull && draft.endAt === null && !unchangedLegacyStart ? 'Choose a duration preset or enter a valid end after changing a legacy empty-end start.' : '') || timeError(endLocal, draft.endAt, 'End', legacyNull) || (draft.startAt && draft.endAt && new Date(draft.endAt).getTime() <= new Date(draft.startAt).getTime() ? 'End must follow start.' : '');
  const readyReview = !error && (awaitingDraft === null || awaitingDraft === incomingDraft) ? reviewFor(draft, startLocal, endLocal, duration) : null;
  function occurrence(name: string, local: string, instant: string | null, edit: (local: string, instant: string) => void) {
    const resolved = resolve(local, zone);
    if (resolved?.kind !== 'ambiguous') return null;
    const selectedOffset = evidence(instant, local, zone)?.offset;
    const selected = resolved.choices.find(choice => choice.offset === selectedOffset)?.instant ?? '';
    return <label className="block text-sm">{name} occurrence<select className={field} disabled={authorityHeld} value={selected} onChange={event => edit(local, event.target.value)}><option value="">Choose occurrence</option>{resolved.choices.map((choice, index) => <option key={choice.instant} value={choice.instant}>{index === 0 ? 'First' : 'Second'} occurrence · UTC{choice.offset} · {choice.instant}</option>)}</select></label>;
  }
  const startEvidence = evidence(draft.startAt, startLocal, zone), endEvidence = evidence(draft.endAt, endLocal, zone);
  const unknownResources = draft.resourceUserIds.filter(resource => !resources.some(choice => choice.id === resource));
  return <section aria-label="Service interval" className="w-full min-w-0 space-y-4">
    <p className="break-words text-sm">Company time zone: {zone ?? 'Unavailable'} · Start offset: {startEvidence?.offset ?? 'Unresolved'} · End offset: {endEvidence?.offset ?? (legacyNull ? 'Legacy empty end' : 'Unresolved')}</p>
    {context?.inspection && <><p className="break-words text-sm">Inspection rule time zone: {context.inspection.ruleTimeZone} · Source: {context.inspection.sourceState}</p><p className="break-all text-xs">Inspection availability digest: {context.inspection.availabilityDigest}</p></>}
    {error && <p role="alert" className="rounded-lg border border-destructive p-3 text-sm">{error}</p>}
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="min-w-0"><label htmlFor={`${id}-start`} className="block text-sm">Service start</label><input id={`${id}-start`} className={field} type="datetime-local" step="0.001" value={startLocal} disabled={authorityHeld} onChange={event => editStart(event.target.value)} />{occurrence('Service start', startLocal, draft.startAt, editStart)}</div>
      <div className="min-w-0"><label htmlFor={`${id}-end`} className="block text-sm">Service end</label><input id={`${id}-end`} className={field} type="datetime-local" step="0.001" value={endLocal} disabled={authorityHeld} onChange={event => editEnd(event.target.value)} />{occurrence('Service end', endLocal, draft.endAt, editEnd)}</div>
    </div>
    <label className="block text-sm">Duration preset<select className={field} disabled={authorityHeld} value={duration.preset?.id ?? ''} onChange={event => selectPreset(event.target.value)}><option value="">Manual / preserved interval — no preset selected</option>{presets.map(preset => <option key={preset.id} value={preset.id}>{preset.label} · {preset.elapsedMinutes} elapsed minutes</option>)}</select></label>
    <p className="text-sm text-muted-foreground">Manual endpoints may span multiple days. {preserveAbsoluteEnd ? 'A start-only change keeps the absolute end and clears the selected duration preset.' : 'A start-only change preserves elapsed duration.'} Travel does not extend the service interval.</p>
    {legacyNull && <p className="text-sm">Legacy stored end remains empty. Its supplied effective interval is compatibility evidence.</p>}
    <fieldset disabled={authorityHeld} className="space-y-2"><legend className="text-sm font-medium">Assigned resources</legend>{resources.map(resource => <label key={resource.id} className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={draft.resourceUserIds.includes(resource.id)} onChange={event => publish({ ...draft, resourceUserIds: event.target.checked ? [...draft.resourceUserIds, resource.id] : draft.resourceUserIds.filter(id => id !== resource.id) })} />{resource.label}</label>)}{unknownResources.map(resource => <p key={resource} className="break-all text-sm">Assigned resource not in current choices: {resource}</p>)}</fieldset>
    {!draft.resourceUserIds.length && <p className="text-sm">Unassigned. This does not establish availability.</p>}
    <button type="button" className={button} disabled={!readyReview} onClick={() => { if (readyReview) props.onReviewChange(readyReview); }}>Review interval</button>
    <p role="status" className="text-sm">{readyReview ? 'Complete interval; final checks run when saving.' : 'Interval review held.'}</p>
  </section>;
}
