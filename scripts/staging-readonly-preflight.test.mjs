import { describe, expect, it } from "vitest";
import { parseStagingTarget } from "./staging-readonly-preflight.mjs";

const app = "mogulforge-growthos-staging";
const url =
  "postgresql://growthos-staging-live:private-value@pgbouncer.zp2wjrejd2zodn4q.flympg.net/growthos_staging";

describe("staging read-only connection preflight", () => {
  it("reports only the expected non-secret identity", () => {
    expect(parseStagingTarget(url, app)).toEqual({
      database: "growthos_staging",
      login: "growthos-staging-live",
      host: "pgbouncer.zp2wjrejd2zodn4q.flympg.net",
      port: "default",
    });
    expect(JSON.stringify(parseStagingTarget(url, app))).not.toContain(
      "private-value",
    );
  });

  it("fails closed for the wrong app, database, login, or malformed URL", () => {
    expect(() => parseStagingTarget(url, "mogulforge-growthos")).toThrow(
      "staging_identity_missing",
    );
    expect(() =>
      parseStagingTarget(url.replace("growthos_staging", "mogulforge-growthos-db"), app),
    ).toThrow("staging_database_target_mismatch");
    expect(() =>
      parseStagingTarget(url.replace("growthos-staging-live", "fly-user"), app),
    ).toThrow("staging_database_target_mismatch");
    expect(() =>
      parseStagingTarget(
        url.replace("zp2wjrejd2zodn4q", "kzpwm0j18eg04nv3"),
        app,
      ),
    ).toThrow("staging_database_target_mismatch");
    expect(() => parseStagingTarget("not a URL", app)).toThrow(
      "database_url_invalid",
    );
    expect(() => parseStagingTarget(undefined, app)).toThrow(
      "staging_identity_missing",
    );
  });
});
