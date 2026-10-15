import { useEffect, useRef, useState } from 'react';
import {
  createProject,
  updateProject,
  getSchedulingReviewContext,
  getSchedulingPolicy,
  reconcileSchedulingOperation,
  updateLead as updateLeadRequest,
  getListProjectsQueryKey,
  getListLeadsQueryKey,
  getListEstimatesQueryKey,
  getListUsersQueryKey,
  getGetMeQueryKey,
  useListEstimates,
  useListUsers,
  useGetMe,
  type MemberProfile,
  type Project,
} from "@workspace/api-client-react";
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  classifyReservationTransition,
  effectiveReservation,
  manualSourceRefSchema,
  schedulingReviewContextSchema,
  type ManualSourceRef,
  type SchedulingCandidate,
} from "@workspace/scheduling-core";
import { toast as globalToast } from "@/hooks/use-toast";
import { ToastAction } from '@/components/ui/toast';
import LeadSelect from "./lead-select";
import { canAssignWork } from "@/lib/contractor-schedule";
import { CustomerWorkForm, type CustomerWorkActor } from './customer-work-form';
import { customerWorkCommandKey } from '@/hooks/use-customer-work-command';
import { memberAuthorityScope } from "@/lib/member-authority-scope";
import { useManualSchedulingCommand } from "@/hooks/use-manual-scheduling-command";
import {
  useSchedulingAuthority,
  useSchedulingContext,
  useSchedulingReview,
} from "@/hooks/use-scheduling-review";
import {
  buildSchedulingProposalView,
  manualSchedulingSourceKey,
  parseManualSchedulingCustody,
} from "@/lib/scheduling-command";
import { SchedulingIntervalFields } from "./scheduling-interval-fields";
import { SchedulingIntervalReview } from "./scheduling-interval-review";
import { SchedulingReservationSummary } from "./scheduling-reservation-summary";
import type { IntervalInput } from "@/lib/scheduling-ui-contract";

export interface ProjectFormDefaults {
  leadId?: string;
  leadLabel?: string;
  estimateId?: string;
  name?: string;
  offerLeadAdvance?: boolean;
}
const field = "min-h-11 w-full rounded border bg-background p-2 text-base";
const button = "min-h-11 rounded border px-4 py-2 disabled:opacity-50";

