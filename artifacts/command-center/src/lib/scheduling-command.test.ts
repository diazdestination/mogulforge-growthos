import { webcrypto, createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  canonicalSchedulingEnvelope,
  classifyReservationTransition,
  effectiveReservation,
  type ReservationSnapshot,
  type SchedulingCandidate,
} from "@workspace/scheduling-core";
import { ApiError } from "@workspace/api-client-react";
import {
  appointmentCommand,
  projectCommand,
  enabledContext,
  disabledContext,
  draft,
  source,
  acknowledgement,
} from "./scheduling-ui-contract.fixtures";
import {
  buildSchedulingProposalView,
  freezeManualSchedulingCommand,
  manualSchedulingHash,
  manualSchedulingSourceKey,
  manualSchedulingAckFor,
} from "./scheduling-command";

beforeAll(() =>
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: webcrypto,
  }),
);
const scope = {
  organizationId: enabledContext.organizationId,
  actorUserId: "staff-synthetic",
};
const interval = {
  startAt: null,
  endAt: null,
  legacyEffectiveEnd: null,
  reservation: null,
  evidence: "legacy" as const,
};
const saved: ReservationSnapshot = {
  formatVersion: 1,
  reservationRevision: 1,
  sourcePolicyRevision: 1,
  sourcePolicyDigest: "a".repeat(64),
  approvedTimeZone: "America/New_York",
  inspection: enabledContext.inspection,
  startAt: draft.startAt!,
  endAt: draft.endAt!,
  resourceUserIds: ["b", "a"],
  minimumTravelGapMinutes: 60,
  duration: { kind: "explicit", preset: null },
  admittedAt: draft.startAt!,
  admittedByUserId: scope.actorUserId,
  target: { kind: "appointment", id: appointmentCommand.operationId },
  lastTransition: {
    kind: "admission",
    actorUserId: scope.actorUserId,
    at: draft.startAt!,
  },
};

