import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  auditEventsTable,
  zapierActionExecutionsTable,
  db,
  organizationsTable,
  usersTable,
  zapierMcpConnectionsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import app from "../../app";
import { requestZapierAction } from "../../services/zapier/zapier-executions";
import { bindZapierCapability, setZapierPolicy } from "../../services/zapier/zapier-connection";
import { processZapierConnectedApps } from "../../services/zapier/zapier-runtime";
import { sha256Hex } from "../../services/zapier/zapier-mcp-client";
import { encryptSecret } from "../../lib/token-encryption";
import { createSession } from "../../lib/auth";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";

const capturedLogs = vi.hoisted(() => [] as string[]);
vi.mock("../../lib/logger", async () => {
  const { default: pino } = await import("pino");
  return { logger: pino({}, { write: (line) => { capturedLogs.push(line); } }) };
});

const mock = vi.hoisted(() => ({
  tools: [] as string[],
  probes: 0,
  reads: 0,
  duringInspect: undefined as undefined | (() => Promise<void>),
  duringRead: undefined as undefined | (() => Promise<void>),
}));
vi.mock("../../services/zapier/zapier-mcp-client", async (original) => ({
  ...(await original<
    typeof import("../../services/zapier/zapier-mcp-client")
  >()),
  withZapierMcpSession: async (
    _credential: string,
    fn: (session: unknown) => Promise<unknown>,
  ) => {
    mock.probes++;
    return fn({
      listTools: async () =>
        mock.tools.map((name) => ({ name, description: null })),
      callTool: async (name: string) => {
        if (name === "inspect_zapier_actions") {
          await mock.duringInspect?.();
          return {
            value: [
              {
                app: "Facebook Lead Ads",
                selected_api: "FacebookLeadsCLIAPI",
                actions: [
                  { key: "new_lead", name: "New Lead", action_type: "read" },
                ],
              },
            ],
            isError: false,
          };
        }
        mock.reads++;
        await mock.duringRead?.();
        return { value: [], digest: "synthetic", isError: false };
      },
    });
  },
}));
let server: Server,
  base: string,
  a: string,
  b: string,
  operator: string,
  owner: string,
  actor: string;
