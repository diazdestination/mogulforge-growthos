import { describe, expect, it } from "vitest";
import { buildIdentity } from "../artifacts/api-server/build-identity.mjs";

const sha = "a".repeat(40),
  now = () => new Date("2026-10-01T12:34:56.789Z");
describe("embedded API build identity", () => {
  it("stamps the clean actual source revision and build time", () => {
    expect(
      buildIdentity({
        env: {},
        now,
        git: (args) => (args[0] === "rev-parse" ? sha : ""),
      }),
    ).toEqual({ sha, builtAt: now().toISOString() });
  });
  it.each([" M source.ts", "?? new-source.ts"])(
    "does not stamp a dirty checkout: %s",
    (status) => {
      expect(
        buildIdentity({
          env: { GROWTHOS_BUILD_SHA: sha },
          now,
          git: (args) => (args[0] === "rev-parse" ? sha : status),
        }).sha,
      ).toBeNull();
    },
  );
  it("rejects a build argument that disagrees with actual source", () => {
    expect(
      buildIdentity({
        env: { GROWTHOS_BUILD_SHA: "b".repeat(40) },
        now,
        git: (args) => (args[0] === "rev-parse" ? sha : ""),
      }).sha,
    ).toBeNull();
  });
  it("never uses an argument to override a failed clean-status check in a known repository", () => {
    expect(
      buildIdentity({
        env: { GROWTHOS_BUILD_SHA: sha },
        now,
        git: (args) => {
          if (args[0] === "rev-parse") return sha;
          throw new Error("status unavailable");
        },
      }).sha,
    ).toBeNull();
  });
  it("accepts only a valid explicit build argument in a no-Git Docker context", () => {
    const git = () => {
      throw new Error("No .git in build context");
    };
    expect(
      buildIdentity({ env: { GROWTHOS_BUILD_SHA: sha }, now, git }).sha,
    ).toBe(sha);
    for (const env of [
      {},
      { GROWTHOS_BUILD_SHA: "secret-invalid" },
      { FLY_IMAGE_REF: sha },
      { GITHUB_REF_NAME: sha },
    ])
      expect(buildIdentity({ env, now, git }).sha).toBeNull();
  });
});
