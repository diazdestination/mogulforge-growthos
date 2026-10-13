import pg from "pg";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import app from "../app";
import { createSession } from "../lib/auth";
import { revenueDesk } from "./revenue-workspace";
import {
  projectEstimateDeliveryExecution,
  projectEstimateDeliveryAudit,
} from "./estimate-delivery-projections";
import { hasRetainedEstimateEmail } from "./estimate-delivery-history";
import { readEstimateEmailAuthority } from "./estimate-delivery-authority";
import { updateCustomerWorkEstimate } from "./returning-customer";
import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  pool,
  usersTable,
  auditEventsTable,
  estimatesTable,
  contactsTable,
  leadsTable,
  orgSettingsTable,
  emailSenderPreferencesTable,
  gmailConnectionsTable,
  revenueExecutionsTable,
  revenueExecutionEventsTable,
  activitiesTable,
  propertiesTable,
} from "@workspace/db";
import {
  returningCustomerFixture,
  returningEstimateDraft,
} from "../test-helpers/returning-customer-fixture";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import {
  createEstimate,
  deleteEstimate,
  deleteContact,
  updateLead,
  updateProperty,
  mergeLeads,
  updateEstimate,
  listAuditEvents,
} from "./crm";
import { clearDemoData } from "./demo-data";
import { deleteTestLeads } from "./onboarding";
import { createCustomerLifecycleExporter } from "./customer-lifecycle-export";
import { createCustomerWorkEstimate } from "./returning-customer";
import {
  previewEstimateEmail,
  getEstimateEmailEvidence,
} from "./estimate-delivery";
import {
  claimEstimateEmail,
  finalizeEstimateEmail,
} from "./estimate-delivery-execution";

