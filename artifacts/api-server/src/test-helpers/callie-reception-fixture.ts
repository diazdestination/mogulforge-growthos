import { randomInt, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, organizationsTable, usersTable, twilioClientBindingsTable, twilioCallsTable, callieReceptionSessionsTable } from "@workspace/db";
import { DEFAULT_CALLIE_RECEPTION, buildReceptionSnapshot, buildReceptionAgentConfiguration, type CallieReceptionSettings } from "../services/callie-reception-contract";
import { receptionConfigurationFingerprint } from "../services/callie-reception-provider";
import { approveCallieReception, previewCallieReception, saveCallieReceptionBinding } from "../services/callie-reception-policy";
import { admitCallieIntake } from "../services/callie-intake";
import { twilioForOrganization } from "../services/twilio-controls";
import { ensureMissedCallHandoff } from "../services/missed-call-handoff";

/** Real local synthetic rows and real approval/admission. Never installs credentials. */
export async function callieReceptionFixture(options: { trade?: "roofing" | "hvac"; settings?: Partial<CallieReceptionSettings>; approve?: boolean } = {}) {
  const suffix = randomUUID().replaceAll("-", ""), [company] = await db.insert(organizationsTable).values({ name: "FICTIONAL CALLIE reception", slug: `reception-${suffix}` }).returning();
  const org = company.id;
  const [owner, afterOwner] = await db.insert(usersTable).values([
    { organizationId: org, role: "owner", isActive: true, emailVerifiedAt: new Date(), email: `${suffix}@example.invalid` },
    { organizationId: org, role: "office", isActive: true, emailVerifiedAt: new Date(), email: `${suffix}-after@example.invalid` },
  ]).returning();
  const [voice] = await db.insert(twilioClientBindingsTable).values({ organizationId: org, accountSid: `AC${suffix}`, phoneNumber: `+1500${randomInt(1000000, 10000000)}`, staffPhone: "+12025550109",
    apiKeySid: `SK${suffix}`, authTokenSecretRef: "TWILIO_CLIENT_RECEPTION_TEST_AUTH_TOKEN", apiKeySecretRef: "TWILIO_CLIENT_RECEPTION_TEST_API_KEY_SECRET",
    publicOrigin: "https://growth.example", businessName: options.trade === "hvac" ? "FICTIONAL HVAC" : "FICTIONAL Roofing", launchApproved: true, voiceEnabled: true,
    voiceApproved: true, geoPermissionsReviewed: true, dailyCallLimit: 20, smsEnabled: false, registrationApproved: false }).returning();
  const settings: CallieReceptionSettings = { ...DEFAULT_CALLIE_RECEPTION, enabled: true, timezone: "UTC", days: [1, 2, 3, 4, 5, 6, 7], opensAt: "00:00", closesAt: "23:59",
    businessHoursOwnerId: owner.id, afterHoursOwnerId: afterOwner.id, businessFacts: options.trade === "hvac" ? "Fictional HVAC repairs and scheduled service requests. No warranty coverage is verified by phone." : "Fictional roofing repair and leak assessment requests. The office confirms availability.",
    callerDisclosure: "You are speaking with CALLIE, a virtual assistant. Information is retained for office review. No appointment or emergency response is confirmed.",
    businessHoursTransferPhone: "+12025550109", afterHoursTransferPhone: "+12025550108", ...options.settings };
  const bindingSettings = { enabled: true, agentId: `agent_${suffix}`, agentVersionId: `agtvrsn_${suffix}`, branchId: `agtbrch_${suffix}`, environment: "staging" as const, credentialKey: "RECEPTION", configurationSha256: "0".repeat(64) };
  const snapshot = buildReceptionSnapshot(settings, { id: voice.id, accountSid: voice.accountSid, sender: voice.phoneNumber, staffPhone: voice.staffPhone!, origin: voice.publicOrigin, businessName: voice.businessName }, { id: randomUUID(), version: 1, ...bindingSettings });
  const remoteConfiguration = { agent_id: bindingSettings.agentId, version_id: bindingSettings.agentVersionId, branch_id: bindingSettings.branchId, ...buildReceptionAgentConfiguration(snapshot) };
  bindingSettings.configurationSha256 = receptionConfigurationFingerprint(remoteConfiguration);
  const saved = await saveCallieReceptionBinding(org, owner.id, { requestId: randomUUID(), expectedVersion: 0, binding: bindingSettings, confirmed: true });
  if (options.approve !== false) {
    const preview = await previewCallieReception(org, owner.id, { expectedVersion: 0, policy: settings });
    await approveCallieReception(org, owner.id, { expectedVersion: 0, expectedSnapshot: preview.expectedSnapshot, previewHash: preview.previewHash, confirmed: true });
  }
  return { org, owner, afterOwner, voice, settings, binding: saved.binding!, remoteConfiguration,
    environmentPrefix: `ELEVENLABS_ORG_${org.replaceAll("-", "").toUpperCase()}_RECEPTION` };
}
export async function newReceptionCall(f: Awaited<ReturnType<typeof callieReceptionFixture>>, phone = "+12025550101", missed = true) {
  const binding = (await twilioForOrganization(f.org))!;
  const result = await db.transaction(async tx => {
    const [call] = await tx.insert(twilioCallsTable).values({ organizationId: f.org, requestKey: randomUUID(), direction: "inbound", phone, staffPhone: binding.staffPhone!,
      accountSid: binding.accountSid, providerSid: `CA${randomUUID().replaceAll("-", "")}`, status: "in-progress", dialStatus: missed ? "no-answer" : "completed", authorizationSource: "signed-inbound-fixture", createdAt: new Date() }).returning();
    const intake = await admitCallieIntake(tx, call, binding);
    return { call, intake };
  });
  const handoff = missed ? await ensureMissedCallHandoff(f.org, result.call.id) : null;
  const [session] = await db.select().from(callieReceptionSessionsTable).where(eq(callieReceptionSessionsTable.callId, result.call.id));
  return { ...result, handoff, session };
}
