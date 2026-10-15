import { useEffect, useId, useRef, useState } from 'react';
import { policySaveInputSchema, schedulingPolicySchema } from '@workspace/scheduling-core';
import type { PolicyReadResult, PolicySaveInput, SchedulingPolicyPanelProps, SchedulingReviewContext } from '@/lib/scheduling-ui-contract';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

type RequestState = { kind: 'pending' | 'completed' | 'stale' | 'unknown' | 'refused'; message: string };
const requiredNumber = (value: string) => value === '' ? Number.NaN : Number(value);
const numberText = (value: number) => Number.isFinite(value) ? String(value) : '';

// Fixed field order preserves semantic identity across equivalent parent clones.
function contextIdentity(context: SchedulingReviewContext | null) {
  return JSON.stringify(context === null ? null : [
    context.organizationId, context.policyRevision, context.policyDigest, context.companyTimeZone,
    context.inspection === null ? null : [context.inspection.ruleTimeZone, context.inspection.availabilityDigest, context.inspection.sourceState],
    [context.applicableRules.newTravelGapMinutes, context.applicableRules.companyCeiling, context.applicableRules.inspectionCeiling],
    context.source === null ? null : [context.source.sourceKind, context.source.leadId, context.source.contactId, context.source.propertyId, context.source.estimateId],
    context.targetVersion, context.targetFingerprint,
  ]);
}

/** Draft and saved authority belong to the parent; local state only fences dispatch. */
export function SchedulingPolicyEditor(props: SchedulingPolicyPanelProps) {
  const { state } = props;
  const context = 'value' in state ? state.value.context : null;
  const requestContextKey = JSON.stringify([state.scope.organizationId, state.scope.actorUserId, contextIdentity(context)]);
  return <ScopedPolicyEditor key={requestContextKey} {...props} requestContextKey={requestContextKey} />;
}

