import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
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
  emailSenderPreferencesTable,
  microsoftConnectionsTable,
  pool,
  usersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import app from "../app";
import { createSession, deleteSession } from "../lib/auth";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import {
  returningInvoiceDeliveryFixture,
  type ReturningInvoiceDeliveryFixture as Fixture,
} from "../test-helpers/returning-invoice-delivery-fixture";
import {
  getInvoiceDelivery,
  previewInvoiceDelivery,
  sendInvoiceDelivery,
} from "./invoice-delivery";
import { updateContact, updateProperty } from "./crm";
import { updateOrgSettings } from "./settings";
import { selectUserEmailProvider } from "./user-email";
import { getGmailConnection } from "./gmail-oauth";
import { disconnectMicrosoft, getMicrosoftConnection } from "./microsoft-oauth";

const gmailSend = vi.hoisted(() => vi.fn());
const microsoftSend = vi.hoisted(() => vi.fn());
const attemptHooks = vi.hoisted(() => ({
  afterAdmission: null as (() => Promise<void>) | null,
}));
vi.mock("./invoice-delivery-attempts", async (original) => {
  const actual = await original<typeof import("./invoice-delivery-attempts")>();
  return {
    ...actual,
    runInvoiceDeliveryAttempt: (
      review: Parameters<typeof actual.runInvoiceDeliveryAttempt>[0],
      execute: Parameters<typeof actual.runInvoiceDeliveryAttempt>[1],
    ) =>
      actual.runInvoiceDeliveryAttempt(review, async (claim) => {
        // The actual kernel has committed its real claim transaction here.
        // Gate only the original executor, never admission or finalization.
        if (attemptHooks.afterAdmission) await attemptHooks.afterAdmission();
        return execute(claim);
      }),
  };
});
vi.mock("./gmail-oauth", async (original) => ({
  ...(await original<typeof import("./gmail-oauth")>()),
  sendGmailForUser: gmailSend,
}));
vi.mock("./microsoft-oauth", async (original) => ({
  ...(await original<typeof import("./microsoft-oauth")>()),
  sendMicrosoftForUser: microsoftSend,
}));
// These assertions require independent PostgreSQL backends, never a PGlite stand-in.
const realPg = it.skipIf(process.env.SCHEDULER_TEST_BACKEND === "pglite");
const orgs: string[] = [],
  sessions: string[] = [],
  originalFetch = globalThis.fetch,
  origin = "https://returning-mail.example";
let server: Server | undefined,
  base: string,
  effects = 0;
let atOAuth: (() => void) | null = null,
  beforeGuard: (() => Promise<unknown>) | null = null;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
async function transport(
  provider: "gmail" | "microsoft",
  input: Parameters<typeof import("./gmail-oauth").sendGmailForUser>[0],
) {
  const connection =
    provider === "gmail"
      ? await getGmailConnection(input.organizationId, input.userId)
      : await getMicrosoftConnection(input.organizationId, input.userId);
  if (!connection) throw Error("Synthetic mailbox unavailable");
  atOAuth?.();
  await beforeGuard?.();
  await input.beforeDispatch?.({ provider, senderEmail: connection.email });
  effects++;
  return {
    provider,
    senderEmail: connection.email,
    id: provider === "gmail" ? `synthetic-${effects}` : null,
    ...(provider === "microsoft"
      ? { acceptance: "accepted", providerRequestId: "synthetic-request" }
      : {}),
  };
}
beforeAll(async () => {
  vi.stubEnv("SESSION_SECRET", "synthetic-returning-email-race-session");
  vi.stubEnv("APP_ORIGIN", origin);
  if (process.env.SCHEDULER_TEST_BACKEND !== "pglite") {
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
});
beforeEach(() => {
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "synthetic-client");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "synthetic-secret");
  vi.stubEnv("MICROSOFT_OAUTH_CLIENT_ID", "synthetic-client");
  vi.stubEnv("MICROSOFT_OAUTH_CLIENT_SECRET", "synthetic-secret");
  vi.stubEnv(
    "OAUTH_TOKEN_ENCRYPTION_KEY",
    Buffer.alloc(32, 18).toString("base64"),
  );
  vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false");
  vi.stubGlobal("fetch", async () => {
    throw Error("Only the captured exact loopback staff request is permitted");
  });
  effects = 0;
  attemptHooks.afterAdmission = null;
  atOAuth = null;
  beforeGuard = null;
  gmailSend
    .mockReset()
    .mockImplementation((input) => transport("gmail", input));
  microsoftSend
    .mockReset()
    .mockImplementation((input) => transport("microsoft", input));
});
afterEach(() => {
  attemptHooks.afterAdmission = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  for (const id of sessions) await deleteSession(id);
  await deleteTestOrgs(...orgs);
  vi.unstubAllEnvs();
});
async function fixture(provider: "gmail" | "microsoft" = "gmail") {
  const f = await returningInvoiceDeliveryFixture(provider);
  orgs.push(f.org);
  return f;
}
const preview = (f: Fixture) =>
  previewInvoiceDelivery(f.org, f.actor, f.invoice.id, {
    expectedVersion: f.invoice.version,
  });