describe("original manual wire and native acknowledgements", () => {
  it("uses fixed immutable source identifiers, independently of object insertion order", () => {
    expect(manualSchedulingSourceKey(source)).toBe(
      '["unlinked_manual",null,null,null,null]',
    );
    expect(
      manualSchedulingSourceKey({
        ...source,
        sourceKind: "lead",
        leadId: appointmentCommand.operationId,
      }),
    ).not.toBe(manualSchedulingSourceKey(source));
  });
  it("freezes raw ISO spelling, explicit null, omissions and crew order before hashing", async () => {
    const original = structuredClone(projectCommand);
    if (original.kind !== "project_create") throw new Error();
    original.body.scheduledStart = "2035-01-01T09:00:00-08:00";
    original.body.crewUserIds = ["b", "a"];
    const frozen = freezeManualSchedulingCommand(
      original,
      scope,
      original.kind,
      manualSchedulingSourceKey(original.review.context.source!),
    );
    original.body.crewUserIds.reverse();
    original.body.name = "edited";
    expect(frozen.body).toMatchObject({
      scheduledStart: "2035-01-01T09:00:00-08:00",
      crewUserIds: ["b", "a"],
      name: "Synthetic job",
    });
    expect(frozen.body).not.toHaveProperty("estimateId");
    const hash = await manualSchedulingHash(frozen, scope);
    const canonical = canonicalSchedulingEnvelope({
      ...scope,
      kind: frozen.kind,
      body: frozen.body,
      review: frozen.review,
    });
    expect(hash).toBe(
      createHash("sha256").update(canonical, "utf8").digest("hex"),
    );
    expect(
      await manualSchedulingHash(
        {
          ...frozen,
          body: { ...frozen.body, crewUserIds: ["a", "b"] },
        } as typeof frozen,
        scope,
      ),
    ).not.toBe(hash);
    const a = {
      ...appointmentCommand,
      body: { ...appointmentCommand.body, propertyId: null },
    } as typeof appointmentCommand;
    expect(await manualSchedulingHash(a, scope)).not.toBe(
      await manualSchedulingHash(appointmentCommand, scope),
    );
    expect(
      await manualSchedulingHash(
        { ...frozen, operationId: scope.organizationId },
        scope,
      ),
    ).toBe(hash);
  });
  it.each([
    (c: any) => {
      c.body.contactId = scope.organizationId;
    },
    (c: any) => {
      c.review.context.organizationId = c.operationId;
    },
    (c: any) => {
      c.body.scheduledStart = new Date(c.body.scheduledStart);
    },
    (c: any) => {
      c.body.actorUserId = "forged";
    },
    (c: any) => {
      c.operationId = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
    },
  ])("rejects incoherent or transformed caller input", (change) => {
    const c = structuredClone(appointmentCommand);
    change(c);
    expect(() =>
      freezeManualSchedulingCommand(
        c,
        scope,
        c.kind,
        manualSchedulingSourceKey(source),
      ),
    ).toThrow();
  });
  it("accepts strict native success, direct reconciliation and real ApiError.data terminal proofs", async () => {
    const hash = await manualSchedulingHash(appointmentCommand, scope);
    const ack = { ...acknowledgement, payloadSha256: hash };
    expect(
      manualSchedulingAckFor(
        { schedulingOperation: ack },
        "dispatch",
        appointmentCommand,
        scope,
        hash,
      ),
    ).toEqual(ack);
    expect(
      manualSchedulingAckFor(ack, "reconcile", appointmentCommand, scope, hash),
    ).toEqual(ack);
    const unavailable = {
      ...ack,
      target: { ...ack.target!, available: false },
    };
    const failure = new ApiError(
      new Response(null, { status: 409 }),
      {
        error: "Unavailable",
        code: "manual_scheduling_target_unavailable",
        schedulingOperation: unavailable,
      },
      { method: "POST", url: "/api/v1/appointments" },
    );
    expect(
      manualSchedulingAckFor(
        failure,
        "dispatch",
        appointmentCommand,
        scope,
        hash,
      ),
    ).toEqual(unavailable);
    for (const value of [
      { ...ack, payloadSha256: "f".repeat(64) },
      { ...ack, operationId: scope.organizationId },
      { ...ack, actorUserId: "other" },
      { ...ack, organizationId: ack.operationId },
      { ...ack, kind: "project_create" },
      { ...ack, source: projectCommand.review.context.source },
      { ...ack, extra: true },
      { ...ack, target: null },
    ]) {
      expect(
        manualSchedulingAckFor(
          value,
          "reconcile",
          appointmentCommand,
          scope,
          hash,
        ),
      ).toBeNull();
    }
    expect(
      manualSchedulingAckFor(ack, "dispatch", appointmentCommand, scope, hash),
    ).toBeNull();
    expect(
      manualSchedulingAckFor(
        { status: 200 },
        "dispatch",
        appointmentCommand,
        scope,
        hash,
      ),
    ).toBeNull();
  });
});

