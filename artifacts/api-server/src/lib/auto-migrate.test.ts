import { afterEach, describe, expect, it, vi } from "vitest";

// These mocks make the former mutation path fail safely if it is reintroduced.
// The unit runner does not load the API's database-provisioning global setup.
const io = vi.hoisted(() => {
  const forbidden = () => {
    throw new Error("UNEXPECTED_STARTUP_MIGRATION_IO");
  };
  return {
    databaseImported: false,
    connect: vi.fn(forbidden),
    query: vi.fn(forbidden),
    spawn: vi.fn(forbidden),
    log: vi.fn(forbidden),
  };
});
vi.mock("@workspace/db", () => {
  io.databaseImported = true;
  return {
    pool: { connect: io.connect, query: io.query },
    db: { execute: io.query },
  };
});
vi.mock("node:child_process", () => ({
  spawn: io.spawn,
  exec: io.spawn,
  execSync: io.spawn,
  execFile: io.spawn,
  execFileSync: io.spawn,
}));
vi.mock("./logger", () => ({
  logger: { info: io.log, warn: io.log, error: io.log },
}));

import { runAutoMigrate } from "./auto-migrate";

const refusal =
  "Automatic startup schema reconciliation is retired. Leave AUTO_MIGRATE unset or false and apply reviewed SQL through the approved exact-source, target and recovery procedure.";

function syntheticEnvironment(flag: string | undefined): NodeJS.ProcessEnv {
  return Object.freeze({
    ...(flag === undefined ? {} : { AUTO_MIGRATE: flag }),
    DATABASE_URL:
      "postgresql://synthetic:STARTUP_CANARY@database.example.invalid/synthetic",
    MIGRATE_CWD: "SYNTHETIC_DIRECTORY_CANARY",
    STAGING_SCHEMA_PUSH_APPROVED: "true",
    PRODUCTION_SCHEMA_PUSH_APPROVED: "true",
    SCHEMA_PUSH_APPROVED: "true",
  });
}

afterEach(() => {
  expect(io.databaseImported).toBe(false);
  expect(io.connect).not.toHaveBeenCalled();
  expect(io.query).not.toHaveBeenCalled();
  expect(io.spawn).not.toHaveBeenCalled();
  expect(io.log).not.toHaveBeenCalled();
});

describe("retired startup schema mutation", () => {
  it.each([
    "true",
    "TRUE",
    "TrUe",
    " true ",
    "1",
    " 1 ",
    "yes",
    "YES",
    " YeS ",
  ])(
    "refuses enabled spelling %j without any database or child access",
    async (flag) => {
      await expect(
        runAutoMigrate(syntheticEnvironment(flag)),
      ).rejects.toMatchObject({ message: refusal });
    },
  );

  it.each([
    undefined,
    "",
    " ",
    "false",
    " FALSE ",
    "0",
    "no",
    "off",
    "unknown",
  ])("preserves disabled startup for %j without I/O", async (flag) => {
    await expect(
      runAutoMigrate(syntheticEnvironment(flag)),
    ).resolves.toBeUndefined();
  });

  it("reads only the flag and never inspects connection or approval inputs", async () => {
    const get = vi.fn((_target: object, name: string | symbol) => {
      if (name !== "AUTO_MIGRATE")
        throw new Error("Unexpected migration environment read");
      return "yes";
    });
    await expect(runAutoMigrate(new Proxy({}, { get }))).rejects.toMatchObject({
      message: refusal,
    });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("preserves the default startup invocation using only a synthetic process environment", async () => {
    const original = process.env;
    try {
      process.env = {};
      await expect(runAutoMigrate()).resolves.toBeUndefined();
      process.env = { AUTO_MIGRATE: " YES " };
      await expect(runAutoMigrate()).rejects.toMatchObject({
        message: refusal,
      });
    } finally {
      process.env = original;
    }
  });

  it("does not turn restore or approval flags into a startup migration bypass", async () => {
    await expect(
      runAutoMigrate({
        ...syntheticEnvironment("true"),
        RESTORE_DRILL_ONLY: "true",
      }),
    ).rejects.toMatchObject({ message: refusal });
    await expect(
      runAutoMigrate({
        ...syntheticEnvironment("false"),
        RESTORE_DRILL_ONLY: "true",
      }),
    ).resolves.toBeUndefined();
  });
});
