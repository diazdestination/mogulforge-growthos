import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer, connect as connectSocket } from "node:net";

const requireFromApi = createRequire(
  new URL("../artifacts/api-server/package.json", import.meta.url),
);

async function unusedLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function listening(port) {
  return new Promise((resolve) => {
    const socket = connectSocket({ host: "127.0.0.1", port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(300, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** Own the exact Fly proxy process. Arbitrary localhost URL overrides are not accepted. */
export async function startRestoreProxy(
  clusterId,
  {
    spawnProcess = spawn,
    selectPort = unusedLoopbackPort,
    probe = listening,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  if (!/^[a-z0-9]+$/.test(clusterId) || clusterId === "kzpwm0j18eg04nv3")
    throw new Error("restore_proxy_cluster_forbidden");
  const port = await selectPort();
  const child = spawnProcess(
    "fly",
    [
      "mpg",
      "proxy",
      clusterId,
      "--bind-addr",
      "127.0.0.1",
      "--local-port",
      String(port),
    ],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  // Never forward CLI output: a future CLI failure could include account detail.
  let failed = false;
  let closed = false;
  child.stdout?.resume();
  child.stderr?.resume();
  child.once("error", () => {
    failed = true;
  });
  child.once("exit", () => {
    failed = true;
    closed = true;
  });
  const onExit = () => {
    if (!closed) child.kill();
  };
  process.once("exit", onExit);
  const close = async () => {
    process.removeListener("exit", onExit);
    if (!closed) child.kill();
  };
  try {
    for (let attempt = 0; attempt < 120; attempt++) {
      if (failed) throw new Error("restore_proxy_start_failed");
      if (await probe(port)) {
        // A bind error from Fly must be observed before trusting a listener.
        await sleep(150);
        if (failed) throw new Error("restore_proxy_start_failed");
        return { host: "127.0.0.1", port, close };
      }
      await sleep(250);
    }
    throw new Error("restore_proxy_start_timeout");
  } catch (error) {
    await close();
    throw error;
  }
}

/** Caller must first validate the canonical URL with parseRestoreDrillTarget. */
export async function restoreClient(
  env,
  target,
  { createClient, startProxy = startRestoreProxy } = {},
) {
  if (createClient)
    return {
      client: createClient(env.RESTORE_DRILL_DATABASE_URL),
      close: async () => {},
    };
  const { Client } = requireFromApi("pg");
  if (
    env.RESTORE_DRILL_USE_FLY_PROXY &&
    env.RESTORE_DRILL_USE_FLY_PROXY !== "true"
  )
    throw new Error("restore_proxy_setting_invalid");
  if (env.RESTORE_DRILL_USE_FLY_PROXY !== "true")
    return {
      client: new Client({
        connectionString: env.RESTORE_DRILL_DATABASE_URL,
        connectionTimeoutMillis: 10000,
      }),
      close: async () => {},
    };
  const proxy = await startProxy(target.clusterId);
  try {
    const url = new URL(env.RESTORE_DRILL_DATABASE_URL);
    // Parse credentials from the validated canonical URL, then explicitly choose
    // the owned transport. URL query options cannot override host/user/database.
    const client = new Client({
      host: proxy.host,
      port: proxy.port,
      user: target.login,
      password: decodeURIComponent(url.password),
      database: target.database,
      ssl: false, // Fly's authenticated tunnel carries the private connection.
      connectionTimeoutMillis: 10000,
    });
    return { client, close: proxy.close };
  } catch (error) {
    await proxy.close();
    throw error;
  }
}
