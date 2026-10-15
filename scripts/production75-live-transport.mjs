/** Explicit private live dependencies. No import-time credential or network I/O. */
import { createHash, randomInt } from "node:crypto";
import { readFileSync, lstatSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { promisify, types } from "node:util";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
const FLY = "C:/Forge/tools/flyctl/0.4.115/flyctl.exe",
  BINARY_SHA =
    "498db0f2211bc43ac8c86fc1d62009b660417536b874dc74ed67edf58dd76be9";
const SOURCE = "kzpwm0j18eg04nv3",
  ACCOUNT = "diazdestination@gmail.com",
  ORG = "adam-diaz";
const errors = new WeakMap(),
  proxyOwners = new WeakMap();
const fail = (code) => {
  const e = Object.assign(new Error(code), { safeCode: code });
  errors.set(e, code);
  return e;
};
const check = (v, code) => {
  if (!v) throw fail(code);
};
const sha = (v) => createHash("sha256").update(v).digest("hex");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export function liveEnvironment(input = process.env) {
  const allowed =
    /^(SystemRoot|WINDIR|PATH|PATHEXT|TEMP|TMP|USERPROFILE|HOME|LOCALAPPDATA|APPDATA|COMSPEC|PROGRAMDATA)$/i;
  return {
    ...Object.fromEntries(
      Object.entries(input).filter(([k]) => allowed.test(k)),
    ),
    NO_COLOR: "1",
    FLY_NO_UPDATE_CHECK: "1",
    FLY_AGENT_ISOLATED: "1",
    FLY_WIREGUARD_TOKEN_MODE: "1",
  };
}
export function normalizeLiveAuthorization(text, kind) {
  check(
    typeof text === "string" &&
      Buffer.byteLength(text) <= 1000000 &&
      ["legacy", "machines"].includes(kind),
    "production75_live_auth_shape",
  );
  const matches = [...text.matchAll(/^access_token: ([^\r\n]+)$/gm)];
  check(matches.length === 1, "production75_live_auth_shape");
  const tokens = matches[0][1]
    .trim()
    .replace(/^(FlyV1|Bearer) /, "")
    .split(",")
    .map((v) => v.trim());
  check(
    tokens.length > 0 &&
      tokens.length <= 100 &&
      tokens.every((v) => /^[A-Za-z0-9_+\/=.-]{20,5000}$/.test(v)),
    "production75_live_auth_shape",
  );
  const mac = tokens.filter((v) => /^(fm1r|fm1a|fm2)_/.test(v));
  return kind === "machines" && mac.length
    ? `FlyV1 ${mac.join(",")}`
    : `Bearer ${[...mac, ...tokens.filter((v) => !mac.includes(v))].join(",")}`;
}
async function bounded(fn, ms, now = Date.now) {
  let timer;
  const until = now() + ms;
  try {
    const value = await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(fail("production75_live_deadline")),
          ms,
        );
      }),
    ]);
    check(now() < until, "production75_live_deadline");
    return value;
  } finally {
    clearTimeout(timer);
  }
}
export function createLiveTransport({
  runFile,
  spawnChild,
  readCredentialConfig,
  inspect,
  Client,
  choosePort = () => randomInt(20000, 55000),
  pause = wait,
  now = Date.now,
  fetchFn,
} = {}) {
  check(
    [
      runFile,
      spawnChild,
      readCredentialConfig,
      inspect,
      Client,
      choosePort,
      pause,
      now,
    ].every((v) => typeof v === "function"),
    "production75_live_input",
  );
  const counts = {
    clients: 0,
    clientsClosed: 0,
    socketsClosed: 0,
    proxies: 0,
    proxiesClosed: 0,
    ownedAgents: 0,
    agentsClosed: 0,
  };
  let verified = false,
    credentialFingerprint = null,
    closed = false,
    sourceCredential = null;
  const closers = new Set();
  const safe = async (fn, code, ms = 30000) => {
    try {
      return await bounded(fn, ms, now);
    } catch (e) {
      throw fail(errors.get(e) ?? code);
    }
  };
  async function verifyIdentity() {
    check(!closed, "production75_live_closed");
    const identity = (
      await safe(() => runFile(["auth", "whoami"]), "production75_live_cli")
    ).trim();
    check(identity === ACCOUNT, "production75_live_identity");
    verified = true;
    return Object.freeze({ account: ACCOUNT, organization: ORG });
  }
  async function authorization(kind) {
    check(!closed, "production75_live_closed");
    const text = await safe(
      readCredentialConfig,
      "production75_live_auth_shape",
    );
    await verifyIdentity();
    const after = await safe(
      readCredentialConfig,
      "production75_live_auth_shape",
    );
    check(sha(text) === sha(after), "production75_live_auth_changed");
    credentialFingerprint = sha(after);
    return normalizeLiveAuthorization(after, kind);
  }
  async function readonlyJson(path, kind = "legacy") {
    const sourcePath = `/api/v1/postgres/${SOURCE}/users/fly-user/credentials`,
      machine =
        /^\/v1\/apps\/(mogulforge-growthos|mogulforge-growthos-staging)\/machines$/;
    check(
      (kind === "legacy" &&
        [sourcePath, `/api/v1/postgres/${SOURCE}/backups`].includes(path)) ||
        (kind === "machines" && machine.test(path)),
      "production75_live_read_scope",
    );
    check(typeof fetchFn === "function", "production75_live_input");
    const auth = await authorization(kind),
      url =
        (kind === "legacy"
          ? "https://api.fly.io"
          : "https://api.machines.dev") + path,
      controller = new AbortController();
    let response, reader;
    try {
      return await safe(
        async () => {
          response = await fetchFn(url, {
            method: "GET",
            headers: { Authorization: auth },
            redirect: "error",
            signal: controller.signal,
          });
          check(
            response.status === 200 &&
              response.redirected === false &&
              (!response.url || response.url === url),
            "production75_live_http",
          );
          const chunks = [];
          let size = 0;
          if (response.body) {
            reader = response.body.getReader();
            for (;;) {
              const item = await reader.read();
              if (item.done) break;
              size += item.value.byteLength;
              check(size <= 4000000, "production75_live_http_bound");
              chunks.push(Buffer.from(item.value));
            }
          }
          return JSON.parse(Buffer.concat(chunks).toString("utf8"));
        },
        "production75_live_http",
        15000,
      );
    } finally {
      controller.abort();
      try {
        void reader?.cancel()?.catch(() => {});
      } catch {}
    }
  }
  async function withSourceCredentials(consumer) {
    check(typeof consumer === "function", "production75_live_input");
    if (!sourceCredential) {
      const raw = (
        await readonlyJson(
          `/api/v1/postgres/${SOURCE}/users/fly-user/credentials`,
        )
      ).data;
      check(
        raw?.user === "fly-user" &&
          typeof raw.password === "string" &&
          raw.password.length > 0 &&
          Buffer.byteLength(raw.password) <= 8192 &&
          !raw.password.includes("\0"),
        "production75_live_credential",
      );
      sourceCredential = Object.freeze({
        user: raw.user,
        password: raw.password,
      });
    }
    return consumer(sourceCredential);
  }
  async function sourceBackups() {
    const raw = (await readonlyJson(`/api/v1/postgres/${SOURCE}/backups`)).data;
    check(Array.isArray(raw) && raw.length <= 1000, "production75_live_backup");
    return Object.freeze(
      raw.map((b) => {
        check(
          b &&
            /^[a-zA-Z0-9_.-]{1,128}$/.test(b.id ?? "") &&
            ["full", "diff", "incr"].includes(b.type) &&
            ["completed", "pending", "running", "failed"].includes(b.status) &&
            Number.isFinite(Date.parse(b.start)) &&
            (b.stop === null || Number.isFinite(Date.parse(b.stop))),
          "production75_live_backup",
        );
        return Object.freeze({
          id: b.id,
          type: b.type,
          status: b.status,
          start: b.start,
          stop: b.stop,
        });
      }),
    );
  }
  async function protectedApps() {
    const values = {};
    for (const app of ["mogulforge-growthos", "mogulforge-growthos-staging"]) {
      const list = await readonlyJson(`/v1/apps/${app}/machines`, "machines");
      check(
        Array.isArray(list) &&
          list.length === 1 &&
          list[0]?.state === "stopped",
        "production75_live_protected",
      );
      const m = list[0];
      check(
        m.id ===
          (app === "mogulforge-growthos" ? "d8de506c72d608" : "8d96936a03d058"),
        "production75_live_protected",
      );
      const secrets = JSON.parse(
        await safe(
          () => runFile(["secrets", "list", "-a", app, "--json"]),
          "production75_live_cli",
        ),
      );
      values[app] = {
        id: m.id,
        state: m.state,
        region: m.region,
        configSha256: sha(JSON.stringify(m.config)),
        secretMetadataSha256: sha(JSON.stringify(secrets)),
      };
    }
    return Object.freeze(values);
  }
  async function openProxy(cluster, resources) {
    check(
      !closed &&
        verified &&
        /^[a-z0-9]{16}$/.test(cluster) &&
        resources?.acquire,
      "production75_live_proxy",
    );
    const port = choosePort();
    check(
      Number.isInteger(port) && port >= 1024 && port <= 65535,
      "production75_live_proxy",
    );
    check(
      (
        await safe(
          () => inspect("listener", port),
          "production75_live_listener",
        )
      ).length === 0,
      "production75_live_listener",
    );
    return resources.acquire(
      async () => {
        resources.assertActive();
        const child = spawnChild([
          "mpg",
          "proxy",
          cluster,
          "--bind-addr",
          "127.0.0.1",
          "--local-port",
          String(port),
        ]);
        check(
          Number.isInteger(child.pid) && child.pid > 0,
          "production75_live_proxy",
        );
        counts.proxies++;
        let exited = false,
          exitedAt = null,
          closing = null;
        const agents = [];
        child.stdout?.resume();
        child.stderr?.resume();
        child.on("error", () => {
          exited = true;
        });
        child.on("close", () => {
          exited = true;
          exitedAt = now();
        });
        let initial;
        try {
          initial = await safe(
            () => inspect("process", child.pid),
            "production75_live_process",
          );
          check(initial?.pid === child.pid, "production75_live_process");
        } catch (e) {
          if (!exited) child.kill();
          await bounded(
            async () => {
              while (!exited || (await inspect("children", child.pid)).length)
                await pause(50);
            },
            5000,
            now,
          );
          check(
            (await inspect("listener", port)).length === 0,
            "production75_live_proxy_cleanup",
          );
          counts.proxiesClosed++;
          throw fail(errors.get(e) ?? "production75_live_process");
        }
        const discover = async () => {
          const list = await safe(
            () => inspect("children", child.pid),
            "production75_live_process",
            5000,
          );
          for (const agent of list) {
            check(
              Number.isInteger(agent.pid) &&
                agent.pid > 0 &&
                agent.pid !== child.pid &&
                agent.parent === child.pid &&
                agent.executable === initial.executable &&
                typeof agent.created === "string" &&
                agent.created.length > 0,
              "production75_live_process",
            );
            const known = agents.find((a) => a.pid === agent.pid);
            check(
              !known || known.created === agent.created,
              "production75_live_process",
            );
            if (!known) {
              if (exited)
                check(
                  exitedAt !== null &&
                    Number.isFinite(Date.parse(agent.created)) &&
                    Date.parse(agent.created) <= exitedAt,
                  "production75_live_process",
                );
              if (Number.isFinite(Date.parse(initial.created)))
                check(
                  Date.parse(agent.created) >= Date.parse(initial.created),
                  "production75_live_process",
                );
              agents.push(agent);
              counts.ownedAgents++;
            }
          }
        };
        const close = () =>
          (closing ??= (async () => {
            try {
              await discover();
              if (!exited) {
                const p = await safe(
                  () => inspect("process", child.pid),
                  "production75_live_process",
                  5000,
                );
                check(
                  p &&
                    p.created === initial.created &&
                    p.executable === initial.executable,
                  "production75_live_process",
                );
                child.kill();
              }
              await bounded(
                async () => {
                  while (!exited) await pause(50);
                },
                5000,
                now,
              );
              await discover();
              check(
                (await safe(
                  () => inspect("process", child.pid),
                  "production75_live_proxy_cleanup",
                  5000,
                )) === null,
                "production75_live_proxy_cleanup",
              );
              for (const agent of agents) {
                const live = await safe(
                  () => inspect("process", agent.pid),
                  "production75_live_process",
                  5000,
                );
                if (live) {
                  check(
                    live.created === agent.created &&
                      live.executable === agent.executable,
                    "production75_live_process",
                  );
                  await safe(
                    () => inspect("terminate", agent),
                    "production75_live_agent_cleanup",
                    5000,
                  );
                }
                check(
                  (await safe(
                    () => inspect("process", agent.pid),
                    "production75_live_agent_cleanup",
                    5000,
                  )) === null,
                  "production75_live_agent_cleanup",
                );
                counts.agentsClosed++;
              }
              check(
                (
                  await safe(
                    () => inspect("children", child.pid),
                    "production75_live_agent_cleanup",
                    5000,
                  )
                ).length === 0,
                "production75_live_agent_cleanup",
              );
              check(
                (
                  await safe(
                    () => inspect("listener", port),
                    "production75_live_proxy_cleanup",
                    5000,
                  )
                ).length === 0,
                "production75_live_proxy_cleanup",
              );
              counts.proxiesClosed++;
            } finally {
              closers.delete(close);
            }
          })());
        closers.add(close);
        try {
          await discover();
          await bounded(
            async () => {
              while (!exited) {
                await discover();
                resources.assertActive();
                const listeners = await inspect("listener", port);
                if (listeners.length) {
                  check(
                    listeners.length === 1 &&
                      listeners[0].pid === child.pid &&
                      listeners[0].address === "127.0.0.1",
                    "production75_live_listener",
                  );
                  await discover();
                  const proxy = Object.freeze({
                    cluster,
                    port,
                    pid: child.pid,
                    privateWireGuard: true,
                  });
                  proxyOwners.set(proxy, {
                    close,
                    child,
                    exited: () => exited,
                    port,
                    owner: counts,
                  });
                  return proxy;
                }
                await pause(250);
              }
              throw fail("production75_live_proxy");
            },
            45000,
            now,
          );
          const proxy = Object.freeze({
            cluster,
            port,
            pid: child.pid,
            privateWireGuard: true,
          });
          proxyOwners.set(proxy, {
            close,
            child,
            exited: () => exited,
            port,
            owner: counts,
          });
          return proxy;
        } catch (e) {
          await close();
          throw fail(errors.get(e) ?? "production75_live_proxy");
        }
      },
      (proxy) => proxyOwners.get(proxy).close(),
    );
  }
  async function connect(
    proxy,
    database,
    credentials,
    { readonly, resources, settledServerErrors = false } = {},
  ) {
    const owned = proxyOwners.get(proxy);
    check(
      !closed &&
        owned?.owner === counts &&
        !owned.exited() &&
        ["fly-db", "growthos_staging", "mogulforge-growthos-db"].includes(
          database,
        ) &&
        typeof readonly === "boolean" &&
        typeof settledServerErrors === "boolean" &&
        resources?.acquire &&
        credentials &&
        /^[a-z_][a-z0-9_-]{0,62}$/.test(credentials.user) &&
        typeof credentials.password === "string" &&
        credentials.password.length > 0,
      "production75_live_client",
    );
    check(
      readonly ||
        !["kzpwm0j18eg04nv3", "zp2wjrejd2zodn4q"].includes(proxy.cluster),
      "production75_live_original_write",
    );
    return resources.acquire(
      async () => {
        resources.assertActive();
        const listeners = await inspect("listener", proxy.port);
        resources.assertActive();
        check(
          listeners.length === 1 &&
            listeners[0].pid === proxy.pid &&
            listeners[0].address === "127.0.0.1",
          "production75_live_listener",
        );
        const client = new Client({
          host: "127.0.0.1",
          port: proxy.port,
          database,
          user: credentials.user,
          password: credentials.password,
          ssl: false,
          connectionTimeoutMillis: 10000,
          query_timeout: 15000,
          statement_timeout: 12000,
          lock_timeout: 2000,
          idle_in_transaction_session_timeout: 20000,
          options: `-c TimeZone=UTC -c search_path=pg_catalog,public${readonly ? " -c default_transaction_read_only=on" : ""}`,
        });
        counts.clients++;
        let ending = null,
          failed = false;
        const end = () =>
          (ending ??= (async () => {
            try {
              await bounded(() => client.end(), 1000, now);
            } catch {
            } finally {
              client.connection?.stream?.destroy();
              check(
                client.connection?.stream?.destroyed === true,
                "production75_live_socket",
              );
              counts.clientsClosed++;
              counts.socketsClosed++;
              closers.delete(end);
            }
          })());
        closers.add(end);
        client.on("error", () => {
          failed = true;
          client.connection?.stream?.destroy();
        });
        const query = client.query.bind(client);
        client.query = async (...args) => {
          check(!failed, "production75_live_client");
          resources.assertActive();
          try {
            const value = await query(...args);
            resources.assertActive();
            return value;
          } catch (e) {
            const sanitized = fail(errors.get(e) ?? "production75_live_query");
            // Only the new scheduling writer opts into settled ERROR metadata.
            // Raw messages, row/constraint details and causes never cross here.
            if (
              settledServerErrors &&
              !failed &&
              client.connection?.stream?.destroyed === false &&
              e &&
              typeof e === "object" &&
              !types.isProxy(e)
            ) {
              const code = Object.getOwnPropertyDescriptor(e, "code")?.value;
              const severity = Object.getOwnPropertyDescriptor(
                e,
                "severity",
              )?.value;
              if (
                typeof code === "string" &&
                /^[0-9A-Z]{5}$/.test(code) &&
                !/^(00|01|02|08)/.test(code) &&
                !["57P01", "57P02", "57P03"].includes(code) &&
                severity === "ERROR"
              ) {
                resources.assertActive();
                Object.assign(sanitized, { code, severity });
              }
            }
            throw sanitized;
          }
        };
        client.__driverClose = end;
        try {
          await bounded(
            () => client.connect(),
            Math.max(1, Math.min(10000, resources.deadline - now())),
            now,
          );
          resources.assertActive();
          return client;
        } catch (e) {
          await end();
          throw fail(errors.get(e) ?? "production75_live_client");
        }
      },
      (client) => {
        client.connection?.stream?.destroy();
        return client.__driverClose();
      },
    );
  }
  return Object.freeze({
    verifyIdentity,
    authorization,
    withSourceCredentials,
    sourceBackups,
    protectedApps,
    openProxy,
    connect,
    async close() {
      closed = true;
      sourceCredential = null;
      await Promise.all([...closers].map((fn) => fn()));
      return {
        closed:
          counts.clients === counts.clientsClosed &&
          counts.clients === counts.socketsClosed &&
          counts.proxies === counts.proxiesClosed &&
          counts.ownedAgents === counts.agentsClosed,
      };
    },
    async closeResources() {
      await Promise.all([...closers].map((fn) => fn()));
      return {
        closed:
          counts.clients === counts.clientsClosed &&
          counts.proxies === counts.proxiesClosed,
      };
    },
    metadata() {
      return Object.freeze({
        ...counts,
        sourceCredentialsLoaded: sourceCredential !== null,
        privateWireGuard: true,
        sqlTls: false,
        credentialValuesRecorded: false,
      });
    },
  });
}
export function createNativeLiveTransport() {
  check(
    process.platform === "win32" && sha(readFileSync(FLY)) === BINARY_SHA,
    "production75_live_binary",
  );
  const require = createRequire(
      resolve(
        fileURLToPath(new URL("..", import.meta.url)),
        "artifacts/api-server/package.json",
      ),
    ),
    run = promisify(execFile),
    env = liveEnvironment(),
    execute = async (args) =>
      (
        await run(FLY, args, {
          env,
          windowsHide: true,
          timeout: 30000,
          maxBuffer: 4000000,
          encoding: "utf8",
        })
      ).stdout;
  const shell = async (code) =>
    (
      await run("powershell.exe", ["-NoProfile", "-Command", code], {
        env,
        windowsHide: true,
        timeout: 10000,
        maxBuffer: 2000000,
        encoding: "utf8",
      })
    ).stdout;
  const inspect = async (kind, value) => {
    let code;
    if (kind === "listener") {
      check(Number.isInteger(value), "production75_live_process");
      code = `$rows=@(Get-NetTCPConnection -LocalPort ${value} -State Listen -ErrorAction SilentlyContinue|ForEach-Object {@{pid=[int]$_.OwningProcess;address=$_.LocalAddress}}); ConvertTo-Json -InputObject $rows -Compress`;
    } else if (kind === "process" || kind === "children") {
      check(Number.isInteger(value) && value > 0, "production75_live_process");
      const filter =
        kind === "process"
          ? `ProcessId = ${value}`
          : `ParentProcessId = ${value}`;
      code = `$rows=@(Get-CimInstance Win32_Process -Filter '${filter}' | Where-Object {$_.Name -eq 'flyctl.exe'} | ForEach-Object {@{pid=[int]$_.ProcessId;parent=[int]$_.ParentProcessId;created=$_.CreationDate.ToUniversalTime().ToString('o');executable=$_.ExecutablePath}}); ConvertTo-Json -InputObject $rows -Compress`;
    } else {
      check(
        kind === "terminate" && Number.isInteger(value.pid),
        "production75_live_process",
      );
      const current = await inspect("process", value.pid);
      check(
        current &&
          current.created === value.created &&
          current.executable === value.executable,
        "production75_live_process",
      );
      await shell(`Stop-Process -Id ${value.pid} -ErrorAction Stop`);
      return true;
    }
    const rows = JSON.parse((await shell(code)).trim() || "[]");
    return kind === "process" ? (rows[0] ?? null) : rows;
  };
  return createLiveTransport({
    runFile: execute,
    spawnChild: (args) =>
      spawn(FLY, args, {
        env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    readCredentialConfig: async () => {
      const file = "C:/Users/diazd/.fly/config.yml",
        stat = lstatSync(file);
      check(
        stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1000000,
        "production75_live_auth_shape",
      );
      return readFileSync(file, "utf8");
    },
    inspect,
    Client: require("pg").Client,
    fetchFn: globalThis.fetch,
  });
}