const hooks = vi.hoisted(() => ({
  afterRead: null as null | ((pid: number) => Promise<void>),
}));
vi.mock("./estimate-delivery-authority", async (original) => {
  const real = await original<typeof import("./estimate-delivery-authority")>();
  return {
    ...real,
    readEstimateEmailAuthority: async (
      ...args: Parameters<typeof real.readEstimateEmailAuthority>
    ) => {
      const result = await real.readEstimateEmailAuthority(...args);
      if (hooks.afterRead) {
        const backend = await args[0].execute(
          sql`SELECT pg_backend_pid() AS pid`,
        );
        await hooks.afterRead(Number(backend.rows[0].pid));
      }
      return result;
    },
  };
});
const orgs: string[] = [];
beforeEach(() => {
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "synthetic");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "synthetic");
  vi.stubEnv("OAUTH_TOKEN_ENCRYPTION_KEY", "ab".repeat(32));
  vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false");
  vi.stubGlobal("fetch", () => {
    throw Error("No live transport");
  });
});
afterEach(() => {
  hooks.afterRead = null;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(async () => deleteTestOrgs(...orgs));
async function fixture(returning = false) {
  const f = await returningCustomerFixture();
  orgs.push(f.org);
  await db
    .insert(orgSettingsTable)
    .values({ organizationId: f.org, customerEmailSenderUserId: f.office.id });
  await db
    .insert(emailSenderPreferencesTable)
    .values({ organizationId: f.org, userId: f.office.id, provider: "gmail" });
  await db.insert(gmailConnectionsTable).values({
    organizationId: f.org,
    userId: f.office.id,
    email: "office@example.test",
    encryptedRefreshToken: "synthetic-not-decrypted",
    grantedScopes: ["https://www.googleapis.com/auth/gmail.send"],
  });
  const [lead] = await db
    .insert(leadsTable)
    .values({
      organizationId: f.org,
      contactId: f.contact.id,
      propertyId: f.secondProperty.id,
      source: "manual",
    })
    .returning();
  const draft = returningEstimateDraft(f);
  const estimate = returning
    ? (await createCustomerWorkEstimate(f.org, f.actor, draft)).estimate
    : (await createEstimate(
        f.org,
        {
          leadId: lead.id,
          title: draft.title,
          lineItems: draft.lineItems.map((x) => ({ ...x, totalCents: 10000 })),
          notes: draft.notes,
        },
        f.actor,
      ))!;
  return { ...f, estimate, lead };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const preview = (f: Fixture) =>
  previewEstimateEmail(f.org, f.actor, f.estimate.id, {
    expectedUpdatedAt: new Date(f.estimate.updatedAt).toISOString(),
    expectedWorkVersion: f.estimate.workVersion,
  });
const sendBody = (p: Awaited<ReturnType<typeof preview>>) => ({
  previewId: p.previewId,
  payloadSha256: p.payloadSha256,
  confirmed: true as const,
});
const audits = (f: Fixture, action: string) =>
  db
    .select()
    .from(auditEventsTable)
    .where(
      and(
        eq(auditEventsTable.entityId, f.estimate.id),
        eq(auditEventsTable.action, action),
      ),
    );

const admit = async (f: Fixture) =>
  claimEstimateEmail(f.org, f.actor, f.estimate.id, sendBody(await preview(f)));
it.each(
  [
    "estimate",
    "contact",
    "lead",
    "property",
    "merge_source",
    "merge_survivor",
    "demo",
    "test",
  ].flatMap((kind) => [false, true].map((uncertain) => ({ kind, uncertain }))),
)(
  "retains history during $kind mutation uncertain=$uncertain",
  async ({ kind, uncertain }) => {
    const f = await fixture(),
      c = await admit(f);
    if (uncertain)
      await finalizeEstimateEmail(c, {
        state: "uncertain",
        reason: "synthetic",
      });
    const [activity] = await db
      .insert(activitiesTable)
      .values({
        organizationId: f.org,
        leadId: f.lead.id,
        contactId: f.contact.id,
        type: "note",
        title: "Retained business evidence",
      })
      .returning();
    const [other] = await db
      .insert(leadsTable)
      .values({ organizationId: f.org, contactId: f.contact.id })
      .returning();
    if (kind === "demo")
      await db
        .update(leadsTable)
        .set({ source: "demo-data" })
        .where(eq(leadsTable.id, f.lead.id));
    if (kind === "test")
      await db
        .update(leadsTable)
        .set({ sourceDetail: "onboarding-test-lead" })
        .where(eq(leadsTable.id, f.lead.id));
    let refused = false;
    try {
      const result =
        kind === "estimate"
          ? await deleteEstimate(f.org, f.estimate.id)
          : kind === "contact"
            ? await deleteContact(f.org, f.contact.id)
            : kind === "lead"
              ? await updateLead(f.org, f.lead.id, { propertyId: null })
              : kind === "property"
                ? await updateProperty(f.org, f.secondProperty.id, {
                    contactId: f.otherContact.id,
                  })
                : kind === "merge_source"
                  ? await mergeLeads(f.org, other.id, f.lead.id, f.actor.userId)
                  : kind === "merge_survivor"
                    ? await mergeLeads(
                        f.org,
                        f.lead.id,
                        other.id,
                        f.actor.userId,
                      )
                    : kind === "demo"
                      ? await clearDemoData(f.org)
                      : await deleteTestLeads(f.org);
      refused =
        typeof result === "object" &&
        result !== null &&
        "ok" in result &&
        result.ok === false;
    } catch (error) {
      refused =
        (error as { code?: string }).code === "estimate_email_history_retained";
    }
    expect(refused).toBe(true);
    expect(
      (
        await db
          .select()
          .from(estimatesTable)
          .where(eq(estimatesTable.id, f.estimate.id))
      ).length,
    ).toBe(1);
    expect(
      (
        await db
          .select()
          .from(activitiesTable)
          .where(eq(activitiesTable.id, activity.id))
      ).length,
    ).toBe(1);
  },
);
it("omits preview rows and private metadata from broad audit history", async () => {
  const f = await fixture(),
    p = await preview(f);
  await claimEstimateEmail(f.org, f.actor, f.estimate.id, sendBody(p));
  const rows = await listAuditEvents(f.org);
  const text = JSON.stringify(
    rows.filter(
      (r) =>
        r.action.startsWith("estimate_delivery.") ||
        r.action === "estimate.saved_state",
    ),
  );
  expect(rows.some((r) => r.action === "estimate_delivery.previewed")).toBe(
    false,
  );
  for (const value of [
    p.previewId,
    p.payloadSha256,
    "estimateSha256",
    f.actor.userId,
    "senderIdentitySha256",
  ])
    expect(text.includes(value)).toBe(false);
});
it.each([false, true])(
  "exports retained original estimate receipt returning=%s",
  async (returning) => {
    const f = await fixture(returning),
      c = await admit(f);
    await finalizeEstimateEmail(c, {
      state: "accepted",
      receipt: {
        provider: "gmail",
        id: "synthetic-receipt",
        acceptance: "accepted",
        senderEmail: "office@example.test",
      },
      acceptedAt: new Date(),
    });
    const out = await createCustomerLifecycleExporter()(f.org, f.owner.id);
    const rows = out.data.estimate_email_receipts;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows?.length).toBe(1);
    expect(rows?.[0]).toMatchObject({
      estimateId: f.estimate.id,
      state: "accepted",
      integrity: "valid",
      deliveryConfirmed: false,
      contactId: f.contact.id,
    });
  },
);

it.each(["orphan_key", "malformed_admission", "orphan_proof"])(
  "retains %s independently of valid metadata",
  async (kind) => {
    const f = await fixture();
    if (kind === "orphan_key")
      await db.insert(revenueExecutionsTable).values({
        organizationId: f.org,
        actionKey: `ESTIMATE-DELIVERY:${f.estimate.id.toUpperCase()}:EMAIL`,
        kind: "estimate_email",
        fingerprint: "corrupt",
        expiresAt: new Date(),
      });
    else
      await db.insert(auditEventsTable).values({
        organizationId: f.org,
        entityType: "estimate",
        entityId: f.estimate.id,
        action:
          kind === "orphan_proof"
            ? "estimate_delivery.provider_accepted"
            : "estimate_delivery.admitted",
        metadata: { malformed: true },
      });
    expect(
      await hasRetainedEstimateEmail(db, f.org, f.estimate.id.toUpperCase()),
    ).toBe(true);
    await expect(deleteEstimate(f.org, f.estimate.id)).rejects.toMatchObject({
      code: "estimate_email_history_retained",
    });
    await expect(deleteContact(f.org, f.contact.id)).rejects.toMatchObject({
      code: "estimate_email_history_retained",
    });
  },
);
it.each([false, true])(
  "preserves admitted document while ordinary draft/customer/address edits remain allowed returning=%s",
  async (returning) => {
    const f = await fixture(returning),
      c = await admit(f),
      original = await getEstimateEmailEvidence(f.org, f.estimate.id);
    if (returning) {
      const { source: _source, ...edit } = returningEstimateDraft(f);
      await updateCustomerWorkEstimate(f.org, f.actor, f.estimate.id, {
        ...edit,
        expectedWorkVersion: 1,
        requestId: randomUUID(),
        status: "draft",
        notes: "Changed draft",
      });
    } else
      await updateEstimate(
        f.org,
        f.estimate.id,
        { notes: "Changed draft" },
        f.actor,
      );
    await updateProperty(f.org, f.secondProperty.id, {
      addressLine1: "Changed address",
    });
    await db
      .update(contactsTable)
      .set({ firstName: "Changed label", email: "new@example.test" })
      .where(eq(contactsTable.id, f.contact.id));
    await db
      .update(usersTable)
      .set({ isActive: false })
      .where(eq(usersTable.id, f.office.id));
    const after = await getEstimateEmailEvidence(f.org, f.estimate.id);
    expect(after.document).toEqual(original.document);
    expect(after.message).toEqual(original.message);
    const out = await createCustomerLifecycleExporter()(f.org, f.owner.id),
      receipt = out.data.estimate_email_receipts[0];
    expect(receipt.document).toEqual(original.document);
    expect(receipt.message).toEqual(original.message);
    expect(receipt.executionId).toBe(c.executionId);
  },
);
it.each(["processing", "uncertain", "held", "operator", "accepted"])(
  "export and dedicated evidence agree for %s",
  async (state) => {
    const f = await fixture(),
      c = await admit(f);
    if (state === "uncertain" || state === "held")
      await finalizeEstimateEmail(c, { state, reason: "synthetic" });
    if (state === "accepted")
      await finalizeEstimateEmail(c, {
        state: "accepted",
        receipt: {
          provider: "gmail",
          id: "synthetic-proof",
          senderEmail: "office@example.test",
          acceptance: "accepted",
        },
        acceptedAt: new Date(),
      });
    if (state === "operator")
      await db
        .update(revenueExecutionsTable)
        .set({ state: "confirmed_succeeded", detail: "PRIVATE_OPERATOR_PROSE" })
        .where(eq(revenueExecutionsTable.id, c.executionId));
    const evidence = await getEstimateEmailEvidence(f.org, f.estimate.id),
      out = await createCustomerLifecycleExporter()(f.org, f.owner.id),
      receipt = out.data.estimate_email_receipts[0];
    const { canPrepare: _can, detail: _detail, ...expected } = evidence;
    expect(receipt).toMatchObject(expected);
    if (state !== "accepted") expect(receipt.acceptedAt).toBeNull();
    const serialized = JSON.stringify(out.data);
    for (const secret of [
      c.payloadSha256,
      f.office.id,
      f.actor.userId,
      "PRIVATE_OPERATOR_PROSE",
      "previewId",
      "senderIdentitySha256",
      "sourceSha256",
      "actionKey",
    ])
      expect(serialized.includes(secret)).toBe(false);
  },
);
it.each(["admission", "proof", "review", "event", "orphan"])(
  "export rejects corrupted %s without releasing ownership",
  async (kind) => {
    const f = await fixture(),
      c = await admit(f);
    await finalizeEstimateEmail(c, {
      state: "accepted",
      receipt: {
        provider: "gmail",
        id: "synthetic-proof",
        senderEmail: "office@example.test",
        acceptance: "accepted",
      },
      acceptedAt: new Date(),
    });
    if (kind === "orphan")
      await db
        .delete(auditEventsTable)
        .where(
          and(
            eq(auditEventsTable.entityId, f.estimate.id),
            eq(auditEventsTable.action, "estimate_delivery.admitted"),
          ),
        );
    else if (kind === "event")
      await db
        .delete(revenueExecutionEventsTable)
        .where(eq(revenueExecutionEventsTable.executionId, c.executionId));
    else
      await db
        .update(auditEventsTable)
        .set({ metadata: { corrupt: true } })
        .where(
          and(
            eq(auditEventsTable.entityId, f.estimate.id),
            eq(
              auditEventsTable.action,
              kind === "proof"
                ? "estimate_delivery.provider_accepted"
                : kind === "review"
                  ? "estimate_delivery.previewed"
                  : "estimate_delivery.admitted",
            ),
          ),
        );
    await expect(
      createCustomerLifecycleExporter()(f.org, f.owner.id),
    ).rejects.toMatchObject({ code: "customer_export_unavailable" });
    expect(await hasRetainedEstimateEmail(db, f.org, f.estimate.id)).toBe(true);
    expect(
      (await getEstimateEmailEvidence(f.org, f.estimate.id)).integrity,
    ).toBe("unavailable");
  },
);
it("fails whole export on quote bytes and retains permanent keys", async () => {
  const f = await fixture();
  await updateEstimate(
    f.org,
    f.estimate.id,
    { notes: "q".repeat(1900) },
    f.actor,
  );
  const [fresh] = await db
    .select()
    .from(estimatesTable)
    .where(eq(estimatesTable.id, f.estimate.id));
  f.estimate = fresh;
  await admit(f);
  await expect(
    createCustomerLifecycleExporter({ maxBytes: 1000 })(f.org, f.owner.id),
  ).rejects.toMatchObject({ code: "customer_export_limit" });
  expect(await hasRetainedEstimateEmail(db, f.org, f.estimate.id)).toBe(true);
});
it("reads receipt proof inside the same repeatable-read export snapshot", async () => {
  const f = await fixture(),
    c = await admit(f);
  let changed = false;
  const exporter = createCustomerLifecycleExporter({
    createClient: () => {
      const client = new pg.Client({
        connectionString: process.env.DATABASE_URL,
      });
      const query = client.query.bind(client);
      client.query = (async (config: any) => {
        const result = await query(config);
        if (
          !changed &&
          String(config.text).includes('FROM public."estimates"')
        ) {
          changed = true;
          await finalizeEstimateEmail(c, {
            state: "accepted",
            receipt: {
              provider: "gmail",
              id: "later-proof",
              senderEmail: "office@example.test",
              acceptance: "accepted",
            },
            acceptedAt: new Date(),
          });
        }
        return result;
      }) as typeof client.query;
      return client;
    },
  });
  const out = await exporter(f.org, f.owner.id);
  expect(changed).toBe(true);
  expect(out.data.estimate_email_receipts[0].acceptedAt).toBeNull();
  expect(
    (await getEstimateEmailEvidence(f.org, f.estimate.id)).acceptedAt,
  ).not.toBeNull();
});
it("keeps other execution and audit kinds unchanged", async () => {
  const f = await fixture();
  const [execution] = await db
    .insert(revenueExecutionsTable)
    .values({
      organizationId: f.org,
      actionKey: "unrelated",
      kind: "other",
      fingerprint: "existing-contract",
      expiresAt: new Date(),
      detail: "existing detail",
    })
    .returning();
  expect(projectEstimateDeliveryExecution(execution)).toBe(execution);
  const [audit] = await db
    .insert(auditEventsTable)
    .values({
      organizationId: f.org,
      action: "other",
      entityType: "lead",
      metadata: { existing: "unchanged" },
    })
    .returning();
  expect(projectEstimateDeliveryAudit(audit)).toBe(audit);
});
const realFetch = globalThis.fetch;
let server: Server, base: string;
beforeAll(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
});
const api = async (
  f: Fixture,
  path: string,
  method = "GET",
  body?: unknown,
) => {
  const sid = await createSession({
    user: {
      id: f.owner.id,
      email: null,
      firstName: null,
      lastName: null,
      profileImageUrl: null,
    },
    access_token: "synthetic",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });
  return realFetch(base + "/api/v1" + path, {
    method,
    headers: {
      cookie: `sid=${sid}`,
      "Content-Type": "application/json",
      origin: base,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
};
it("returns exact safe execution and event summaries from desk/detail/reconcile", async () => {
  const f = await fixture(),
    c = await admit(f);
  await finalizeEstimateEmail(c, { state: "uncertain", reason: "synthetic" });
  const desk = await revenueDesk(f.org);
  const summary = desk.executions.find((e) => e.id === c.executionId)!;
  const keys = ["createdAt", "detail", "expiresAt", "id", "kind", "state"];
  expect(Object.keys(summary).sort()).toEqual(keys);
  const detail = await api(f, `/revenue/executions/${c.executionId}`);
  expect(detail.status).toBe(200);
  const read = (await detail.json()) as {
    execution: Record<string, unknown>;
    events: Record<string, unknown>[];
  };
  expect(Object.keys(read.execution).sort()).toEqual(keys);
  for (const event of read.events)
    expect(Object.keys(event).sort()).toEqual([
      "createdAt",
      "detail",
      "executionId",
      "id",
      "state",
    ]);
  const reconciled = await api(
    f,
    `/revenue/executions/${c.executionId}/reconcile`,
    "POST",
    {
      outcome: "confirmed_succeeded",
      evidence: "PRIVATE_OPERATOR_PROSE " + c.payloadSha256,
      confirmed: true,
    },
  );
  expect(reconciled.status).toBe(200);
  const saved = (await reconciled.json()) as Record<string, unknown>;
  expect(Object.keys(saved).sort()).toEqual(keys);
  const after = await (
    await api(f, `/revenue/executions/${c.executionId}`)
  ).json();
  expect(JSON.stringify(after).includes("PRIVATE_OPERATOR_PROSE")).toBe(false);
  expect(JSON.stringify(after).includes(c.payloadSha256)).toBe(false);
  expect(
    (await getEstimateEmailEvidence(f.org, f.estimate.id)).acceptedAt,
  ).toBeNull();
});
it.each(["estimate", "contact", "property", "merge", "demo", "test"])(
  "safe409 for retained %s route",
  async (kind) => {
    const f = await fixture();
    await admit(f);
    await db
      .update(leadsTable)
      .set({ source: "demo-data", sourceDetail: "onboarding-test-lead" })
      .where(eq(leadsTable.id, f.lead.id));
    const [other] = await db
      .insert(leadsTable)
      .values({ organizationId: f.org, contactId: f.contact.id })
      .returning();
    const res =
      kind === "estimate"
        ? await api(f, `/estimates/${f.estimate.id}`, "DELETE")
        : kind === "contact"
          ? await api(f, `/contacts/${f.contact.id}`, "DELETE")
          : kind === "property"
            ? await api(f, `/properties/${f.secondProperty.id}`, "PATCH", {
                contactId: f.otherContact.id,
              })
            : kind === "merge"
              ? await api(f, `/leads/${f.lead.id}/merge`, "POST", {
                  sourceLeadId: other.id,
                })
              : kind === "demo"
                ? await api(f, "/demo-data", "DELETE")
                : await api(f, "/onboarding/test-lead", "DELETE");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe(
      "estimate_email_history_retained",
    );
  },
);

const latch = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
it.each(["property", "lead", "contact", "estimate"])(
  "ordinary %s writer waits for admitted history and refuses safely",
  async (kind) => {
    const f = await fixture(),
      p = await preview(f),
      entered = latch(),
      release = latch();
    let blockerPid = 0;
    hooks.afterRead = async (pid) => {
      blockerPid = pid;
      entered.resolve();
      await release.promise;
    };
    const claiming = claimEstimateEmail(
      f.org,
      f.actor,
      f.estimate.id,
      sendBody(p),
    );
    await entered.promise;
    let finished = false;
    const writing = (
      kind === "property"
        ? updateProperty(f.org, f.secondProperty.id, {
            contactId: f.otherContact.id,
          })
        : kind === "lead"
          ? updateLead(f.org, f.lead.id, { propertyId: null })
          : kind === "contact"
            ? deleteContact(f.org, f.contact.id)
            : deleteEstimate(f.org, f.estimate.id)
    )
      .then(
        () => "allowed",
        (error) => error.code,
      )
      .finally(() => {
        finished = true;
      });
    try {
      let blocked = false;
      for (let i = 0; i < 150; i++) {
        const { rows } = await pool.query(
          "SELECT pid FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid)) AND datname=current_database()",
          [blockerPid],
        );
        if (rows.length) {
          blocked = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(blocked).toBe(true);
      expect(finished).toBe(false);
    } finally {
      release.resolve();
      hooks.afterRead = null;
    }
    await claiming;
    expect(await writing).toBe("estimate_email_history_retained");
  },
);

it("keeps foreign estimate deletion tenant-scoped even with permanent evidence", async () => {
  const f = await fixture(),
    other = await fixture();
  await admit(f);
  await expect(deleteEstimate(other.org, f.estimate.id)).resolves.toBe(false);
});

it("permanent ownership survives direct content loss and export refuses the orphan", async () => {
  const f = await fixture();
  await admit(f);
  await db.delete(estimatesTable).where(eq(estimatesTable.id, f.estimate.id));
  expect(await hasRetainedEstimateEmail(db, f.org, f.estimate.id)).toBe(true);
  await expect(
    createCustomerLifecycleExporter()(f.org, f.owner.id),
  ).rejects.toMatchObject({ code: "customer_export_unavailable" });
});
