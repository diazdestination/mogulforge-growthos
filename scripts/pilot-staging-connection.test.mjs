import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), spawn: vi.fn() }));

// No test can invoke the installed Fly CLI. Both process entrypoints and all
// HTTP requests are replaced before this operational script is imported.
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  return {
    execFile: Object.assign(vi.fn(), { [promisify.custom]: mocks.execute }),
    spawn: mocks.spawn,
  };
});

import {
  pilotCredentials,
  stagePilotSecrets,
} from "./pilot-staging-connection.mjs";

const token = "synthetic-fly-token-never-valid";
const password = "synthetic:p@ss/word?#&= %";
const fetchMock = vi.fn();

function childProcessDouble({
  code = 0,
  inputError = false,
  processError = false,
} = {}) {
  const child = new EventEmitter();
  const stdin = new EventEmitter();
  stdin.end = vi.fn(() => {
    queueMicrotask(() => {
      if (inputError)
        stdin.emit("error", new Error("synthetic private stdin error"));
      if (processError)
        child.emit("error", new Error("synthetic private process error"));
      child.emit("close", code);
    });
  });
  return Object.assign(child, {
    stdin,
    stdout: { resume: vi.fn() },
    stderr: { resume: vi.fn() },
    kill: vi.fn(),
  });
}

