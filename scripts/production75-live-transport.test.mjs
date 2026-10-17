import { test, expect, vi } from "vitest";
import { createLiveTransportFixture } from "./test-support/live-transport-fixture.mjs";
import {
  production75Diagnostic,
  withProduction75Stage,
} from "./production75-safe-diagnostics.mjs";
import { createOperatorResources } from "./production75-operator.mjs";
import { guardCombinedSchedulingWriter } from "./production75-live-runner.mjs";
import {
  createLiveTransport,
  liveEnvironment,
  normalizeLiveAuthorization,
} from "./production75-live-transport.mjs";
const credential = "fm1r_" + "A".repeat(40),
  config = `access_token: ${credential},${"B".repeat(40)}\n`;
const fixture = createLiveTransportFixture;

test("late idle errors stay bound to their originating client and sealed stage", async () => {
  const f = fixture(),
    resources = createOperatorResources({ until: Date.now() + 10000 });
  try {
    await f.transport.verifyIdentity();
    const proxy = await f.transport.openProxy("abcdefghijklmnop", resources);
    const connect = () =>
      f.transport.connect(
        proxy,
        "fly-db",
        { user: "fly-user", password: "fixture" },
        { readonly: true, resources },
      );
    const first = await connect(),
      second = await connect();
    first.emit("error", { code: "25P03" });
    second.emit("error", { code: "08006" });
    let a, b;
    try {
      await withProduction75Stage("legacy-reader-state", () =>
        first.query("SELECT 1"),
      );
    } catch (error) {
      a = error;
    }
    try {
      await withProduction75Stage("scheduling-reader-state", () =>
        second.query("SELECT 1"),
      );
    } catch (error) {
      b = error;
    }
    const snapshot = production75Diagnostic(a);
    first.emit("error", { code: "23514" });
    try {
      await withProduction75Stage("scheduling-context", () =>
        first.query("SELECT 1"),
      );
    } catch {}
    expect(production75Diagnostic(a)).toEqual(snapshot);
    expect(snapshot).toEqual({
      stage: "legacy-reader-state",
      safeCode: "production75_live_client",
      sqlState: "25P03",
    });
    expect(production75Diagnostic(b)).toEqual({
      stage: "scheduling-reader-state",
      safeCode: "production75_live_client",
      sqlState: "08006",
    });
  } finally {
    expect(await resources.drain()).toEqual({ closed: true });
  }
});

test("connect failure survives a later closure failure without certifying cleanup", async () => {
  const f = fixture(),
    resources = createOperatorResources({ until: Date.now() + 10000 });
  let socket;
  f.Client.prototype.connect = async function () {
    socket = this.connection.stream;
    socket.destroy = () => {
      socket.destroyed = true;
      throw Error("synthetic close failure");
    };
    throw Object.assign(Error("synthetic primary connect failure"), {
      code: "08006",
    });
  };
  f.Client.prototype.end = async function () {};
  await f.transport.verifyIdentity();
  const proxy = await f.transport.openProxy("abcdefghijklmnop", resources);
  let failure;
  try {
    await f.transport.connect(
      proxy,
      "fly-db",
      { user: "fly-user", password: "fixture" },
      { readonly: true, resources },
    );
  } catch (error) {
    failure = error;
  }
  expect(production75Diagnostic(failure)).toEqual({
    stage: "transport-connect",
    safeCode: "production75_live_client",
    sqlState: "08006",
    secondary: {
      stage: "transport-close",
      safeCode: "production75_diagnostic_unknown",
    },
  });
  expect(socket.destroyed).toBe(true);
  expect(f.transport.metadata().clientsClosed).toBe(0);
  await resources.drain();
  await expect(f.transport.close()).rejects.toThrow("synthetic close failure");
  expect(JSON.stringify(production75Diagnostic(failure))).not.toContain(
    "synthetic",
  );
});

test.each([false, true])(
  "idle SQLSTATE stays diagnostic-only with scheduling opt-in %s",
  async (settledServerErrors) => {
    const f = fixture(),
      resources = createOperatorResources({ until: Date.now() + 10000 });
    await f.transport.verifyIdentity();
    const proxy = await f.transport.openProxy("abcdefghijklmnop", resources);
    const client = await f.transport.connect(
      proxy,
      "fly-db",
      { user: "fly-user", password: "fixture" },
      { readonly: true, settledServerErrors, resources },
    );
    client.emit(
      "error",
      Object.assign(Error("synthetic private row and credential"), {
        code: "25P03",
        severity: "FATAL",
        detail: "synthetic private detail",
      }),
    );
    let failure;
    try {
      await withProduction75Stage("legacy-context", () =>
        withProduction75Stage("legacy-reader-state", () =>
          client.query("SELECT 1"),
        ),
      );
    } catch (error) {
      failure = error;
    }
    expect(production75Diagnostic(failure)).toEqual({
      stage: "legacy-reader-state",
      safeCode: "production75_live_client",
      sqlState: "25P03",
    });
    expect(failure.code).toBeUndefined();
    expect(failure.severity).toBeUndefined();
    expect(client.connection.stream.destroyed).toBe(true);
    expect(JSON.stringify(production75Diagnostic(failure))).not.toContain(
      "private",
    );
    expect(await resources.drain()).toEqual({ closed: true });
    expect(f.transport.metadata()).toMatchObject({
      clients: 1,
      clientsClosed: 1,
      socketsClosed: 1,
    });
  },
);

