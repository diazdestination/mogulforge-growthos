import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { SchedulingTravelReviewProps } from "@/lib/scheduling-ui-contract";
import { makeReservationSnapshot, makeSchedulingInterval, makeSchedulingProposal, makeSchedulingResources } from "@/test/scheduling-ui-fixtures";
import { SchedulingReservationSummary } from "./scheduling-reservation-summary";

afterEach(cleanup);
function props(overrides: Partial<SchedulingTravelReviewProps> = {}): SchedulingTravelReviewProps {
  return { companyTimeZone: "America/New_York", interval: makeSchedulingInterval(), proposal: null, resources: makeSchedulingResources(), conflict: null, ...overrides };
}
describe("Scheduling reservation summary", () => {
  it("retains saved service endpoints, gap, preset and source evidence after a company zone and policy change", () => {
    render(<SchedulingReservationSummary {...props({ proposal: makeSchedulingProposal({ basis: "saved_preservation", resourceUserIds: ["staff-synthetic"], appliedTravelGapMinutes: 60, companyCeiling: null, inspectionCeiling: null }) })} />);
    expect(screen.getByText(/90 elapsed minutes/)).toBeTruthy();
    expect(screen.getByText(/Saved travel gap: 60 minutes/)).toBeTruthy();
    expect(screen.getByText(/Saved preset: Synthetic visit.*90 minutes/)).toBeTruthy();
    expect(screen.getByText(/Approved company zone: America\/Los_Angeles/)).toBeTruthy();
    expect(screen.getByText(/Current company zone: America\/New_York/)).toBeTruthy();
    expect(screen.getByText(/Inspection rule zone: America\/New_York/)).toBeTruthy();
    expect(screen.getByText(/Source policy revision: 1/)).toBeTruthy();
    expect(screen.getByText(/Source policy digest: a{64}/)).toBeTruthy();
    expect(screen.getByText(/Inspection availability digest: b{64}/)).toBeTruthy();
    expect(screen.getByText(/Synthetic staff/)).toBeTruthy();
    expect(screen.getByText(/Recorded work is retained; no new capacity admission is requested/)).toBeTruthy();
    expect(screen.queryByText(/reservation cap/)).toBeNull();
    const endpoints = [...document.querySelectorAll("time")].map(item => item.dateTime);
    expect(endpoints).toEqual(["2035-01-01T17:00:00.000Z", "2035-01-01T18:30:00.000Z"]);
    expect(screen.getByText(/12:00.*GMT-05:00/)).toBeTruthy();
    expect(screen.getByText(/1:30.*GMT-05:00/)).toBeTruthy();
  });
  it("shows the root's new proposal and distinct final company and inspection checks without asserting availability", () => {
    render(<SchedulingReservationSummary {...props({ interval: makeSchedulingInterval({ startAt: null, endAt: null, reservation: null, evidence: "legacy" }), proposal: makeSchedulingProposal() })} />);
    expect(screen.getByText(/Proposed travel gap: 60 minutes/)).toBeTruthy();
    expect(screen.getByText(/Company reservation cap: 3/)).toBeTruthy();
    expect(screen.getByText(/Inspection reservation cap: 2/)).toBeTruthy();
    expect(screen.getAllByText(/Rechecked when saving/)).toHaveLength(2);
    expect(screen.getByText(/Unassigned.*technician availability has not been checked/)).toBeTruthy();
    expect(screen.queryByText(/Saved travel gap/)).toBeNull();
  });
  it("keeps a null saved end explicit while rendering the caller's legacy compatibility window", () => {
    render(<SchedulingReservationSummary {...props({ companyTimeZone: "UTC", interval: makeSchedulingInterval({ startAt: "2035-01-01T17:00:00Z", endAt: null, legacyEffectiveEnd: "2035-01-01T19:00:00Z", reservation: null, evidence: "legacy" }) })} />);
    expect(screen.getByText(/Saved end: Not recorded \(legacy\)/)).toBeTruthy();
    expect(screen.getByText(/Legacy compatibility window/)).toBeTruthy();
    expect(screen.getByText(/120 elapsed minutes/)).toBeTruthy();
    expect(screen.getByText(/Legacy travel gap: 0 minutes/)).toBeTruthy();
    expect(screen.queryByText(/Saved preset/)).toBeNull();
  });
  it("never infers legacy staff assignments from the available resource label directory", () => {
    render(<SchedulingReservationSummary {...props({ interval: makeSchedulingInterval({ reservation: null, evidence: "legacy" }) })} />);
    expect(screen.queryByText(/Resources: Synthetic staff/)).toBeNull();
    expect(screen.getByText(/^Technician availability has not been checked\./)).toBeTruthy();
    expect(screen.queryByText(/^Unassigned/)).toBeNull();
  });
  it.each([null, "", "Invalid/Zone"])("holds an absent or invalid current company zone %s without using saved or browser zone", companyTimeZone => {
    render(<SchedulingReservationSummary {...props({ companyTimeZone })} />);
    expect(screen.getByRole("alert").textContent).toMatch(/current company time zone.*required/i);
    expect(document.querySelector("time")).toBeNull();
  });
  it.each(["invalid", "corrupt", "missing-versioned", "bad-legacy"])("holds %s evidence instead of displaying legacy zero protection", kind => {
    const interval = kind === "invalid" ? makeSchedulingInterval({ evidence: "invalid", reservation: null }) : kind === "corrupt" ? makeSchedulingInterval({ reservation: makeReservationSnapshot({ minimumTravelGapMinutes: -1 }) }) : kind === "missing-versioned" ? makeSchedulingInterval({ reservation: null }) : makeSchedulingInterval({ evidence: "legacy", reservation: null, startAt: "not-an-instant" });
    render(<SchedulingReservationSummary {...props({ interval })} />);
    expect(screen.getByRole("alert").textContent).toMatch(/Scheduling evidence.*held/);
    expect(screen.queryByText(/Legacy travel gap: 0/)).toBeNull();
    expect(document.querySelector("time")).toBeNull();
  });
  it("shows only a supplied authorized staff conflict separately from cap checks", () => {
    const conflict = { reservationKind: "appointment" as const, reservationId: "22222222-2222-4222-8222-222222222222", resourceLabel: "Authorized synthetic staff", startAt: "2035-01-01T19:00:00Z", endAt: "2035-01-01T20:00:00Z", reason: "Adjacent saved travel gap" };
    const view = render(<SchedulingReservationSummary {...props({ proposal: makeSchedulingProposal(), conflict })} />);
    expect(screen.getByText(/Staff resource conflict: Authorized synthetic staff/)).toBeTruthy();
    expect(screen.getByText(/Adjacent saved travel gap/)).toBeTruthy();
    expect(screen.getByText(/Company reservation cap: 3/)).toBeTruthy();
    view.rerender(<SchedulingReservationSummary {...props({ proposal: makeSchedulingProposal() })} />);
    expect(screen.queryByText(/Authorized synthetic staff/)).toBeNull();
    expect(screen.queryByText(/Adjacent saved travel gap/)).toBeNull();
  });
  it("preserves precise offsets across a repeated DST hour and unknown assigned names", () => {
    const reservation = makeReservationSnapshot({ startAt: "2035-11-04T05:30:00Z", endAt: "2035-11-04T06:30:00Z", resourceUserIds: ["unknown-staff"], duration: { kind: "explicit", preset: null } });
    render(<SchedulingReservationSummary {...props({ interval: makeSchedulingInterval({ startAt: reservation.startAt, endAt: reservation.endAt, reservation }) })} />);
    expect(screen.getByText(/1:30.*GMT-04:00/)).toBeTruthy();
    expect(screen.getByText(/1:30.*GMT-05:00/)).toBeTruthy();
    expect(screen.getByText(/60 elapsed minutes/)).toBeTruthy();
    expect(screen.getByText(/Assigned staff \(name unavailable\)/)).toBeTruthy();
    expect(screen.queryByText(/^Unassigned/)).toBeNull();
  });
});