describe("proposal describes exact draft without claiming capacity", () => {
  it("rejects legacy NULL-to-explicit-end retention even when the effective range is equal", () => {
    const before: SchedulingCandidate = {
      kind: "appointment",
      id: appointmentCommand.operationId,
      startAt: draft.startAt,
      endAt: null,
      resourceUserIds: [],
      type: "inspection",
      status: "scheduled",
      source,
      reservation: null,
    };
    const effectiveEnd = effectiveReservation(before)!.endAt;
    const after = { ...before, endAt: effectiveEnd };
    expect(classifyReservationTransition(before, after)).toBe("admission");
    const legacy = {
      ...interval,
      startAt: before.startAt,
      legacyEffectiveEnd: effectiveEnd,
    };
    const edited = {
      startAt: after.startAt,
      endAt: after.endAt,
      resourceUserIds: [],
    };
    expect(
      buildSchedulingProposalView({
        context: enabledContext,
        interval: legacy,
        draft: edited,
        transition: "admission",
      }),
    ).toMatchObject({
      basis: "new_admission",
      appliedTravelGapMinutes: 60,
      companyCeiling: 3,
    });
    for (const transition of ["preserve", "release"] as const) {
      expect(
        buildSchedulingProposalView({
          context: enabledContext,
          interval: legacy,
          draft: edited,
          transition,
        }),
      ).toBeNull();
    }
    expect(legacy.endAt).toBeNull();
  });
  it("rejects legacy non-admission claims without original resource evidence", () => {
    const before: SchedulingCandidate = {
      kind: "appointment",
      id: appointmentCommand.operationId,
      startAt: draft.startAt,
      endAt: draft.endAt,
      resourceUserIds: ["original-staff"],
      type: "inspection",
      status: "scheduled",
      source,
      reservation: null,
    };
    const after = { ...before, resourceUserIds: ["new-unreviewed-staff"] };
    expect(classifyReservationTransition(before, after)).toBe("admission");
    const legacy = {
      ...interval,
      startAt: before.startAt,
      endAt: before.endAt,
    };
    for (const transition of ["release", "preserve"] as const) {
      expect(
        buildSchedulingProposalView({
          context: enabledContext,
          interval: legacy,
          draft: {
            startAt: after.startAt,
            endAt: after.endAt,
            resourceUserIds: after.resourceUserIds,
          },
          transition,
        }),
      ).toBeNull();
    }
    // The frozen IntervalInput cannot prove even a genuinely unchanged legacy
    // resource set. A null presentation must not gate the separate host action.
    expect(classifyReservationTransition(before, before)).toBe("preserve");
    expect(
      buildSchedulingProposalView({
        context: enabledContext,
        interval: legacy,
        draft: {
          startAt: before.startAt,
          endAt: before.endAt,
          resourceUserIds: before.resourceUserIds,
        },
        transition: "preserve",
      }),
    ).toBeNull();
  });
  it("uses current rules for new reservations and copies resource order", () => {
    const proposal = buildSchedulingProposalView({
      context: enabledContext,
      interval,
      draft: { ...draft, resourceUserIds: ["b", "a"] },
      transition: "admission",
    });
    expect(proposal).toMatchObject({
      basis: "new_admission",
      startAt: draft.startAt,
      endAt: draft.endAt,
      resourceUserIds: ["b", "a"],
      appliedTravelGapMinutes: 60,
      companyCeiling: 3,
      inspectionCeiling: 2,
      companyGate: { kind: "held", message: "Rechecked when saving" },
    });
  });
  it.each(["release", "preserve"] as const)(
    "retains saved gap and admits no historical ceilings for %s",
    (transition) => {
      const proposal = buildSchedulingProposalView({
        context: disabledContext,
        interval: {
          ...interval,
          startAt: saved.startAt,
          endAt: saved.endAt,
          reservation: saved,
          evidence: "versioned",
        },
        draft: {
          ...draft,
          resourceUserIds: transition === "release" ? ["a"] : ["b", "a"],
        },
        transition,
      });
      expect(proposal).toMatchObject({
        basis:
          transition === "release" ? "saved_release" : "saved_preservation",
        appliedTravelGapMinutes: 60,
        companyCeiling: null,
        inspectionCeiling: null,
        companyGate: {
          kind: "held",
          message:
            "Recorded work is retained; no new capacity admission is requested.",
        },
      });
    },
  );
  it("rejects incomplete or corrupt evidence, fabricated releases, and reversed endpoints", () => {
    for (const change of [
      { draft: { ...draft, endAt: null } },
      { draft: { ...draft, endAt: draft.startAt } },
      { interval: { ...interval, evidence: "invalid" as const } },
    ]) {
      expect(
        buildSchedulingProposalView({
          context: enabledContext,
          interval,
          draft,
          transition: "admission",
          ...change,
        }),
      ).toBeNull();
    }
    expect(
      buildSchedulingProposalView({
        context: enabledContext,
        interval: {
          ...interval,
          startAt: saved.startAt,
          endAt: saved.endAt,
          reservation: saved,
          evidence: "versioned",
        },
        draft: { ...draft, resourceUserIds: ["new"] },
        transition: "release",
      }),
    ).toBeNull();
  });
});
