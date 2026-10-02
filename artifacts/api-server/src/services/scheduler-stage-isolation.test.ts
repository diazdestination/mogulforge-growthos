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

// Never claim another parallel suite's approved missed-call fixtures.
vi.mock("./missed-call-care", () => ({
  processMissedCallCare: vi.fn(async () => {}),
}));

// The notification stage intentionally retires expired subscriptions and
// abandoned claims even while outbound delivery is held. An unscoped real
// invocation here could mutate another parallel suite's deliberately stale
// fixtures. Observe sequencing without running that global housekeeping.
vi.mock("./staff-push", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./staff-push")>();
  return { ...actual, processStaffLeadPush: vi.fn(async () => {}) };
});

import { markAbandonedConversations } from "./concierge";
import { processScheduledWork } from "./automation";
import { processStaffLeadPush } from "./staff-push";
import { processMissedCallCare } from "./missed-call-care";
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
    expect(processMissedCallCare).not.toHaveBeenCalled();
    expect(processStaffLeadPush).not.toHaveBeenCalled();
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
    expect(processMissedCallCare).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(processStaffLeadPush).toHaveBeenCalledTimes(1);
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
    const observe = vi.fn(async () => {});
    await expect(processScheduledWork(undefined, observe)).resolves.toBeUndefined();
    expect(processStaffLeadPush).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(observe).toHaveBeenCalledWith("staff-lead-notifications", "running");
    expect(observe).toHaveBeenCalledWith("staff-lead-notifications", "succeeded");
    expect(processPendingDeliveries).toHaveBeenCalledTimes(1);
    expect(markAbandonedConversations).toHaveBeenCalledTimes(1);
  });

  it("reports a failed notification stage without dropping later stages or exposing its error", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(processStaffLeadPush).mockRejectedValueOnce(new Error("SECRET_PUSH_ENDPOINT"));
    const observe = vi.fn(async () => {});
    await expect(processScheduledWork(undefined, observe)).resolves.toBeUndefined();
    expect(observe).toHaveBeenCalledWith("staff-lead-notifications", "failed");
    expect(observe).toHaveBeenCalledWith("upload-cleanup", "succeeded");
    expect(processPendingDeliveries).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("SECRET_PUSH_ENDPOINT");
    expect(JSON.stringify(observe.mock.calls)).not.toContain("SECRET_PUSH_ENDPOINT");
  });

  it("isolates missed-call recovery failure and still runs staff notifications", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(processMissedCallCare).mockRejectedValueOnce(new Error("SECRET_CALLER_NUMBER"));
    const observe = vi.fn(async () => {});
    await expect(processScheduledWork(undefined, observe)).resolves.toBeUndefined();
    expect(observe).toHaveBeenCalledWith("missed-call-care", "running");
    expect(observe).toHaveBeenCalledWith("missed-call-care", "failed");
    expect(processStaffLeadPush).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(observe).toHaveBeenCalledWith("upload-cleanup", "succeeded");
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("SECRET_CALLER_NUMBER");
    expect(JSON.stringify(observe.mock.calls)).not.toContain("SECRET_CALLER_NUMBER");
  });
});
