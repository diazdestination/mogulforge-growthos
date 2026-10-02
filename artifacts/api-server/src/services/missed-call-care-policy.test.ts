import { describe, expect, it } from "vitest";
import { CARE_BODY, DEFAULT_CARE_POLICY, careOperationKey, careOwnerAt, isMissedInbound, missedCallCarePolicySchema, nextCareWindow } from "./missed-call-care-policy";

const policy = { ...DEFAULT_CARE_POLICY, enabled: true, timezone: "America/New_York", days: [1, 2, 3, 4, 5, 6], businessHoursOwnerId: "day-owner", afterHoursOwnerId: "night-owner" };
describe("explicit missed-call recovery policy", () => {
  it("defaults off and never treats an answered or outgoing call as missed", () => {
    expect(DEFAULT_CARE_POLICY.enabled).toBe(false);
    expect(isMissedInbound({ direction: "inbound", dialStatus: "completed" })).toBe(false);
    expect(isMissedInbound({ direction: "outbound", dialStatus: "no-answer" })).toBe(false);
    expect(isMissedInbound({ direction: "inbound", dialStatus: "no-answer" })).toBe(true);
    expect(careOperationKey("call-id")).toBe("missed-call-care:call-id:sms:v1");
    expect(CARE_BODY).toContain("does not confirm an appointment");
    expect(CARE_BODY).not.toMatch(/emergency|on our way|24\/7/i);
  });
  it("requires both accountable owners and a valid explicit window", () => {
    for (const change of [{ afterHoursOwnerId: null }, { timezone: "not/a-zone" }, { days: [] }, { days: [1, 1] }, { opensAt: "22:00", closesAt: "06:00" }, { responseMinutes: 0 }]) {
      expect(missedCallCarePolicySchema.safeParse({ ...policy, ...change }).success).toBe(false);
    }
  });
  it("routes the day and after-hours owner with DST and defers customer texts to business hours", () => {
    expect(careOwnerAt(policy, new Date("2026-10-02T14:00:00Z"))).toBe("day-owner");
    expect(careOwnerAt(policy, new Date("2026-10-03T23:00:00Z"))).toBe("night-owner");
    expect(nextCareWindow(policy, new Date("2026-10-03T23:00:00Z"))?.toISOString()).toBe("2026-10-05T13:00:00.000Z");
    expect(nextCareWindow(policy, new Date("2026-11-01T03:00:00Z"))?.toISOString()).toBe("2026-11-02T14:00:00.000Z");
    expect(nextCareWindow(policy, new Date("2026-10-02T14:00:00Z"))).toBeNull();
  });
});
