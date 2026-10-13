import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import {
  db,
  pool,
  auditEventsTable,
  estimatesTable,
  leadsTable,
  orgSettingsTable,
  emailSenderPreferencesTable,
  gmailConnectionsTable,
  revenueExecutionsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import {
  returningCustomerFixture,
  returningEstimateDraft,
} from "../test-helpers/returning-customer-fixture";
import { createEstimate, updateEstimate } from "./crm";
import { createCustomerWorkEstimate } from "./returning-customer";
import { readEstimateEmailAuthority } from "./estimate-delivery-authority";
import { estimateDeliveryFingerprint } from "./estimate-delivery-contract";
import { assertEstimateCleanHistory } from "./estimate-delivery-history";
import {
  claimEstimateEmail,
  assertEstimateEmailDispatch,
  finalizeEstimateEmail,
} from "./estimate-delivery-execution";
const hooks = vi.hoisted(() => ({
  afterRead: null as null | (() => Promise<void>),
}));
vi.mock("./estimate-delivery-authority", async (original) => {
  const real = await original<typeof import("./estimate-delivery-authority")>();
  return {
    ...real,
    readEstimateEmailAuthority: async (
      ...args: Parameters<typeof real.readEstimateEmailAuthority>
    ) => {
      const result = await real.readEstimateEmailAuthority(...args);
      await hooks.afterRead?.();
      return result;
    },
  };
});
const orgs: string[] = [];
beforeAll(async () => {
  const { rows } = await pool.query("SHOW server_version_num");
  expect(Number(rows[0].server_version_num)).toBeGreaterThanOrEqual(160000);
  expect(Number(rows[0].server_version_num)).toBeLessThan(170000);
});
beforeEach(() => {
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "synthetic");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "synthetic");
  vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false");
  vi.stubGlobal("fetch", () => {
    throw Error("No external network");
  });
});
afterEach(() => {
  hooks.afterRead = null;
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
    encryptedRefreshToken: "synthetic-never-decrypted",
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
  const d = returningEstimateDraft(f);
  const estimate = returning
    ? (await createCustomerWorkEstimate(f.org, f.actor, d)).estimate
    : (await createEstimate(
        f.org,
        {
          leadId: lead.id,
          title: d.title,
          lineItems: d.lineItems.map((x) => ({ ...x, totalCents: 10000 })),
          notes: d.notes,
        },
        f.actor,
      ))!;
  return { ...f, lead, estimate };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function review(f: Fixture) {
  const snapshot = await db.transaction((tx) =>
      readEstimateEmailAuthority(tx, f.org, f.actor, f.estimate.id, true),
    ),
    payloadSha256 = estimateDeliveryFingerprint(snapshot),
    now = new Date();
  const [a] = await db
    .insert(auditEventsTable)
    .values({
      organizationId: f.org,
      actorUserId: f.actor.userId,
      entityType: "estimate",
      entityId: f.estimate.id,
      action: "estimate_delivery.previewed",
      createdAt: now,
      metadata: {
        version: 1,
        snapshot,
        payloadSha256,
        expiresAt: new Date(now.getTime() + 600000).toISOString(),
      },
    })
    .returning();
  return { previewId: a.id, payloadSha256, confirmed: true as const };
}
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
async function blocked(pid: number) {
  for (let i = 0; i < 180; i++) {
    const { rows } = await pool.query(
      "SELECT pid FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))",
      [pid],
    );
    if (rows.length) return Number(rows[0].pid);
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("Independent PostgreSQL blocker was not observed");
}
function mutation(f: Fixture, kind: string): [string, unknown[]] {
  if (kind === "estimate")
    return [
      "UPDATE estimates SET notes=$1 WHERE id=$2",
      ["Changed saved notes", f.estimate.id],
    ];
  if (kind === "contact")
    return [
      "UPDATE contacts SET email=$1 WHERE id=$2",
      ["changed@example.test", f.contact.id],
    ];
  if (kind === "property")
    return [
      "UPDATE properties SET contact_id=$1 WHERE id=$2",
      [f.otherContact.id, f.secondProperty.id],
    ];
  if (kind === "role")
    return ["UPDATE users SET role=$1 WHERE id=$2", ["viewer", f.owner.id]];
  return [
    "UPDATE email_sender_preferences SET provider=$1 WHERE organization_id=$2 AND user_id=$3",
    ["microsoft", f.org, f.office.id],
  ];
}
it.each([false, true])(
  "two independent previews and UUID aliases race one permanent claim returning=%s",
  async (returning) => {
    const f = await fixture(returning),
      p1 = await review(f),
      p2 = await review(f);
    let posts = 0;
    const claims = await Promise.allSettled([
      claimEstimateEmail(f.org, f.actor, f.estimate.id, p1),
      claimEstimateEmail(f.org, f.actor, f.estimate.id.toUpperCase(), p2),
    ]);
    expect(claims.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    for (const result of claims)
      if (result.status === "fulfilled") {
        await assertEstimateEmailDispatch(result.value);
        posts++;
        await finalizeEstimateEmail(result.value, {
          state: "uncertain",
          reason: "Synthetic acknowledgment lost",
        });
      }
    expect(posts).toBe(1);
    const rows = await db
      .select()
      .from(revenueExecutionsTable)
      .where(eq(revenueExecutionsTable.organizationId, f.org));
    expect(rows.map((x) => x.actionKey)).toEqual([
      `estimate-delivery:${f.estimate.id}:email`,
    ]);
    await db
      .update(revenueExecutionsTable)
      .set({ state: "confirmed_not_performed", expiresAt: new Date(0) })
      .where(eq(revenueExecutionsTable.id, rows[0].id));
    await expect(
      claimEstimateEmail(f.org, f.actor, f.estimate.id, p2),
    ).rejects.toMatchObject({ code: "estimate_delivery_reserved" });
    expect(posts).toBe(1);
  },
);
it.each(
  [false, true].flatMap((returning) =>
    ["estimate", "contact", "property", "role", "sender"].map((kind) => ({
      returning,
      kind,
    })),
  ),
)(
  "ordinary $kind UPDATE wins admission race returning=$returning",
  async ({ returning, kind }) => {
    const f = await fixture(returning),
      p = await review(f),
      writer = await pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await writer.query("BEGIN");
      const { rows } = await writer.query("SELECT pg_backend_pid() AS pid");
      await writer.query(...mutation(f, kind));
      pending = claimEstimateEmail(f.org, f.actor, f.estimate.id, p);
      void pending.catch(() => {});
      const waiter = await blocked(Number(rows[0].pid));
      expect(waiter).not.toBe(Number(rows[0].pid));
      await writer.query("COMMIT");
      await expect(pending).rejects.toBeDefined();
      expect(
        await db
          .select()
          .from(revenueExecutionsTable)
          .where(eq(revenueExecutionsTable.organizationId, f.org)),
      ).toHaveLength(0);
    } finally {
      await writer.query("ROLLBACK");
      writer.release();
      await pending?.catch(() => {});
    }
  },
);
it.each(
  [false, true].flatMap((returning) =>
    ["estimate", "contact", "property", "role", "sender"].map((kind) => ({
      returning,
      kind,
    })),
  ),
)(
  "admission keeps source locks until commit against ordinary $kind writer returning=$returning",
  async ({ returning, kind }) => {
    const f = await fixture(returning),
      p = await review(f),
      arrived = deferred(),
      release = deferred(),
      writer = await pool.connect();
    let pending: Promise<unknown> | undefined;
    hooks.afterRead = async () => {
      arrived.resolve();
      await release.promise;
    };
    const claiming = claimEstimateEmail(f.org, f.actor, f.estimate.id, p);
    void claiming.catch(() => {});
    try {
      await Promise.race([arrived.promise, claiming]);
      await writer.query("BEGIN");
      const backend = await writer.query("SELECT pg_backend_pid() AS pid");
      pending = writer.query(...mutation(f, kind));
      void pending.catch(() => {});
      let seen = false;
      for (let i = 0; i < 150; i++) {
        const { rows } = await pool.query(
          "SELECT pg_blocking_pids($1::int) AS blockers",
          [backend.rows[0].pid],
        );
        if (rows[0].blockers.length) {
          seen = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(seen).toBe(true);
      release.resolve();
      const c = await claiming;
      await pending;
      await writer.query("COMMIT");
      hooks.afterRead = null;
      await expect(assertEstimateEmailDispatch(c)).rejects.toBeDefined();
    } finally {
      release.resolve();
      await claiming.catch(() => {});
      await pending?.catch(() => {});
      await writer.query("ROLLBACK");
      writer.release();
    }
  },
);
it("two clean draft saves retain one linear provenance and successful eligibility", async () => {
  const f = await fixture();
  await Promise.all([
    updateEstimate(
      f.org,
      f.estimate.id,
      { notes: "Synthetic draft A" },
      f.actor,
    ),
    updateEstimate(
      f.org,
      f.estimate.id,
      { notes: "Synthetic draft B" },
      f.actor,
    ),
  ]);
  const [e] = await db
    .select()
    .from(estimatesTable)
    .where(eq(estimatesTable.id, f.estimate.id));
  await assertEstimateCleanHistory(db, f.org, e);
  const p = await review(f);
  await assertEstimateEmailDispatch(
    await claimEstimateEmail(f.org, f.actor, e.id, p),
  );
  const states = await db
    .select()
    .from(auditEventsTable)
    .where(
      and(
        eq(auditEventsTable.entityId, e.id),
        eq(auditEventsTable.action, "estimate.saved_state"),
      ),
    );
  expect(states.map((x) => x.metadata.sequence).sort()).toEqual([1, 2, 3]);
});