// Discover only this selected source in the existing native custody namespace.
// A current admission GET cannot recover the original contact/property tuple.
async function retainedProjectSource(
  scope: { organizationId: string; actorUserId: string },
  leadId: string,
  estimateId: string,
) {
  if (!leadId) return null;
  const prefix = `growthos.scheduling.pending.v1:${scope.organizationId}:${scope.actorUserId}:project_create:`;
  const matching = () => {
    const entries: { key: string; sourceKey: string; bytes: string }[] = [];
    for (let index = 0; index < sessionStorage.length; index++) {
      const key = sessionStorage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const sourceKey = key.slice(prefix.length);
      const tuple: unknown = JSON.parse(sourceKey);
      if (!Array.isArray(tuple)) throw new Error('Unverifiable native source key');
      if (tuple[1] !== leadId || tuple[4] !== (estimateId || null)) continue;
      if (tuple.length !== 5) throw new Error('Unverifiable native source tuple');
      const source = manualSourceRefSchema.parse({
        sourceKind: tuple[0], leadId: tuple[1], contactId: tuple[2], propertyId: tuple[3], estimateId: tuple[4],
      });
      if (source.sourceKind !== 'lead' || manualSchedulingSourceKey(source) !== sourceKey)
        throw new Error('Unverifiable native source binding');
      const bytes = sessionStorage.getItem(key);
      if (bytes === null) throw new Error('Original custody disappeared');
      entries.push({ key, sourceKey, bytes });
    }
    return entries.sort((a, b) => a.key.localeCompare(b.key));
  };
  const entries = matching();
  if (entries.length > 1) throw new Error('Ambiguous original project source');
  if (entries[0]) await parseManualSchedulingCustody(entries[0].bytes, scope, 'project_create', entries[0].sourceKey);
  if (JSON.stringify(matching()) !== JSON.stringify(entries)) throw new Error('Original custody changed during discovery');
  return entries[0]?.sourceKey ?? null;
}
export default function ProjectFormModal({
  project,
  defaults,
  initialLeadId,
  initialContactId,
  authority: supplied,
  onClose,
}: {
  project: Project | null;
  defaults?: ProjectFormDefaults;
  initialLeadId?: string;
  initialContactId?: string;
  authority?: CustomerWorkActor;
  onClose: () => void;
}) {
  const profile = useGetMe(),
    client = useQueryClient();
  const actor =
    supplied ?? (profile.data?.organization ? { id: profile.data.id, organizationId: profile.data.organization.id, scopeKey: memberAuthorityScope(profile.data) } : null);
  const authority = useSchedulingAuthority(
    actor
      ? {
          organizationId: actor.organizationId,
          actorUserId: actor.id,
          scopeKey: actor.scopeKey,
        }
      : null,
  );
  const [returning, setReturning] = useState(() => { try { return !!initialContactId || (!!actor && !!sessionStorage.getItem(customerWorkCommandKey(actor.id, actor.organizationId, 'projects:new'))); } catch { return !!initialContactId; } });
  const [name, setName] = useState(project?.name ?? defaults?.name ?? ""),
    [leadId, setLeadId] = useState(
      project?.leadId ?? defaults?.leadId ?? initialLeadId ?? "",
    );
  const [estimateId, setEstimateId] = useState(
      project?.estimateId ?? defaults?.estimateId ?? "",
    ),
    [crewNotes, setCrewNotes] = useState(project?.crewNotes ?? "");
  const [status, setStatus] = useState(project?.status ?? "scheduled"), [advanceLead, setAdvanceLead] = useState(defaults?.offerLeadAdvance ?? false);
  const [formError, setFormError] = useState(""),
    [patchState, setPatchState] = useState<"idle" | "saving" | "unknown">(
      "idle",
    ),
    [future, setFuture] = useState(false);
  const { data: users } = useListUsers({
    query: {
      queryKey: [...getListUsersQueryKey(), actor?.scopeKey],
      enabled: authority.allowed,
    },
  });
  const { data: estimates } = useListEstimates(undefined, {
    query: {
      queryKey: [...getListEstimatesQueryKey(), actor?.scopeKey],
      enabled: authority.allowed,
    },
  });
  const selection = JSON.stringify([
    project?.id ?? "new",
    leadId,
    estimateId,
    project?.updatedAt ?? null,
    project?.schedulingTargetFingerprint ?? null,
  ]);
  const read = useSchedulingContext({
    authority,
    identity: selection,
    enabled: !returning && !!leadId && authority.allowed,
    load: async () => {
      const [raw, policy] = await Promise.all([
        getSchedulingReviewContext({
          sourceKind: "lead",
          sourceId: leadId,
          ...(estimateId ? { estimateId } : {}),
          reservationKind: "project",
          ...(project ? { targetKind: "project", targetId: project.id } : {}),
        }),
        getSchedulingPolicy(),
      ]);
      const context = schedulingReviewContextSchema.parse(raw);
      if (
        context.source?.sourceKind !== "lead" ||
        context.source.leadId !== leadId ||
        context.source.estimateId !== (estimateId || null) ||
        (project
          ? context.targetVersion !== project.updatedAt ||
            context.targetFingerprint !== project.schedulingTargetFingerprint
          : context.targetVersion !== null ||
            context.targetFingerprint !== null)
      )
        throw new Error("Project source changed");
      return { context, policy: policy.policy };
    },
  });
  const context = read.value?.context ?? null;
  const source: ManualSourceRef = {
    sourceKind: "lead",
    leadId: project?.leadId ?? leadId,
    contactId: project?.contactId ?? null,
    propertyId: project?.propertyId ?? null,
    estimateId: project?.estimateId ?? null,
  };
  const before: SchedulingCandidate | null = project
    ? {
        kind: "project",
        id: project.id,
        startAt: project.scheduledStart ?? null,
        endAt: project.scheduledEnd ?? null,
        resourceUserIds: project.crewUserIds ?? [],
        type: "project",
        status: project.status,
        source,
        reservation: project.schedulingReservation ?? null,
      }
    : null;
  let legacyEffectiveEnd: string | null = null;
  if (before && before.endAt === null)
    try {
      legacyEffectiveEnd = effectiveReservation(before)?.endAt ?? null;
    } catch {
      /* Invalid historical evidence remains held. */
    }
  const interval: IntervalInput = {
    startAt: before?.startAt ?? null,
    endAt: before?.endAt ?? null,
    legacyEffectiveEnd,
    reservation: project?.schedulingReservation ?? null,
    evidence: project?.schedulingEvidence ?? "legacy",
  };
  const review = useSchedulingReview({
    authority,
    identity: selection,
    context,
    interval,
    initialDraft: {
      startAt: interval.startAt,
      endAt: interval.endAt,
      resourceUserIds: project?.crewUserIds ?? [],
    },
    transition: "admission",
    explanationScope: { reservationKind: 'project', ...(project ? { targetKind: 'project', targetId: project.id } : {}) },
  });
  let transition: "admission" | "release" | "preserve" = "admission";
  if (before)
    try {
      transition = classifyReservationTransition(before, {
        ...before,
        ...review.draft,
        status,
        source: { ...source, estimateId: estimateId || null },
      });
    } catch {
      /* Material change remains held. */
    }
  const unchangedResources =
    JSON.stringify(review.draft.resourceUserIds) ===
    JSON.stringify(project?.crewUserIds ?? []);
  const historical =
    !!project &&
    !!project.updatedAt &&
    !!project.schedulingTargetFingerprint &&
    transition !== "admission" &&
    (interval.evidence !== "invalid" ||
      unchangedResources ||
      !["scheduled", "in_progress"].includes(status));
  const custodyIdentity = JSON.stringify([actor?.organizationId, actor?.id, project?.id ?? null, returning, leadId, estimateId]);
  const retainedSource = useRef<{ identity: string; sourceKey: string | null; original: boolean }>({ identity: custodyIdentity, sourceKey: null, original: false });
  if (retainedSource.current.identity !== custodyIdentity)
    retainedSource.current = { identity: custodyIdentity, sourceKey: null, original: false };
  const retained = retainedSource.current;
  const [discovery, setDiscovery] = useState<{ identity: string; authority: string; blocked: boolean } | null>(null);
  useEffect(() => {
    if (project || returning || !actor || !authority.isCurrent()) return;
    let cancelled = false;
    const current = () => !cancelled && retainedSource.current === retained && authority.isCurrent();
    void (async () => {
      try {
        const originalKey = await retainedProjectSource({ organizationId: actor.organizationId, actorUserId: actor.id }, leadId, estimateId);
        if (!current()) return;
        if (originalKey) { retained.sourceKey = originalKey; retained.original = true; }
        else if (retained.original) throw new Error('Original project custody is missing');
        setDiscovery({ identity: custodyIdentity, authority: authority.identity, blocked: false });
      } catch {
        if (current()) setDiscovery({ identity: custodyIdentity, authority: authority.identity, blocked: true });
      }
    })();
    return () => { cancelled = true; };
  }, [custodyIdentity, authority.identity]);
  const discoveryReady = !!project || returning || (discovery?.identity === custodyIdentity && discovery.authority === authority.identity);
  const discoveryBlocked = discoveryReady && !project && !returning && discovery?.blocked === true;
  if (!retained.original && context?.source) retained.sourceKey = manualSchedulingSourceKey(context.source);
  const sourceKey = retained.sourceKey ?? JSON.stringify(["unready", leadId, estimateId]);
  const manual = useManualSchedulingCommand({
    scope:
      actor && authority.allowed && !discoveryBlocked && (discoveryReady || retained.original)
        ? {
            organizationId: actor.organizationId,
            actorUserId: actor.id,
            canWrite: true,
          }
        : null,
    kind: "project_create",
    sourceKey,
    dispatch: async (command) => {
      const current = authority.isCurrent;
      if (!current()) throw new Error('Project authority changed');
      if (command.kind !== "project_create")
        throw new Error("Wrong project command");
      try {
        return await createProject({
          ...command.body,
          operationId: command.operationId,
          schedulingReview: command.review,
        });
      } finally {
        if (!current()) throw new Error('Project authority changed');
      }
    },
    reconcile: async (original) => {
      const current = authority.isCurrent;
      if (!current()) throw new Error('Project authority changed');
      try {
        return await reconcileSchedulingOperation(original);
      } finally {
        if (!current()) throw new Error('Project authority changed');
      }
    },
  });
  if (!project && manual.state.command) {
    retained.sourceKey = manualSchedulingSourceKey(manual.state.command.review.context.source!);
    retained.original = true;
  }
  const intent = useRef<{
      operationId: string;
      leadId: string;
      advance: boolean;
      current: () => boolean;
    } | null>(null),
    finished = useRef<string | null>(null);
  const finish = () => {
    if (!authority.isCurrent()) return;
    void client.invalidateQueries({ queryKey: getListProjectsQueryKey() });
    onClose();
  };
  useEffect(() => {
    if (
      project ||
      manual.state.kind !== "committed" ||
      !manual.state.ack ||
      !intent.current ||
      intent.current.operationId !== manual.state.ack.operationId ||
      finished.current === intent.current.operationId ||
      !intent.current.current()
    )
      return;
    const original = intent.current;
    finished.current = original.operationId;
    void (async () => {
      if (original.advance) {
        try {
          await updateLeadRequest(original.leadId, {
            status: "production_scheduled",
          });
        } catch {
          if (original.current() && actor)
            showLeadAdvanceFailedToast(
              original.leadId,
              client,
              detachedLeadRetryAuthority(client, actor.scopeKey),
            );
        }
        if (original.current())
          void client.invalidateQueries({ queryKey: getListLeadsQueryKey() });
      }
      if (original.current()) finish();
    })();
  }, [manual.state.kind, manual.state.ack]);
  const nativeHeld =
    !project && !["idle", "committed"].includes(manual.state.kind);
  const terminal = !project && manual.state.kind === "committed" && !future;
  const busy =
    patchState === "saving" ||
    (!project &&
      ["preparing", "submitting", "reconciling"].includes(manual.state.kind));
  const locked =
    !authority.allowed ||
    !discoveryReady ||
    discoveryBlocked ||
    busy ||
    nativeHeld ||
    terminal ||
    patchState === "unknown";
  const proposal = context
    ? buildSchedulingProposalView({
        context,
        interval,
        draft: review.draft,
        transition,
      })
    : null;
  const resources = (users ?? [])
    .filter(canAssignWork)
    .map((user) => ({
      id: user.id,
      label:
        [user.firstName, user.lastName].filter(Boolean).join(" ") ||
        user.email ||
        user.id,
    }));
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (
      locked ||
      !authority.isCurrent() ||
      !name ||
      !leadId ||
      (!historical && (!review.review || !review.current()))
    )
      return;
    setFormError("");
    if (project) {
      const guard = authority.isCurrent;
      setPatchState("saving");
      try {
        await updateProject(project.id, {
          name,
          ...(estimateId !== (project.estimateId ?? "") ? { estimateId: estimateId || null } : {}),
          ...(status !== project.status ? { status } : {}),
          ...(review.draft.startAt !== interval.startAt ? { scheduledStart: review.draft.startAt } : {}),
          ...(review.draft.endAt !== interval.endAt ? { scheduledEnd: review.draft.endAt } : {}),
          ...(!unchangedResources ? { crewUserIds: review.draft.resourceUserIds } : {}),
          crewNotes: crewNotes || null,
          expectedUpdatedAt: project.updatedAt,
          expectedTargetFingerprint: project.schedulingTargetFingerprint,
          ...(!historical && review.review
            ? { schedulingReview: review.review }
            : {}),
        });
        if (guard()) finish();
      } catch {
        if (guard()) {
          setPatchState("unknown");
          setFormError(
            "The project update result is unconfirmed. Read the original project before another deliberate change. No automatic retry was made.",
          );
        }
      }
      return;
    }
    if (!review.review) return;
    const operationId = crypto.randomUUID();
    intent.current = {
      operationId,
      leadId,
      advance: !!defaults?.offerLeadAdvance && advanceLead,
      current: authority.isCurrent,
    };
    await manual.submit({
      operationId,
      kind: "project_create",
      body: {
        leadId,
        name,
        ...(estimateId ? { estimateId } : {}),
        status,
        ...(review.draft.startAt
          ? { scheduledStart: review.draft.startAt }
          : {}),
        ...(review.draft.endAt ? { scheduledEnd: review.draft.endAt } : {}),
        crewUserIds: [...review.draft.resourceUserIds],
        ...(crewNotes ? { crewNotes } : {}),
      },
      review: review.review,
    });
    setFuture(false);
  }
  if (!authority.allowed)
    return (
      <p role="status">
        Checking current job access. Reopen the exact job if access changed.
      </p>
    );
  if (returning && actor && !project && !defaults?.leadId) return <CustomerWorkForm kind="projects" actor={actor} contactId={initialContactId} onOpportunity={() => setReturning(false)} onClose={onClose} />;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/90 p-4">
      <section
        role="dialog"
        aria-label="Project form"
        className="max-h-[90vh] w-full max-w-2xl overflow-auto rounded border bg-card p-5 space-y-4"
      >
        <div className="flex justify-between">
          <h2>
            {project ? 'Edit Project' : defaults?.offerLeadAdvance ? 'Start Project' : 'New Project'}
          </h2>
          <button
            className={button}
            aria-label="Close project form"
            onClick={onClose}
          >
            Close
          </button>
        </div>
        {!project && manual.state.kind === "unknown" && (
          <div role="alert">
            <p>
              The original project result is unconfirmed. Its exact command is
              retained in this tab.
            </p>
            <button
              className={button}
              onClick={() => void manual.reconcileOriginal()}
            >
              Reconcile original project command
            </button>
          </div>
        )}
        {!project && manual.state.kind === "refused" && (
          <div role="alert">
            <p>
              The original command was permanently refused. Review again for
              distinct future work.
            </p>
            <button
              className={button}
              onClick={() => {
                manual.acknowledgeRefusal();
                review.invalidate();
              }}
            >
              Acknowledge original refusal
            </button>
          </div>
        )}
        {!project && (manual.state.kind === "blocked_custody" || discoveryBlocked) && (
          <p role="alert">
            Original command custody is unavailable or invalid. Nothing new can
            be submitted.
          </p>
        )}
        {terminal && (
          <div role="status">
            <p>
              The original project committed
              {manual.state.ack?.target?.available === false
                ? ", but its display is unavailable. Do not recreate it."
                : ". Its original proof is retained."}
            </p>
            <button
              className={button}
              onClick={() => {
                setFuture(true);
                review.invalidate();
              }}
            >
              Prepare separate new project
            </button>
          </div>
        )}
        <button type="button" className={button} onClick={() => void read.refresh()}>
          Refresh scheduling review
        </button>
        <form onSubmit={(event) => void submit(event)} className="space-y-4">
          <fieldset disabled={locked} className="space-y-4">
            {!project && !defaults?.leadId && (
              <>
                <p>Work source: Customer opportunity</p>
                <button
                  type="button"
                  className={button}
                  onClick={() => setReturning(true)}
                >
                  Use existing customer instead
                </button>
                <LeadSelect
                  required
                  withStatus
                  queryScope={actor?.scopeKey}
                  value={leadId}
                  onChange={(id) => {
                    setLeadId(id);
                    setEstimateId("");
                  }}
                />
              </>
            )}
            <label className="block">
              Name
              <input
                aria-label="Project name"
                className={field}
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="block">
              Linked Estimate
              <select
                aria-label="Linked estimate"
                className={field}
                value={estimateId}
                disabled={!leadId}
                onChange={(event) => setEstimateId(event.target.value)}
              >
                <option value="">-- None --</option>
                {estimates
                  ?.filter((row) => row.leadId === leadId)
                  .map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.title}
                    </option>
                  ))}
              </select>
            </label>
            {project && (
              <label className="block">
                Job status
                <select
                  className={field}
                  value={status}
                  onChange={(event) => {
                    review.invalidate();
                    setStatus(event.target.value as typeof status);
                  }}
                >
                  {[
                    "scheduled",
                    "in_progress",
                    "on_hold",
                    "completed",
                    "cancelled",
                  ].map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
            )}
            {read.error && (
              <p role="status">
                {read.error} Historical notes, closure and eligible crew removal
                retain their existing authority.
              </p>
            )}
            <SchedulingIntervalFields
              {...review.fields}
              resources={resources}
              presets={read.value?.policy?.durationPresets ?? []}
              disabled={locked}
              startOnlyBehavior="preserve_absolute_end"
            />
            {!review.draft.startAt && !review.draft.endAt && context && (
              <button
                type="button"
                className={button}
                onClick={() =>
                  review.fields.onReviewChange({
                    context,
                    duration: { kind: "explicit", preset: null },
                    startWallTime: null,
                    endWallTime: null,
                  })
                }
              >
                Review unscheduled job
              </button>
            )}
            {project &&
              !context &&
              interval.evidence !== "invalid" &&
              review.draft.resourceUserIds.map((id) => (
                <button
                  type="button"
                  className={button}
                  key={id}
                  onClick={() =>
                    review.fields.onDraftChange({
                      ...review.draft,
                      resourceUserIds: review.draft.resourceUserIds.filter(
                        (value) => value !== id,
                      ),
                    })
                  }
                >
                  Remove {id} from saved crew
                </button>
              ))}
            <SchedulingIntervalReview
              companyTimeZone={
                context?.companyTimeZone ??
                authority.profile?.organization?.timezone ??
                null
              }
              interval={interval}
              proposal={proposal}
              resources={resources}
              conflict={review.conflict}
            />
            {project && (
              <SchedulingReservationSummary
                companyTimeZone={
                  context?.companyTimeZone ??
                  authority.profile?.organization?.timezone ??
                  null
                }
                interval={interval}
                proposal={proposal}
                resources={resources}
                conflict={review.conflict}
              />
            )}
            <label className="block">
              Crew Notes
              <textarea
                aria-label="Crew notes"
                className={field}
                value={crewNotes}
                onChange={(event) => setCrewNotes(event.target.value)}
              />
            </label>
            {!project && defaults?.offerLeadAdvance && (
              <label className="flex gap-2">
                <input
                  type="checkbox"
                  checked={advanceLead}
                  onChange={(event) => setAdvanceLead(event.target.checked)}
                />
                Advance lead status to Production Scheduled
              </label>
            )}
            {formError && <p role="alert">{formError}</p>}
            <button
              className={button}
              type="submit"
              disabled={locked || (!historical && !review.review)}
            >
              {defaults?.offerLeadAdvance ? "Start Project" : "Save"}
            </button>
          </fieldset>
        </form>
      </section>
    </div>
  );
}
/**
 * Shows the "Lead status not updated" toast with a Retry action.
 * Lives at module level (using the global toast store and the plain fetch
 * client) so retrying keeps working after the modal has closed.
 */
