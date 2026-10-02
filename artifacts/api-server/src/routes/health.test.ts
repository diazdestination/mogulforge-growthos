import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  sessionId: vi.fn(),
  session: vi.fn(),
  config: vi.fn(),
  refresh: vi.fn(),
  clear: vi.fn(),
  update: vi.fn(),
}));
vi.mock("../lib/readiness", () => ({ checkReadiness: mocks.check }));
vi.mock("../lib/auth", () => ({
  getSessionId: mocks.sessionId,
  getSession: mocks.session,
  getOidcConfig: mocks.config,
  clearSession: mocks.clear,
  updateSession: mocks.update,
}));
vi.mock("openid-client", () => ({ refreshTokenGrant: mocks.refresh }));
import router from "./health";
import { authMiddleware } from "../middlewares/authMiddleware";

let server: Server, base: string;
beforeAll(async () => {
  const app = express();
  app.use(authMiddleware);
  app.use("/api", router);
  app.get("/private", (req, res) =>
    res.json({ authenticated: req.isAuthenticated() }),
  );
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((done) => server.once("listening", done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(() => {
  mocks.check.mockResolvedValue(true);
  mocks.sessionId.mockReturnValue("synthetic-expired-cookie");
  mocks.session.mockResolvedValue({
    user: { id: "synthetic" },
    expires_at: 1,
    refresh_token: "synthetic-only",
  });
  mocks.config.mockResolvedValue({});
  mocks.refresh.mockResolvedValue({
    access_token: "synthetic-refreshed",
    expiresIn: () => 60,
  });
  mocks.clear.mockResolvedValue(undefined);
  mocks.update.mockResolvedValue(undefined);
});
afterEach(() => vi.clearAllMocks());
afterAll(async () => {
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
});

it.each(["/api/healthz", "/API/HEALTHZ", "/api/healthz/"])(
  "keeps liveness unchanged and independent of cookie/database readiness: %s",
  async (path) => {
    mocks.check.mockResolvedValue(false);
    const response = await fetch(base + path, {
      headers: { cookie: "sid=synthetic-expired-cookie" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(mocks.check).not.toHaveBeenCalled();
    expect(mocks.sessionId).not.toHaveBeenCalled();
    expect(mocks.session).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  },
);
it.each(["/api/readyz", "/API/READYZ", "/api/readyz/"])(
  "exposes only database readiness and safe release metadata without cookie/OIDC work: %s",
  async (path) => {
    const response = await fetch(base + path, {
      headers: {
        cookie: "sid=synthetic-expired-cookie",
        authorization: "Bearer synthetic-secret",
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      status: "ready",
      database: "reachable",
      release: { sha: null, builtAt: null, environment: "test" },
    });
    expect(mocks.sessionId).not.toHaveBeenCalled();
    expect(mocks.config).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  },
);
it("returns 503 for database failure without raw driver/connection/provider details", async () => {
  mocks.check.mockResolvedValue(false);
  const response = await fetch(base + "/api/readyz");
  expect(response.status).toBe(503);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    status: "not_ready",
    database: "unavailable",
    release: { sha: null, builtAt: null, environment: "test" },
  });
});
it.each(["/api/healthz", "/api/readyz", "/API/READYZ/"])(
  "HEAD uses the same cookie-free public semantics: %s",
  async (path) => {
    expect(
      (
        await fetch(base + path, {
          method: "HEAD",
          headers: { cookie: "sid=synthetic-expired-cookie" },
        })
      ).status,
    ).toBe(200);
    expect(mocks.session).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  },
);
it.each([
  ["GET", "/api/readyz-extra"],
  ["GET", "/api/readyz/nested"],
  ["POST", "/api/readyz"],
  ["GET", "/private"],
  ["GET", "/api/v1/platform/runtime"],
])("does not bypass authentication for %s %s", async (method, path) => {
  await fetch(base + path, {
    method,
    headers: { cookie: "sid=synthetic-expired-cookie" },
  });
  expect(mocks.sessionId).toHaveBeenCalledOnce();
  expect(mocks.session).toHaveBeenCalledOnce();
  expect(mocks.config).toHaveBeenCalledOnce();
  expect(mocks.refresh).toHaveBeenCalledOnce();
  expect(mocks.check).not.toHaveBeenCalled();
});
