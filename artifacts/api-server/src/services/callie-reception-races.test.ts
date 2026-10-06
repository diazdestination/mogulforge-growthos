import { createHmac, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { db, pool, callieReceptionSessionsTable as sessions, crmTasksTable, revenueExecutionsTable as executions } from "@workspace/db";
import { callieReceptionFixture, newReceptionCall } from "../test-helpers/callie-reception-fixture";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { beginCallieReception, receiveReceptionPostCall, receptionTransferKey, runCallieReceptionTool } from "./callie-reception-runtime";
import { approveCallieReception, previewCallieReception } from "./callie-reception-policy";
import { getCallieOfficeDetail, updateCallieOffice } from "./callie-office";
import { updateTask } from "./crm";

const pg = it.skipIf(process.env.SCHEDULER_TEST_BACKEND === "pglite");
let f: Awaited<ReturnType<typeof callieReceptionFixture>>, c: Awaited<ReturnType<typeof newReceptionCall>>, capability = "", conversationId = "";
const provider = vi.fn<typeof fetch>();
beforeEach(async () => {
  const target = new URL(process.env.DATABASE_URL ?? "");
  if (process.env.NODE_ENV !== "test" || !["localhost", "127.0.0.1"].includes(target.hostname)) throw new Error("Isolated loopback test database required");
  vi.stubEnv("SESSION_SECRET", "synthetic-reception-pg-signing-secret"); vi.stubEnv("OAUTH_TOKEN_ENCRYPTION_KEY", "73".repeat(32)); vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false");
  vi.stubEnv("TWILIO_CLIENT_RECEPTION_TEST_AUTH_TOKEN", "synthetic-pg-token"); vi.stubEnv("TWILIO_CLIENT_RECEPTION_TEST_API_KEY_SECRET", "synthetic-pg-key");
  f = await callieReceptionFixture();
  for (const [suffix, value] of Object.entries({ API_KEY: "synthetic-pg-el-api", WEBHOOK_SECRET: "synthetic-pg-el-webhook", CONFIG_SHA256: f.binding.configurationSha256, AGENT_VERSION_ID: f.binding.agentVersionId })) vi.stubEnv(`${f.environmentPrefix}_${suffix}`, value);
  c = await newReceptionCall(f); expect(c.session).toBeDefined(); conversationId = `conv_${randomUUID().replaceAll("-", "")}`;
  provider.mockReset().mockImplementation(async (url, init) => {
    if (String(url).includes("/agents/")) return Response.json(f.remoteConfiguration);
    if (String(url).includes("/conversations/")) return Response.json(conversation());
    if (String(url).endsWith("/twilio/register-call")) {
      capability = JSON.parse(String(init?.body)).conversation_initiation_client_data.dynamic_variables.secret__callie_capability;
      return Response.json('<Response><Connect><Stream url="wss://api.elevenlabs.io/v1/convai/twilio/pg-synthetic" /></Connect></Response>');
    }
    if (String(url).includes("api.twilio.com")) return Response.json({ sid: c.call.providerSid, account_sid: f.voice.accountSid });
    throw new Error("Unexpected synthetic provider boundary");
  }); vi.stubGlobal("fetch", provider);
});
afterEach(async () => { await deleteTestOrgs(f?.org); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const posts = () => provider.mock.calls.filter(([, init]) => init?.method === "POST");
function conversation() { return { conversation_id: conversationId, agent_id: f.binding.agentId, version_id: f.binding.agentVersionId, branch_id: f.binding.branchId, environment: "staging",
  metadata: { phone_call: { type: "twilio", direction: "inbound", call_sid: c.call.providerSid, external_number: c.call.phone, agent_number: f.voice.phoneNumber } } }; }
function tool(action: string) { return { action, requestId: randomUUID(), conversationId, agentId: f.binding.agentId }; }
async function active() { expect(await beginCallieReception(f.org, c.call.id)).toContain("<Connect>"); await runCallieReceptionTool(c.session.id, capability, tool("initialize")); }
async function blockedBy(blocker: number, query: string) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const value = await pool.query("select pid from pg_stat_activity where $1::int = any(pg_blocking_pids(pid)) and query ilike $2", [blocker, query]);
    if (value.rows[0]) return Number(value.rows[0].pid);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Expected independent PostgreSQL CALLIE writer barrier was not observed");
}
async function barrier(table: "callie_reception_sessions" | "callie_policy_revisions" | "callie_intakes", event: "UPDATE" | "INSERT", condition: string) {
  const suffix = randomUUID().replaceAll("-", ""), hook = `qa_reception_${suffix}`, key = `qa-reception-${suffix}`, keeper = await pool.connect();
  await pool.query(`create function ${hook}() returns trigger language plpgsql as $$ begin if NEW.organization_id='${f.org}'::uuid and (${condition}) then perform pg_advisory_xact_lock(hashtext('${key}')); end if; return NEW; end $$`);
  await pool.query(`create trigger ${hook} after ${event} on ${table} for each row execute function ${hook}()`);
  await keeper.query("begin"); await keeper.query("select pg_advisory_xact_lock(hashtext($1))", [key]);
  const keeperPid = Number((await keeper.query("select pg_backend_pid() as pid")).rows[0].pid);
  return { keeperPid, release: () => keeper.query("commit"), cleanup: async (operations: Array<Promise<unknown> | undefined>) => {
    await keeper.query("rollback"); keeper.release(); await Promise.allSettled(operations.filter((value): value is Promise<unknown> => !!value));
    await pool.query(`drop trigger if exists ${hook} on ${table}`); await pool.query(`drop function if exists ${hook}()`);
  } };
}

pg("one final registration claim serializes duplicate callbacks and the actual CRM task writer through physical dispatch ownership", async () => {
  const gate = await barrier("callie_reception_sessions", "UPDATE", "NEW.dispatch_started_at is not null and OLD.dispatch_started_at is null");
  let first: Promise<string | null> | undefined, duplicate: Promise<string | null> | undefined, writer: ReturnType<typeof updateTask> | undefined;
  try {
    first = beginCallieReception(f.org, c.call.id); void first.catch(() => {});
    const claimPid = await blockedBy(gate.keeperPid, '%update "callie_reception_sessions"%');
    duplicate = beginCallieReception(f.org, c.call.id); void duplicate.catch(() => {});
    writer = updateTask(f.org, c.handoff!.taskId, { status: "in_progress", description: "Actual office notes after the final claim." }); void writer.catch(() => {});
    const duplicatePid = await blockedBy(claimPid, "%pg_advisory_xact_lock%"), writerPid = await blockedBy(claimPid, '%update "crm_tasks"%');
    expect(new Set([claimPid, duplicatePid, writerPid]).size).toBe(3); expect(posts()).toHaveLength(0);
    await gate.release(); const responses = await Promise.all([first, duplicate]); await writer;
    expect(responses.filter(value => value?.includes("<Connect>"))).toHaveLength(1); expect(posts()).toHaveLength(1);
    expect(await db.select().from(executions).where(eq(executions.organizationId, f.org))).toHaveLength(1);
    expect((await db.select().from(crmTasksTable).where(eq(crmTasksTable.id, c.handoff!.taskId)))[0]).toMatchObject({ status: "in_progress", description: "Actual office notes after the final claim." });
  } finally { await gate.cleanup([first, duplicate, writer]); }
}, 20_000);

pg("an actual policy disable writer commits before a waiting original registration and prevents every provider POST", async () => {
  const preview = await previewCallieReception(f.org, f.owner.id, { expectedVersion: 1, policy: { ...f.settings, enabled: false } });
  const gate = await barrier("callie_policy_revisions", "INSERT", "NEW.version=2 and NEW.enabled=false");
  let writer: ReturnType<typeof approveCallieReception> | undefined, registering: Promise<string | null> | undefined;
  try {
    writer = approveCallieReception(f.org, f.owner.id, { expectedVersion: 1, expectedSnapshot: preview.expectedSnapshot, previewHash: preview.previewHash, confirmed: true }); void writer.catch(() => {});
    const writerPid = await blockedBy(gate.keeperPid, '%insert into "callie_policy_revisions"%');
    registering = beginCallieReception(f.org, c.call.id); void registering.catch(() => {});
    const readerPid = await blockedBy(writerPid, "%pg_advisory_xact_lock%"); expect(readerPid).not.toBe(writerPid); expect(provider).not.toHaveBeenCalled();
    await gate.release(); await writer; expect(await registering).not.toContain("<Connect>"); expect(posts()).toHaveLength(0);
    expect(await db.select().from(executions).where(eq(executions.organizationId, f.org))).toHaveLength(0);
  } finally { await gate.cleanup([writer, registering]); }
}, 20_000);

pg("a final transfer claim serializes competing call tools and retains exactly one original redirect effect", async () => {
  await active(); const request = tool("request_handoff");
  const gate = await barrier("callie_reception_sessions", "UPDATE", "NEW.transfer_dispatch_started_at is not null and OLD.transfer_dispatch_started_at is null");
  let transferring: Promise<unknown> | undefined, competing: Promise<unknown> | undefined;
  try {
    transferring = runCallieReceptionTool(c.session.id, capability, request); void transferring.catch(() => {});
    const claimPid = await blockedBy(gate.keeperPid, '%update "callie_reception_sessions"%');
    competing = runCallieReceptionTool(c.session.id, capability, tool("request_handoff")); void competing.catch(() => {});
    const competitorPid = await blockedBy(claimPid, "%pg_advisory_xact_lock%"); expect(competitorPid).not.toBe(claimPid); expect(posts()).toHaveLength(1);
    await gate.release(); expect(await transferring).toMatchObject({ transfer: "redirect_accepted" });
    await expect(competing).rejects.toMatchObject({ code: "handoff_already_requested" });
    expect(posts()).toHaveLength(2); expect(await db.select().from(executions).where(and(eq(executions.organizationId, f.org), eq(executions.actionKey, receptionTransferKey(c.call.id))))).toHaveLength(1);
    expect(await runCallieReceptionTool(c.session.id, capability, request)).toMatchObject({ replayed: true }); expect(posts()).toHaveLength(2);
  } finally { await gate.cleanup([transferring, competing]); }
}, 20_000);

pg("signed late provider evidence waits for the actual office resolve writer and cannot undo its original task or disposition", async () => {
  await active();
  await updateTask(f.org, c.handoff!.taskId, { description: "Actual office callback finished; preserve outcome." });
  const detail = await getCallieOfficeDetail(f.org, f.owner.id, c.intake!.id);
  const gate = await barrier("callie_intakes", "UPDATE", "NEW.state='resolved' and OLD.state<>'resolved'");
  let writer: ReturnType<typeof updateCallieOffice> | undefined, receiving: Promise<unknown> | undefined;
  try {
    writer = updateCallieOffice(f.org, f.owner.id, c.intake!.id, { requestId: randomUUID(), expectedVersion: detail.version, expectedFingerprint: detail.expectedFingerprint, action: "resolved", staffConfirmed: true, note: "Actual office callback finished; preserve outcome." }); void writer.catch(() => {});
    const writerPid = await blockedBy(gate.keeperPid, '%update "callie_intakes"%');
    const raw = Buffer.from(JSON.stringify({ type: "post_call_transcription", data: { ...conversation(), status: "done", analysis: { transcript_summary: "Late unverified provider summary." } } })), t = String(Math.floor(Date.now() / 1000));
    const signature = `t=${t},v0=${createHmac("sha256", "synthetic-pg-el-webhook").update(`${t}.`).update(raw).digest("hex")}`;
    receiving = receiveReceptionPostCall(raw, signature); void receiving.catch(() => {});
    const receiverPid = await blockedBy(writerPid, "%pg_advisory_xact_lock%"); expect(receiverPid).not.toBe(writerPid);
    await gate.release(); await writer; await receiving;
    expect(await getCallieOfficeDetail(f.org, f.owner.id, c.intake!.id)).toMatchObject({ state: "resolved", reception: { conversation: { outcome: "completed" } } });
    expect((await db.select().from(crmTasksTable).where(eq(crmTasksTable.id, c.handoff!.taskId)))[0]).toMatchObject({ status: "done", description: "Actual office callback finished; preserve outcome." });
  } finally { await gate.cleanup([writer, receiving]); }
}, 20_000);
