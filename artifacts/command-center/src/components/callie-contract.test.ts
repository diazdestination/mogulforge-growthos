import { describe, expect, it } from "vitest";
import { callieBookingFor, callieCommandFor, callieSchedulingContextFor } from "./callie-contract";
import { callieBookingSchema, canonicalCallieBookingInput } from "../../../api-server/src/services/callie-office-contract";
import { detail, id, otherId, organizationId, contactId, propertyId, receiptId } from "../test/callie-fixtures";

const input = callieBookingSchema.parse({ requestId: otherId, expectedVersion: 1, expectedFingerprint: "a".repeat(64), contactId, leadId: null, propertyId, assignedUserId: "tech", type: "other", scheduledStart: "2035-01-02T15:00:00.000Z", scheduledEnd: "2035-01-02T16:00:00.000Z", confirmationNote: "Customer confirmed this exact visit.", customerConfirmed: true });
const fingerprint = "b".repeat(64);
const outcome = { formatVersion: 1, status: "committed", organizationId, actorUserId: "u1", intakeId: id, bookingId: receiptId, requestId: input.requestId, requestFingerprint: fingerprint, expectedVersion: input.expectedVersion, expectedFingerprint: input.expectedFingerprint, customerConfirmed: true, appointmentId: otherId };
const source = { sourceKind: "direct_customer", contactId, leadId: null, propertyId, estimateId: null };
function read() { return { organizationId, actorUserId: "u1", intakeId: id, expectedVersion: 1, expectedFingerprint: "a".repeat(64), appointmentType: "other", source,
  review: { state: "ready", policy: null, context: { organizationId, policyRevision: 0, policyDigest: null, companyTimeZone: "America/Los_Angeles", inspection: null, applicableRules: { newTravelGapMinutes: 0, companyCeiling: null, inspectionCeiling: null }, source, targetVersion: null, targetFingerprint: null } } }; }

describe("CALLIE original booking and selected-source parsers", () => {
  it("accepts a verified original committed replay without current presentation", () => {
    expect(callieBookingFor(organizationId, "u1", id, input, fingerprint).parse({ detail: null, replayed: true, bookingOutcome: outcome }).bookingOutcome.appointmentId).toBe(otherId);
  });
  it.each(["organizationId", "actorUserId", "intakeId", "requestId", "requestFingerprint", "expectedVersion", "expectedFingerprint", "customerConfirmed", "status"])("rejects changed original outcome %s", field => {
    const changed = { ...outcome, [field]: field === "expectedVersion" ? 2 : field === "customerConfirmed" ? false : field === "requestFingerprint" || field === "expectedFingerprint" ? "c".repeat(64) : field === "actorUserId" ? "tech" : field === "status" ? "no_commit_refused" : receiptId };
    expect(callieBookingFor(organizationId, "u1", id, input, fingerprint).safeParse({ detail: null, replayed: true, bookingOutcome: changed }).success).toBe(false);
  });
  it("keeps nonbooking shape unchanged and rejects invented availability, extra metadata or mismatched current detail", () => {
    expect(callieCommandFor(organizationId, id).safeParse({ detail: detail(), replayed: false }).success).toBe(true);
    const parser = callieBookingFor(organizationId, "u1", id, input, fingerprint);
    for (const result of [{ detail: null, replayed: false, bookingOutcome: outcome }, { detail: null, replayed: true, bookingOutcome: { ...outcome, available: true } }, { detail: detail(), replayed: true, bookingOutcome: outcome }, { detail: null, replayed: true, bookingOutcome: outcome, operationId: otherId }]) expect(parser.safeParse(result).success).toBe(false);
  });
  it("binds source scope, actual selected type/property and nested create context", () => {
    const selected = { appointmentType: "other" as const, propertyId };
    const parser = callieSchedulingContextFor(organizationId, "u1", id, selected);
    selected.propertyId = otherId; // Later draft edits do not rewrite an in-flight parser's authority.
    expect(parser.safeParse(read()).success).toBe(true);
    const changed = [ { ...read(), actorUserId: "tech" }, { ...read(), organizationId: otherId }, { ...read(), intakeId: otherId }, { ...read(), appointmentType: "inspection" }, { ...read(), source: { ...source, propertyId: null } }, { ...read(), review: { ...read().review, context: { ...read().review.context, source: { ...source, contactId: otherId } } } }, { ...read(), review: { ...read().review, context: { ...read().review.context, targetVersion: input.scheduledStart } } }, { ...read(), review: { ...read().review, context: { ...read().review.context, applicableRules: { newTravelGapMinutes: 60, companyCeiling: null, inspectionCeiling: null } } } } ];
    for (const value of changed) expect(parser.safeParse(value).success).toBe(false);
  });
  it("keeps missing worksite null and held reads closed without pretending ready", () => {
    const parser = callieSchedulingContextFor(organizationId, "u1", id, { appointmentType: "other" });
    const held = { ...read(), source: null, review: { state: "held", code: "caller_review_required", message: "Review caller." } };
    expect(parser.safeParse(held).success).toBe(true);
    expect(parser.safeParse({ ...held, review: { ...held.review, context: read().review.context } }).success).toBe(false);
    expect(parser.safeParse({ ...held, source }).success).toBe(false);
  });
  it("canonicalizes the original parsed source command without a manual envelope", () => {
    const canonical = canonicalCallieBookingInput(input);
    expect(canonicalCallieBookingInput({ ...input, confirmationNote: `  ${input.confirmationNote}  ` })).toBe(canonical);
    expect(canonicalCallieBookingInput(Object.fromEntries(Object.entries(input).reverse()))).toBe(canonical);
    expect(canonical).not.toContain("schedulingReview"); expect(canonical).toContain(`"requestId":"${input.requestId}"`);
    expect(() => canonicalCallieBookingInput({ ...input, actorUserId: "u1" })).toThrow();
  });
});
