import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { buildIdentity } from "../artifacts/api-server/build-identity.mjs";

const sha = "a".repeat(40),
  now = () => new Date("2026-10-08T12:34:56.789Z");
const fixturePrefix = "growthos-build-identity-";
const fixtureRoot = mkdtempSync(join(tmpdir(), fixturePrefix));
const checkout = join(fixtureRoot, "checkout");
const worktree = join(fixtureRoot, "worktree");
const gitless = join(fixtureRoot, "docker");
mkdirSync(join(checkout, ".git"), { recursive: true });
mkdirSync(worktree);
writeFileSync(
  join(worktree, ".git"),
  "gitdir: unavailable-synthetic-metadata\n",
);
mkdirSync(gitless);

afterAll(() => {
  const target = resolve(fixtureRoot);
  if (
    dirname(target) !== resolve(tmpdir()) ||
    !basename(target).startsWith(fixturePrefix)
  )
    throw new Error("Refusing cleanup outside the owned identity fixture");
  rmSync(target, { recursive: true, force: true });
});

function identity(options) {
  return buildIdentity({ sourceDirectory: checkout, now, ...options });
}

describe("embedded API build identity", () => {
  it.each([checkout, worktree])(
    "stamps the clean actual revision with directory or worktree metadata: %s",
    (sourceDirectory) => {
      expect(
        identity({
          sourceDirectory,
          env: {},
          git: (args) => (args[0] === "rev-parse" ? sha : ""),
        }),
      ).toEqual({ sha, builtAt: now().toISOString() });
    },
  );
  it.each([" M source.ts", "?? new-source.ts"])(
    "does not stamp a dirty checkout: %s",
    (status) => {
      expect(
        identity({
          env: { GROWTHOS_BUILD_SHA: sha },
          git: (args) => (args[0] === "rev-parse" ? sha : status),
        }).sha,
      ).toBeNull();
    },
  );
  it("rejects a build argument that disagrees with actual source", () => {
    expect(
      identity({
        env: { GROWTHOS_BUILD_SHA: "b".repeat(40) },
        git: (args) => (args[0] === "rev-parse" ? sha : ""),
      }).sha,
    ).toBeNull();
  });
  it("never uses an argument to override a failed clean-status check", () => {
    expect(
      identity({
        env: { GROWTHOS_BUILD_SHA: sha },
        git: (args) => {
          if (args[0] === "rev-parse") return sha;
          throw new Error("status unavailable");
        },
      }).sha,
    ).toBeNull();
  });
  it.each([
    ["checkout Git timeout", checkout, "ETIMEDOUT"],
    ["worktree Git timeout", worktree, "ETIMEDOUT"],
    ["missing Git executable", checkout, "ENOENT"],
    ["inaccessible worktree metadata", worktree, "EACCES"],
    ["corrupt HEAD", checkout, "GIT_HEAD_INVALID"],
  ])(
    "does not use an asserted SHA after %s",
    (_name, sourceDirectory, code) => {
      expect(
        identity({
          sourceDirectory,
          env: { GROWTHOS_BUILD_SHA: sha },
          git: () => {
            throw Object.assign(new Error("synthetic Git failure"), { code });
          },
        }),
      ).toEqual({ sha: null, builtAt: now().toISOString() });
    },
  );
  it("rejects an invalid HEAD response despite a valid asserted SHA", () => {
    expect(
      identity({
        env: { GROWTHOS_BUILD_SHA: sha },
        git: (args) => (args[0] === "rev-parse" ? "unverifiable HEAD" : ""),
      }).sha,
    ).toBeNull();
  });
  it.each([join(worktree, ".git"), join(fixtureRoot, "missing-context")])(
    "does not treat an unverifiable source directory as a Git-less build: %s",
    (sourceDirectory) => {
      const git = vi.fn();
      expect(
        identity({
          sourceDirectory,
          env: { GROWTHOS_BUILD_SHA: sha },
          git,
        }).sha,
      ).toBeNull();
      expect(git).not.toHaveBeenCalled();
    },
  );
  it("accepts only a valid explicit build argument in a confirmed Git-less Docker context", () => {
    const git = vi.fn(() => {
      throw new Error("Git is intentionally unavailable in Docker");
    });
    expect(
      identity({
        sourceDirectory: gitless,
        env: { GROWTHOS_BUILD_SHA: sha.toUpperCase() },
        git,
      }),
    ).toEqual({ sha, builtAt: now().toISOString() });
    for (const env of [
      {},
      { GROWTHOS_BUILD_SHA: "invalid-synthetic-value" },
      { FLY_IMAGE_REF: sha },
      { GITHUB_REF_NAME: sha },
    ])
      expect(identity({ sourceDirectory: gitless, env, git }).sha).toBeNull();
    expect(git).not.toHaveBeenCalled();
  });
});
