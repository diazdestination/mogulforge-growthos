import { describe, expect, it, vi } from "vitest";
import {
  RESTORE_TABLES,
  fingerprintRestoreRows,
  parseRestoreDrillTarget,
  runRestoreDrillReadOnly,
} from "./restore-drill-readonly.mjs";

const stagingCluster = "zp2wjrejd2zodn4q";
const restoredCluster = "restore123456";

function config(mode = "source", overrides = {}) {
  const cluster = mode === "managed" ? restoredCluster : stagingCluster;
  const database =
    mode === "logical" ? "growthos_restore_drill" : "growthos_staging";
  const login = "growthos-restore-reader";
  return {
    RESTORE_DRILL_MODE: mode,
    RESTORE_DRILL_DATABASE_URL: `postgresql://${login}:private-value@pgbouncer.${cluster}.flympg.net/${database}`,
    RESTORE_DRILL_EXPECTED_LOGIN: login,
    RESTORE_DRILL_SYNTHETIC_SLUG: "restore-drill-fixture-1",
    ...(mode === "source"
      ? {}
      : { RESTORE_DRILL_EXPECTED_FINGERPRINT: "a".repeat(64) }),
    ...(mode === "managed"
      ? { RESTORE_DRILL_EXPECTED_CLUSTER_ID: restoredCluster }
      : {}),
    ...overrides,
  };
}

describe("restore drill target guard", () => {
  it("accepts the staging source, sibling logical target and new managed cluster without leaking credentials", () => {
    for (const mode of ["source", "logical", "managed"]) {
      const target = parseRestoreDrillTarget(config(mode));
      expect(target.mode).toBe(mode);
      expect(JSON.stringify(target)).not.toContain("private-value");
      expect(target.clusterId).toBe(
        mode === "managed" ? restoredCluster : stagingCluster,
      );
    }
  });

  it("rejects production, wrong destination and missing source fingerprint", () => {
    expect(() =>
      parseRestoreDrillTarget(
        config("managed", {
          RESTORE_DRILL_DATABASE_URL:
            "postgresql://growthos-restore-reader:private-value@pgbouncer.kzpwm0j18eg04nv3.flympg.net/growthos_staging",
        }),
      ),
    ).toThrow("restore_production_target_forbidden");
    expect(() =>
      parseRestoreDrillTarget(
        config("managed", {
          RESTORE_DRILL_DATABASE_URL:
            config("source").RESTORE_DRILL_DATABASE_URL,
        }),
      ),
    ).toThrow("restore_cluster_identity_mismatch");
    expect(() =>
      parseRestoreDrillTarget(
        config("logical", {
          RESTORE_DRILL_DATABASE_URL:
            config("source").RESTORE_DRILL_DATABASE_URL,
        }),
      ),
    ).toThrow("restore_target_mismatch");
    expect(() =>
      parseRestoreDrillTarget(
        config("managed", {
          RESTORE_DRILL_EXPECTED_FINGERPRINT: undefined,
        }),
      ),
    ).toThrow("restore_baseline_missing");
    expect(() =>
      parseRestoreDrillTarget(
        config("managed", {
          RESTORE_DRILL_EXPECTED_CLUSTER_ID: undefined,
        }),
      ),
    ).toThrow("restore_cluster_identity_mismatch");
    expect(() =>
      parseRestoreDrillTarget(
        config("managed", {
          RESTORE_DRILL_EXPECTED_CLUSTER_ID: "some-other-cluster",
        }),
      ),
    ).toThrow("restore_cluster_identity_mismatch");
    expect(() =>
      parseRestoreDrillTarget(
        config("source", {
          RESTORE_DRILL_SYNTHETIC_SLUG: "actual-customer",
        }),
      ),
    ).toThrow("restore_target_invalid");
    expect(() =>
      parseRestoreDrillTarget(
        config("source", {
          RESTORE_DRILL_EXPECTED_LOGIN: "fly-user",
        }),
      ),
    ).toThrow("restore_login_mismatch");
  });
});

