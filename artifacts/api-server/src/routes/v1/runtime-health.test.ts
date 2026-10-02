import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  db,
  organizationsTable,
  usersTable,
  scheduledActionsTable,
} from "@workspace/db";
import { beforeAll, afterAll, expect, it } from "vitest";
import app from "../../app";
import { createSession, deleteSession } from "../../lib/auth";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";
import type { getSchedulerHealth } from "../../services/scheduler-runtime";

let server: Server,
  base: string,
  org: string,
  admin: string,
  owner: string,
  inactive: string;
const sessions: string[] = [];
beforeAll(async () => {
  const [tenant] = await db
    .insert(organizationsTable)
    .values({ name: "Private runtime QA", slug: `runtime-qa-${randomUUID()}` })
    .returning();
  org = tenant.id;
  const session = async (platform: boolean, active = true) => {
    const [user] = await db
      .insert(usersTable)
      .values({
        organizationId: org,
        role: "owner",
        isPlatformAdmin: platform,
        isActive: active,
      })
      .returning();
    const sid = await createSession({
      user: {
        id: user.id,
        email: null,
        firstName: null,
        lastName: null,
        profileImageUrl: null,
      },
      access_token: "synthetic-only",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });
    sessions.push(sid);
    return sid;
  };
  admin = await session(true);
  owner = await session(false);
  inactive = await session(true, false);
  await db
    .insert(scheduledActionsTable)
    .values({
      organizationId: org,
      action: {
        type: "send_email",
        params: { body: "SECRET_CUSTOMER_BODY", to: "private@example.invalid" },
      },
      context: { credential: "SECRET_PROVIDER_KEY" },
      runAt: new Date(),
      status: "failed",
      lastError: "SECRET_RAW_EXCEPTION",
    });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  for (const sid of sessions) await deleteSession(sid);
  await deleteTestOrgs(org);
});
const read = (sid = "", headers = {}) =>
  fetch(`${base}/api/v1/platform/runtime`, {
    headers: { cookie: `sid=${sid}`, ...headers },
  });
it("requires a current active platform-admin session, rejecting tenant owners and API keys", async () => {
  for (const sid of ["", owner, inactive])
    expect([401, 403]).toContain((await read(sid)).status);
  expect((await read(admin, { "x-api-key": "synthetic-key" })).status).toBe(
    403,
  );
});
it("exposes only aggregate operational metadata, with no payload, provider or customer data", async () => {
  const response = await read(admin);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = (await response.json()) as Awaited<
    ReturnType<typeof getSchedulerHealth>
  >;
  expect(body.queue.failed).toBeGreaterThanOrEqual(1);
  expect(body.staleAfterSeconds).toBe(300);
  expect(JSON.stringify(body)).not.toMatch(
    /SECRET|private@example|credential|ownerId|DATABASE_URL/,
  );
  expect(Object.keys(body).sort()).toEqual(
    [
      "serverNow",
      "health",
      "staleAfterSeconds",
      "heartbeatAt",
      "startedAt",
      "completedAt",
      "intervalSeconds",
      "currentStage",
      "failedStages",
      "queue",
      "executionsNeedingReview",
      "failedWebhookDeliveries",
      "boundary",
    ].sort(),
  );
});
