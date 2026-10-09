import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activitiesTable,
  auditEventsTable,
  contactsTable,
  crmTasksTable,
  db,
  leadsTable,
  organizationsTable,
  pool,
  smartSiteFollowupsTable,
  smartSiteSubmissionsTable,
  smartSitesTable,
  usersTable,
} from "@workspace/db";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import {
  assignSmartSiteLead,
  getSmartSiteInquiryFollowup,
  recordSmartSiteAttempt,
  smartSiteFollowup,
} from "./smart-site-followup";

const orgs: string[] = [];
async function fixture() {
  const [org, foreignOrg] = await db
    .insert(organizationsTable)
    .values(
      ["A", "B"].map((label) => ({
        name: `Synthetic claim ${label}`,
        slug: `claim-${randomUUID()}`,
      })),
    )
    .returning();
  orgs.push(org.id, foreignOrg.id);
  const [actor, teammate, viewer, foreign] = await db
    .insert(usersTable)
    .values([
      {
        organizationId: org.id,
        firstName: "Synthetic",
        lastName: "Responder A",
        role: "office" as const,
        emailVerifiedAt: new Date(),
      },
      {
        organizationId: org.id,
        firstName: "Synthetic",
        lastName: "Responder B",
        role: "sales_rep" as const,
        emailVerifiedAt: new Date(),
      },
      {
        organizationId: org.id,
        role: "viewer" as const,
        emailVerifiedAt: new Date(),
      },
      {
        organizationId: foreignOrg.id,
        firstName: "FOREIGN_STAFF",
        role: "office" as const,
        emailVerifiedAt: new Date(),
      },
    ])
    .returning();
  const [contact] = await db
    .insert(contactsTable)
    .values({
      organizationId: org.id,
      firstName: "PRIVATE_CONTACT",
      email: "private-customer@example.invalid",
    })
    .returning();
  const [site] = await db
    .insert(smartSitesTable)
    .values({
      organizationId: org.id,
      siteKey: randomUUID(),
      name: "Synthetic intake",
      profile: "hvac",
      source: "synthetic-site",
      keyHash: "synthetic-key-hash",
    })
    .returning();
  return { org, foreignOrg, actor, teammate, viewer, foreign, contact, site };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function inquiry(
  f: Fixture,
  extra: Partial<typeof leadsTable.$inferInsert> = {},
) {
  const [lead] = await db
    .insert(leadsTable)
    .values({
      organizationId: f.org.id,
      contactId: f.contact.id,
      creationMethod: "smart-site",
      ...extra,
    })
    .returning();
  const [receipt] = await db
    .insert(smartSiteSubmissionsTable)
    .values({
      organizationId: f.org.id,
      siteId: f.site.id,
      leadId: lead.id,
      requestId: randomUUID(),
      payloadHash: "synthetic",
      consent: { privateEvidence: "DO_NOT_RETURN_CONSENT" },
      responseDueAt: new Date(),
    })
    .returning();
  const [task] = await db
    .insert(crmTasksTable)
    .values({
      organizationId: f.org.id,
      leadId: lead.id,
      contactId: f.contact.id,
      title: "Synthetic first response",
      sourceEvent: "smart_site.lead_saved",
    })
    .returning();
  return { lead, receipt, task };
}
const attempt = () => ({
  requestId: randomUUID(),
  channel: "phone" as const,
  outcome: "no_answer",
  confirmed: true as const,
});
afterEach(async () => {
  vi.restoreAllMocks();
  await deleteTestOrgs(...orgs.splice(0));
});

describe("current Smart Site responder authority", () => {
  it("commits one initial claimant and the same canonical task owner", async () => {
    const f = await fixture(),
      item = await inquiry(f);
    const results = await Promise.allSettled([
      assignSmartSiteLead(f.org.id, f.actor.id, item.lead.id, f.actor.id, null),
      assignSmartSiteLead(
        f.org.id,
        f.teammate.id,
        item.lead.id,
        f.teammate.id,
        null,
      ),
    ]);
    const success = results.find((result) => result.status === "fulfilled");
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === "rejected"),
    ).toMatchObject({
      reason: { code: "owner_changed_refresh_first", status: 409 },
    });
    if (success?.status !== "fulfilled") throw new Error("No winner");
    const [task] = await db
      .select()
      .from(crmTasksTable)
      .where(eq(crmTasksTable.id, item.task.id));
    expect(task.assignedUserId).toBe(success.value.assignedUserId);
    expect(
      await db
        .select()
        .from(auditEventsTable)
        .where(
          and(
            eq(auditEventsTable.organizationId, f.org.id),
            eq(auditEventsTable.action, "smart_site.owner_changed"),
          ),
        ),
    ).toHaveLength(1);
  });

  // Like callie-runtime's storage-failure coverage, this needs PostgreSQL:
  // PGlite's socket adapter cannot attest recovery after an aborted trigger.
  it.skipIf(process.env.SCHEDULER_TEST_BACKEND === "pglite")(
    "rolls ownership and audit back when the canonical task cannot be updated",
    async () => {
      const f = await fixture(),
        item = await inquiry(f);
      const hook = `claim_task_failure_${randomUUID().replaceAll("-", "")}`;
      await pool.query(
        `CREATE FUNCTION ${hook}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic task write failure'; END $$`,
      );
      try {
        await pool.query(
          `CREATE TRIGGER ${hook} BEFORE UPDATE ON crm_tasks FOR EACH ROW WHEN (NEW.id = '${item.task.id}'::uuid) EXECUTE FUNCTION ${hook}()`,
        );
        await expect(
          assignSmartSiteLead(
            f.org.id,
            f.actor.id,
            item.lead.id,
            f.actor.id,
            null,
          ),
        ).rejects.toThrow();
        expect(
          (
            await db
              .select()
              .from(leadsTable)
              .where(eq(leadsTable.id, item.lead.id))
          )[0].assignedUserId,
        ).toBeNull();
        expect(
          (
            await db
              .select()
              .from(crmTasksTable)
              .where(eq(crmTasksTable.id, item.task.id))
          )[0],
        ).toMatchObject({ assignedUserId: null, status: "open" });
        expect(
          await db
            .select()
            .from(auditEventsTable)
            .where(
              and(
                eq(auditEventsTable.organizationId, f.org.id),
                eq(auditEventsTable.action, "smart_site.owner_changed"),
              ),
            ),
        ).toHaveLength(0);
      } finally {
        await pool.query(`DROP TRIGGER IF EXISTS ${hook} ON crm_tasks`);
        await pool.query(`DROP FUNCTION IF EXISTS ${hook}()`);
      }
    },
  );

  it("excludes pending, unverified, inactive and read-only staff from owner choices and assignment", async () => {
    const f = await fixture(),
      item = await inquiry(f);
    const invalid = await db
      .insert(usersTable)
      .values([
        {
          id: `invite:${randomUUID()}`,
          organizationId: f.org.id,
          role: "office" as const,
        },
        {
          organizationId: f.org.id,
          role: "office" as const,
          emailVerifiedAt: null,
        },
        { organizationId: f.org.id, role: "office" as const, isActive: false },
      ])
      .returning();
    for (const target of [...invalid, f.viewer, f.foreign]) {
      await expect(
        assignSmartSiteLead(
          f.org.id,
          f.actor.id,
          item.lead.id,
          target.id,
          null,
        ),
      ).rejects.toMatchObject({
        code: "owner_must_be_active_team_member",
        status: 400,
      });
    }
    const report = await smartSiteFollowup(f.org.id);
    expect(new Set(report.members.map((member) => member.id))).toEqual(
      new Set([f.actor.id, f.teammate.id]),
    );
    expect(
      (
        await db
          .select()
          .from(leadsTable)
          .where(eq(leadsTable.id, item.lead.id))
      )[0].assignedUserId,
    ).toBeNull();
  });

  it("rechecks actor eligibility for assignments, releases and attempted-contact receipts", async () => {
    const f = await fixture(),
      item = await inquiry(f);
    const actors = await db
      .insert(usersTable)
      .values([
        {
          id: `invite:${randomUUID()}`,
          organizationId: f.org.id,
          role: "office" as const,
        },
        {
          organizationId: f.org.id,
          role: "office" as const,
          emailVerifiedAt: null,
        },
        { organizationId: f.org.id, role: "office" as const, isActive: false },
      ])
      .returning();
    for (const actor of [...actors, f.viewer, f.foreign]) {
      await expect(
        assignSmartSiteLead(
          f.org.id,
          actor.id,
          item.lead.id,
          f.teammate.id,
          null,
        ),
      ).rejects.toMatchObject({
        code: "active_responder_required",
        status: 403,
      });
      await expect(
        assignSmartSiteLead(f.org.id, actor.id, item.lead.id, null, null),
      ).rejects.toMatchObject({
        code: "active_responder_required",
        status: 403,
      });
      await expect(
        recordSmartSiteAttempt(f.org.id, actor.id, item.lead.id, attempt()),
      ).rejects.toMatchObject({
        code: "active_responder_required",
        status: 403,
      });
    }
    expect(
      await db
        .select()
        .from(smartSiteFollowupsTable)
        .where(eq(smartSiteFollowupsTable.organizationId, f.org.id)),
    ).toHaveLength(0);
    expect(
      (
        await db
          .select()
          .from(crmTasksTable)
          .where(eq(crmTasksTable.id, item.task.id))
      )[0].status,
    ).toBe("open");
  });

  it("retains attempt idempotency while refusing replay by a now-unverified actor", async () => {
    const f = await fixture(),
      item = await inquiry(f),
      input = attempt();
    const saved = await recordSmartSiteAttempt(
      f.org.id,
      f.actor.id,
      item.lead.id,
      input,
    );
    expect(
      await recordSmartSiteAttempt(f.org.id, f.actor.id, item.lead.id, input),
    ).toMatchObject({ id: saved.id, duplicate: true });
    await expect(
      recordSmartSiteAttempt(f.org.id, f.actor.id, item.lead.id, {
        ...input,
        outcome: "connected",
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await db
      .update(usersTable)
      .set({ emailVerifiedAt: null })
      .where(eq(usersTable.id, f.actor.id));
    await expect(
      recordSmartSiteAttempt(f.org.id, f.actor.id, item.lead.id, input),
    ).rejects.toMatchObject({ code: "active_responder_required" });
    expect(
      await db
        .select()
        .from(smartSiteFollowupsTable)
        .where(eq(smartSiteFollowupsTable.organizationId, f.org.id)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(activitiesTable)
        .where(
          and(
            eq(activitiesTable.leadId, item.lead.id),
            eq(activitiesTable.type, "smart_site_contact_attempt"),
          ),
        ),
    ).toHaveLength(1);
  });
});

describe("exact inquiry ownership read", () => {
  it("finds the exact inquiry beyond the Capture queue without returning contact or receipt content", async () => {
    const f = await fixture();
    for (let i = 0; i < 26; i++) await inquiry(f);
    const item = await inquiry(f);
    await db
      .update(smartSiteSubmissionsTable)
      .set({ responseDueAt: new Date("2035-01-01T00:00:00Z") })
      .where(eq(smartSiteSubmissionsTable.id, item.receipt.id));
    const report = await smartSiteFollowup(f.org.id);
    expect(report.pending).toHaveLength(25);
    expect(report.pending.some((row) => row.leadId === item.lead.id)).toBe(
      false,
    );
    const result = await getSmartSiteInquiryFollowup(
      f.org.id,
      f.actor.id,
      item.lead.id,
    );
    expect(result).toMatchObject({
      organizationId: f.org.id,
      leadId: item.lead.id,
      siteName: f.site.name,
      ownerName: null,
      ownerEligible: false,
      canClaim: true,
    });
    expect(Object.keys(result).sort()).toEqual(
      [
        "organizationId",
        "leadId",
        "siteName",
        "status",
        "assignedUserId",
        "ownerName",
        "ownerEligible",
        "receivedAt",
        "dueAt",
        "firstAttemptAt",
        "canClaim",
        "serverNow",
      ].sort(),
    );
    for (const privateValue of [
      f.contact.firstName,
      f.contact.email,
      f.site.keyHash,
      "DO_NOT_RETURN_CONSENT",
      item.receipt.id,
    ])
      expect(JSON.stringify(result)).not.toContain(privateValue);
  });

  it("reports current owner and current actor authority without exposing another company's staff", async () => {
    const f = await fixture(),
      item = await inquiry(f);
    expect(
      await getSmartSiteInquiryFollowup(f.org.id, f.viewer.id, item.lead.id),
    ).toMatchObject({ canClaim: false });
    expect(
      await getSmartSiteInquiryFollowup(f.org.id, f.actor.id, item.lead.id, {
        effectiveRole: "viewer",
      }),
    ).toMatchObject({ canClaim: false });
    expect(
      await getSmartSiteInquiryFollowup(f.org.id, f.actor.id, item.lead.id, {
        staffSession: false,
      }),
    ).toMatchObject({ canClaim: false });
    await assignSmartSiteLead(
      f.org.id,
      f.actor.id,
      item.lead.id,
      f.teammate.id,
      null,
    );
    expect(
      await getSmartSiteInquiryFollowup(f.org.id, f.actor.id, item.lead.id),
    ).toMatchObject({
      assignedUserId: f.teammate.id,
      ownerName: "Synthetic Responder B",
      ownerEligible: true,
      canClaim: false,
    });
    await db
      .update(usersTable)
      .set({ isActive: false })
      .where(eq(usersTable.id, f.teammate.id));
    expect(
      await getSmartSiteInquiryFollowup(f.org.id, f.actor.id, item.lead.id),
    ).toMatchObject({ ownerEligible: false, canClaim: false });
    await db
      .update(usersTable)
      .set({ organizationId: f.foreignOrg.id })
      .where(eq(usersTable.id, f.teammate.id));
    expect(
      await getSmartSiteInquiryFollowup(f.org.id, f.actor.id, item.lead.id),
    ).toMatchObject({ ownerName: null, ownerEligible: false, canClaim: false });
  });

  it.each(["won", "lost", "completed"] as const)(
    "does not offer or commit an initial claim after %s",
    async (status) => {
      const f = await fixture(),
        item = await inquiry(f, { status });
      expect(
        await getSmartSiteInquiryFollowup(f.org.id, f.actor.id, item.lead.id),
      ).toMatchObject({ status, canClaim: false });
      await expect(
        assignSmartSiteLead(
          f.org.id,
          f.actor.id,
          item.lead.id,
          f.actor.id,
          null,
        ),
      ).rejects.toMatchObject({ code: "inquiry_no_longer_open", status: 409 });
    },
  );

  it("rejects ordinary or inaccessible lead IDs and rechecks the reader's current company", async () => {
    const f = await fixture(),
      item = await inquiry(f);
    const [ordinary] = await db
      .insert(leadsTable)
      .values({ organizationId: f.org.id, contactId: f.contact.id })
      .returning();
    await expect(
      getSmartSiteInquiryFollowup(f.org.id, f.actor.id, ordinary.id),
    ).rejects.toMatchObject({ code: "inquiry_not_found", status: 404 });
    await expect(
      getSmartSiteInquiryFollowup(f.foreignOrg.id, f.foreign.id, item.lead.id),
    ).rejects.toMatchObject({ code: "inquiry_not_found", status: 404 });
    await expect(
      getSmartSiteInquiryFollowup(f.org.id, f.foreign.id, item.lead.id),
    ).rejects.toMatchObject({ code: "active_member_required", status: 403 });
    await db
      .update(usersTable)
      .set({ emailVerifiedAt: null })
      .where(eq(usersTable.id, f.actor.id));
    expect(
      await getSmartSiteInquiryFollowup(f.org.id, f.actor.id, item.lead.id),
    ).toMatchObject({ canClaim: false });
  });
});

async function blockedBy(blocker: number, query: string) {
  let pid: number | undefined;
  await vi.waitFor(
    async () => {
      const result = await pool.query<{ pid: number }>(
        "SELECT pid FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid)) AND query ILIKE $2",
        [blocker, query],
      );
      pid = result.rows[0]?.pid;
      expect(pid).toBeDefined();
    },
    { timeout: 3000, interval: 20 },
  );
  return pid!;
}

// PGlite serializes socket sessions. These barriers require the real PostgreSQL CI service.
describe.skipIf(process.env.SCHEDULER_TEST_BACKEND === "pglite")(
  "independent PostgreSQL membership barriers",
  () => {
    it.each(["claim", "attempt"] as const)(
      "%s observes a membership change committed while it waits on the lead",
      async (command) => {
        const f = await fixture(),
          item = await inquiry(f),
          blocker = await pool.connect();
        let pending: Promise<unknown> | undefined;
        try {
          await blocker.query("BEGIN");
          const { rows } = await blocker.query<{ pid: number }>(
            "SELECT pg_backend_pid() AS pid",
          );
          await blocker.query("SELECT id FROM leads WHERE id=$1 FOR UPDATE", [
            item.lead.id,
          ]);
          pending = (
            command === "claim"
              ? assignSmartSiteLead(
                  f.org.id,
                  f.actor.id,
                  item.lead.id,
                  f.teammate.id,
                  null,
                )
              : recordSmartSiteAttempt(
                  f.org.id,
                  f.actor.id,
                  item.lead.id,
                  attempt(),
                )
          ).then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          );
          await blockedBy(rows[0].pid, '%from "leads"%for update%');
          await blocker.query(
            "UPDATE users SET organization_id=$2 WHERE id=$1",
            [f.actor.id, f.foreignOrg.id],
          );
          await blocker.query("COMMIT");
          expect(await pending).toMatchObject({
            error: { code: "active_responder_required", status: 403 },
          });
          expect(
            (
              await db
                .select()
                .from(leadsTable)
                .where(eq(leadsTable.id, item.lead.id))
            )[0].assignedUserId,
          ).toBeNull();
          expect(
            (
              await db
                .select()
                .from(crmTasksTable)
                .where(eq(crmTasksTable.id, item.task.id))
            )[0].status,
          ).toBe("open");
          expect(
            await db
              .select()
              .from(smartSiteFollowupsTable)
              .where(eq(smartSiteFollowupsTable.leadId, item.lead.id)),
          ).toHaveLength(0);
        } finally {
          await blocker.query("ROLLBACK");
          blocker.release();
          await pending;
        }
      },
    );

    it("rejects a target whose verification changed while ownership waits", async () => {
      const f = await fixture(),
        item = await inquiry(f),
        blocker = await pool.connect();
      let pending: Promise<unknown> | undefined;
      try {
        await blocker.query("BEGIN");
        const { rows } = await blocker.query<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid",
        );
        await blocker.query("SELECT id FROM leads WHERE id=$1 FOR UPDATE", [
          item.lead.id,
        ]);
        pending = assignSmartSiteLead(
          f.org.id,
          f.actor.id,
          item.lead.id,
          f.teammate.id,
          null,
        ).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        await blockedBy(rows[0].pid, '%from "leads"%for update%');
        await blocker.query(
          "UPDATE users SET email_verified_at=NULL WHERE id=$1",
          [f.teammate.id],
        );
        await blocker.query("COMMIT");
        expect(await pending).toMatchObject({
          error: { code: "owner_must_be_active_team_member", status: 400 },
        });
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
        await pending;
      }
    });

    it("retains actor and target authority until the canonical task change commits", async () => {
      const f = await fixture(),
        item = await inquiry(f),
        taskWriter = await pool.connect(),
        memberWriter = await pool.connect();
      let pending: Promise<unknown> | undefined,
        changed: Promise<unknown> | undefined;
      try {
        await taskWriter.query("BEGIN");
        const { rows } = await taskWriter.query<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid",
        );
        await taskWriter.query(
          "SELECT id FROM crm_tasks WHERE id=$1 FOR UPDATE",
          [item.task.id],
        );
        pending = assignSmartSiteLead(
          f.org.id,
          f.actor.id,
          item.lead.id,
          f.teammate.id,
          null,
        );
        const claimant = await blockedBy(rows[0].pid, '%update "crm_tasks"%');
        changed = memberWriter.query(
          "UPDATE users SET is_active=false WHERE id=ANY($1::varchar[])",
          [[f.actor.id, f.teammate.id]],
        );
        await blockedBy(claimant, "%UPDATE users SET is_active%");
        await taskWriter.query("COMMIT");
        expect(await pending).toMatchObject({ assignedUserId: f.teammate.id });
        await changed;
        expect(
          await getSmartSiteInquiryFollowup(
            f.org.id,
            f.viewer.id,
            item.lead.id,
          ),
        ).toMatchObject({
          assignedUserId: f.teammate.id,
          ownerEligible: false,
        });
      } finally {
        await taskWriter.query("ROLLBACK");
        taskWriter.release();
        await Promise.allSettled([pending, changed]);
        memberWriter.release();
      }
    });
  },
);
