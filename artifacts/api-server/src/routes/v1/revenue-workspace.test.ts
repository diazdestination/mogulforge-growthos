import { createHash, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  db,
  organizationsTable,
  usersTable,
  contactsTable,
  leadsTable,
  estimatesTable,
  projectsTable,
  portalSessionsTable,
  bieActionProposalsTable,
  crmTasksTable,
  valueEntriesTable,
  activitiesTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import app from "../../app";
import { createSession } from "../../lib/auth";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";
import { executeBieProposal, reviewBieProposal } from "../../services/bie";

let server: Server,
  base: string,
  org: string,
  other: string,
  actor: string,
  ownerSid: string,
  viewerSid: string,
  lead: string,
  otherLead: string,
  estimate: string,
  project: string,
  portalToken: string;
const call = (
  path: string,
  body?: unknown,
  sid = ownerSid,
  method = body ? "POST" : "GET",
  headers = {},
) =>
  fetch(`${base}/api/v1${path}`, {
    method,
    headers: {
      cookie: `sid=${sid}`,
      "Content-Type": "application/json",
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
const profile = () => ({
  expectedVersion: 0,
  confirmed: true,
  content: {
    services: "Roofing and siding",
    serviceArea: "North Georgia",
    businessHours: "Monday to Friday",
    escalation: "Contact the approved manager",
    materials: "Client-approved materials",
    warranties: "Only the written agreement applies",
    pricingBoundaries: "No unapproved quotes",
    sourceReference: "LOCAL QA owner confirmation",
  },
});
const room = () => ({
  expectedVersion: 0,
  confirmed: true,
  estimateId: estimate,
  title: "LOCAL QA exterior options",
  scope: "Replace the specified roof system per estimate.",
  warranty: "See the owner's approved written terms.",
  sourceReference: "LOCAL QA estimate approval",
  options: [
    { name: "Shingle system", description: "Client-approved material option." },
  ],
});
beforeAll(async () => {
  if (new URL(process.env.DATABASE_URL!).hostname !== "127.0.0.1")
    throw new Error("Local DB only");
  [org, other] = (
    await db
      .insert(organizationsTable)
      .values(
        [1, 2].map((i) => ({
          name: `Revenue QA ${i}`,
          slug: `revenue-qa-${randomUUID()}`,
        })),
      )
      .returning()
  ).map((r) => r.id);
  const session = async (role: "owner" | "viewer") => {
    const [u] = await db
      .insert(usersTable)
      .values({ organizationId: org, role, firstName: "Local QA", emailVerifiedAt: new Date() })
      .returning();
    if (role === "owner") actor = u.id;
    return createSession({
      user: {
        id: u.id,
        email: null,
        firstName: null,
        lastName: null,
        profileImageUrl: null,
      },
      access_token: "local-fixture",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });
  };
  ownerSid = await session("owner");
  viewerSid = await session("viewer");
  for (const tenant of [org, other]) {
    const [contact] = await db
      .insert(contactsTable)
      .values({
        organizationId: tenant,
        firstName: "Fictional",
        lastName: "Customer",
        email: `local-${tenant}@example.invalid`,
      })
      .returning();
    const [record] = await db
      .insert(leadsTable)
      .values({
        organizationId: tenant,
        contactId: contact.id,
        status: "estimate_sent",
        summary: "LOCAL QA premium roof",
      })
      .returning();
    if (tenant === org) lead = record.id;
    else otherLead = record.id;
  }
  const [e] = await db
    .insert(estimatesTable)
    .values({
      organizationId: org,
      leadId: lead,
      title: "LOCAL QA roof",
      status: "sent",
      totalCents: 100000,
      sentAt: new Date(),
    })
    .returning();
  estimate = e.id;
  const [p] = await db
    .insert(projectsTable)
    .values({
      organizationId: org,
      leadId: lead,
      estimateId: estimate,
      name: "LOCAL QA exterior project",
      status: "completed",
      completedAt: new Date(),
    })
    .returning();
  project = p.id;
  portalToken = randomUUID();
  await db.insert(portalSessionsTable).values({
    organizationId: org,
    tokenHash: createHash("sha256").update(portalToken).digest("hex"),
    identifier: `local-${org}@example.invalid`,
    channel: "email",
    expiresAt: new Date(Date.now() + 3600_000),
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await deleteTestOrgs(org, other);
});

describe("tenant-scoped revenue workspace", () => {
  it("enforces session, owner approvals and strict field validation", async () => {
    expect((await call("/revenue/desk", undefined, "")).status).toBe(401);
    expect((await call("/revenue/profile", profile(), viewerSid)).status).toBe(
      403,
    );
    expect(
      (await call("/revenue/profile", { ...profile(), organizationId: other }))
        .status,
    ).toBe(400);
    expect(
      (await call("/revenue/profile", { ...profile(), confirmed: false }))
        .status,
    ).toBe(400);
    expect((await call("/platform/clients/health")).status).toBe(403);
  });
  it("versions approved knowledge, reconciles duplicate saves, and rejects stale edits", async () => {
    const first = (await (
      await call("/revenue/profile", profile())
    ).json()) as { id: string; version: number };
    expect(first.version).toBe(1);
    expect(
      (
        (await (await call("/revenue/profile", profile())).json()) as {
          id: string;
        }
      ).id,
    ).toBe(first.id);
    expect(
      (
        await call("/revenue/profile", {
          ...profile(),
          content: { ...profile().content, services: "Changed service" },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        (await (await call("/revenue/profile")).json()) as {
          content: { services: string };
        }
      ).content.services,
    ).toBe("Roofing and siding");
  });
  it("requires owned lead/estimate and preserves historical decision packages", async () => {
    expect((await call(`/revenue/rooms/${otherLead}`, room())).status).toBe(
      404,
    );
    const saved = await call(`/revenue/rooms/${lead}`, room());
    expect(saved.status).toBe(201);
    type RoomResponse = {
      versions: Array<{ isCurrent: boolean; estimateTotalCents: number }>;
      customerPath: string;
    };
    let data = (await (
      await call(`/revenue/rooms/${lead}`)
    ).json()) as RoomResponse;
    expect(data.versions[0].isCurrent).toBe(true);
    expect(data.customerPath).toContain(`/project-room/`);
    await db
      .update(estimatesTable)
      .set({
        title: "Revised LOCAL QA estimate",
        totalCents: 200000,
        updatedAt: new Date(Date.now() + 1000),
      })
      .where(eq(estimatesTable.id, estimate));
    data = (await (
      await call(`/revenue/rooms/${lead}`)
    ).json()) as RoomResponse;
    expect(data.versions[0].isCurrent).toBe(false);
    expect(data.versions[0].estimateTotalCents).toBe(100000);
  });
  it("serves only a portal session's own project and strips internal approval data", async () => {
    expect(
      (await call(`/portal/projects/${lead}/decision-room`, undefined, ""))
        .status,
    ).toBe(401);
    const headers = { "x-portal-token": portalToken };
    const result = await call(
      `/portal/projects/${lead}/decision-room`,
      undefined,
      "",
      "GET",
      headers,
    );
    expect(result.status).toBe(200);
    const data = (await result.json()) as {
      versions: Array<{ title: string }>;
    };
    expect(data.versions[0].title).toContain("LOCAL QA");
    expect(JSON.stringify(data)).not.toContain("sourceReference");
    expect(JSON.stringify(data)).not.toContain("approvedByUserId");
    expect(
      (
        await call(
          `/portal/projects/${otherLead}/decision-room`,
          undefined,
          "",
          "GET",
          headers,
        )
      ).status,
    ).toBe(404);
  });
  it("records financial events idempotently with refunds and direct-cost corrections", async () => {
    const occurredAt = "2026-09-01T12:00:00.000Z";
    const input = {
      leadId: lead,
      sourceReference: `receipt-${randomUUID()}`,
      kind: "payment",
      amountCents: 50000,
      occurredAt,
      confirmed: true,
    };
    const result = await Promise.all([
      call("/revenue/value", input),
      call("/revenue/value", input),
    ]);
    expect(result.every((r) => r.status === 201)).toBe(true);
    expect(
      await db
        .select()
        .from(valueEntriesTable)
        .where(
          and(
            eq(valueEntriesTable.organizationId, org),
            eq(valueEntriesTable.sourceReference, input.sourceReference),
          ),
        ),
    ).toHaveLength(1);
    expect(
      (await call("/revenue/value", { ...input, amountCents: 999 })).status,
    ).toBe(409);
    expect(
      (
        await call("/revenue/value", {
          ...input,
          leadId: otherLead,
          sourceReference: randomUUID(),
        })
      ).status,
    ).toBe(404);
    for (const [kind, amountCents] of [
      ["refund", 10000],
      ["direct_cost", 20000],
      ["cost_refund", 3000],
    ] as const)
      expect(
        (
          await call("/revenue/value", {
            ...input,
            kind,
            amountCents,
            sourceReference: randomUUID(),
          })
        ).status,
      ).toBe(201);
    const ledger = (await (await call("/revenue/value")).json()) as {
      entryCount: number;
      netReceiptsCents: number;
      netDirectCostsCents: number;
      recordedContributionCents: number;
      boundary: string;
    };
    expect(ledger.entryCount).toBe(4);
    expect(ledger.netReceiptsCents).toBe(40000);
    expect(ledger.netDirectCostsCents).toBe(17000);
    expect(ledger.recordedContributionCents).toBe(23000);
    expect(ledger.boundary).toContain(
      "No bank/accounting synchronization or causal ROI",
    );
    expect(ledger.boundary).toContain(
      "missing costs, tax and overhead prevent a profit claim",
    );
    expect(
      (await call("/revenue/value", { ...input, amountCents: 0 })).status,
    ).toBe(400);
    expect(
      (
        await call("/revenue/value", {
          ...input,
          occurredAt: "2999-01-01T00:00:00.000Z",
        })
      ).status,
    ).toBe(400);
  });
  it("drafts only from completed owned work and requires explicit content permission", async () => {
    const input = {
      projectId: project,
      expectedVersion: 0,
      title: "LOCAL QA completed project",
      serviceArea: "North Georgia",
      body: "The team completed the approved exterior scope. These are fictional local test records.",
      sourceReference: "LOCAL QA completion record",
    };
    const draft = (await (await call("/revenue/growth", input)).json()) as {
      id: string;
      state: string;
    };
    expect(draft.state).toBe("draft");
    expect(
      (
        await call(`/revenue/growth/${draft.id}/approve`, {
          confirmedContentPermission: false,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(
          `/revenue/growth/${draft.id}/approve`,
          { confirmedContentPermission: true },
          viewerSid,
        )
      ).status,
    ).toBe(403);
    const approved = (await (
      await call(`/revenue/growth/${draft.id}/approve`, {
        confirmedContentPermission: true,
      })
    ).json()) as { state: string };
    expect(approved.state).toBe("approved");
    expect(approved).not.toHaveProperty("publishedAt");
    await db
      .update(projectsTable)
      .set({ status: "in_progress" })
      .where(eq(projectsTable.id, project));
    expect(
      (await call("/revenue/growth", { ...input, expectedVersion: 1 })).status,
    ).toBe(409);
  });
  it("claims an inquiry once without replacing another owner", async () => {
    const responses = await Promise.all([
      call(`/revenue/leads/${lead}/claim`, { confirmed: true }),
      call(`/revenue/leads/${lead}/claim`, { confirmed: true }),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
  });
  it("executes an approved BIE task exactly once for repeated requests", async () => {
    const [p] = await db
      .insert(bieActionProposalsTable)
      .values({
        organizationId: org,
        leadId: lead,
        actionType: "create_task",
        title: "LOCAL QA guarded task",
        rationale: "Fictional follow-up",
        payload: { title: "LOCAL QA guarded task" },
      })
      .returning();
    await reviewBieProposal(org, p.id, actor, "approve");
    await Promise.all(
      Array.from({ length: 5 }, () => executeBieProposal(org, p.id, actor)),
    );
    expect(
      await db
        .select()
        .from(crmTasksTable)
        .where(
          and(
            eq(crmTasksTable.organizationId, org),
            eq(crmTasksTable.title, "LOCAL QA guarded task"),
          ),
        ),
    ).toHaveLength(1);
    expect((await executeBieProposal(org, p.id, actor))?.status).toBe(
      "executed",
    );
    const foreign = await executeBieProposal(other, p.id, actor);
    expect(foreign).toBeNull();
  });
  it("blocks disconnected outbound email before a provider effect", async () => {
    const [p] = await db
      .insert(bieActionProposalsTable)
      .values({
        organizationId: org,
        leadId: lead,
        actionType: "send_email",
        title: "LOCAL QA no provider",
        rationale: "Test channel",
        payload: { subject: "QA", body: "No real message" },
        // Historical approvals remain untracked; new approvals must prepare.
        status: "approved",
        reviewedByUserId: actor,
      })
      .returning();
    const result = await executeBieProposal(org, p.id, actor);
    expect(result?.status).toBe("blocked");
    expect(result?.executionDetail).toContain("not ready");
  });
  it("rejects stale and unprepared email approvals, then stops a historical reviewed action on a new reply", async () => {
    const payload = {
      subject: "LOCAL QA current draft",
      body: "Current reviewed content",
    };
    const [p] = await db
      .insert(bieActionProposalsTable)
      .values({
        organizationId: org,
        leadId: lead,
        actionType: "send_email",
        title: "LOCAL QA stale approval",
        rationale: "Test content lock",
        payload,
      })
      .returning();
    expect((await call(`/bie/actions/${p.id}/approve`, {})).status).toBe(400);
    expect(
      (
        await call(`/bie/actions/${p.id}/approve`, {
          expectedPayload: { ...payload, body: "Outdated content" },
        })
      ).status,
    ).toBe(409);
    expect(
      (await call(`/bie/actions/${p.id}/approve`, { expectedPayload: payload }))
        .status,
    ).toBe(409);
    // Preserve the separate existing-approval safety test; no new email may
    // silently acquire a review or mailbox snapshot from this transition.
    await db.update(bieActionProposalsTable).set({ status: "approved", reviewedByUserId: actor }).where(eq(bieActionProposalsTable.id, p.id));
    await db.insert(activitiesTable).values({
      organizationId: org,
      leadId: lead,
      type: "portal_message",
      title: "LOCAL QA customer reply",
      createdAt: new Date(Date.now() + 100),
    });
    const result = await executeBieProposal(org, p.id, actor);
    expect(result?.status).toBe("blocked");
    expect(result?.executionDetail).toContain("New customer activity");
  });
  it("refuses execution after the approving staff member is deactivated", async () => {
    const [p] = await db
      .insert(bieActionProposalsTable)
      .values({
        organizationId: org,
        leadId: lead,
        actionType: "create_task",
        title: "LOCAL QA revoked actor",
        rationale: "Test current identity",
        payload: { title: "Never create this task" },
      })
      .returning();
    await reviewBieProposal(org, p.id, actor, "approve");
    await db
      .update(usersTable)
      .set({ isActive: false })
      .where(eq(usersTable.id, actor));
    try {
      const result = await executeBieProposal(org, p.id, actor);
      expect(result?.status).toBe("blocked");
      expect(result?.executionDetail).toContain("active, authorized");
    } finally {
      await db
        .update(usersTable)
        .set({ isActive: true })
        .where(eq(usersTable.id, actor));
    }
  });
});
