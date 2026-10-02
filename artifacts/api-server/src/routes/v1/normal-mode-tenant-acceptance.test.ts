import { createHash, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  activitiesTable,
  auditEventsTable,
  contactsTable,
  crmTasksTable,
  db,
  estimatesTable,
  leadsTable,
  organizationsTable,
  portalSessionsTable,
  revenueExecutionsTable,
  storedObjectsTable,
  usersTable,
  valueEntriesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Only the external effect is replaced. Session/API-key authentication,
// membership, role checks, routing, services and PostgreSQL queries stay real.
const sendEmail = vi.hoisted(() => vi.fn());
vi.mock("../../services/user-email", async (original) => ({
  ...(await original<typeof import("../../services/user-email")>()),
  sendEmailForUser: sendEmail,
}));

import app from "../../app";
import { createSession, deleteSession } from "../../lib/auth";
import { restoreModeRequested } from "../../lib/restore-mode";
import {
  ObjectNotFoundError,
  ObjectStorageService,
  objectStorageClient,
} from "../../lib/objectStorage";
import { createApiKey } from "../../services/api-keys";
import type { RoiReport } from "../../services/roi-report";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";

type Tenant = {
  org: string;
  actor: string;
  sid: string;
  viewerSid: string;
  key: string;
  contact: string;
  lead: string;
  estimate: string;
  task: string;
  source: string;
  marker: string;
  email: string;
  photo: string;
  bytes: Buffer;
  portalToken: string;
};
let server: Server, base: string;
const tenants: Tenant[] = [];
const sessions: string[] = [];
const unownedObjects: string[] = [];
const nativeFetch = globalThis.fetch;
let externalAttempts = 0;

async function request(
  tenant: Tenant | null,
  path: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return fetch(`${base}/api/v1${path}`, {
    method,
    headers: {
      ...(tenant ? { authorization: `Bearer ${tenant.sid}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function snapshot(org: string) {
  // These are the business/effect rows this matrix exercises, not a claim of
  // whole-database fingerprinting or a customer data export.
  return Promise.all([
    db
      .select()
      .from(contactsTable)
      .where(eq(contactsTable.organizationId, org))
      .orderBy(contactsTable.id),
    db
      .select()
      .from(leadsTable)
      .where(eq(leadsTable.organizationId, org))
      .orderBy(leadsTable.id),
    db
      .select()
      .from(estimatesTable)
      .where(eq(estimatesTable.organizationId, org))
      .orderBy(estimatesTable.id),
    db
      .select()
      .from(crmTasksTable)
      .where(eq(crmTasksTable.organizationId, org))
      .orderBy(crmTasksTable.id),
    db
      .select()
      .from(activitiesTable)
      .where(eq(activitiesTable.organizationId, org))
      .orderBy(activitiesTable.id),
    db
      .select()
      .from(auditEventsTable)
      .where(eq(auditEventsTable.organizationId, org))
      .orderBy(auditEventsTable.id),
    db
      .select()
      .from(valueEntriesTable)
      .where(eq(valueEntriesTable.organizationId, org))
      .orderBy(valueEntriesTable.id),
    db
      .select()
      .from(revenueExecutionsTable)
      .where(eq(revenueExecutionsTable.organizationId, org))
      .orderBy(revenueExecutionsTable.id),
    db
      .select()
      .from(storedObjectsTable)
      .where(eq(storedObjectsTable.organizationId, org))
      .orderBy(storedObjectsTable.id),
  ]);
}

beforeAll(async () => {
  if (process.env.NODE_ENV !== "test" || restoreModeRequested()) {
    throw new Error(
      "This matrix requires normal test mode; restore-mode denials do not count.",
    );
  }
  expect(process.env.OBJECT_STORAGE_PROVIDER).toBe("postgres");
  for (const label of ["A", "B"]) {
    const marker = `NORMAL_MODE_${label}_${randomUUID()}`;
    const [org] = await db
      .insert(organizationsTable)
      .values({ name: marker, slug: marker.toLowerCase() })
      .returning();
    const [owner, viewer] = await db
      .insert(usersTable)
      .values([
        { organizationId: org.id, role: "owner", isActive: true },
        { organizationId: org.id, role: "viewer", isActive: true },
      ])
      .returning();
    const login = async (id: string) => {
      const sid = await createSession({
        user: {
          id,
          email: null,
          firstName: null,
          lastName: null,
          profileImageUrl: null,
        },
        access_token: "synthetic-test-only",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      });
      sessions.push(sid);
      return sid;
    };
    const email = `${label.toLowerCase()}-${randomUUID()}@example.invalid`;
    const [contact] = await db
      .insert(contactsTable)
      .values({ organizationId: org.id, firstName: marker, email })
      .returning();
    const source = `SOURCE_${marker}`;
    const [lead] = await db
      .insert(leadsTable)
      .values({
        organizationId: org.id,
        contactId: contact.id,
        source,
        status: "new",
      })
      .returning();
    const [estimate] = await db
      .insert(estimatesTable)
      .values({ organizationId: org.id, leadId: lead.id, title: marker })
      .returning();
    const [task] = await db
      .insert(crmTasksTable)
      .values({
        organizationId: org.id,
        leadId: lead.id,
        contactId: contact.id,
        title: marker,
      })
      .returning();
    const photo = randomUUID();
    const bytes = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.from(marker),
    ]);
    await db.insert(storedObjectsTable).values({
      id: photo,
      organizationId: org.id,
      data: bytes,
      contentType: "image/png",
      sizeBytes: bytes.length,
    });
    await db.insert(activitiesTable).values({
      organizationId: org.id,
      leadId: lead.id,
      contactId: contact.id,
      type: "photos_attached",
      title: "Synthetic owned photo",
      metadata: { photoPaths: [`/objects/uploads/${photo}`] },
    });
    const portalToken = randomUUID();
    await db.insert(portalSessionsTable).values({
      organizationId: org.id,
      identifier: email,
      channel: "email",
      tokenHash: createHash("sha256").update(portalToken).digest("hex"),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const key = (
      await createApiKey({
        organizationId: org.id,
        name: "Synthetic office integration",
        role: "office",
        createdByUserId: owner.id,
      })
    ).key;
    tenants.push({
      org: org.id,
      actor: owner.id,
      sid: await login(owner.id),
      viewerSid: await login(viewer.id),
      key,
      contact: contact.id,
      lead: lead.id,
      estimate: estimate.id,
      task: task.id,
      source,
      marker,
      email,
      photo,
      bytes,
      portalToken,
    });
  }
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
    );
    if (url.origin !== base) {
      externalAttempts++;
      throw new Error("Normal-mode acceptance refuses external fetches");
    }
    return nativeFetch(input, init);
  });
});

beforeEach(() => {
  sendEmail
    .mockReset()
    .mockImplementation(async (input: { organizationId: string }) => ({
      id: `synthetic-receipt-${randomUUID()}`,
      provider: "gmail",
      acceptance: "accepted",
      senderEmail: `sender-${input.organizationId}@example.invalid`,
    }));
});

afterAll(async () => {
  vi.restoreAllMocks();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  for (const sid of sessions) await deleteSession(sid);
  for (const id of unownedObjects)
    await db.delete(storedObjectsTable).where(eq(storedObjectsTable.id, id));
  await deleteTestOrgs(...tenants.map((tenant) => tenant.org));
  expect(externalAttempts).toBe(0);
});

describe.each([0, 1])(
  "normal-mode company %i acts against the other company",
  (index) => {
    const pair = () => ({ own: tenants[index]!, other: tenants[1 - index]! });

    it("NM-01 authenticates real sessions, scopes direct/list/search reads and ignores forged tenant selectors", async () => {
      const { own, other } = pair();
      const before = await snapshot(other.org);
      expect((await request(null, `/contacts/${own.contact}`)).status).toBe(
        401,
      );
      expect((await request(own, `/contacts/${own.contact}`)).status).toBe(200);
      const foreign = await request(own, `/contacts/${other.contact}`);
      const absent = await request(own, `/contacts/${randomUUID()}`);
      expect(foreign.status).toBe(404);
      expect(await foreign.json()).toEqual(await absent.json());
      const search = await request(
        own,
        `/contacts?search=${encodeURIComponent(other.marker)}&organizationId=${other.org}`,
      );
      expect(await search.json()).toEqual([]);
      const list = await request(
        own,
        `/contacts?organizationId=${other.org}`,
        "GET",
        undefined,
        { "x-organization-id": other.org, "x-org-id": other.org },
      );
      expect(list.status).toBe(200);
      const rows = (await list.json()) as Array<{
        id: string;
        organizationId: string;
      }>;
      expect(rows.some((row) => row.id === own.contact)).toBe(true);
      expect(rows.every((row) => row.organizationId === own.org)).toBe(true);
      expect(await snapshot(other.org)).toEqual(before);
      expect(sendEmail).not.toHaveBeenCalled();
    });

    it("NM-02 permits own CRUD while denying foreign writes, deletes and related-record grafting", async () => {
      const { own, other } = pair();
      const before = await snapshot(other.org);
      expect(
        (
          await request(own, `/contacts/${other.contact}`, "PATCH", {
            firstName: "Must not change",
          })
        ).status,
      ).toBe(404);
      expect(
        (await request(own, `/contacts/${other.contact}`, "DELETE")).status,
      ).toBe(404);
      expect(
        (await request(own, "/leads", "POST", { contactId: other.contact }))
          .status,
      ).toBe(400);
      expect(
        (
          await request(own, "/estimates", "POST", {
            leadId: other.lead,
            title: "Must not graft",
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await request(own, `/estimates/${other.estimate}`, "PATCH", {
            title: "Must not change",
          })
        ).status,
      ).toBe(404);
      expect(
        (await request(own, `/estimates/${other.estimate}`, "DELETE")).status,
      ).toBe(404);
      expect(
        (
          await request(own, `/tasks/${other.task}`, "PATCH", {
            title: "Must not change",
          })
        ).status,
      ).toBe(404);
      expect(
        (await request(own, `/tasks/${other.task}`, "DELETE")).status,
      ).toBe(404);
      const create = await request(own, "/contacts", "POST", {
        firstName: "Own temporary contact",
        organizationId: other.org,
      });
      expect(create.status).toBe(201);
      const row = (await create.json()) as {
        id: string;
        organizationId: string;
      };
      expect(row.organizationId).toBe(own.org);
      expect(
        (
          await request(own, `/contacts/${row.id}`, "PATCH", {
            firstName: "Own update",
          })
        ).status,
      ).toBe(200);
      expect((await request(own, `/contacts/${row.id}`, "DELETE")).status).toBe(
        204,
      );
      expect((await request(own, `/contacts/${row.id}`)).status).toBe(404);
      expect(await snapshot(other.org)).toEqual(before);
      expect(sendEmail).not.toHaveBeenCalled();
    });

    it("NM-03 scopes exports and evidence and rejects another company's recorded payment", async () => {
      const { own, other } = pair();
      const before = await snapshot(other.org);
      for (const path of ["/reports/roi", "/reports/roi/export"]) {
        const rejected = await request(
          own,
          `${path}?organizationId=${other.org}`,
        );
        expect(rejected.status).toBe(400);
        expect(rejected.headers.get("cache-control")).toBe("no-store");
        expect(await rejected.json()).toEqual({ error: expect.any(String) });
      }
      const forgedHeaders = {
        "x-organization-id": other.org,
        "x-org-id": other.org,
      };
      const reportResponse = await request(
        own,
        "/reports/roi",
        "GET",
        undefined,
        forgedHeaders,
      );
      expect(reportResponse.status).toBe(200);
      expect(reportResponse.headers.get("cache-control")).toBe("no-store");
      const report = (await reportResponse.json()) as RoiReport;
      expect(report.leads.total).toBe(1);
      expect(report.leads.bySource).toEqual([{ key: own.source, count: 1 }]);
      expect(JSON.stringify(report)).not.toContain(other.source);
      const exported = await request(
        own,
        `/reports/roi/export?days=${report.windowDays}&endAt=${encodeURIComponent(report.period.endAt)}`,
        "GET",
        undefined,
        forgedHeaders,
      );
      expect(exported.status).toBe(200);
      expect(exported.headers.get("cache-control")).toBe("no-store");
      expect(exported.headers.get("content-type")).toContain("text/csv");
      const csv = await exported.text();
      expect(csv).toContain(`start_at_inclusive,UTC,${report.period.startAt}`);
      expect(csv).toContain(`end_at_exclusive,UTC,${report.period.endAt}`);
      expect(csv).toContain(own.source);
      expect(csv).not.toContain(other.source);
      expect((await request(own, `/revenue/evidence/${own.lead}`)).status).toBe(
        200,
      );
      expect(
        (await request(own, `/revenue/evidence/${other.lead}`)).status,
      ).toBe(404);
      const payment = {
        kind: "payment",
        amountCents: 100,
        sourceReference: `synthetic-${randomUUID()}`,
        occurredAt: new Date(Date.now() - 1000).toISOString(),
        confirmed: true,
      };
      expect(
        (
          await request(own, "/revenue/value", "POST", {
            ...payment,
            leadId: other.lead,
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await request(own, "/revenue/value", "POST", {
            ...payment,
            leadId: own.lead,
          })
        ).status,
      ).toBe(201);
      expect(await snapshot(other.org)).toEqual(before);
      expect(sendEmail).not.toHaveBeenCalled();
    });

    it("NM-04 blocks cross-company sends before the provider boundary and proves the own-sender positive control", async () => {
      const { own, other } = pair();
      const before = await snapshot(other.org);
      const body = {
        subject: "Synthetic acceptance only",
        body: "No real provider is called.",
      };
      const foreign = await request(
        own,
        `/leads/${other.lead}/send-email`,
        "POST",
        body,
      );
      expect(foreign.status).toBe(404);
      expect(await foreign.json()).toEqual(
        await (
          await request(own, `/leads/${randomUUID()}/send-email`, "POST", body)
        ).json(),
      );
      expect(sendEmail).not.toHaveBeenCalled();
      const ownResponse = await request(
        own,
        `/leads/${own.lead}/send-email`,
        "POST",
        body,
      );
      expect(ownResponse.status).toBe(201);
      expect(sendEmail).toHaveBeenCalledExactlyOnceWith({
        organizationId: own.org,
        userId: own.actor,
        to: own.email,
        ...body,
      });
      const activity = (await ownResponse.json()) as {
        metadata: Record<string, unknown>;
      };
      expect(activity.metadata).toMatchObject({
        deliveryConfirmed: false,
        acceptance: "accepted",
        from: `sender-${own.org}@example.invalid`,
      });
      expect(await snapshot(other.org)).toEqual(before);
    });

    it("NM-05 checks actual API-key authentication and current role without a restore-mode 405", async () => {
      const { own, other } = pair();
      const before = await snapshot(other.org);
      const keyHeaders = { "x-api-key": own.key };
      expect(
        (
          await request(
            null,
            `/contacts/${own.contact}`,
            "GET",
            undefined,
            keyHeaders,
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await request(
            null,
            `/contacts/${other.contact}`,
            "GET",
            undefined,
            keyHeaders,
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await request(
            null,
            `/contacts/${other.contact}`,
            "PATCH",
            { firstName: "No key graft" },
            keyHeaders,
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await request(
            null,
            `/contacts/${own.contact}`,
            "DELETE",
            undefined,
            keyHeaders,
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await request(
            { ...own, sid: own.viewerSid },
            `/contacts/${own.contact}`,
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await request(
            { ...own, sid: own.viewerSid },
            `/contacts/${own.contact}`,
            "PATCH",
            { firstName: "No viewer edit" },
          )
        ).status,
      ).toBe(403);
      expect(await snapshot(other.org)).toEqual(before);
      expect(sendEmail).not.toHaveBeenCalled();
    });

    it("NM-06 cannot turn caller-created photo metadata into a grant for foreign object bytes", async () => {
      const { own, other } = pair();
      const before = await snapshot(other.org);
      const photoPath = (tenant: Tenant) =>
        `/storage/objects/uploads/${tenant.photo}`;
      const ownPhoto = await request(own, photoPath(own));
      expect(ownPhoto.status).toBe(200);
      expect(Buffer.from(await ownPhoto.arrayBuffer())).toEqual(own.bytes);
      expect((await request(own, photoPath(other))).status).toBe(404);
      const forged = await request(
        own,
        `/leads/${own.lead}/activities`,
        "POST",
        {
          type: "photos_attached",
          title: "Untrusted photo reference",
          metadata: { photoPaths: [`/objects/uploads/${other.photo}`] },
        },
      );
      const after = await request(own, photoPath(other));
      const result = {
        writeStatus: forged.status,
        readStatus: after.status,
        foreignBytesExposed: Buffer.from(await after.arrayBuffer()).equals(
          other.bytes,
        ),
      };
      expect(result).toEqual({
        writeStatus: 400,
        readStatus: 404,
        foreignBytesExposed: false,
      });
      expect(await snapshot(other.org)).toEqual(before);
      expect(sendEmail).not.toHaveBeenCalled();
    });

    it("NM-07 denies legacy forged/unowned references in staff and portal views while preserving owned photo flows", async () => {
      const { own, other } = pair();
      const before = await snapshot(other.org);
      const unowned = randomUUID();
      unownedObjects.push(unowned);
      await db.insert(storedObjectsTable).values({
        id: unowned,
        data: Buffer.from("unowned synthetic bytes"),
        contentType: "image/png",
        sizeBytes: 23,
      });
      // Model already-persisted legacy or malformed references: fixing only the
      // write handler must not leave these links capable of exposing bytes.
      await db.insert(activitiesTable).values({
        organizationId: own.org,
        leadId: own.lead,
        contactId: own.contact,
        type: "photos_attached",
        title: "Synthetic legacy invalid references",
        metadata: {
          photoPaths: [
            `/objects/uploads/${other.photo}`,
            `/objects/uploads/${unowned}`,
          ],
        },
      });
      for (const id of [other.photo, unowned]) {
        const staff = await request(own, `/storage/objects/uploads/${id}`);
        expect(staff.status).toBe(404);
        const portal = await request(
          null,
          `/portal/photos/objects/uploads/${id}`,
          "GET",
          undefined,
          { "x-portal-token": own.portalToken },
        );
        expect(portal.status).toBe(404);
      }
      const attached = await request(own, `/leads/${own.lead}/photos`, "POST", {
        photoPaths: [`/objects/uploads/${own.photo}`],
      });
      expect(attached.status).toBe(201);
      expect(
        (
          await request(own, `/leads/${own.lead}/photos`, "POST", {
            photoPaths: [`/objects/uploads/${other.photo}`],
          })
        ).status,
      ).toBe(400);
      const note = await request(own, `/leads/${own.lead}/activities`, "POST", {
        type: "note",
        title: "Ordinary staff note still works",
      });
      expect(note.status).toBe(201);
      for (const response of [
        await request(own, `/storage/objects/uploads/${own.photo}`),
        await request(
          null,
          `/portal/photos/objects/uploads/${own.photo}`,
          "GET",
          undefined,
          { "x-portal-token": own.portalToken },
        ),
      ]) {
        expect(response.status).toBe(200);
        expect(Buffer.from(await response.arrayBuffer())).toEqual(own.bytes);
      }
      expect(await snapshot(other.org)).toEqual(before);
      expect(sendEmail).not.toHaveBeenCalled();
    });
  },
);

it("NM-08 refuses tenant-scoped legacy external storage before contacting a provider with no ownership registry", async () => {
  const previous = process.env.OBJECT_STORAGE_PROVIDER;
  const bucket = vi.spyOn(objectStorageClient, "bucket");
  try {
    for (const provider of ["gcs", "replit"]) {
      process.env.OBJECT_STORAGE_PROVIDER = provider;
      await expect(
        new ObjectStorageService().getObjectEntityFile(
          `/objects/uploads/${tenants[0]!.photo}`,
          tenants[0]!.org,
        ),
      ).rejects.toBeInstanceOf(ObjectNotFoundError);
    }
    expect(bucket).not.toHaveBeenCalled();
  } finally {
    if (previous === undefined) delete process.env.OBJECT_STORAGE_PROVIDER;
    else process.env.OBJECT_STORAGE_PROVIDER = previous;
    bucket.mockRestore();
  }
});
