import type { NextFunction, Request, Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDataLifecycleInventoryGuard, createDataLifecycleMembershipReader,
  DATA_LIFECYCLE_AUTH_LIMITS, type InventoryMembershipResult,
} from "./data-lifecycle-inventory-session";
import type { InventoryClient } from "./data-lifecycle-inventory";

function fixture() {
  const row: Record<string, unknown> = {
    sessionExpiresAt: new Date(Date.now() + 60_000), tokenExpiresAt: Math.floor(Date.now() / 1000) + 60,
    identityType: "string", sessionUserId: "user-a", userId: "user-a",
    organizationId: "00000000-0000-4000-8000-000000000001", role: "owner", active: true,
  };
  const queries: Array<{ text: string; values?: unknown[]; query_timeout: number }> = [];
  let onError: (() => void) | undefined;
  const client = {
    connect: vi.fn(async (): Promise<void> => undefined),
    end: vi.fn(async (): Promise<void> => undefined),
    on: vi.fn((_event: "error", callback: () => void) => { onError = callback; }),
    query: vi.fn(async (query: { text: string; values?: unknown[]; query_timeout: number }) => {
      queries.push(query);
      return { rows: query.text.includes("FROM public.sessions") ? [row] : [] };
    }),
  } satisfies InventoryClient;
  const createClient = vi.fn(() => client);
  return { row, client, createClient, queries, onError: () => onError?.(), read: createDataLifecycleMembershipReader({ createClient }) };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("bounded read-only inventory membership", () => {
  it("projects one current session and member in a read-only transaction with no credential columns", async () => {
    const { read, client, queries, row } = fixture();
    expect(await read("CANARY_SESSION_VALUE")).toEqual({ status: "authenticated", member: { userId: "user-a", organizationId: row.organizationId, role: "owner" } });
    expect(queries[0]!.text).toBe("BEGIN TRANSACTION READ ONLY");
    expect(queries.at(-1)!.text).toBe("ROLLBACK");
    expect(queries.every((q) => /^(SELECT|BEGIN|SET LOCAL|ROLLBACK)/.test(q.text))).toBe(true);
    const projection = queries.find((q) => q.text.includes("FROM public.sessions"))!;
    expect(projection.values).toEqual(["CANARY_SESSION_VALUE"]);
    expect(projection.text).toContain("LEFT JOIN public.users u ON u.id = s.sess->'user'->>'id'");
    expect(projection.text).toContain("u.organization_id");
    expect(projection.text).toContain("s.expire AT TIME ZONE 'UTC'");
    expect(projection.text).not.toMatch(/SELECT\s+\*|password_hash|access_token|refresh_token|email|s\.sess\s*(?:,|FROM)/);
    expect(client.end).toHaveBeenCalledOnce();
  });

  it.each([
    ["admin", { role: "admin" }, "authenticated"],
    ["role downgrade", { role: "viewer" }, "forbidden"],
    ["inactive user", { active: false }, "forbidden"],
    ["removed user", { userId: null, active: null }, "forbidden"],
    ["unscoped platform identity", { organizationId: null }, "forbidden"],
    ["expired token", { tokenExpiresAt: 1 }, "unauthenticated"],
    ["malformed token expiry", { tokenExpiresAt: "untrusted" }, "unauthenticated"],
    ["non-finite token expiry", { tokenExpiresAt: Infinity }, "unauthenticated"],
    ["expired session", { sessionExpiresAt: new Date(0) }, "unauthenticated"],
    ["malformed session expiry", { sessionExpiresAt: "2099-01-01" }, "unauthenticated"],
    ["non-string identity", { identityType: "number" }, "unauthenticated"],
    ["missing identity", { sessionUserId: null }, "unauthenticated"],
  ])("handles %s without repair", async (_label, fields, status) => {
    const { read, row } = fixture(); Object.assign(row, fields);
    expect((await read("synthetic-session")).status).toBe(status);
  });

  it("rejects absent, malformed and oversized session references before creating a client", async () => {
    const { read, createClient } = fixture();
    for (const sid of [undefined, null, {}, "", "x".repeat(513)]) expect(await read(sid)).toEqual({ status: "unauthenticated" });
    expect(createClient).not.toHaveBeenCalled();
  });

  it("redacts acquisition/query errors and closes the dedicated client", async () => {
    const { read, client } = fixture();
    client.query.mockRejectedValueOnce(new Error("CANARY_DATABASE_SECRET"));
    expect(await read("synthetic-session")).toEqual({ status: "unavailable" });
    expect(client.end).toHaveBeenCalledOnce();
  });

  it("bounds stalled acquisition, caps simultaneous connections and schedules no queries after expiry", async () => {
    vi.useFakeTimers();
    const { read, client, createClient } = fixture();
    const release: Array<() => void> = [];
    client.connect.mockImplementation(() => new Promise<void>((resolve) => { release.push(resolve); }));
    const pending = Array.from({ length: DATA_LIFECYCLE_AUTH_LIMITS.maxConnections }, () => read("synthetic-session"));
    expect(await read("another-session")).toEqual({ status: "unavailable" });
    expect(createClient).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(DATA_LIFECYCLE_AUTH_LIMITS.totalMs + 1);
    expect(await Promise.all(pending)).toEqual(Array.from({ length: 4 }, () => ({ status: "unavailable" })));
    for (const resolve of release) resolve();
    await Promise.resolve();
    expect(client.query).not.toHaveBeenCalled();
    expect(client.end).toHaveBeenCalledTimes(4);
  });

  it("closes a stalled query at the total deadline and does not queue more work when it settles late", async () => {
    vi.useFakeTimers();
    const { read, client } = fixture();
    let release!: (result: { rows: Record<string, unknown>[] }) => void;
    client.query.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const pending = read("synthetic-session");
    await vi.advanceTimersByTimeAsync(DATA_LIFECYCLE_AUTH_LIMITS.totalMs + 1);
    expect(await pending).toEqual({ status: "unavailable" });
    expect(client.end).toHaveBeenCalledOnce();
    release({ rows: [] }); await Promise.resolve();
    expect(client.query).toHaveBeenCalledOnce();
  });

  it("retains connection slots after failed cleanup rather than leaking replacement jobs", async () => {
    const { read, createClient, client } = fixture();
    client.end.mockRejectedValue(new Error("CANARY_CLOSE_FAILURE"));
    for (let i = 0; i < 5; i++) expect(await read("synthetic-session")).toEqual({ status: "unavailable" });
    expect(createClient).toHaveBeenCalledTimes(4);
  });

  it("makes driver error events fail closed", async () => {
    const { read, client, onError } = fixture();
    client.connect.mockImplementationOnce(async () => { onError(); });
    expect(await read("synthetic-session")).toEqual({ status: "unavailable" });
    expect(client.query).not.toHaveBeenCalled();
    expect(client.end).toHaveBeenCalledOnce();
  });
});

describe("specialized inventory guard", () => {
  function requestResponse(headers: Record<string, string>, cookies: Record<string, string> = {}) {
    const req = { headers, cookies } as unknown as Request;
    const res = { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
    return { req, res, next: vi.fn() as NextFunction };
  }
  it("rejects API-key headers before any session or membership lookup", async () => {
    const read = vi.fn(async (_sid: unknown): Promise<InventoryMembershipResult> => ({ status: "unavailable" }));
    const guard = createDataLifecycleInventoryGuard(read);
    expect(guard.requiredPermission).toBe("settings.manage");
    for (const value of ["", "CANARY_API_KEY"]) {
      const { req, res, next } = requestResponse({ "x-api-key": value }, { sid: "existing-session" });
      await guard(req, res, next);
      expect(res.status).toHaveBeenCalledWith(403); expect(next).not.toHaveBeenCalled();
    }
    expect(read).not.toHaveBeenCalled();
  });
  it("preserves cookie and Bearer session semantics, without selected-tenant inputs", async () => {
    const read = vi.fn(async (_sid: unknown): Promise<InventoryMembershipResult> => ({ status: "authenticated", member: { userId: "member", organizationId: "verified-organization", role: "admin" } }));
    const guard = createDataLifecycleInventoryGuard(read);
    const headerOptions: Array<Record<string, string>> = [{}, { authorization: "Bearer bearer-session", "x-organization-id": "forged-org" }];
    for (const headers of headerOptions) {
      const { req, res, next } = requestResponse(headers, { sid: "cookie-session" });
      await guard(req, res, next);
      expect(req.dataLifecycleInventoryMember?.organizationId).toBe("verified-organization");
      expect(next).toHaveBeenCalledOnce();
    }
    expect(read.mock.calls.map((args) => args[0])).toEqual(["cookie-session", "bearer-session"]);
  });
});
