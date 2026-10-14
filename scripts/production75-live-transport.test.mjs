import { test, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createOperatorResources } from "./production75-operator.mjs";
import {
  createLiveTransport,
  liveEnvironment,
  normalizeLiveAuthorization,
} from "./production75-live-transport.mjs";
const credential = "fm1r_" + "A".repeat(40),
  config = `access_token: ${credential},${"B".repeat(40)}\n`;
function fixture({ fetchFn } = {}) {
  let alive = false,
    closed = false;
  const child = new EventEmitter();
  child.pid = 123;
  child.stdout = new EventEmitter();
  child.stdout.resume = () => {};
  child.stderr = { resume() {} };
  child.kill = () => {
    alive = false;
    closed = true;
    queueMicrotask(() => child.emit("close", 0));
    return true;
  };
  const runFile = vi.fn(async (args) =>
    args[0] === "auth" ? "diazdestination@gmail.com\n" : "",
  );
  const inspect = vi.fn(async (kind, id) =>
    kind === "listener"
      ? alive
        ? [{ pid: 123, address: "127.0.0.1" }]
        : []
      : kind === "children"
        ? []
        : closed
          ? null
          : { pid: id, created: "fixed", executable: "fly" },
  );
  class Client extends EventEmitter {
    constructor(c) {
      super();
      this.config = c;
      this.connection = {
        stream: {
          destroyed: false,
          destroy() {
            this.destroyed = true;
          },
        },
      };
    }
    async connect() {}
    async query() {
      return { rows: [] };
    }
    async end() {
      this.connection.stream.destroy();
    }
  }
  const transport = createLiveTransport({
    fetchFn,
    runFile,
    spawnChild: () => {
      alive = true;
      return child;
    },
    readCredentialConfig: async () => config,
    inspect,
    Client,
    choosePort: () => 16487,
    pause: async () => {},
  });
  return { transport, runFile, inspect, Client, child };
}
test("sanitized environment removes provider/PG overrides and isolates the agent", () => {
  const e = liveEnvironment({
    PATH: "path",
    USERPROFILE: "profile",
    FLY_API_TOKEN: "secret",
    PGPASSWORD: "secret",
    FLY_UIEX_BASE_URL: "evil",
    FLY_AGENT_SOCKET_PATH: "shared",
  });
  expect(e).toMatchObject({
    FLY_AGENT_ISOLATED: "1",
    FLY_WIREGUARD_TOKEN_MODE: "1",
  });
  expect(e.FLY_API_TOKEN).toBeUndefined();
  expect(e.PGPASSWORD).toBeUndefined();
  expect(e.FLY_AGENT_SOCKET_PATH).toBeUndefined();
});
test("source backup discovery preserves actual differential backup type", async () => {
  const f = fixture({
    fetchFn: async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              id: "backup_diff",
              type: "diff",
              status: "completed",
              start: "2026-10-12T21:50:29Z",
              stop: "2026-10-12T21:50:30Z",
            },
          ],
        }),
        { status: 200 },
      ),
  });
  expect(await f.transport.sourceBackups()).toEqual([
    {
      id: "backup_diff",
      type: "diff",
      status: "completed",
      start: "2026-10-12T21:50:29Z",
      stop: "2026-10-12T21:50:30Z",
    },
  ]);
  expect(f.transport.metadata().sourceCredentialsLoaded).toBe(false);
});
test("private token normalization is strict and errors contain no input", () => {
  expect(normalizeLiveAuthorization(config, "legacy")).toBe(
    `Bearer ${credential},${"B".repeat(40)}`,
  );
  expect(normalizeLiveAuthorization(config, "machines")).toBe(
    `FlyV1 ${credential}`,
  );
  expect(() =>
    normalizeLiveAuthorization(
      "access_token: private\naccess_token: another",
      "legacy",
    ),
  ).toThrow("production75_live_auth_shape");
});
test("foreign account refuses credential loading", async () => {
  const f = fixture();
  f.runFile.mockResolvedValue("foreign@example.com");
  await expect(f.transport.authorization("legacy")).rejects.toMatchObject({
    safeCode: "production75_live_identity",
  });
});
test("owned loopback proxy and every client close through terminal resources", async () => {
  const f = fixture(),
    r = createOperatorResources({ until: Date.now() + 10000 });
  await f.transport.verifyIdentity();
  const p = await f.transport.openProxy("kzpwm0j18eg04nv3", r);
  const c = await f.transport.connect(
    p,
    "fly-db",
    { user: "fly-user", password: "private-fixture" },
    { readonly: true, resources: r },
  );
  expect(c.config.options).toContain("default_transaction_read_only=on");
  expect(c.config.ssl).toBe(false);
  expect(await r.drain()).toEqual({ closed: true });
  expect(f.transport.metadata()).toMatchObject({
    clients: 1,
    clientsClosed: 1,
    proxies: 1,
    proxiesClosed: 1,
  });
  expect(f.runFile.mock.calls.flat().flat()).not.toContain("stop");
});
test("occupied or foreign listener is refused and only owned child is closed", async () => {
  const f = fixture(),
    r = createOperatorResources({ until: Date.now() + 10000 });
  await f.transport.verifyIdentity();
  f.inspect.mockImplementation(async (kind) =>
    kind === "listener" ? [{ pid: 999, address: "127.0.0.1" }] : null,
  );
  await expect(
    f.transport.openProxy("kzpwm0j18eg04nv3", r),
  ).rejects.toMatchObject({ safeCode: "production75_live_listener" });
  expect(f.transport.metadata().proxies).toBe(0);
  await r.drain();
});
test("idle client error terminates acquisition scope and never escapes", async () => {
  const f = fixture(),
    r = createOperatorResources({ until: Date.now() + 10000 });
  await f.transport.verifyIdentity();
  const p = await f.transport.openProxy("kzpwm0j18eg04nv3", r),
    c = await f.transport.connect(
      p,
      "fly-db",
      { user: "fly-user", password: "private-fixture" },
      { readonly: true, resources: r },
    );
  expect(() => c.emit("error", new Error("private value"))).not.toThrow();
  await expect(c.query("SELECT 1")).rejects.toMatchObject({
    safeCode: "production75_live_client",
  });
  expect(await r.drain()).toEqual({ closed: true });
});
test("raw dependency errors are rebuilt without private cause/message", async () => {
  const f = fixture();
  f.runFile.mockRejectedValue(
    Object.assign(new Error("private credential"), {
      safeCode: "production75_live_spoof",
      cause: "private",
    }),
  );
  try {
    await f.transport.verifyIdentity();
    throw new Error("unexpected");
  } catch (e) {
    expect(e.message).toBe("production75_live_cli");
    expect(e.cause).toBeUndefined();
  }
});
test.each(["kzpwm0j18eg04nv3", "zp2wjrejd2zodn4q"])(
  "writable session on protected %s is refused",
  async (cluster) => {
    const f = fixture(),
      r = createOperatorResources({ until: Date.now() + 10000 });
    await f.transport.verifyIdentity();
    const p = await f.transport.openProxy(cluster, r);
    await expect(
      f.transport.connect(
        p,
        "fly-db",
        { user: "fly-user", password: "private-fixture" },
        { readonly: false, resources: r },
      ),
    ).rejects.toMatchObject({ safeCode: "production75_live_original_write" });
    await r.drain();
  },
);
test("late listener inspection cannot instantiate a new client after abort", async () => {
  const f = fixture(),
    r = createOperatorResources({ until: Date.now() + 10000 });
  await f.transport.verifyIdentity();
  const p = await f.transport.openProxy("kzpwm0j18eg04nv3", r);
  let resolve;
  f.inspect.mockImplementation((kind, id) =>
    kind === "listener"
      ? new Promise((done) => {
          resolve = done;
        })
      : Promise.resolve({ pid: id, created: "fixed", executable: "fly" }),
  );
  const pending = f.transport.connect(
    p,
    "fly-db",
    { user: "fly-user", password: "private-fixture" },
    { readonly: true, resources: r },
  );
  await Promise.resolve();
  await Promise.resolve();
  r.abort();
  resolve([{ pid: 123, address: "127.0.0.1" }]);
  await expect(pending).rejects.toMatchObject({
    safeCode: "production75_operator_resources",
  });
  expect(f.transport.metadata().clients).toBe(0);
});
test("failure inspecting a newly spawned child still closes its owned handle", async () => {
  const f = fixture(),
    r = createOperatorResources({ until: Date.now() + 10000 });
  await f.transport.verifyIdentity();
  const original = f.inspect.getMockImplementation(),
    kill = vi.spyOn(f.child, "kill");
  f.inspect.mockImplementation(async (kind, id) =>
    kind === "process" ? null : original(kind, id),
  );
  await expect(
    f.transport.openProxy("kzpwm0j18eg04nv3", r),
  ).rejects.toMatchObject({ safeCode: "production75_live_process" });
  expect(kill).toHaveBeenCalledTimes(1);
  expect(f.transport.metadata()).toMatchObject({
    proxies: 1,
    proxiesClosed: 1,
  });
  await r.drain();
});
test("changed auth store around identity verification is refused", async () => {
  let reads = 0;
  const f = fixture(),
    transport = createLiveTransport({
      runFile: f.runFile,
      spawnChild: () => f.child,
      inspect: f.inspect,
      Client: f.Client,
      readCredentialConfig: async () =>
        reads++ ? config.replaceAll("A", "C") : config,
    });
  await expect(transport.authorization("legacy")).rejects.toThrow(
    "production75_live_auth_changed",
  );
});
test("failed writer cannot kill independent Reader reconciliation", async () => {
  const f = fixture(),
    r = createOperatorResources({ until: Date.now() + 10000 });
  await f.transport.verifyIdentity();
  const p = await f.transport.openProxy("abcdefghijklmnop", r),
    writer = await f.transport.connect(
      p,
      "fly-db",
      { user: "fly-user", password: "fixture" },
      { readonly: false, resources: r },
    ),
    reader = await f.transport.connect(
      p,
      "fly-db",
      { user: "growthos-reader-abcdef01234546789abcdef012345678", password: "fixture" },
      { readonly: true, resources: r },
    );
  writer.emit("error", new Error("synthetic connection loss"));
  await expect(writer.query("COMMIT")).rejects.toThrow(
    "production75_live_client",
  );
  expect(await reader.query("SELECT 1")).toEqual({ rows: [] });
  expect(await r.drain()).toEqual({ closed: true });
});
test("failed readiness discovers and closes its private agent", async () => {
  const f = fixture(),
    r = createOperatorResources({ until: Date.now() + 10000 });
  await f.transport.verifyIdentity();
  let agentAlive = true,
    spawned = false;
  const original = f.inspect.getMockImplementation();
  f.inspect.mockImplementation(async (kind, id) => {
    if (kind === "children")
      return spawned && agentAlive
        ? [{ pid: 42, parent: 123, created: "agent", executable: "fly" }]
        : [];
    if (kind === "terminate") {
      agentAlive = false;
      return true;
    }
    if (kind === "process" && id === 42)
      return agentAlive
        ? { pid: 42, parent: 123, created: "agent", executable: "fly" }
        : null;
    if (kind === "listener") {
      const rows = await original(kind, id);
      if (rows.length) {
        spawned = true;
        return [{ pid: 999, address: "127.0.0.1" }];
      }
      return [];
    }
    return original(kind, id);
  });
  await expect(f.transport.openProxy("kzpwm0j18eg04nv3", r)).rejects.toThrow(
    "production75_live_listener",
  );
  expect(agentAlive).toBe(false);
  expect(f.transport.metadata()).toMatchObject({
    ownedAgents: 1,
    agentsClosed: 1,
  });
  expect(await r.drain()).toEqual({ closed: true });
});