describe("read-only restore fingerprint", () => {
  function fakeClient(database = "growthos_staging") {
    const queries = [];
    const client = {
      connect: vi.fn(async () => {}),
      end: vi.fn(async () => {}),
      query: vi.fn(async (sql, params) => {
        queries.push({ sql, params });
        if (sql.startsWith("SELECT current_database"))
          return { rows: [{ database, login: "growthos-restore-reader" }] };
        if (sql.includes("AS can_write"))
          return { rows: [{ can_write: false }] };
        if (sql.startsWith("SELECT id::text AS id FROM organizations"))
          return { rows: [{ id: "synthetic-org-id" }] };
        if (sql.startsWith("SELECT count(*)::int AS total"))
          return { rows: [{ total: 1, content_digest: "b".repeat(32) }] };
        return { rows: [] };
      }),
    };
    return { client, queries };
  }

  it("scopes every table query to the fixture, emits no row content and rolls back", async () => {
    const { client, queries } = fakeClient();
    const emit = vi.fn();
    const evidence = await runRestoreDrillReadOnly(config(), {
      createClient: () => client,
      emit,
    });
    expect(evidence.appBootVerified).toBe(false);
    expect(evidence.credentialDecryptVerified).toBe(false);
    expect(evidence.tableCounts.users).toBe(1);
    expect(Object.keys(evidence.tableCounts)).toEqual(RESTORE_TABLES);
    expect(evidence.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(queries[0].sql).toBe("BEGIN TRANSACTION READ ONLY");
    expect(queries.at(-1).sql).toBe("ROLLBACK");
    for (const query of queries.filter(
      (entry) => entry.sql.includes("FROM ") && entry.sql.includes(" t WHERE"),
    )) {
      expect(query.sql).toContain("t.organization_id = $1");
      expect(query.params).toEqual(["synthetic-org-id"]);
    }
    expect(emit).toHaveBeenCalledOnce();
    expect(emit.mock.calls[0][0]).not.toContain("private-value");
    expect(emit.mock.calls[0][0]).not.toContain("synthetic-org-id");
    expect(client.end).toHaveBeenCalledOnce();
  });

  it("requires the exact source fingerprint for a restored target", async () => {
    const source = fakeClient();
    const baseline = await runRestoreDrillReadOnly(config(), {
      createClient: () => source.client,
      emit: () => {},
    });
    const target = fakeClient("growthos_restore_drill");
    const evidence = await runRestoreDrillReadOnly(
      config("logical", {
        RESTORE_DRILL_EXPECTED_FINGERPRINT: baseline.fingerprint,
      }),
      {
        createClient: () => target.client,
        emit: () => {},
      },
    );
    expect(evidence.sourceFingerprintMatched).toBe(true);
    const mismatch = fakeClient("growthos_restore_drill");
    await expect(
      runRestoreDrillReadOnly(config("logical"), {
        createClient: () => mismatch.client,
        emit: () => {},
      }),
    ).rejects.toThrow("restore_fingerprint_mismatch");
    expect(mismatch.client.end).toHaveBeenCalledOnce();
  });

  it("does not pass an empty fixture or the wrong SQL session", async () => {
    const empty = fakeClient();
    empty.client.query.mockImplementation(async (sql) => {
      if (sql.startsWith("SELECT current_database"))
        return {
          rows: [
            { database: "growthos_staging", login: "growthos-restore-reader" },
          ],
        };
      if (sql.includes("AS can_write")) return { rows: [{ can_write: false }] };
      if (sql.startsWith("SELECT id::text AS id FROM organizations"))
        return { rows: [{ id: "synthetic-org-id" }] };
      if (sql.startsWith("SELECT count(*)::int AS total"))
        return {
          rows: [
            { total: 0, content_digest: "d41d8cd98f00b204e9800998ecf8427e" },
          ],
        };
      return { rows: [] };
    });
    await expect(
      runRestoreDrillReadOnly(config(), {
        createClient: () => empty.client,
        emit: () => {},
      }),
    ).rejects.toThrow("restore_fixture_incomplete");
    const wrong = fakeClient("production");
    await expect(
      runRestoreDrillReadOnly(config(), {
        createClient: () => wrong.client,
        emit: () => {},
      }),
    ).rejects.toThrow("restore_session_identity_mismatch");
    const writable = fakeClient();
    const normalQuery = writable.client.query.getMockImplementation();
    writable.client.query.mockImplementation((sql, params) =>
      sql.includes("AS can_write")
        ? Promise.resolve({ rows: [{ can_write: true }] })
        : normalQuery(sql, params),
    );
    await expect(
      runRestoreDrillReadOnly(config(), {
        createClient: () => writable.client,
        emit: () => {},
      }),
    ).rejects.toThrow("restore_reader_privilege_required");
  });

  it("hashes table evidence deterministically", () => {
    const rows = { users: { total: 1, contentDigest: "abc" } };
    expect(fingerprintRestoreRows("restore-drill-fixture-1", rows)).toBe(
      fingerprintRestoreRows("restore-drill-fixture-1", rows),
    );
    expect(fingerprintRestoreRows("restore-drill-fixture-2", rows)).not.toBe(
      fingerprintRestoreRows("restore-drill-fixture-1", rows),
    );
  });
});
