/** Synthetic-only recovery evidence; no usable account, number or consent. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fixtureIds } from "./restore-drill-fixture.mjs";

const stamp = "2026-10-02T12:00:00.000Z";
const hash = (value) => createHash("sha256").update(value).digest("hex");
export function careFixtureIds(slug) {
  return Object.fromEntries(["call", "handoff", "case", "execution", "binding"].map((name) => {
    const value = hash(`customer-care-recovery-v1:${slug}:${name}`);
    return [name, `${value.slice(0, 8)}-${value.slice(8, 12)}-5${value.slice(13, 16)}-a${value.slice(17, 20)}-${value.slice(20, 32)}`];
  }));
}
export function careFixtureRows(slug) {
  const id = fixtureIds(slug), care = careFixtureIds(slug), shared = { organization_id: id.organization };
  const snapshot = {
    templateVersion: "missed-call-care.v1", callId: care.call, handoffId: care.handoff,
    contactId: id.contact, leadId: id.lead, phone: "+12025550123", dialStatus: "no-answer",
    reviewedAt: stamp, policyVersion: 1, responseMinutes: 30, ownerUserId: id.user,
    bindingId: care.binding, accountSid: "ACsynthetic-not-an-account", sender: "+12025550124",
    messagingServiceSid: "MGsynthetic-not-a-service", disclosureVersion: "synthetic-only",
    businessName: "Synthetic contractor", publicOrigin: "https://example.invalid",
    body: "Synthetic recovery fixture only.", renderedMessage: "Synthetic recovery fixture only. No delivery authorized.",
  };
  return [
    ["missed_call_care_policies", { ...shared, enabled: false, timezone: "America/New_York", days: [1, 2, 3, 4, 5, 6],
      opens_at: "09:00", closes_at: "18:00", business_hours_owner_id: id.user, after_hours_owner_id: id.user,
      response_minutes: 30, approved_by_user_id: id.user, approved_at: stamp }],
    ["twilio_calls", { ...shared, id: care.call, contact_id: id.contact, request_key: `synthetic-recovery:${slug}`,
      direction: "inbound", phone: snapshot.phone, staff_phone: snapshot.sender, account_sid: snapshot.accountSid,
      status: "completed", dial_status: "no-answer", authorization_source: "synthetic_fixture", created_at: stamp }],
    ["missed_call_handoffs", { ...shared, id: care.handoff, call_id: care.call, task_id: id.task,
      contact_id: id.contact, lead_id: id.lead, reviewed_by_user_id: id.user, reviewed_at: stamp }],
    ["missed_call_care_cases", { ...shared, id: care.case, call_id: care.call, state: "indeterminate", version: 3,
      approved_snapshot: snapshot, approved_by_user_id: id.user, approved_at: stamp,
      owner_user_id: id.user, due_at: stamp, reason: "synthetic_acknowledgement_unknown" }],
    ["revenue_executions", { ...shared, id: care.execution, action_key: `missed-call-care:${care.call}:sms:v1`,
      fingerprint: hash(JSON.stringify(snapshot)), kind: "missed_call_care", state: "indeterminate",
      detail: "Synthetic unknown acknowledgement; never replay automatically.", actor_user_id: id.user, expires_at: stamp }],
  ];
}
export async function assertCareFixture(database, slug) {
  const id = fixtureIds(slug), care = careFixtureIds(slug);
  const { rows: [row] } = await database.query(
    "SELECT c.*,p.enabled,p.days,p.timezone,e.state AS receipt_state,e.action_key FROM missed_call_care_cases c JOIN missed_call_care_policies p ON p.organization_id=c.organization_id JOIN revenue_executions e ON e.id=$3 AND e.organization_id=c.organization_id WHERE c.id=$1 AND c.organization_id=$2",
    [care.case, id.organization, care.execution]);
  assert.equal(row.state, "indeterminate");
  assert.equal(row.receipt_state, "indeterminate");
  assert.equal(row.action_key, `missed-call-care:${care.call}:sms:v1`);
  assert.equal(row.enabled, false);
  assert.equal(row.timezone, "America/New_York");
  assert.deepEqual(row.days, [1, 2, 3, 4, 5, 6]);
  assert.equal(row.version, 3);
  assert.equal(row.approved_by_user_id, id.user);
  assert.equal(row.owner_user_id, id.user);
  assert.equal(row.approved_snapshot.callId, care.call);
  assert.equal(row.approved_snapshot.contactId, id.contact);
  assert.equal(row.approved_snapshot.renderedMessage, "Synthetic recovery fixture only. No delivery authorized.");
}

/** The new composite FKs, not merely app predicates, reject foreign identities. */
export async function assertCareTenantKeys(database, slug, otherSlug) {
  const id = fixtureIds(slug), care = careFixtureIds(slug), other = fixtureIds(otherSlug), foreign = careFixtureIds(otherSlug);
  for (const [query, values] of [
    ["UPDATE missed_call_care_cases SET call_id=$2 WHERE id=$1", [care.case, foreign.call]],
    ["UPDATE missed_call_care_cases SET owner_user_id=$2 WHERE id=$1", [care.case, other.user]],
    ["UPDATE missed_call_care_cases SET approved_by_user_id=$2 WHERE id=$1", [care.case, other.user]],
    ["UPDATE missed_call_care_policies SET business_hours_owner_id=$2 WHERE organization_id=$1", [id.organization, other.user]],
    ["UPDATE missed_call_care_policies SET after_hours_owner_id=$2 WHERE organization_id=$1", [id.organization, other.user]],
    ["UPDATE missed_call_care_policies SET approved_by_user_id=$2 WHERE organization_id=$1", [id.organization, other.user]],
  ]) {
    await database.exec("BEGIN");
    try {
      // Remove only the other synthetic case inside this rollback-only test so
      // a duplicate-call index cannot mask the cross-company foreign-key check.
      if (query.includes("SET call_id")) await database.query("DELETE FROM missed_call_care_cases WHERE id=$1", [foreign.case]);
      await assert.rejects(database.query(query, values), (error) => error.code === "23503");
    }
    finally { await database.exec("ROLLBACK"); }
  }
}