type LeadRetryAuthority = (() => boolean) & { dispose: () => void };
function detachedLeadRetryAuthority(
  client: QueryClient,
  scope: string,
): LeadRetryAuthority {
  const matches = () => {
    const query = client.getQueryState<MemberProfile>(getGetMeQueryKey());
    return (
      query?.status === "success" &&
      query.data?.isActive === true &&
      memberAuthorityScope(query.data) === scope
    );
  };
  let valid = matches();
  const unsubscribe = client.getQueryCache().subscribe(() => {
    if (!matches()) {
      valid = false;
      unsubscribe();
    }
  });
  return Object.assign(() => valid && matches(), {
    dispose: () => {
      valid = false;
      unsubscribe();
    },
  });
}
function showLeadAdvanceFailedToast(
  leadId: string,
  queryClient: QueryClient,
  currentMember: LeadRetryAuthority,
) {
  const { dismiss } = globalToast({
    variant: "destructive",
    title: "Lead status not updated",
    description:
      'The project was created, but advancing the lead to Production Scheduled failed. Retry below or update the lead manually from the Leads page.',
    action: (
      <ToastAction
        altText="Retry lead status update"
        onClick={async () => {
          if (!currentMember()) return;
          try {
            await updateLeadRequest(leadId, { status: 'production_scheduled' });
            if (!currentMember()) return;
                  queryClient.invalidateQueries({ queryKey: getListLeadsQueryKey() });
            dismiss();
            currentMember.dispose();
          } catch {
            if (!currentMember()) return;
                  queryClient.invalidateQueries({ queryKey: getListLeadsQueryKey() });
            if (currentMember()) showLeadAdvanceFailedToast(leadId, queryClient, currentMember);
          }
        }}
      >
        Retry
      </ToastAction>
    ),
  });
}
