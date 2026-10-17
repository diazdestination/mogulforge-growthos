import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  customerWorkCommandsTable,
  customerWorkRootsTable,
  db,
  invoiceOperationsTable,
  invoiceReceiptAllocationsTable,
  invoicesTable,
  leadsTable,
  pool,
  projectsTable,
  propertiesTable,
  valueEntriesTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import app from "../app";
import { createSession, deleteSession } from "../lib/auth";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import {
  acceptedReturningEstimate,
  returningCustomerFixture,
  returningEstimateDraft,
  returningInvoiceDocument,
  returningProjectDraft,
} from "../test-helpers/returning-customer-fixture";
import {
  createCustomerWorkEstimate,
  createCustomerWorkProject,
  updateCustomerWorkEstimate,
} from "./returning-customer";
import {
  INVOICE_HISTORY_RETAINED,
  VALUE_HISTORY_RETAINED,
  mergeLeads,
  updateContact,
  updateLead,
  updateProperty,
} from "./crm";
import {
  allocateInvoiceValue,
  createInvoice,
  getInvoice,
  issueInvoice,
  recordInvoicePayment,
  recordInvoiceRefund,
  reverseInvoiceAllocation,
} from "./invoices";
import { recordValueEntry } from "./revenue-workspace";
import {
  commitFinancialMigration,
  previewFinancialMigration,
} from "./financial-migration";
import { financialSourceFixture } from "../test-helpers/financial-migration-fixture";
import {
  getSchedulingReviewContext,
  saveSchedulingPolicy,
  setSchedulingCompanyTimeZone,
} from "./scheduling-policy";
import {
  createManualScheduledAppointment,
  createManualScheduledProject,
} from "./manual-scheduling";
import { transitionCustomerLifecycle } from "./customer-lifecycle";
import { auditEventsTable, usersTable } from "@workspace/db";
const realPg = it.skipIf(process.env.SCHEDULER_TEST_BACKEND === "pglite"),
  orgs: string[] = [],
  sessions: string[] = [],
  realFetch = globalThis.fetch,
  origin = "https://returning-race.example";