const fixture = (
  ref = randomUUID() as string,
  token = "private-" + randomUUID(),
) => ({
  serverReference: ref,
  connectionToken: token,
  expectedConnectionFingerprint: null as string | null,
  ownershipConfirmed: true,
  dedicatedConnectionConfirmed: true,
});
const path = (id: string) => "/platform/clients/" + id + "/integrations/zapier";
async function request(
  method: string,
  endpoint: string,
  body?: unknown,
  sid = operator,
  headers = {},
) {
  const response = await fetch(base + endpoint, {
    method,
    headers: {
      authorization: "Bearer " + sid,
      "content-type": "application/json",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    text,
    json: text ? JSON.parse(text) : null,
  };
}
beforeAll(() => {
  server = app.listen(0, "127.0.0.1");
  return new Promise<void>((done) =>
    server.on("listening", () => {
      base =
        "http://127.0.0.1:" +
        (server.address() as AddressInfo).port +
        "/api/v1";
      done();
    }),
  );
});
beforeEach(async () => {
  vi.stubEnv(
    "OAUTH_TOKEN_ENCRYPTION_KEY",
    Buffer.alloc(32, 44).toString("base64"),
  );
  [a, b] = (
    await db
      .insert(organizationsTable)
      .values(
        [a, b].map(() => ({ name: "Managed fixture", slug: randomUUID() })),
      )
      .returning()
  ).map((r) => r.id);
  const sessions = [];
  for (const [id, admin] of [
    [b, true],
    [a, false],
  ] as const) {
    const [user] = await db
      .insert(usersTable)
      .values({
        organizationId: id,
        email: randomUUID() + "@example.test",
        role: "owner",
        isPlatformAdmin: admin,
        emailVerifiedAt: new Date(),
      })
      .returning();
    if (admin) actor = user!.id;
    sessions.push(
      await createSession({
        user: {
          id: user!.id,
          email: user!.email,
          firstName: null,
          lastName: null,
          profileImageUrl: null,
        },
        access_token: "synthetic",
      }),
    );
  }
  [operator, owner] = sessions;
  mock.probes = 0;
  mock.reads = 0;
  mock.duringRead = undefined;
  mock.duringInspect = undefined;
  mock.tools = [
    "inspect_zapier_actions",
    "execute_zapier_read_action",
    "execute_zapier_write_action",
  ];
});
afterEach(async () => {
  await deleteTestOrgs(a, b);
  vi.unstubAllEnvs();
});
afterAll(() => new Promise<void>((done) => server.close(() => done())));

it("returns fixed parser errors and keeps rejected credential bodies out of application and Express logs", async () => {
  const previousEnv = app.get("env");
  app.set("env", "development");
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  capturedLogs.length = 0;
  try {
    const marker = "synthetic_input_marker";
    const token = "synthetic_token_marker";
    for (const [body, expectedStatus] of [
      [marker + token, 400],
      [JSON.stringify({ connectionToken: token, notes: marker.repeat(6000) }), 413],
    ] as const) {
      const response = await fetch(base + path(a), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(response.status).toBe(expectedStatus);
      expect(await response.json()).toEqual({ error: "Invalid managed Zapier request.", code: "zapier_invalid_request" });
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(errors).not.toHaveBeenCalled();
    expect(capturedLogs).toHaveLength(2);
    for (const log of capturedLogs) {
      expect(log).not.toContain(marker);
      expect(log).not.toContain(token);
    }
    expect(mock.probes).toBe(0);
  } finally {
    errors.mockRestore();
    app.set("env", previousEnv);
  }
});

it("polls the managed client during an Embed outage and resumes the legacy client in the same window", async () => {
  const legacyUrl = "https://mcp.zapier.com/api/mcp/s/synthetic-server/mcp";
  vi.stubEnv("ZAPIER_MCP_EMBED_ID", "synthetic-embed");
  vi.stubEnv("ZAPIER_MCP_EMBED_SECRET", "synthetic-secret");
  expect((await request("PUT", path(a), fixture())).status).toBe(200);
  await db.insert(zapierMcpConnectionsTable).values({
    organizationId: b, connectedByUserId: actor,
    encryptedServerUrl: encryptSecret(legacyUrl, b + ":zapier-mcp"),
    serverUrlFingerprint: sha256Hex(legacyUrl), serverHost: "mcp.zapier.com",
    serverMode: "agentic", toolCount: 3, connectedAt: new Date(),
  });
  for (const organizationId of [a, b]) {
    const [user] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.organizationId, organizationId));
    const args = { organizationId, userId: user!.id, capability: "scout.leads.list" as const };
    await bindZapierCapability({ ...args, app: "FacebookLeadsCLIAPI", action: "new_lead", config: { page: "fixture" } });
    await setZapierPolicy({ ...args, mode: "auto", dailyBudget: 500 });
  }
  const receipts = (org: string) => db.select().from(zapierActionExecutionsTable).where(eq(zapierActionExecutionsTable.organizationId, org));
  vi.stubEnv("ZAPIER_MCP_EMBED_SECRET", "");
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    await processZapierConnectedApps();
    const managed = await receipts(a);
    expect(managed).toHaveLength(1);
    expect(managed[0]!.state).toBe("succeeded");
    expect(await receipts(b)).toHaveLength(0);
    expect(mock.reads).toBe(1);
    vi.stubEnv("ZAPIER_MCP_EMBED_SECRET", "synthetic-secret");
    await processZapierConnectedApps();
    expect((await receipts(a)).map((row) => row.id)).toEqual([managed[0]!.id]);
    const legacy = await receipts(b);
    expect(legacy).toHaveLength(1);
    expect(legacy[0]!.state).toBe("succeeded");
    expect(mock.reads).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});

it("rejects ordinary members, keys, malformed bodies, unsupported mode and retired tenant routes before any save", async () => {
  const input = fixture();
  for (const id of [a, b]) {
    for (const method of ["GET", "PUT", "DELETE"]) {
      expect(
        (
          await request(
            method,
            path(id),
            method === "GET" ? undefined : input,
            owner,
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await request(
            method,
            path(id),
            method === "GET" ? undefined : input,
            operator,
            { "x-api-key": "synthetic" },
          )
        ).status,
      ).toBe(403);
    }
  }
  for (const [method, route] of [
    ["POST", "server-url"],
    ["GET", "actions/search"],
    ["POST", "actions/enable"],
  ]) {
    expect(
      (
        await request(
          method!,
          "/integrations/zapier/" + route,
          method === "GET" ? undefined : input,
          owner,
        )
      ).status,
    ).toBe(403);
  }
  for (const change of [
    { ownershipConfirmed: false },
    { dedicatedConnectionConfirmed: false },
    { serverReference: "invalid/full-url" },
    { connectionToken: "has whitespace" },
    { extra: true },
    { expectedConnectionFingerprint: undefined },
    { monthlyActionLimit: -1 },
  ]) {
    const result = await request("PUT", path(a), { ...input, ...change });
    expect(result.status).toBe(400);
    expect(result.text).not.toContain(input.connectionToken);
  }
  expect((await request("PUT", path(randomUUID()), input)).status).toBe(404);
  expect(mock.probes).toBe(0);
  mock.tools = ["arbitrary_direct_write"];
  expect((await request("PUT", path(a), input)).status).toBe(422);
  expect(
    (await request("GET", path(a))).json.status.connectionFingerprint,
  ).toBeNull();
});

it.each(["reference", "token"])(
  "serializes competing assignments by %s including revoked and rotated tokens",
  async (shared) => {
    const first = fixture();
    const other = fixture(
      shared === "reference" ? first.serverReference : undefined,
      shared === "token" ? first.connectionToken : undefined,
    );
    const outcomes = await Promise.all([
      request("PUT", path(a), first),
      request("PUT", path(b), other),
    ]);
    expect(outcomes.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = outcomes[0]!.status === 200 ? a : b;
    const loser = winner === a ? b : a;
    const original = winner === a ? first : other;
    const status = (await request("GET", path(winner))).json;
    expect(status.status).toMatchObject({
      connected: true,
      provisioning: "mogulforge",
      monthlyActionLimit: 1000,
    });
    expect(status.usage).toMatchObject({
      monthlyActionsUsed: 0,
      monthlyActionsRemaining: 1000,
    });
    expect(JSON.stringify(outcomes)).not.toContain(original.connectionToken);
    expect((await request("PUT", path(winner), original)).status).toBe(409);
    const same = {
      ...original,
      expectedConnectionFingerprint: status.status.connectionFingerprint,
    };
    expect(
      (await request("PUT", path(winner), same)).json.status
        .connectionFingerprint,
    ).toBe(same.expectedConnectionFingerprint);
    const rotated = await request("PUT", path(winner), {
      ...same,
      connectionToken: "rotated-" + randomUUID(),
      monthlyActionLimit: 0,
    });
    expect(rotated.status).toBe(200);
    expect(rotated.json.status.connectionFingerprint).not.toBe(
      same.expectedConnectionFingerprint,
    );
    expect(
      (
        await request("DELETE", path(winner), {
          expectedConnectionFingerprint: same.expectedConnectionFingerprint,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request("DELETE", path(winner), {
          expectedConnectionFingerprint:
            rotated.json.status.connectionFingerprint,
        })
      ).status,
    ).toBe(204);
    const revoked = (await request("GET", path(winner))).json;
    expect(revoked.status.connected).toBe(false);
    expect(revoked.status.connectionFingerprint).not.toBe(
      rotated.json.status.connectionFingerprint,
    );
    expect(
      (
        await request(
          "PUT",
          path(loser),
          fixture(undefined, original.connectionToken),
        )
      ).status,
    ).toBe(409);
    expect(
      (await request("PUT", path(loser), fixture(original.serverReference)))
        .status,
    ).toBe(409);
    const [row] = await db
      .select()
      .from(zapierMcpConnectionsTable)
      .where(eq(zapierMcpConnectionsTable.organizationId, winner));
    expect(row!.encryptedServerUrl).toBe("");
    const events = await db
      .select()
      .from(auditEventsTable)
      .where(eq(auditEventsTable.organizationId, winner));
    expect(
      events
        .filter((event) => event.action.startsWith("integration.zapier"))
        .every((event) => event.actorUserId === actor),
    ).toBe(true);
    expect(JSON.stringify(events)).not.toContain(original.connectionToken);
  },
);

it("fences concurrent managed reads, reserves one slot per receipt and enforces a changed limit", async () => {
  const input = { ...fixture(), monthlyActionLimit: 1 };
  const saved = await request("PUT", path(a), input);
  expect(saved.status).toBe(200);
  const base = "/integrations/zapier/capabilities/scout.leads.list";
  expect(
    (
      await request(
        "PUT",
        base + "/binding",
        {
          app: "FacebookLeadsCLIAPI",
          action: "new_lead",
          config: { page: "fixture" },
        },
        owner,
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await request(
        "PUT",
        base + "/policy",
        { mode: "auto", dailyBudget: 500 },
        owner,
      )
    ).status,
  ).toBe(200);
  const run = (idempotencyKey: string) =>
    requestZapierAction({
      organizationId: a,
      capability: "scout.leads.list",
      input: {},
      idempotencyKey,
    });
  const results = await Promise.all([run("first"), run("second")]);
  expect(mock.reads).toBe(1);
  const success = results.find(
    (result) => result.execution.state === "succeeded",
  )!;
  expect(
    results.find((result) => result !== success)?.execution.errorCode,
  ).toBe("monthly_limit");
  await run(success.execution.idempotencyKey);
  expect(mock.reads).toBe(1);
  expect((await request("GET", path(a))).json.usage).toMatchObject({
    successfulActions: 1,
    estimatedTasksFromRecordedActions: 2,
    monthlyActionsUsed: 1,
    monthlyActionsRemaining: 0,
  });
  const update = {
    ...input,
    expectedConnectionFingerprint: saved.json.status.connectionFingerprint,
  };
  const zero = await request("PUT", path(a), {
    ...update,
    monthlyActionLimit: 0,
  });
  expect(zero.status).toBe(200);
  expect(zero.json.status.connectionFingerprint).not.toBe(
    update.expectedConnectionFingerprint,
  );
  expect((await run("third")).execution.errorCode).toBe("monthly_limit");
  const unlimited = await request("PUT", path(a), {
    ...input,
    monthlyActionLimit: 3,
    expectedConnectionFingerprint: zero.json.status.connectionFingerprint,
  });
  expect(unlimited.status).toBe(200);
  let entered!: () => void, release!: () => void;
  const active = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  mock.duringRead = async () => {
    entered();
    await hold;
  };
  const inFlight = run("fourth");
  await active;
  let revoked = false;
  const revoke = request("DELETE", "/integrations/zapier", {}, owner).then(
    (result) => {
      revoked = true;
      return result;
    },
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(revoked).toBe(false);
  } finally {
    release();
  }
  expect((await inFlight).execution.state).toBe("succeeded");
  expect((await revoke).json.disconnected).toBe(true);
  expect((await run("fifth")).execution.state).toBe("blocked");
  expect(mock.reads).toBe(2);
});

it("fails closed on a missing encryption key before a provider probe", async () => {
  vi.stubEnv("OAUTH_TOKEN_ENCRYPTION_KEY", "");
  const input = fixture();
  const result = await request("PUT", path(a), input);
  expect(result.status).toBe(503);
  expect(result.text).not.toContain(input.connectionToken);
  expect(mock.probes).toBe(0);
  expect((await request("GET", path(a))).json.status.connected).toBe(false);
});

it("rejects a binding discovered on a credential replaced before the binding save", async () => {
  const input = fixture();
  const saved = await request("PUT", path(a), input);
  expect(saved.status).toBe(200);
  let entered!: () => void, release!: () => void;
  const active = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  mock.duringInspect = async () => {
    entered();
    await hold;
  };
  const pending = request(
    "PUT",
    "/integrations/zapier/capabilities/scout.leads.list/binding",
    {
      app: "FacebookLeadsCLIAPI",
      action: "new_lead",
      config: { page: "fixture" },
    },
    owner,
  );
  await active;
  try {
    const rotated = await request("PUT", path(a), {
      ...input,
      connectionToken: "rotated-" + randomUUID(),
      expectedConnectionFingerprint: saved.json.status.connectionFingerprint,
    });
    expect(rotated.status).toBe(200);
  } finally {
    release();
  }
  expect((await pending).status).toBe(409);
});
