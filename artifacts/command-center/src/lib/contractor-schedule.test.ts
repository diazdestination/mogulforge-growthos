import { describe, expect, it } from "vitest";
import {
  companySchedulingWallTime,
  resolveCompanySchedulingInput,
  schedulingPresetEnd,
  schedulingStartOnlyDraft,
} from "./contractor-schedule";

describe("explicit company scheduling time", () => {
  it("renders the supplied company zone and both repeated-hour occurrences", () => {
    expect(
      companySchedulingWallTime("2035-11-04T08:30:00Z", "America/Los_Angeles"),
    ).toMatchObject({
      localDateTime: "2035-11-04T01:30:00.000",
      offset: "-07:00",
    });
    expect(
      companySchedulingWallTime("2035-11-04T09:30:00Z", "America/Los_Angeles"),
    ).toMatchObject({
      localDateTime: "2035-11-04T01:30:00.000",
      offset: "-08:00",
    });
  });
  it("holds gaps, folds without explicit choice and missing zones", () => {
    expect(
      resolveCompanySchedulingInput("2035-03-11T02:30", "America/Los_Angeles"),
    ).toBeNull();
    expect(
      resolveCompanySchedulingInput("2035-11-04T01:30", "America/Los_Angeles"),
    ).toBeNull();
    expect(
      resolveCompanySchedulingInput(
        "2035-11-04T01:30",
        "America/Los_Angeles",
        "-08:00",
      ),
    ).toBe("2035-11-04T09:30:00.000Z");
    expect(resolveCompanySchedulingInput("2035-11-04T01:30", null)).toBeNull();
    expect(
      resolveCompanySchedulingInput(
        "2035-11-04T01:30",
        "America/Los_Angeles",
        "-06:00",
      ),
    ).toBeNull();
  });
  it("preserves original equivalent raw wire and uses elapsed preset duration across DST", () => {
    expect(
      resolveCompanySchedulingInput(
        "2035-01-01T09:00",
        "America/Los_Angeles",
        "-08:00",
        "2035-01-01T09:00:00-08:00",
      ),
    ).toBe("2035-01-01T09:00:00-08:00");
    expect(
      schedulingPresetEnd("2035-03-11T09:30:00Z", {
        id: "11111111-1111-4111-8111-111111111111",
        label: "Explicit 90",
        elapsedMinutes: 90,
      }),
    ).toBe("2035-03-11T11:00:00.000Z");
  });
  it("shifts multi-day appointments, preserves project absolute ends and never invents unchanged legacy ends", () => {
    const existing = {
      startAt: "2035-03-10T10:00:00Z",
      endAt: "2035-03-12T10:00:00.250Z",
      resourceUserIds: ["a"],
    };
    expect(
      schedulingStartOnlyDraft("appointment", existing, "2035-03-11T10:00:00Z"),
    ).toEqual({
      ...existing,
      startAt: "2035-03-11T10:00:00Z",
      endAt: "2035-03-13T10:00:00.250Z",
    });
    expect(
      schedulingStartOnlyDraft("project", existing, "2035-03-11T10:00:00Z"),
    ).toEqual({ ...existing, startAt: "2035-03-11T10:00:00Z" });
    const legacy = { ...existing, endAt: null };
    expect(
      schedulingStartOnlyDraft("appointment", legacy, existing.startAt),
    ).toEqual(legacy);
    expect(
      schedulingStartOnlyDraft("appointment", legacy, "2035-03-11T10:00:00Z"),
    ).toBeNull();
    expect(
      schedulingStartOnlyDraft("project", existing, "2035-03-13T10:00:00Z"),
    ).toBeNull();
  });
});
