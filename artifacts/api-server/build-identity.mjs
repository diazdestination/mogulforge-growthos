import { execFileSync } from "node:child_process";
import { lstatSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const validSha = (value) =>
  typeof value === "string" && /^[a-f\d]{40}$/i.test(value)
    ? value.toLowerCase()
    : null;

/** Stamp build input, never mutable runtime Fly/branch metadata. */
export function buildIdentity({
  env = process.env,
  now = () => new Date(),
  sourceDirectory = root,
  git = (args) =>
    execFileSync("git", args, {
      cwd: sourceDirectory,
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim(),
} = {}) {
  const builtAt = now().toISOString();
  try {
    if (!statSync(sourceDirectory).isDirectory()) return { sha: null, builtAt };
  } catch {
    return { sha: null, builtAt };
  }
  try {
    // A worktree's .git is a file; both that and a directory establish a known
    // checkout. lstat also treats a broken metadata symlink as present.
    lstatSync(resolve(sourceDirectory, ".git"));
  } catch (error) {
    // Only confirmed absence permits the intentionally Git-less Docker path.
    // Inaccessible/unverifiable metadata cannot authorize an asserted SHA.
    return {
      sha: error.code === "ENOENT" ? validSha(env.GROWTHOS_BUILD_SHA) : null,
      builtAt,
    };
  }
  let sha = null,
    head;
  try {
    head = validSha(git(["rev-parse", "HEAD"]));
  } catch {
    // Missing Git, a timeout or corrupt HEAD inside a checkout is not Docker.
    return { sha: null, builtAt };
  }
  try {
    const dirty = git(["status", "--porcelain", "--untracked-files=normal"]);
    // A dirty/unverifiable checkout is not exact HEAD. A build argument cannot
    // override observed source or a failed status check in a known repository.
    if (
      !dirty &&
      head &&
      (!env.GROWTHOS_BUILD_SHA || validSha(env.GROWTHOS_BUILD_SHA) === head)
    )
      sha = head;
  } catch {
    /* Unknown source cleanliness is deliberately reported as null. */
  }
  return { sha, builtAt };
}
