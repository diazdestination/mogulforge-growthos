// Instance-owned local manifest for the disposable demo runtime.
//
// Each runtime instance gets its own manifest file bound to its port and a
// random instance ID. The file is created exclusively (never overwrites an
// existing file), and cleanup removes only the exact file this instance
// created, after re-reading it and confirming the instance ID still matches.
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const MANIFEST_BASENAME = "manifest.json";

/**
 * Create the manifest exclusively. With an explicit `file` the path must not
 * already exist; without one a fresh private directory named for the port is
 * created under `baseDir` (default: OS temp).
 */
export async function createOwnedManifest({ port, origin, payload, file, baseDir = os.tmpdir() }) {
  if (![4192, 4193].includes(port)) throw new Error("Manifest port must be 4192 or 4193.");
  if (origin !== `http://127.0.0.1:${port}`) throw new Error("Manifest origin must be the loopback origin of its port.");
  const instanceId = randomUUID();
  let dir = null;
  let target = file;
  if (!target) {
    dir = await mkdtemp(path.join(baseDir, `growthos-soft-onboarding-${port}-`));
    target = path.join(dir, MANIFEST_BASENAME);
  }
  const body = { ...payload, instanceId, port, origin, pid: process.pid };
  // "wx": fail if the path exists, so a second runtime can never overwrite
  // another runtime's (or anyone's) file.
  await writeFile(target, JSON.stringify(body, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return { file: target, dir, instanceId, port };
}

/**
 * Remove only the file this instance created. If the file is missing, or now
 * holds a different instance's manifest, nothing is deleted.
 */
export async function removeOwnedManifest(handle) {
  if (!handle?.file || !handle.instanceId) return { removed: false, reason: "no-handle" };
  let current;
  try { current = JSON.parse(await readFile(handle.file, "utf8")); } catch { return { removed: false, reason: "missing-or-unreadable" }; }
  if (current?.instanceId !== handle.instanceId || current?.port !== handle.port) return { removed: false, reason: "not-owned" };
  await rm(handle.file, { force: false });
  if (handle.dir) await rmdir(handle.dir).catch(() => {});
  return { removed: true };
}