const send = (f: Fixture, p: { previewId: string; payloadSha256: string }) =>
  sendInvoiceDelivery(f.org, f.actor, f.invoice.id, {
    previewId: p.previewId,
    payloadSha256: p.payloadSha256,
    confirmed: true,
  });
function observe<T>(promise: Promise<T>, pending: Promise<unknown>[]) {
  pending.push(promise);
  void promise.catch(() => {});
  return promise;
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
  throw Error(
    `Actual independent PostgreSQL row/writer barrier not observed: ${pattern}`,
  );
}
async function barrier(
  table: string,
  timing: "BEFORE INSERT" | "AFTER UPDATE",
  condition: string,
) {
  const suffix = randomUUID().replaceAll("-", ""),
    hook = `qa_returning_mail_${suffix}`,
    key = `qa-returning-mail-${suffix}`,
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

realPg(
  "v3 admission retains actual customer, property, member, company sender and mailbox preference locks against ordinary writers",
  async () => {
    const f = await fixture(),
      p = await preview(f),
      pending: Promise<unknown>[] = [],
      admitted = deferred(),
      continueEffect = deferred();
    let executorEntries = 0;
    const [controller] = await db
      .insert(usersTable)
      .values({
        organizationId: f.org,
        role: "owner",
        emailVerifiedAt: new Date(),
      })
      .returning();
    const sid = await createSession({
      user: {
        id: controller.id,
        email: null,
        firstName: null,
        lastName: null,
        profileImageUrl: null,
      },
      access_token: "synthetic",
    });
    sessions.push(sid);
    await db
      .insert(microsoftConnectionsTable)
      .values({
        organizationId: f.org,
        userId: f.sender,
        accountId: "synthetic-secondary",
        email: "secondary@example.invalid",
        encryptedRefreshToken: "synthetic-never-decrypted",
        grantedScopes: ["mail.send", "user.read"],
      });
    const b = await barrier(
      "invoice_delivery_attempts",
      "BEFORE INSERT",
      `NEW.organization_id='${f.org}'::uuid`,
    );
    attemptHooks.afterAdmission = async () => {
      executorEntries++;
      admitted.resolve();
      await continueEffect.promise;
    };
    try {
      const sending = observe(send(f, p), pending),
        admitting = await blockedBy(
          b.pid,
          '%insert into "invoice_delivery_attempts"%',
        );
      const customer = observe(
        updateContact(f.org, f.contact.id, {
          firstName: "Ordinary updated customer",
          updatedAt: f.contact.updatedAt,
        }),
        pending,
      );
      const property = observe(
        updateProperty(f.org, f.property!.id, {
          addressLine1: "Ordinary updated property",
          updatedAt: f.property!.updatedAt,
        }),
        pending,
      );
      const member = observe(
        originalFetch(`${base}/api/v1/users/${f.actor}`, {
          method: "PATCH",
          headers: {
            origin,
            cookie: `sid=${sid}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ role: "sales_manager" }),
        }),
        pending,
      );
      const settings = observe(
        updateOrgSettings(f.org, { customerEmailSenderUserId: null }),
        pending,
      );
      const preference = observe(
        selectUserEmailProvider(f.org, f.sender, "microsoft"),
        pending,
      );
      const writers = await Promise.all([
        blockedBy(admitting, '%update "contacts"%'),
        blockedBy(admitting, '%from "properties"%for update%'),
        blockedBy(admitting, '%update "users"%'),
        blockedBy(admitting, '%update "org_settings"%'),
        blockedBy(admitting, '%insert into "email_sender_preferences"%'),
      ]);
      expect(new Set([b.pid, admitting, ...writers]).size).toBe(7);
      await b.release();
      await Promise.race([
        admitted.promise,
        sending.then(() => {
          throw Error(
            "Actual kernel settled without invoking its original admission executor",
          );
        }),
      ]);
      await Promise.all([customer, property, settings, preference]);
      expect((await member).status).toBe(200);
      expect(executorEntries).toBe(1);
      continueEffect.resolve();
      const result = await sending;
      expect(result).toMatchObject({
        state: "held",
        attemptCount: 1,
        attempts: [{ proof: "not_dispatched" }],
      });
      expect(effects).toBe(0);
      expect(
        (
          await db
            .select()
            .from(emailSenderPreferencesTable)
            .where(eq(emailSenderPreferencesTable.organizationId, f.org))
        )[0].provider,
      ).toBe("microsoft");
    } finally {
      continueEffect.resolve();
      await b.cleanup(pending);
    }
  },
  30_000,
);

realPg(
  "v3 final post-OAuth guard waits for an actual property writer and refuses changed same-timestamp evidence before POST",
  async () => {
    const f = await fixture(),
      p = await preview(f),
      pending: Promise<unknown>[] = [],
      oauth = deferred(),
      enterGuard = deferred();
    atOAuth = oauth.resolve;
    beforeGuard = () => enterGuard.promise;
    const b = await barrier(
      "properties",
      "AFTER UPDATE",
      `NEW.id='${f.property!.id}'::uuid`,
    );
    try {
      const sending = observe(send(f, p), pending);
      await oauth.promise;
      const changing = observe(
        updateProperty(f.org, f.property!.id, {
          addressLine1: "Actual writer changed the site",
          updatedAt: f.property!.updatedAt,
        }),
        pending,
      );
      const writer = await blockedBy(b.pid, '%update "properties"%');
      enterGuard.resolve();
      const guard = await blockedBy(writer, '%from "properties"%for share%');
      expect(new Set([b.pid, writer, guard]).size).toBe(3);
      await b.release();
      await changing;
      expect(await sending).toMatchObject({
        state: "held",
        attempts: [{ state: "blocked", proof: "not_dispatched" }],
      });
      expect(effects).toBe(0);
    } finally {
      enterGuard.resolve();
      await b.cleanup(pending);
    }
  },
  30_000,
);

realPg(
  "v3 final post-OAuth guard waits for the real Microsoft disconnect writer and never posts from revoked identity",
  async () => {
    const f = await fixture("microsoft"),
      p = await preview(f),
      pending: Promise<unknown>[] = [],
      oauth = deferred(),
      enterGuard = deferred();
    atOAuth = oauth.resolve;
    beforeGuard = () => enterGuard.promise;
    const b = await barrier(
      "microsoft_connections",
      "AFTER UPDATE",
      `NEW.organization_id='${f.org}'::uuid`,
    );
    try {
      const sending = observe(send(f, p), pending);
      await oauth.promise;
      const disconnecting = observe(
          disconnectMicrosoft(f.org, f.sender),
          pending,
        ),
        writer = await blockedBy(b.pid, '%update "microsoft_connections"%');
      enterGuard.resolve();
      const guard = await blockedBy(
        writer,
        '%from "microsoft_connections"%for share%',
      );
      expect(new Set([b.pid, writer, guard]).size).toBe(3);
      await b.release();
      expect(await disconnecting).toMatchObject({
        disconnected: true,
        remoteConsentRevoked: false,
      });
      expect(await sending).toMatchObject({
        state: "held",
        attempts: [{ state: "blocked", proof: "not_dispatched" }],
      });
      expect(effects).toBe(0);
    } finally {
      enterGuard.resolve();
      await b.cleanup(pending);
    }
  },
  30_000,
);

realPg(
  "two independently observed v3 initial approvers retain one original execution and one physical effect",
  async () => {
    const f = await fixture(),
      first = await preview(f),
      second = await preview(f),
      pending: Promise<unknown>[] = [];
    const b = await barrier(
      "invoice_delivery_attempts",
      "BEFORE INSERT",
      `NEW.organization_id='${f.org}'::uuid`,
    );
    try {
      const one = observe(send(f, first), pending),
        original = await blockedBy(
          b.pid,
          '%insert into "invoice_delivery_attempts"%',
        );
      const two = observe(send(f, second), pending),
        contender = await blockedBy(original, "%pg_advisory_xact_lock%");
      expect(new Set([b.pid, original, contender]).size).toBe(3);
      await b.release();
      await Promise.all([one, two]);
      expect(
        await getInvoiceDelivery(f.org, f.actor, f.invoice.id),
      ).toMatchObject({ attemptCount: 1, state: "accepted" });
      expect(effects).toBe(1);
    } finally {
      await b.cleanup(pending);
    }
  },
  30_000,
);