test.each(["23514", "08006"])(
  "query SQLSTATE %s is retained without turning uncertain failure into settled rejection",
  async (code) => {
    const f = fixture({
      queryFn: async () => {
        throw Object.assign(Error("synthetic private data"), {
          code,
          severity: "FATAL",
        });
      },
    });
    const resources = createOperatorResources({ until: Date.now() + 10000 });
    try {
      await f.transport.verifyIdentity();
      const proxy = await f.transport.openProxy("abcdefghijklmnop", resources);
      const client = await f.transport.connect(
        proxy,
        "fly-db",
        { user: "fly-user", password: "fixture" },
        { readonly: false, settledServerErrors: true, resources },
      );
      let failure;
      try {
        await withProduction75Stage("scheduling-reader-state", () =>
          client.query("SELECT 1"),
        );
      } catch (error) {
        failure = error;
      }
      expect(production75Diagnostic(failure)).toEqual({
        stage: "scheduling-reader-state",
        safeCode: "production75_live_query",
        sqlState: code,
      });
      expect(failure.code).toBeUndefined();
      expect(failure.severity).toBeUndefined();
    } finally {
      expect(await resources.drain()).toEqual({ closed: true });
    }
  },
);
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
test.each([true, false])(
  "settled server classification is scheduling-only opt-in: %s",
  async (enabled) => {
    const calls = [],
      f = fixture({
        queryFn: async (sql) => {
          calls.push(sql);
          if (sql === "ROLLBACK") return { command: "ROLLBACK" };
          throw Object.assign(new Error("private row and credential"), {
            code: "23514",
            severity: "ERROR",
            constraint: "private_constraint",
            detail: "private data",
          });
        },
      }),
      r = createOperatorResources({ until: Date.now() + 10000 });
    try {
      await f.transport.verifyIdentity();
      const p = await f.transport.openProxy("abcdefghijklmnop", r);
      const client = await f.transport.connect(
        p,
        "fly-db",
        { user: "fly-user", password: "fixture" },
        { readonly: false, resources: r, settledServerErrors: enabled },
      );
      const writer = guardCombinedSchedulingWriter({
        writer: client,
        resources: r,
        verifyProtected: async () => {},
      });
      let observed;
      try {
        await writer.query("ALTER TABLE fixture");
      } catch (e) {
        observed = e;
      }
      expect(observed.message).toBe("production75_live_query");
      expect(observed.code).toBe(enabled ? "23514" : undefined);
      expect(observed.severity).toBe(enabled ? "ERROR" : undefined);
      expect(observed.detail).toBeUndefined();
      expect(observed.constraint).toBeUndefined();
      expect(observed.cause).toBeUndefined();
      expect(JSON.stringify(observed)).not.toContain("private");
      if (enabled)
        expect(await writer.query("ROLLBACK")).toEqual({ command: "ROLLBACK" });
      expect(calls).toEqual(
        enabled ? ["ALTER TABLE fixture", "ROLLBACK"] : ["ALTER TABLE fixture"],
      );
    } finally {
      expect(await r.drain()).toEqual({ closed: true });
    }
  },
);
test.each([
  ["08006", "ERROR"],
  ["57P01", "ERROR"],
  ["23514", "FATAL"],
  ["23514", "PANIC"],
  ["23514", undefined],
  ["private", "ERROR"],
])(
  "uncertain server error %s/%s remains generic with scheduling opt-in",
  async (code, severity) => {
    const f = fixture({
        queryFn: async () => {
          throw Object.assign(new Error("private"), { code, severity });
        },
      }),
      r = createOperatorResources({ until: Date.now() + 10000 });
    try {
      await f.transport.verifyIdentity();
      const p = await f.transport.openProxy("abcdefghijklmnop", r);
      const client = await f.transport.connect(
        p,
        "fly-db",
        { user: "fly-user", password: "fixture" },
        { readonly: false, resources: r, settledServerErrors: true },
      );
      await expect(client.query("ALTER TABLE fixture")).rejects.toMatchObject({
        safeCode: "production75_live_query",
      });
      try {
        await client.query("ALTER TABLE fixture");
      } catch (e) {
        expect(e.code).toBeUndefined();
        expect(e.severity).toBeUndefined();
      }
    } finally {
      expect(await r.drain()).toEqual({ closed: true });
    }
  },
);
test.each(["accessor", "proxy", "closed-socket", "aborted-resources"])(
  "settled classification refuses %s without evaluating error hooks",
  async (kind) => {
    let hooks = 0,
      client;
    const r = createOperatorResources({ until: Date.now() + 10000 });
    const f = fixture({
      queryFn: async () => {
        const error = Object.assign(new Error("private"), {
          code: "23514",
          severity: "ERROR",
        });
        if (kind === "accessor")
          Object.defineProperty(error, "code", {
            get() {
              hooks++;
              return "23514";
            },
          });
        if (kind === "closed-socket") client.connection.stream.destroy();
        if (kind === "aborted-resources") r.abort();
        throw kind === "proxy"
          ? new Proxy(error, {
              getOwnPropertyDescriptor() {
                hooks++;
                throw Error("private");
              },
            })
          : error;
      },
    });
    try {
      await f.transport.verifyIdentity();
      const p = await f.transport.openProxy("abcdefghijklmnop", r);
      client = await f.transport.connect(
        p,
        "fly-db",
        { user: "fly-user", password: "fixture" },
        { readonly: false, resources: r, settledServerErrors: true },
      );
      let observed;
      try {
        await client.query("ALTER TABLE fixture");
      } catch (e) {
        observed = e;
      }
      expect(observed.code).toBeUndefined();
      expect(observed.severity).toBeUndefined();
      expect(observed.message).not.toContain("private");
      expect(hooks).toBe(0);
    } finally {
      expect(await r.drain()).toEqual({ closed: true });
    }
  },
);
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
      {
        user: "growthos-reader-abcdef01234546789abcdef012345678",
        password: "fixture",
      },
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
