import { db, scheduledActionsTable } from "@workspace/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Spy on the webhook stage so we can prove it runs even when an earlier
// scheduler stage crashes.
vi.mock("./webhooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./webhooks")>();
  return {
    ...actual,
    processPendingDeliveries: vi.fn(async () => {}),
    cleanupExpiredPreviousSecrets: vi.fn(async () => {}),
  };
});

// Keep the abandoned-chat sweep observable (and side-effect free) too.
vi.mock("./concierge", () => ({
  markAbandonedConversations: vi.fn(async () => {}),
}));

// This suite calls processScheduledWork() UNSCOPED; the real reactivation
// drain would grab running campaigns owned by parallel test workers and
// enroll their leads out from under them. Neutralize it — stage isolation
// is what's under test, not draining.
vi.mock("./reactivation", () => ({
  drainReactivationCampaigns: vi.fn(async () => {}),
}));

import { markAbandonedConversations } from "./concierge";
import { processScheduledWork } from "./automation";
import {
  cleanupExpiredPreviousSecrets,
  processPendingDeliveries,
} from "./webhooks";

beforeEach(() => {
  // These tests deliberately run the global stage sequence. Never consume due
  // actions belonging to another parallel suite (especially the crash fixture).
  // Keep the first select spyable so the query-failure test remains meaningful.
  const select = db.select.bind(db);
  vi.spyOn(db, "select").mockImplementation(
    (fields?: Parameters<typeof db.select>[0]) => {
      const query = fields ? select(fields) : select();
      const from = query.from.bind(query);
      query.from = ((table: Parameters<typeof from>[0]) => {
        if (table !== scheduledActionsTable) return from(table);
        const empty = {
          where: () => empty,
          orderBy: () => empty,
          limit: async () => [],
        };
        return empty;
      }) as typeof query.from;
      // vi.spyOn sees only the last overload; runtime preserves select() too.
      return query as ReturnType<typeof db.select>;
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("scheduler stage isolation", () => {
  it("reports failed stages without exposing raw exceptions to logs or heartbeat", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(processPendingDeliveries).mockRejectedValueOnce(
      new Error("SECRET_PROVIDER_KEY"),
    );
    const observe = vi.fn(async () => {});
    await processScheduledWork(undefined, observe);
    expect(observe).toHaveBeenCalledWith("webhook-retries", "failed");
    expect(observe).toHaveBeenCalledWith("upload-cleanup", "succeeded");
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("SECRET");
    expect(JSON.stringify(observe.mock.calls)).not.toContain("SECRET");
  });
  it("does not start another stage when ownership or heartbeat persistence is lost", async () => {
    const observe = vi.fn(async () => {
      throw new Error("Ownership lost");
    });
    await expect(processScheduledWork(undefined, observe)).rejects.toThrow(
      "Ownership lost",
    );
    expect(processPendingDeliveries).not.toHaveBeenCalled();
  });
  it("still runs webhook retries and later stages when the scheduled-actions stage throws", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Make the first stage's DB query blow up (simulates a DB error while
    // querying due scheduled actions).
    vi.spyOn(db, "select").mockImplementationOnce(() => {
      throw new Error("boom: scheduled actions query failed");
    });

    await expect(processScheduledWork()).resolves.toBeUndefined();

    expect(processPendingDeliveries).toHaveBeenCalledTimes(1);
    expect(cleanupExpiredPreviousSecrets).toHaveBeenCalledTimes(1);
    expect(markAbandonedConversations).toHaveBeenCalledTimes(1);
    expect(
      errorSpy.mock.calls.some((args) =>
        String(args[0]).includes('scheduler stage "scheduled-actions" failed'),
      ),
    ).toBe(true);
  });

  it("still runs the abandoned-chat sweep when webhook retries throw", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(processPendingDeliveries).mockRejectedValueOnce(
      new Error("boom: webhook retry crashed"),
    );

    await expect(processScheduledWork()).resolves.toBeUndefined();

    expect(markAbandonedConversations).toHaveBeenCalledTimes(1);
    expect(
      errorSpy.mock.calls.some((args) =>
        String(args[0]).includes('scheduler stage "webhook-retries" failed'),
      ),
    ).toBe(true);
  });

  it("completes cleanly when no stage throws", async () => {
    await expect(processScheduledWork()).resolves.toBeUndefined();
    expect(processPendingDeliveries).toHaveBeenCalledTimes(1);
    expect(markAbandonedConversations).toHaveBeenCalledTimes(1);
  });
});