let server: Server | undefined, base: string;
beforeAll(async () => {
  vi.stubEnv("APP_ORIGIN", origin);
  vi.stubEnv("SESSION_SECRET", "synthetic-returning-race-session");
  if (process.env.SCHEDULER_TEST_BACKEND !== "pglite") {
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  vi.stubGlobal("fetch", async () => {
    throw Error("Only captured loopback staff HTTP may run");
  });
});
afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  for (const sid of sessions) await deleteSession(sid);
  await deleteTestOrgs(...orgs);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
async function fixture() {
  const f = await returningCustomerFixture();
  orgs.push(f.org);
  return f;
}
function observe<T>(p: Promise<T>, all: Promise<unknown>[]) {
  all.push(p);
  void p.catch(() => {});
  return p;
}
async function blockedBy(blocker: number, pattern: string) {
  for (let i = 0; i < 150; i++) {
    const { rows } = await pool.query(
      "SELECT pid FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid)) AND query ILIKE $2",
      [blocker, pattern],
    );
    if (rows[0]) return Number(rows[0].pid);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw Error(`Actual independent PostgreSQL barrier not observed: ${pattern}`);
}
async function barrier(
  table: string,
  timing: "BEFORE INSERT" | "AFTER UPDATE",
  condition: string,
) {
  const suffix = randomUUID().replaceAll("-", ""),
    hook = `qa_returning_${suffix}`,
    key = `qa-returning-${suffix}`,
    keeper = await pool.connect();
  await pool.query(
    `CREATE FUNCTION ${hook}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN PERFORM pg_advisory_xact_lock(hashtext('${key}')); END IF; RETURN NEW; END $$`,
  );
  await pool.query(
    `CREATE TRIGGER ${hook} ${timing} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${hook}()`,
  );
  await keeper.query("BEGIN");
  await keeper.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
  const pid = Number(
    (await keeper.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
  );
  return {
    pid,
    release: () => keeper.query("COMMIT"),
    cleanup: async (pending: Promise<unknown>[]) => {
      await keeper.query("ROLLBACK");
      keeper.release();
      await Promise.allSettled(pending);
      await pool.query(`DROP TRIGGER IF EXISTS ${hook} ON ${table}`);
      await pool.query(`DROP FUNCTION IF EXISTS ${hook}()`);
    },
  };
}
const command = (version: number) => ({
  requestId: randomUUID(),
  expectedVersion: version,
  confirmed: true as const,
});

realPg(
  "retains actual returning-work contact, property and accepted member locks through native command commit while ordinary writers wait",
  async () => {
    const f = await fixture(),
      pending: Promise<unknown>[] = [],
      input = returningEstimateDraft(f),
      b = await barrier(
        "customer_work_commands",
        "BEFORE INSERT",
        `NEW.organization_id='${f.org}'::uuid`,
      );
    const sid = await createSession({
      user: {
        id: f.owner.id,
        email: null,
        firstName: null,
        lastName: null,
        profileImageUrl: null,
      },
      access_token: "synthetic",
    });
    sessions.push(sid);
    try {
      const creating = observe(
          createCustomerWorkEstimate(
            f.org,
            { userId: f.office.id, effectiveRole: "office" },
            input,
          ),
          pending,
        ),
        creator = await blockedBy(
          b.pid,
          '%insert into "customer_work_commands"%',
        );
      const property = observe(
          updateProperty(f.org, f.secondProperty.id, {
            contactId: f.otherContact.id,
          }),
          pending,
        ),
        contact = observe(
          updateContact(f.org, f.contact.id, {
            firstName: "Later actual customer edit",
          }),
          pending,
        ),
        member = observe(
          realFetch(`${base}/api/v1/users/${f.office.id}`, {
            method: "PATCH",
            headers: {
              origin,
              cookie: `sid=${sid}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ isActive: false }),
          }),
          pending,
        );
      const writers = await Promise.all([
        blockedBy(creator, '%from "properties"%for update%'),
        blockedBy(creator, '%update "contacts"%'),
        blockedBy(creator, '%update "users"%'),
      ]);
      expect(new Set([...writers, creator, b.pid]).size).toBe(5);
      expect(
        await db
          .select()
          .from(customerWorkRootsTable)
          .where(eq(customerWorkRootsTable.organizationId, f.org)),
      ).toHaveLength(0);
      await b.release();
      const result = await creating;
      expect(result.estimate).toMatchObject({
        contactId: f.contact.id,
        propertyId: f.secondProperty.id,
        customerLabel: "Synthetic Returning Customer",
      });
      await expect(property).rejects.toMatchObject({
        code: "customer_work_parent_locked",
      });
      expect(await contact).toMatchObject({
        firstName: "Later actual customer edit",
      });
      expect((await member).status).toBe(200);
      await expect(
        createCustomerWorkEstimate(f.org, { userId: f.office.id }, input),
      ).rejects.toMatchObject({ code: "customer_work_access_denied" });
      expect(
        await db
          .select()
          .from(customerWorkCommandsTable)
          .where(eq(customerWorkCommandsTable.organizationId, f.org)),
      ).toHaveLength(1);
    } finally {
      await b.cleanup(pending);
    }
  },
  20000,
);

realPg(
  "waits for an actual property reassignment then refuses stale returning customer selection with no root or native command",
  async () => {
    const f = await fixture(),
      pending: Promise<unknown>[] = [],
      b = await barrier(
        "properties",
        "AFTER UPDATE",
        `NEW.id='${f.secondProperty.id}'::uuid`,
      );
    try {
      const moving = observe(
          updateProperty(f.org, f.secondProperty.id, {
            contactId: f.otherContact.id,
          }),
          pending,
        ),
        writer = await blockedBy(b.pid, '%update "properties"%');
      const creating = observe(
          createCustomerWorkEstimate(f.org, f.actor, returningEstimateDraft(f)),
          pending,
        ),
        creator = await blockedBy(writer, '%from "properties"%for share%');
      expect(new Set([b.pid, writer, creator]).size).toBe(3);
      await b.release();
      await moving;
      await expect(creating).rejects.toMatchObject({
        code: "customer_work_parent_mismatch",
      });
      expect(
        await db
          .select()
          .from(customerWorkRootsTable)
          .where(eq(customerWorkRootsTable.organizationId, f.org)),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(customerWorkCommandsTable)
          .where(eq(customerWorkCommandsTable.organizationId, f.org)),
      ).toHaveLength(0);
    } finally {
      await b.cleanup(pending);
    }
  },
  20000,
);

realPg(
  "serializes actual estimate conversion with duplicate creation and accepted-price writers into one retained native job",
  async () => {
    for (const mode of ["duplicate", "estimate"] as const) {
      const f = await fixture(),
        accepted = await acceptedReturningEstimate(f),
        input = {
          ...returningProjectDraft(f),
          source: {
            kind: "estimate",
            estimateId: accepted.estimate.id,
            expectedWorkVersion: 2,
          },
        },
        pending: Promise<unknown>[] = [],
        b = await barrier(
          "projects",
          "BEFORE INSERT",
          `NEW.organization_id='${f.org}'::uuid`,
        );
      try {
        const converting = observe(
            createCustomerWorkProject(f.org, f.actor, input),
            pending,
          ),
          creator = await blockedBy(b.pid, '%insert into "projects"%');
        const { source: _source, ...edit } = returningEstimateDraft(f);
        const next = observe<unknown>(
            mode === "duplicate"
              ? createCustomerWorkProject(f.org, f.actor, input)
              : updateCustomerWorkEstimate(
                  f.org,
                  f.actor,
                  accepted.estimate.id,
                  {
                    ...edit,
                    expectedWorkVersion: 2,
                    status: "accepted",
                    taxCents: 1,
                  },
                ),
            pending,
          ),
          writer = await blockedBy(creator, "%pg_advisory_xact_lock%");
        expect(new Set([b.pid, creator, writer]).size).toBe(3);
        await b.release();
        const result = await converting;
        if (mode === "duplicate")
          expect(await next).toMatchObject({
            command: { duplicate: true, targetId: result.project.id },
          });
        else
          await expect(next).rejects.toMatchObject({
            code: "customer_work_estimate_retained",
          });
        expect(
          await db
            .select()
            .from(projectsTable)
            .where(
              eq(
                projectsTable.customerWorkId,
                accepted.estimate.customerWorkId!,
              ),
            ),
        ).toHaveLength(1);
      } finally {
        await b.cleanup(pending);
      }
    }
  },
  30000,
);

async function schedulingFixture(cap: number | null = null) {
  const f = await fixture(),
    actor = { organizationId: f.org, userId: f.owner.id };
  await db
    .update(usersTable)
    .set({ isPlatformAdmin: true })
    .where(eq(usersTable.id, f.owner.id));
  const policy = {
    expectedRevision: 0,
    expectedCompanyTimeZone: f.company.timezone,
    enabled: true,
    minimumTravelGapMinutes: 60,
    maxConcurrentReservations: cap,
    durationPresets: [],
  };
  await saveSchedulingPolicy(actor, policy);
  const [lead] = await db
    .insert(leadsTable)
    .values({
      organizationId: f.org,
      contactId: f.contact.id,
      propertyId: f.secondProperty.id,
    })
    .returning();
  return { ...f, schedulingActor: actor, policy, lead };
}
type SchedulingFixture = Awaited<ReturnType<typeof schedulingFixture>>;
async function scheduledCommand(
  f: SchedulingFixture,
  kind: "returning" | "appointment" | "project",
  minute: number,
  userId: string,
) {
  const context = await getSchedulingReviewContext(f.schedulingActor, {
    sourceKind: kind === "returning" ? "direct_customer" : "lead",
    sourceId: kind === "returning" ? f.contact.id : f.lead.id,
    propertyId: f.secondProperty.id,
    reservationKind: kind === "appointment" ? "appointment" : "project",
    ...(kind === "appointment"
      ? { appointmentType: "production" as const }
      : {}),
  });
  const review = {
    context,
    duration: { kind: "explicit" as const, preset: null },
    startWallTime: null,
    endWallTime: null,
  };
  const window = {
    scheduledStart: new Date(Date.UTC(2037, 5, 15, 0, minute)).toISOString(),
    scheduledEnd: new Date(Date.UTC(2037, 5, 15, 0, minute + 60)).toISOString(),
  };
  const requestId = randomUUID();
  return {
    requestId,
    run: async () => {
      if (kind === "returning")
        return {
          committed: true,
          value: await createCustomerWorkProject(f.org, f.actor, {
            ...returningProjectDraft(f),
            requestId,
            ...window,
            crewUserIds: [userId],
            schedulingReview: review,
          }),
        };
      const result =
        kind === "appointment"
          ? await createManualScheduledAppointment(f.schedulingActor, {
              kind: "appointment_create",
              operationId: requestId,
              review,
              body: {
                ...window,
                leadId: f.lead.id,
                propertyId: f.secondProperty.id,
                type: "production",
                assignedUserId: userId,
              },
            })
          : await createManualScheduledProject(f.schedulingActor, {
              kind: "project_create",
              operationId: requestId,
              review,
              body: {
                ...window,
                leadId: f.lead.id,
                name: "Synthetic competing crew",
                crewUserIds: [userId],
              },
            });
      return {
        committed: result.ack.outcome === "committed",
        value: result.ack,
      };
    },
  };
}

for (const other of ["appointment", "project", "returning"] as const)
  for (const returningFirst of [true, false])
    for (const mode of ["travel", "capacity"] as const) {
      realPg(
        `returning/${other} ${mode} admission uses observed independent PostgreSQL locks returningFirst=${returningFirst}`,
        async () => {
          const f = await schedulingFixture(mode === "capacity" ? 1 : null),
            pending: Promise<unknown>[] = [];
          const firstKind = returningFirst ? "returning" : other,
            secondKind = returningFirst ? other : "returning";
          const first = await scheduledCommand(f, firstKind, 600, f.office.id),
            second = await scheduledCommand(
              f,
              secondKind,
              mode === "travel" ? 690 : 600,
              mode === "travel" ? f.office.id : f.owner.id,
            );
          const b = await barrier(
            firstKind === "appointment" ? "appointments" : "projects",
            "BEFORE INSERT",
            `NEW.organization_id='${f.org}'::uuid`,
          );
          try {
            const creating = observe(first.run(), pending),
              writer = await blockedBy(b.pid, "%insert into%");
            const competing = observe(second.run(), pending),
              waiter = await blockedBy(writer, "%pg_advisory_xact_lock%");
            expect(new Set([b.pid, writer, waiter]).size).toBe(3);
            await b.release();
            expect((await creating).committed).toBe(true);
            const code =
              mode === "travel"
                ? "travel_conflict"
                : "company_capacity_conflict";
            if (secondKind === "returning")
              await expect(competing).rejects.toMatchObject({ code });
            else
              expect(await competing).toMatchObject({
                committed: false,
                value: { outcome: "no_commit_refused", refusalCode: code },
              });
            const rows = await db
              .select()
              .from(customerWorkCommandsTable)
              .where(eq(customerWorkCommandsTable.organizationId, f.org));
            expect(rows).toHaveLength(firstKind === "returning" ? 1 : 0);
            expect(
              await db
                .select()
                .from(customerWorkRootsTable)
                .where(eq(customerWorkRootsTable.organizationId, f.org)),
            ).toHaveLength(rows.length);
            const transitions = await db
              .select()
              .from(auditEventsTable)
              .where(
                and(
                  eq(auditEventsTable.organizationId, f.org),
                  eq(
                    auditEventsTable.action,
                    "scheduling.reservation_transition.v1",
                  ),
                ),
              );
            expect(transitions).toHaveLength(1);
          } finally {
            await b.cleanup(pending);
          }
        },
        30000,
      );
    }

for (const mode of ["policy", "zone", "lifecycle"] as const)
  for (const sourceFirst of [true, false]) {
    realPg(
      `returning booking and ${mode} changes retain original authority sourceFirst=${sourceFirst}`,
      async () => {
        const f = await schedulingFixture(),
          input = await scheduledCommand(f, "returning", 600, f.office.id),
          pending: Promise<unknown>[] = [];
        const action =
          mode === "policy"
            ? "scheduling.policy_saved"
            : mode === "zone"
              ? "organization.timezone_updated"
              : "customer_lifecycle.pause";
        const b = await barrier(
          sourceFirst ? "projects" : "audit_events",
          "BEFORE INSERT",
          sourceFirst
            ? `NEW.organization_id='${f.org}'::uuid`
            : `NEW.organization_id='${f.org}'::uuid AND NEW.action='${action}'`,
        );
        const change = async () =>
          mode === "policy"
            ? saveSchedulingPolicy(f.schedulingActor, {
                ...f.policy,
                expectedRevision: 1,
                minimumTravelGapMinutes: 90,
              })
            : mode === "zone"
              ? setSchedulingCompanyTimeZone(
                  f.schedulingActor,
                  f.org,
                  f.company.timezone === "UTC" ? "America/Los_Angeles" : "UTC",
                  f.company.timezone,
                )
              : transitionCustomerLifecycle(f.org, f.owner.id, {
                  action: "pause",
                  expectedVersion: 0,
                  reason: "Synthetic returning race",
                });
        try {
          const first = observe<unknown>(
              sourceFirst ? input.run() : change(),
              pending,
            ),
            writer = await blockedBy(b.pid, "%insert into%");
          const second = observe<unknown>(
              sourceFirst ? change() : input.run(),
              pending,
            ),
            waiter = await blockedBy(writer, "%pg_advisory_xact_lock%");
          expect(new Set([b.pid, writer, waiter]).size).toBe(3);
          await b.release();
          await first;
          if (sourceFirst) {
            await second;
            expect((await input.run()).committed).toBe(true);
          } else
            await expect(second).rejects.toMatchObject({
              code:
                mode === "lifecycle"
                  ? "customer_work_company_held"
                  : "stale_scheduling_review",
            });
          expect(
            await db
              .select()
              .from(customerWorkCommandsTable)
              .where(eq(customerWorkCommandsTable.organizationId, f.org)),
          ).toHaveLength(sourceFirst ? 1 : 0);
        } finally {
          await b.cleanup(pending);
        }
      },
      30000,
    );
  }

for (const mode of ["crew", "property"] as const)
  for (const sourceFirst of [true, false])
    realPg(
      `returning scheduled source locks ${mode} through commit sourceFirst=${sourceFirst}`,
      async () => {
        const f = await schedulingFixture(),
          input = await scheduledCommand(f, "returning", 600, f.office.id),
          pending: Promise<unknown>[] = [];
        const sid = await createSession({
          user: {
            id: f.owner.id,
            email: null,
            firstName: null,
            lastName: null,
            profileImageUrl: null,
          },
          access_token: "synthetic",
        });
        sessions.push(sid);
        const b = await barrier(
          sourceFirst
            ? "customer_work_commands"
            : mode === "crew"
              ? "users"
              : "properties",
          sourceFirst ? "BEFORE INSERT" : "AFTER UPDATE",
          sourceFirst
            ? `NEW.organization_id='${f.org}'::uuid`
            : `NEW.id='${mode === "crew" ? f.office.id : f.secondProperty.id}'::${mode === "crew" ? "varchar" : "uuid"}`,
        );
        const change = async () =>
          mode === "crew"
            ? realFetch(`${base}/api/v1/users/${f.office.id}`, {
                method: "PATCH",
                headers: {
                  origin,
                  cookie: `sid=${sid}`,
                  "content-type": "application/json",
                },
                body: JSON.stringify({ isActive: false }),
              })
            : updateProperty(f.org, f.secondProperty.id, {
                contactId: f.otherContact.id,
              });
        try {
          const first = observe<unknown>(
              sourceFirst ? input.run() : change(),
              pending,
            ),
            writer = await blockedBy(
              b.pid,
              sourceFirst
                ? '%insert into "customer_work_commands"%'
                : mode === "crew"
                  ? '%update "users"%'
                  : '%update "properties"%',
            );
          const second = observe<unknown>(
              sourceFirst ? change() : input.run(),
              pending,
            ),
            waiter = await blockedBy(
              writer,
              sourceFirst
                ? mode === "crew"
                  ? '%update "users"%'
                  : '%from "properties"%for update%'
                : mode === "crew"
                  ? '%from "users"%for share%'
                  : '%from "properties"%for share%',
            );
          expect(new Set([b.pid, writer, waiter]).size).toBe(3);
          await b.release();
          await first;
          if (sourceFirst) {
            if (mode === "property")
              await expect(second).rejects.toMatchObject({
                code: "customer_work_parent_locked",
              });
            else expect(((await second) as Response).status).toBe(200);
          } else
            await expect(second).rejects.toMatchObject({
              code:
                mode === "crew"
                  ? "invalid_assignee"
                  : "customer_work_parent_mismatch",
            });
          expect(
            await db
              .select()
              .from(customerWorkCommandsTable)
              .where(eq(customerWorkCommandsTable.organizationId, f.org)),
          ).toHaveLength(sourceFirst ? 1 : 0);
        } finally {
          await b.cleanup(pending);
        }
      },
      30000,
    );

realPg(
  "retains one returning invoice number and original issue operation under concurrent exact-request recovery",
  async () => {
    const f = await fixture(),
      draft = (
        await createInvoice(f.org, f.owner.id, {
          requestId: randomUUID(),
          source: {
            kind: "existing_customer",
            contactId: f.contact.id,
            propertyId: null,
          },
          document: returningInvoiceDocument(),
        })
      ).invoice,
      input = command(draft.version),
      pending: Promise<unknown>[] = [],
      b = await barrier(
        "invoice_operations",
        "BEFORE INSERT",
        `NEW.organization_id='${f.org}'::uuid AND NEW.action='issued'`,
      );
    try {
      const first = observe(
          issueInvoice(f.org, f.owner.id, draft.id, input),
          pending,
        ),
        issuer = await blockedBy(b.pid, '%insert into "invoice_operations"%');
      const duplicate = observe(
          issueInvoice(f.org, f.owner.id, draft.id, input),
          pending,
        ),
        waiter = await blockedBy(issuer, "%pg_advisory_xact_lock%");
      expect(new Set([b.pid, issuer, waiter]).size).toBe(3);
      await b.release();
      const result = await first;
      expect(result.invoice.invoiceNumber).toBe("INV-000001");
      expect(await duplicate).toMatchObject({
        duplicate: true,
        invoice: { id: draft.id, invoiceNumber: "INV-000001" },
      });
      expect(
        await db
          .select()
          .from(invoiceOperationsTable)
          .where(
            and(
              eq(invoiceOperationsTable.organizationId, f.org),
              eq(invoiceOperationsTable.action, "issued"),
            ),
          ),
      ).toHaveLength(1);
    } finally {
      await b.cleanup(pending);
    }
  },
  20000,
);

realPg(
  "serializes original returning cash allocation and refund corrections without exceeding the exact receipt or invoice allocation",
  async () => {
    const f = await fixture(),
      firstDraft = (
        await createInvoice(f.org, f.owner.id, {
          requestId: randomUUID(),
          source: {
            kind: "existing_customer",
            contactId: f.contact.id,
            propertyId: null,
          },
          document: returningInvoiceDocument(),
        })
      ).invoice,
      one = (await issueInvoice(f.org, f.owner.id, firstDraft.id, command(1)))
        .invoice;
    const secondDraft = (
        await createInvoice(f.org, f.owner.id, {
          requestId: randomUUID(),
          source: { kind: "customer_work", customerWorkId: one.customerWorkId },
          document: returningInvoiceDocument(),
        })
      ).invoice,
      two = (await issueInvoice(f.org, f.owner.id, secondDraft.id, command(1)))
        .invoice;
    const paid = (
        await recordInvoicePayment(f.org, f.owner.id, one.id, {
          ...command(one.version),
          amountCents: 10000,
          sourceReference: `race-cash-${randomUUID()}`,
          occurredAt: new Date(Date.now() - 60000).toISOString(),
        })
      ).invoice,
      original = paid.allocations[0];
    const released = (
        await reverseInvoiceAllocation(f.org, f.owner.id, one.id, original.id, {
          ...command(paid.version),
          reason: "Split only the original recorded allocation",
        })
      ).invoice,
      pending: Promise<unknown>[] = [],
      b = await barrier(
        "invoice_receipt_allocations",
        "BEFORE INSERT",
        `NEW.invoice_id='${one.id}'::uuid AND NEW.kind='payment'`,
      );
    try {
      const first = observe(
          allocateInvoiceValue(f.org, f.owner.id, one.id, {
            ...command(released.version),
            valueEntryId: original.valueEntryId,
            amountCents: 6000,
          }),
          pending,
        ),
        allocator = await blockedBy(
          b.pid,
          '%insert into "invoice_receipt_allocations"%',
        );
      const excess = observe(
          allocateInvoiceValue(f.org, f.owner.id, two.id, {
            ...command(two.version),
            valueEntryId: original.valueEntryId,
            amountCents: 6000,
          }),
          pending,
        ),
        waiter = await blockedBy(allocator, "%pg_advisory_xact_lock%");
      expect(new Set([b.pid, allocator, waiter]).size).toBe(3);
      await b.release();
      await first;
      await expect(excess).rejects.toMatchObject({
        code: "invoice_receipt_unavailable",
      });
    } finally {
      await b.cleanup(pending);
    }
    const split = (
        await allocateInvoiceValue(f.org, f.owner.id, two.id, {
          ...command(two.version),
          valueEntryId: original.valueEntryId,
          amountCents: 4000,
        })
      ).invoice,
      current = await getInvoice(f.org, f.owner.id, one.id),
      refundPending: Promise<unknown>[] = [],
      rb = await barrier(
        "invoice_receipt_allocations",
        "BEFORE INSERT",
        `NEW.invoice_id='${one.id}'::uuid AND NEW.kind='refund'`,
      );
    const refund = (invoiceId: string, version: number, amountCents: number) =>
      recordInvoiceRefund(f.org, f.owner.id, invoiceId, {
        ...command(version),
        originalPaymentValueEntryId: original.valueEntryId,
        amountCents,
        sourceReference: `race-refund-${randomUUID()}`,
        occurredAt: new Date().toISOString(),
        reason: "Actual office-recorded external refund correction",
      });
    try {
      const first = observe(
          refund(one.id, current.version, 6000),
          refundPending,
        ),
        refunder = await blockedBy(
          rb.pid,
          '%insert into "invoice_receipt_allocations"%',
        ),
        excess = observe(refund(two.id, split.version, 5000), refundPending),
        waiter = await blockedBy(refunder, "%pg_advisory_xact_lock%");
      expect(new Set([rb.pid, refunder, waiter]).size).toBe(3);
      await rb.release();
      expect((await first).invoice.recordedPaidCents).toBe(0);
      await expect(excess).rejects.toMatchObject({
        code: "invoice_refund_cash_conflict",
      });
      expect(
        (await getInvoice(f.org, f.owner.id, two.id)).recordedPaidCents,
      ).toBe(4000);
      expect(
        await db
          .select()
          .from(invoiceReceiptAllocationsTable)
          .where(
            and(
              eq(invoiceReceiptAllocationsTable.organizationId, f.org),
              eq(invoiceReceiptAllocationsTable.kind, "refund"),
            ),
          ),
      ).toHaveLength(1);
    } finally {
      await rb.cleanup(refundPending);
    }
  },
  30000,
);

async function legacyMoneyFixture(mode: "cash" | "migration") {
  const f = await fixture(),
    [lead, survivor] = await db
      .insert(leadsTable)
      .values([
        {
          organizationId: f.org,
          contactId: f.contact.id,
          propertyId: f.secondProperty.id,
        },
        { organizationId: f.org, contactId: f.contact.id },
      ])
      .returning();
  if (mode === "cash")
    return {
      ...f,
      lead,
      survivor,
      write: () =>
        recordValueEntry(f.org, f.owner.id, {
          leadId: lead.id,
          kind: "payment",
          amountCents: 3000,
          sourceReference: `original-cash-${randomUUID()}`,
          occurredAt: new Date().toISOString(),
          confirmed: true,
        }),
    };
  const preview = await previewFinancialMigration(f.org, f.owner.id, {
    sourceJson: JSON.stringify(financialSourceFixture(lead.id)),
  });
  if (!preview.valid)
    throw Error("Synthetic original migration review was refused");
  return {
    ...f,
    lead,
    survivor,
    write: () =>
      commitFinancialMigration(f.org, f.owner.id, preview.review.id, {
        expectedDigest: preview.review.digest,
        confirmed: true,
        sourceFrozen: true,
      }),
  };
}

realPg(
  "retains original legacy cash and imported invoice lineage against actual property and merge writers",
  async () => {
    for (const mode of ["cash", "migration"] as const) {
      const f = await legacyMoneyFixture(mode),
        pending: Promise<unknown>[] = [],
        b = await barrier(
          "value_entries",
          "BEFORE INSERT",
          `NEW.organization_id='${f.org}'::uuid`,
        );
      try {
        const recording = observe<unknown>(f.write(), pending),
          writer = await blockedBy(b.pid, '%insert into "value_entries"%');
        const moving = observe(
            updateProperty(f.org, f.secondProperty.id, {
              contactId: f.otherContact.id,
            }),
            pending,
          ),
          merging = observe(
            mergeLeads(f.org, f.survivor.id, f.lead.id, f.owner.id),
            pending,
          ),
          reparenting = observe(
            updateLead(f.org, f.lead.id, { propertyId: f.firstProperty.id }),
            pending,
          );
        const propertyWriter = await blockedBy(
          writer,
          '%from "properties"%for update%',
        );
        const waits = await pool.query(
          "SELECT pid FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid)) AND query ILIKE '%pg_advisory_xact_lock%'",
          [writer],
        );
        // Observe both real schedule-prefix writers, not merely outstanding JS promises.
        for (
          let attempt = 0;
          waits.rows.length < 2 && attempt < 150;
          attempt++
        ) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          const latest = await pool.query(
            "SELECT pid FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid)) AND query ILIKE '%pg_advisory_xact_lock%'",
            [writer],
          );
          waits.rows = latest.rows;
        }
        expect(waits.rows).toHaveLength(2);
        expect(
          new Set([
            b.pid,
            writer,
            propertyWriter,
            ...waits.rows.map((row) => Number(row.pid)),
          ]).size,
        ).toBe(5);
        await b.release();
        await recording;
        const code =
          mode === "cash" ? VALUE_HISTORY_RETAINED : INVOICE_HISTORY_RETAINED;
        await expect(moving).rejects.toMatchObject({ code });
        await expect(reparenting).rejects.toMatchObject({ code });
        expect(await merging).toEqual({ ok: false, error: code });
        expect(
          (
            await db
              .select()
              .from(leadsTable)
              .where(eq(leadsTable.id, f.lead.id))
          )[0],
        ).toMatchObject({
          contactId: f.contact.id,
          propertyId: f.secondProperty.id,
          status: "new",
        });
        expect(
          (
            await db
              .select()
              .from(propertiesTable)
              .where(eq(propertiesTable.id, f.secondProperty.id))
          )[0].contactId,
        ).toBe(f.contact.id);
        expect(
          await db
            .select()
            .from(valueEntriesTable)
            .where(eq(valueEntriesTable.organizationId, f.org)),
        ).toHaveLength(1);
      } finally {
        await b.cleanup(pending);
      }
    }
  },
  30000,
);

realPg(
  "rereads actual property ownership before original legacy cash or historical import commit with no financial writes",
  async () => {
    for (const mode of ["cash", "migration"] as const) {
      const f = await legacyMoneyFixture(mode),
        pending: Promise<unknown>[] = [],
        b = await barrier(
          "properties",
          "AFTER UPDATE",
          `NEW.id='${f.secondProperty.id}'::uuid`,
        );
      try {
        const moving = observe(
            updateProperty(f.org, f.secondProperty.id, {
              contactId: f.otherContact.id,
            }),
            pending,
          ),
          writer = await blockedBy(b.pid, '%update "properties"%');
        const recording = observe<unknown>(f.write(), pending),
          reader = await blockedBy(writer, '%from "properties"%for share%');
        expect(new Set([b.pid, writer, reader]).size).toBe(3);
        await b.release();
        await moving;
        await expect(recording).rejects.toMatchObject({ status: 409 });
        expect(
          await db
            .select()
            .from(valueEntriesTable)
            .where(eq(valueEntriesTable.organizationId, f.org)),
        ).toHaveLength(0);
        expect(
          await db
            .select()
            .from(invoicesTable)
            .where(eq(invoicesTable.organizationId, f.org)),
        ).toHaveLength(0);
        expect(
          (
            await db
              .select()
              .from(leadsTable)
              .where(eq(leadsTable.id, f.lead.id))
          )[0],
        ).toMatchObject({
          contactId: f.contact.id,
          propertyId: f.secondProperty.id,
        });
      } finally {
        await b.cleanup(pending);
      }
    }
  },
  30000,
);