beforeEach(() => {
  mocks.execute
    .mockReset()
    .mockResolvedValue({ stdout: `${token}\n`, stderr: "" });
  mocks.spawn.mockReset();
  fetchMock.mockReset().mockResolvedValue({
    ok: true,
    json: async () => ({ data: { username: "growthos-staging-live", password } }),
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("pilot database credential transfer", () => {
  it.each([
    "fly-user",
    "production-user",
    "growthos-staging-live/../../admin",
    "",
  ])(
    "rejects unapproved database identity before process or HTTP access: %s",
    async (username) => {
      await expect(pilotCredentials(username)).rejects.toThrow(
        "pilot_user_forbidden",
      );
      expect(mocks.execute).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("uses the pinned official HTTPS endpoint and encodes credentials into only the isolated database URL", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const credential = await pilotCredentials("growthos-staging-live");
    expect(mocks.execute).toHaveBeenCalledWith(
      "fly",
      ["auth", "token", "--quiet"],
      expect.objectContaining({ windowsHide: true, timeout: 30000 }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.fly.io/api/v1/postgresv2/zp2wjrejd2zodn4q/users/growthos-staging-live/credentials",
      expect.objectContaining({
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        redirect: "error",
        signal: expect.any(AbortSignal),
      }),
    );
    const target = new URL(credential.connectionString);
    expect(target.protocol).toBe("postgresql:");
    expect(target.hostname).toBe("pgbouncer.zp2wjrejd2zodn4q.flympg.net");
    expect(target.username).toBe("growthos-staging-live");
    expect(target.pathname).toBe("/growthos_staging");
    expect(target.search).toBe("");
    expect(target.hash).toBe("");
    expect(decodeURIComponent(target.password)).toBe(password);
    expect(credential.password).toBe(password);
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.execute.mock.calls)).not.toContain(token);
  });

  it("allows only the explicit restore-reader alternative", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { username: "growthos-restore-reader", password },
      }),
    });
    const result = await pilotCredentials("growthos-restore-reader");
    expect(new URL(result.connectionString).username).toBe(
      "growthos-restore-reader",
    );
    expect(new URL(result.connectionString).hostname).toBe(
      "pgbouncer.zp2wjrejd2zodn4q.flympg.net",
    );
  });

  it("does not include provider error response text in credential lookup failures", async () => {
    const readBody = vi.fn(async () => ({ privateToken: token }));
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: readBody });
    await expect(pilotCredentials("growthos-staging-live")).rejects.toThrow(
      /^pilot_credential_lookup_failed_500$/,
    );
    expect(readBody).not.toHaveBeenCalled();
  });

  it.each([
    { username: "fly-user", password },
    { username: "growthos-staging-live", password: "" },
    { username: "growthos-staging-live", password: null },
    { username: "growthos-staging-live", password: { unsafe: "coercion" } },
    { username: "growthos-staging-live", password: true },
  ])(
    "rejects mismatched or malformed provider credential identity",
    async (data) => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data }),
      });
      await expect(pilotCredentials("growthos-staging-live")).rejects.toThrow(
        /^pilot_credential_identity_invalid$/,
      );
    },
  );

  it.each([
    {},
    null,
    [],
    { UNRELATED_SECRET: "synthetic" },
    { RESEND_WEBHOOK_SECRET: "" },
    { RESTORE_DRILL_SYNTHETIC_KEY: 42 },
    { RESEND_WEBHOOK_SECRET: "synthetic\nDATABASE_URL=injected" },
    { RESEND_WEBHOOK_SECRET: "synthetic\rsecond-line" },
    { RESEND_WEBHOOK_SECRET: "synthetic\0null" },
  ])("rejects invalid secret imports before starting Fly", async (values) => {
    await expect(stagePilotSecrets(values)).rejects.toThrow(
      "pilot_secret_input_invalid",
    );
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("stages only the named app through stdin without deploying or printing credentials", async () => {
    const child = childProcessDouble();
    mocks.spawn.mockReturnValueOnce(child);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const values = {
      RESEND_WEBHOOK_SECRET: "whsec_synthetic-signing-secret-only",
      RESTORE_DRILL_SESSION_BEARER: "synthetic-session-bearer-only",
    };
    await stagePilotSecrets(values);
    expect(mocks.spawn).toHaveBeenCalledWith(
      "fly",
      ["secrets", "import", "--stage", "--app", "mogulforge-growthos-staging"],
      expect.objectContaining({
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 60000,
      }),
    );
    expect(child.stdin.end).toHaveBeenCalledWith(
      "RESEND_WEBHOOK_SECRET=whsec_synthetic-signing-secret-only\nRESTORE_DRILL_SESSION_BEARER=synthetic-session-bearer-only\n",
    );
    for (const value of Object.values(values))
      expect(JSON.stringify(mocks.spawn.mock.calls)).not.toContain(value);
    expect(child.stdout.resume).toHaveBeenCalledOnce();
    expect(child.stderr.resume).toHaveBeenCalledOnce();
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it.each([
    { code: 1 },
    { code: null },
    { processError: true },
    { inputError: true },
  ])(
    "does not report secret staging success after a process or stdin failure",
    async (failure) => {
      mocks.spawn.mockReturnValueOnce(childProcessDouble(failure));
      await expect(
        stagePilotSecrets({ RESEND_WEBHOOK_SECRET: "synthetic-secret" }),
      ).rejects.toThrow(/^pilot_secret_stage_failed$/);
    },
  );

  const approvedUrl =
    "postgresql://growthos-staging-live:synthetic-password@pgbouncer.zp2wjrejd2zodn4q.flympg.net/growthos_staging";
  it.each([
    approvedUrl.replace("zp2wjrejd2zodn4q", "kzpwm0j18eg04nv3"),
    approvedUrl.replace("growthos-staging-live", "fly-user"),
    approvedUrl.replace("growthos-staging-live", "growthos-restore-reader"),
    approvedUrl.replace("/growthos_staging", "/production"),
    approvedUrl.replace("postgresql:", "https:"),
    approvedUrl.replace(":synthetic-password", ""),
    approvedUrl.replace("synthetic-password", "broken%credential"),
    approvedUrl.replace(".net/", ".net:5432/"),
    `${approvedUrl}?host=production.example`,
    `${approvedUrl}#unsafe`,
    "not-a-url",
  ])(
    "rejects any database secret that is not the exact staging target",
    async (connectionString) => {
      await expect(
        stagePilotSecrets({ DATABASE_URL: connectionString }),
      ).rejects.toThrow("pilot_secret_database_target_invalid");
      expect(mocks.spawn).not.toHaveBeenCalled();
    },
  );

  it("stages the exact approved database URL only on stdin", async () => {
    const child = childProcessDouble();
    mocks.spawn.mockReturnValueOnce(child);
    await stagePilotSecrets({ DATABASE_URL: approvedUrl });
    expect(child.stdin.end).toHaveBeenCalledWith(
      `DATABASE_URL=${approvedUrl}\n`,
    );
    expect(JSON.stringify(mocks.spawn.mock.calls)).not.toContain(approvedUrl);
  });

  it("terminates the child and redacts a synchronous stdin write failure", async () => {
    const child = childProcessDouble();
    child.stdin.end.mockImplementationOnce(() => {
      throw new Error(`private ${password}`);
    });
    mocks.spawn.mockReturnValueOnce(child);
    await expect(
      stagePilotSecrets({ RESEND_WEBHOOK_SECRET: "synthetic-secret" }),
    ).rejects.toThrow(/^pilot_secret_stage_failed$/);
    expect(child.kill).toHaveBeenCalledOnce();
  });
});