function ScopedPolicyEditor({ state, draft, canManage, onDraftChange, onSave, onRefresh, requestContextKey }: SchedulingPolicyPanelProps & { requestContextKey: string }) {
  const id = useId();
  const value = 'value' in state ? state.value : null;
  const latestContext = useRef<string | null>(requestContextKey);
  latestContext.current = requestContextKey;
  useEffect(() => {
    latestContext.current = requestContextKey;
    return () => { latestContext.current = null; };
  }, [requestContextKey]);
  const requestRef = useRef<RequestState | null>(null);
  const [request, setRequest] = useState<RequestState | null>(null);
  const [refreshBasis, setRefreshBasis] = useState<PolicyReadResult | null>(null);
  const scopeMismatch = value !== null && value.context.organizationId !== state.scope.organizationId;
  const visibleValue = scopeMismatch ? null : value;
  const visibleDraft = scopeMismatch ? null : draft;
  const activeRequest = scopeMismatch ? null : request;
  const ready = (state.kind === 'loaded' || state.kind === 'unconfigured') && visibleValue !== null;
  // A passive parent clone is not permission to dispatch again. Only an explicit
  // refresh returning authoritative props may release a settled local hold.
  useEffect(() => {
    if (refreshBasis && ready && value !== refreshBasis) {
      requestRef.current = null;
      setRequest(null);
      setRefreshBasis(null);
    }
  }, [refreshBasis, ready, value]);
  const editable = canManage && ready && activeRequest === null;
  const parsed = visibleDraft ? policySaveInputSchema.safeParse(visibleDraft) : null;
  let validation: string | null = null;
  if (ready) {
    if (!visibleDraft) validation = 'Scheduling draft unavailable. Refresh scheduling settings.';
    else if (parsed && !parsed.success) validation = parsed.error.issues.map(issue => `${issue.path.join('.') || 'Policy'}: ${issue.message}`).join('; ');
    else if (visibleDraft.expectedRevision !== visibleValue.context.policyRevision || visibleDraft.expectedCompanyTimeZone !== visibleValue.context.companyTimeZone) {
      validation = 'This draft uses an older scheduling revision or company time zone. Refresh scheduling settings before saving.';
    } else if (visibleValue.policy && (!schedulingPolicySchema.safeParse(visibleValue.policy).success || visibleValue.policy.revision !== visibleValue.context.policyRevision)) {
      validation = 'Saved scheduling policy is invalid. Refresh scheduling settings for recovery.';
    } else if (!visibleValue.policy && visibleValue.context.policyRevision !== 0) {
      validation = 'Saved scheduling revision is invalid. Refresh scheduling settings for recovery.';
    } else if (visibleDraft.durationPresets.some(preset => preset.id !== null && !visibleValue.policy?.durationPresets.some(saved => saved.id === preset.id))) {
      validation = 'A duration preset does not belong to the saved policy. Refresh scheduling settings before saving.';
    }
  }
  const canSave = editable && parsed?.success === true && validation === null;

  function change(patch: Partial<PolicySaveInput>) {
    if (editable && visibleDraft) onDraftChange({ ...visibleDraft, ...patch });
  }

  async function save() {
    // Ref closes the same-event duplicate window before React renders disabled controls.
    if (!canSave || !visibleValue || !parsed?.success || requestRef.current !== null) return;
    const basis = requestContextKey;
    const pending: RequestState = { kind: 'pending', message: 'Saving scheduling settings…' };
    requestRef.current = pending;
    setRequest(pending);
    let next: RequestState;
    try {
      const result = await onSave(structuredClone(parsed.data));
      next = result.kind === 'saved'
        ? { kind: 'completed', message: 'Save response received. Waiting for refreshed saved settings.' }
        : { kind: result.kind, message: result.message };
    } catch {
      next = { kind: 'unknown', message: 'Save outcome unknown. Refresh saved settings before any further save. No automatic retry was made.' };
    }
    if (latestContext.current !== basis) return;
    requestRef.current = next;
    setRequest(next);
  }

  const stateMessage = scopeMismatch ? 'Scheduling scope changed. Refresh scheduling settings.'
    : state.kind === 'loading' ? 'Loading scheduling settings…'
    : 'message' in state ? state.message : null;
  const stateTitle = scopeMismatch ? 'Scheduling settings unavailable'
    : state.kind === 'unconfigured' ? 'Not configured'
    : state.kind === 'loaded' ? 'Saved scheduling settings'
    : ({ loading: 'Loading', read_error: 'Unable to read scheduling settings', invalid: 'Invalid scheduling settings', saving: 'Saving scheduling settings', stale: 'Scheduling settings changed', unknown: 'Save outcome unknown' } as const)[state.kind];

  return (
    <Card aria-label="Scheduling policy">
      <CardHeader>
        <CardTitle>Scheduling policy</CardTitle>
        <CardDescription>Set company reservation limits, travel gaps and explicit elapsed duration presets. Inspection availability remains separate.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-1 text-sm" aria-live="polite">
          <p className="font-medium">{stateTitle}</p>
          {visibleValue && <p>Company time zone: {visibleValue.context.companyTimeZone}</p>}
          {visibleValue?.policy && <p>Saved policy: {visibleValue.policy.enabled ? 'enabled' : 'disabled'} · Revision {visibleValue.policy.revision}</p>}
          {visibleValue && !visibleValue.policy && <p>No saved scheduling policy. First explicit save creates revision 1.</p>}
        </div>
        {stateMessage && <p role={state.kind === 'loading' ? 'status' : 'alert'} className="text-sm">{stateMessage}</p>}
        {!canManage && <p className="text-sm text-muted-foreground">Scheduling settings require settings management permission to edit.</p>}
        {validation && <p role="alert" className="text-sm text-destructive">{validation}</p>}
        {activeRequest && <p role={activeRequest.kind === 'pending' || activeRequest.kind === 'completed' ? 'status' : 'alert'} className="text-sm">{activeRequest.message}</p>}
        <form noValidate onSubmit={event => { event.preventDefault(); void save(); }} className="space-y-5">
          {visibleDraft && <>
            <div className="flex items-center gap-3">
              <Switch id={`${id}-enabled`} checked={visibleDraft.enabled} disabled={!editable} onCheckedChange={enabled => change({ enabled })} />
              <Label htmlFor={`${id}-enabled`}>Enable scheduling policy</Label>
            </div>
            <p className="text-sm text-muted-foreground">Disabling retains the saved policy and preset IDs. Existing reservations keep their saved protection; changes apply to new admissions.</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor={`${id}-gap`}>Minimum travel gap (minutes)</Label>
                <Input id={`${id}-gap`} type="number" min={0} max={1440} step={1} disabled={!editable} value={numberText(visibleDraft.minimumTravelGapMinutes)} onChange={event => change({ minimumTravelGapMinutes: requiredNumber(event.target.value) })} />
                <p className="text-xs text-muted-foreground">0–1440 elapsed minutes. Travel never extends service endpoints.</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor={`${id}-cap`}>Company concurrent reservation limit</Label>
                <Input id={`${id}-cap`} type="number" min={1} max={100} step={1} disabled={!editable} value={visibleDraft.maxConcurrentReservations === null ? '' : numberText(visibleDraft.maxConcurrentReservations)} onChange={event => change({ maxConcurrentReservations: event.target.value === '' ? null : Number(event.target.value) })} />
                <p className="text-xs text-muted-foreground">1–100 reservations, or leave blank for no company ceiling. Staff overlap and inspection limits still apply.</p>
              </div>
            </div>
            <fieldset className="space-y-3">
              <legend className="mb-2 text-sm font-medium">Duration presets</legend>
              <p className="text-xs text-muted-foreground">Presets are selected explicitly when scheduling. No service type or staff assignment is inferred.</p>
              {visibleDraft.durationPresets.map((preset, index) => (
                <div key={`${preset.id ?? 'new'}-${index}`} className="grid gap-3 rounded-md border p-3 sm:grid-cols-[1fr_9rem_auto] sm:items-end">
                  <div className="space-y-2">
                    <Label htmlFor={`${id}-preset-${index}-label`}>Preset {index + 1} label</Label>
                    <Input id={`${id}-preset-${index}-label`} disabled={!editable} value={preset.label} onChange={event => change({ durationPresets: visibleDraft.durationPresets.map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value } : item) })} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={`${id}-preset-${index}-minutes`}>Preset {index + 1} elapsed minutes</Label>
                    <Input id={`${id}-preset-${index}-minutes`} type="number" min={1} max={1440} step={1} disabled={!editable} value={numberText(preset.elapsedMinutes)} onChange={event => change({ durationPresets: visibleDraft.durationPresets.map((item, itemIndex) => itemIndex === index ? { ...item, elapsedMinutes: requiredNumber(event.target.value) } : item) })} />
                  </div>
                  <Button type="button" variant="outline" disabled={!editable} aria-label={`Remove preset ${index + 1}`} onClick={() => change({ durationPresets: visibleDraft.durationPresets.filter((_, itemIndex) => itemIndex !== index) })}>Remove</Button>
                </div>
              ))}
              <Button type="button" variant="outline" disabled={!editable || visibleDraft.durationPresets.length >= 50} onClick={() => change({ durationPresets: [...visibleDraft.durationPresets, { id: null, label: '', elapsedMinutes: Number.NaN }] })}>Add duration preset</Button>
            </fieldset>
          </>}
          <div className="flex flex-wrap gap-3">
            <Button type="submit" disabled={!canSave}>Save scheduling settings</Button>
            <Button type="button" variant="outline" disabled={state.kind === 'loading' || state.kind === 'saving' || activeRequest?.kind === 'pending'} onClick={() => { setRefreshBasis(value); onRefresh(); }}>Refresh scheduling settings</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
