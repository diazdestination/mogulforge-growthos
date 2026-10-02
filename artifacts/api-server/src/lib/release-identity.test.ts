import { expect, it } from "vitest";
import { releaseIdentity } from "./release-identity";

const valid = { sha: "a".repeat(40), builtAt: "2026-10-01T12:34:56.789Z" };
it("exposes only a validated embedded SHA/time and finite environment label", () => {
  expect(
    releaseIdentity(
      { ...valid, password: "SECRET" },
      { FLY_APP_NAME: "mogulforge-growthos-staging" },
    ),
  ).toEqual({ ...valid, environment: "staging" });
  expect(
    releaseIdentity(valid, { FLY_APP_NAME: "mogulforge-growthos" }).environment,
  ).toBe("production");
  expect(releaseIdentity(valid, { NODE_ENV: "test" }).environment).toBe("test");
});
it("never infers artifact identity from mutable runtime release/image/branch values", () => {
  expect(
    releaseIdentity(null, {
      GROWTHOS_BUILD_SHA: valid.sha,
      GITHUB_SHA: valid.sha,
      FLY_IMAGE_REF: "private-image",
      NODE_ENV: "production",
    }),
  ).toEqual({ sha: null, builtAt: null, environment: "unknown" });
});
it("drops hostile/malformed metadata instead of reflecting it", () => {
  for (const build of [
    null,
    "SECRET",
    { sha: "SECRET", builtAt: "password" },
    { ...valid, builtAt: "2026-02-30T00:00:00.000Z" },
  ]) {
    const result = releaseIdentity(build, {
      GROWTHOS_ENVIRONMENT: "SECRET",
      FLY_APP_NAME: "private-company",
    });
    expect(result.builtAt).toBeNull();
    expect(result.environment).toBe("unknown");
    expect(JSON.stringify(result)).not.toMatch(
      /SECRET|password|private-company/,
    );
  }
});
