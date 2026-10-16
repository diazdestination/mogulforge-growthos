import { test, expect } from "vitest";
import {
  production75Diagnostic,
  registerProduction75SafeError,
  recordProduction75DriverFailure,
  recordProduction75Secondary,
  withProduction75Stage,
  transferProduction75Diagnostic,
} from "./production75-safe-diagnostics.mjs";

test("sanitizer transfer copies only owned scalar evidence and respects sealed targets", async () => {
  let hooks = 0;
  const untrusted = new Proxy(
    {},
    {
      get() {
        hooks++;
        throw Error("synthetic private");
      },
      getOwnPropertyDescriptor() {
        hooks++;
        throw Error("synthetic private");
      },
    },
  );
  const target = Error("sanitized");
  transferProduction75Diagnostic(target, untrusted);
  transferProduction75Diagnostic(target, {
    safeCode: "production75_live_query",
    code: "42501",
    stage: "legacy-reader-state",
  });
  expect(production75Diagnostic(target)).toEqual({
    stage: "operator-callback",
    safeCode: "production75_diagnostic_unknown",
  });
  const owned = registerProduction75SafeError(
    Error("synthetic private"),
    "production75_live_query",
  );
  recordProduction75DriverFailure(owned, { code: "42501" });
  try {
    await withProduction75Stage("legacy-reader-state", async () => {
      throw owned;
    });
  } catch {}
  transferProduction75Diagnostic(target, owned);
  expect(production75Diagnostic(target)).toEqual({
    stage: "operator-callback",
    safeCode: "production75_diagnostic_unknown",
  });
  const fresh = Error("sanitized");
  transferProduction75Diagnostic(fresh, owned);
  expect(production75Diagnostic(fresh)).toEqual({
    stage: "legacy-reader-state",
    safeCode: "production75_live_query",
    sqlState: "42501",
  });
  expect(hooks).toBe(0);
  expect(fresh).not.toHaveProperty("code");
});

test("a sealed failure cannot change its trusted classification after late registration", async () => {
  const failure = registerProduction75SafeError(
    Error("synthetic private"),
    "production75_live_query",
  );
  try {
    await withProduction75Stage("legacy-reader-state", async () => {
      throw failure;
    });
  } catch {}
  const first = production75Diagnostic(failure);
  registerProduction75SafeError(failure, "production75_live_client");
  recordProduction75DriverFailure(failure, { code: "08006" });
  recordProduction75Secondary(
    failure,
    Error("synthetic late close"),
    "transport-close",
  );
  expect(production75Diagnostic(failure)).toEqual(first);
  expect(first).toEqual({
    stage: "legacy-reader-state",
    safeCode: "production75_live_query",
  });
  expect(Object.isFrozen(first)).toBe(true);
});

test("nested stages and saturated secondary errors retain the primary and first cleanup only", async () => {
  const failure = Error("synthetic private"),
    secondary = Error("synthetic private cleanup");
  try {
    await withProduction75Stage("legacy-context", () =>
      withProduction75Stage("legacy-reader-state", async () => {
        throw failure;
      }),
    );
  } catch {}
  recordProduction75Secondary(failure, secondary, "legacy-reader-rollback");
  for (let index = 0; index < 100; index++)
    recordProduction75Secondary(
      failure,
      Error("discarded synthetic"),
      "transport-close",
    );
  expect(production75Diagnostic(failure)).toEqual({
    stage: "legacy-reader-state",
    safeCode: "production75_diagnostic_unknown",
    secondary: {
      stage: "legacy-reader-rollback",
      safeCode: "production75_diagnostic_unknown",
    },
  });
});

test.each(["getter", "proxy", "coercion", "oversize"])(
  "driver %s metadata cannot invoke hooks or escape its allowlist",
  (kind) => {
    let hooks = 0;
    const failure = registerProduction75SafeError(
      Error("owned"),
      "production75_live_query",
    );
    let driver;
    if (kind === "getter")
      driver = Object.defineProperty({}, "code", {
        get() {
          hooks++;
          throw Error("synthetic private");
        },
      });
    if (kind === "proxy")
      driver = new Proxy(
        {},
        {
          getOwnPropertyDescriptor() {
            hooks++;
            throw Error("synthetic private");
          },
        },
      );
    if (kind === "coercion")
      driver = {
        code: {
          toString() {
            hooks++;
            return "23514";
          },
        },
      };
    if (kind === "oversize") driver = { code: "A".repeat(100000) };
    recordProduction75DriverFailure(failure, driver);
    expect(production75Diagnostic(failure)).toEqual({
      stage: "operator-callback",
      safeCode: "production75_live_query",
    });
    expect(hooks).toBe(0);
  },
);
