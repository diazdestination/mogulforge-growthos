/**
 * CRM assistant approval gate: tools declare an effect, the loop only runs
 * read/propose tools, propose tools only queue `proposed` rows for a
 * crm.write user, and nothing is executed or sent from chat.
 */
import { randomUUID } from "node:crypto";

import { bieActionProposalsTable, contactsTable, db, leadsTable, organizationsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { EXECUTABLE_TOOL_EFFECTS, TOOLS, offeredTools, resolveToolCall, runAssistantChat } from "./assistant";

let orgA: string, orgB: string, writer: string, viewer: string, leadA: string, leadB: string;

beforeAll(async () => {
  const make = async (name: string) => (await db.insert(organizationsTable).values({ name, slug: `assistant-propose-${randomUUID()}` }).returning())[0]!.id;
  orgA = await make("Synthetic assistant proposals A");
  orgB = await make("Synthetic assistant proposals B");
  writer = (await db.insert(usersTable).values({ organizationId: orgA, role: "sales_rep", isActive: true }).returning())[0]!.id;
  viewer = (await db.insert(usersTable).values({ organizationId: orgA, role: "viewer", isActive: true }).returning())[0]!.id;
  const leadIn = async (org: string) => {
    const [contact] = await db.insert(contactsTable).values({ organizationId: org, firstName: "Synthetic" }).returning();
    return (await db.insert(leadsTable).values({ organizationId: org, contactId: contact!.id, status: "new", source: "native_qa" }).returning())[0]!.id;
  };
  leadA = await leadIn(orgA);
  leadB = await leadIn(orgB);
});
afterAll(async () => { await deleteTestOrgs(orgA, orgB); });
afterEach(() => { vi.restoreAllMocks(); delete process.env.OPENAI_API_KEY; });

const rowsFor = (org: string) => db.select().from(bieActionProposalsTable).where(eq(bieActionProposalsTable.organizationId, org));

/** Fake OpenAI: one round of the given tool calls, then a plain final answer. Records request bodies. */
function mockModel(calls: Array<{ name: string; args: Record<string, unknown> }>) {
  process.env.OPENAI_API_KEY = "test-key";
  const bodies: Array<{ tools?: Array<{ function: { name: string } }>; messages: Array<{ role: string; content: string | null }> }> = [];
  let round = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    const message = round++ === 0 && calls.length
      ? { content: null, tool_calls: calls.map((c, i) => ({ id: `call_${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) }
      : { content: "Done." };
    return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200, headers: { "content-type": "application/json" } });
  });
  return bodies;
}
const toolResults = (bodies: ReturnType<typeof mockModel>) =>
  bodies.at(-1)!.messages.filter((m) => m.role === "tool").map((m) => JSON.parse(m.content!));

describe("tool effects", () => {
  it("every registered tool declares read or propose, and propose tools are only offered to writers", () => {
    for (const [name, tool] of Object.entries(TOOLS)) expect(EXECUTABLE_TOOL_EFFECTS.has(tool.effect), name).toBe(true);
    expect(Object.keys(TOOLS).filter((name) => /execute|approve|send|delete/.test(name))).toEqual([]);
    expect(offeredTools(false).every((name) => TOOLS[name]!.effect === "read")).toBe(true);
    expect(offeredTools(true)).toEqual(expect.arrayContaining(["propose_follow_up_task", "propose_stage_change"]));
  });

  it("refuses a tool with an unknown effect without running it", async () => {
    const run = vi.fn(async () => ({ executed: true }));
    (TOOLS as Record<string, unknown>).rogue_execute = { effect: "execute", description: "x", parameters: {}, run };
    try {
      expect(resolveToolCall("rogue_execute", true)).toEqual({ refusal: expect.stringMatching(/not permitted/) });
      expect(offeredTools(true)).not.toContain("rogue_execute");
      const bodies = mockModel([{ name: "rogue_execute", args: {} }]);
      await runAssistantChat({ organizationId: orgA, userId: writer, canPropose: true, messages: [{ role: "user", content: "do it" }], onDelta: () => {} });
      expect(run).not.toHaveBeenCalled();
      expect(toolResults(bodies)[0].error).toMatch(/not permitted/);
    } finally {
      delete (TOOLS as Record<string, unknown>).rogue_execute;
    }
  });
});

describe("assistant proposals", () => {
  it("a propose tool creates exactly one proposed row attributed to the user; a repeat reuses it", async () => {
    const before = (await rowsFor(orgA)).length;
    const onProposal = vi.fn();
    const bodies = mockModel([{ name: "propose_follow_up_task", args: { leadId: leadA, title: "Call back about repair", reason: "No contact in 10 days" } }]);
    await runAssistantChat({ organizationId: orgA, userId: writer, canPropose: true, messages: [{ role: "user", content: "follow up" }], onDelta: () => {}, onProposal });
    expect(bodies[0]!.tools!.map((t) => t.function.name)).toContain("propose_follow_up_task");
    expect(bodies[0]!.messages[0]!.content).toMatch(/cannot execute, send, approve/);
    const rows = await rowsFor(orgA);
    expect(rows.length).toBe(before + 1);
    const row = rows.find((r) => r.id === toolResults(bodies)[0].proposalId)!;
    expect(row).toMatchObject({ status: "proposed", actionType: "create_task", leadId: leadA, createdByUserId: writer, reviewedByUserId: null, executedAt: null });
    expect(row.evidence).toMatchObject({ specialist: "Assistant" });
    expect(onProposal).toHaveBeenCalledWith(expect.objectContaining({ ok: true, proposalId: row.id, status: "proposed" }));

    const repeat = await TOOLS.propose_follow_up_task!.run(orgA, { leadId: leadA, title: "Call back about repair", reason: "again" }, { userId: writer, canPropose: true });
    expect(repeat).toMatchObject({ ok: true, proposalId: row.id, duplicate: true });
    expect((await rowsFor(orgA)).length).toBe(before + 1);
  });

  it("rejects another company's lead id and invalid stage targets", async () => {
    const cross = await TOOLS.propose_stage_change!.run(orgA, { leadId: leadB, status: "follow_up", reason: "cross-tenant" }, { userId: writer, canPropose: true });
    expect(cross).toMatchObject({ ok: false });
    expect(await TOOLS.propose_stage_change!.run(orgA, { leadId: leadA, status: "won", reason: "close it" }, { userId: writer, canPropose: true })).toMatchObject({ ok: false });
    expect((await rowsFor(orgB)).length).toBe(0);
    const ok = await TOOLS.propose_stage_change!.run(orgA, { leadId: leadA, status: "follow_up", reason: "quiet lead" }, { userId: writer, canPropose: true });
    expect(ok).toMatchObject({ ok: true, actionType: "change_stage" });
  });

  it("a user without crm.write is not offered propose tools and cannot use them", async () => {
    const before = (await rowsFor(orgA)).length;
    const bodies = mockModel([{ name: "propose_follow_up_task", args: { leadId: leadA, title: "Sneaky", reason: "should be refused" } }]);
    await runAssistantChat({ organizationId: orgA, userId: viewer, canPropose: false, messages: [{ role: "user", content: "x" }], onDelta: () => {} });
    expect(bodies[0]!.tools!.map((t) => t.function.name).filter((n) => n.startsWith("propose_"))).toEqual([]);
    expect(toolResults(bodies)[0].error).toMatch(/not available/);
    // Even a direct call re-checks the user's own permission.
    expect(await TOOLS.propose_follow_up_task!.run(orgA, { leadId: leadA, title: "Direct", reason: "viewer" }, { userId: viewer, canPropose: true })).toMatchObject({ ok: false });
    expect((await rowsFor(orgA)).length).toBe(before);
  });

  it("no execution path is reachable from chat: proposals stay proposed", async () => {
    expect((await rowsFor(orgA)).every((r) => r.status === "proposed" && r.executedAt === null && r.reviewedByUserId === null)).toBe(true);
  });
});
