import { execFileSync } from "node:child_process";
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
  git = (args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim(),
} = {}) {
  let sha = null,
    head;
  try {
    head = validSha(git(["rev-parse", "HEAD"]));
  } catch {
    // Docker intentionally excludes .git. Its operator must supply the exact
    // clean source SHA via a build argument; absence is honestly unknown.
    return {
      sha: validSha(env.GROWTHOS_BUILD_SHA),
      builtAt: now().toISOString(),
    };
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
  return { sha, builtAt: now().toISOString() };
}
