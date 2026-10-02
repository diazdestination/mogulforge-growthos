import { describe, expect, it, vi } from "vitest";
import { assertStagingDatabaseIdentity } from "./staging-database-identity";

const env = {
  FLY_APP_NAME: "mogulforge-growthos-staging",
  APP_ORIGIN: "https://mogulforge-growthos-staging.fly.dev",
  DATABASE_URL:
    "postgresql://growthos-staging-live:private-value@pgbouncer.zp2wjrejd2zodn4q.flympg.net/growthos_staging",
};
const correct = () => ({
  query: vi.fn(async () => ({
    rows: [{ database: "growthos_staging", login: "growthos-staging-live" }],
  })),
});

describe("staging startup database identity", () => {
  it("does nothing outside staging", async () => {
    const client = correct();
    await assertStagingDatabaseIdentity(client, { FLY_APP_NAME: "mogulforge-growthos" });
    expect(client.query).not.toHaveBeenCalled();
  });

  it("accepts only the isolated URL and actual database session", async () => {
    const client = correct();
    await assertStagingDatabaseIdentity(client, env);
    expect(client.query).toHaveBeenCalledWith(
      "SELECT current_database() AS database, session_user AS login",
    );
  });

  it("fails before seeding if URL or session points elsewhere", async () => {
    const client = correct();
    await expect(
      assertStagingDatabaseIdentity(client, {
        ...env,
        DATABASE_URL: env.DATABASE_URL.replace("growthos_staging", "fly-db"),
      }),
    ).rejects.toThrow("required database");
    expect(client.query).not.toHaveBeenCalled();

    await expect(
      assertStagingDatabaseIdentity(client, {
        ...env,
        DATABASE_URL: env.DATABASE_URL.replace("zp2wjrejd2zodn4q", "kzpwm0j18eg04nv3"),
      }),
    ).rejects.toThrow("required database");
    expect(client.query).not.toHaveBeenCalled();

    const wrongSession = {
      query: vi.fn(async () => ({
        rows: [{ database: "mogulforge-growthos-db", login: "fly-user" }],
      })),
    };
    await expect(assertStagingDatabaseIdentity(wrongSession, env)).rejects.toThrow(
      "session does not match",
    );
  });
});
