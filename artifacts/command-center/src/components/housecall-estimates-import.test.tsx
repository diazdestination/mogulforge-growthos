import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HousecallEstimatesImport, type EstimatesResult } from "./housecall-estimates-import";
import { ESTIMATE_FIELD_ALIASES, suggestMapping } from "@/lib/housecall-jobs";

// Published estimates report layout (no status or amount columns).
const header = ["Invoice", "HCP Id", "Created At", "Date", "End Time", "Travel Duration", "On Job Duration", "Total Duration", "Customer",
  "First Name", "Last Name", "Email", "Company", "Mobile Phone", "Home Phone", "Customer Tag", "Address", "Street", "Street Line 2", "City", "State", "Zip"];
const csv = `${header.join(",")}\n2001,est_1,2026-09-01,,,,,,"Stone, Avery",Avery,Stone,avery@example.invalid,,,,VIP,,12 Lake Rd,,Dawsonville,GA,30534\n`;
const preview: EstimatesResult = {
  dryRun: true, totalRows: 2, openEstimates: 1, sent: 1, drafts: 0, decidedHistory: 0, approved: 0, declined: 0, closed: 0,
  alreadyImported: 0, changedSinceImport: 0, visitsToBook: 0, missingAmounts: 1, propertiesCreated: 0, listsTruncated: false, problems: [],
  unmatched: [{ row: 3, jobNumber: "2003", customer: "Stranger", reason: "no GrowthOS customer has this email or phone" }],
  sample: [{ row: 2, estimateNumber: "2001", customer: "Avery Stone", status: "sent", totalCents: null, action: "open estimate (sent), follow-up" }],
};
function mockApi() {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ path: url, body });
    return new Response(JSON.stringify({ ...preview, dryRun: body.dryRun }), { status: 200, headers: { "content-type": "application/json" } });
  }));
  return calls;
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Housecall Pro estimates import", () => {
  it("suggests the published estimates headers", () => {
    expect(suggestMapping(header, ESTIMATE_FIELD_ALIASES)).toMatchObject({ estimateNumber: 0, estimateId: 1, createdAt: 2, scheduledStart: 3, email: 11, phone: 13, customerTags: 15, street: 17, postalCode: 21 });
    expect(suggestMapping(header, ESTIMATE_FIELD_ALIASES).status).toBeUndefined();
  });

  it("asks whether open estimates were sent when the file has no status, and imports only after review", async () => {
    const calls = mockApi();
    render(<HousecallEstimatesImport />);
    fireEvent.change(screen.getByLabelText("Housecall Pro estimates CSV"), { target: { files: [new File([csv], "estimates.csv", { type: "text/csv" })] } });
    expect(((await screen.findByLabelText(/Estimate ID \(HCP Id\)/)) as HTMLSelectElement).value).toBe("1");
    const previewButton = screen.getByRole("button", { name: "Preview estimates" }) as HTMLButtonElement;
    expect(previewButton.disabled).toBe(true);
    expect(screen.getByText(/This file has no status column/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Sent, awaiting the customer's decision/));
    expect(previewButton.disabled).toBe(false);
    fireEvent.click(previewButton);
    await screen.findByTestId("hcp-estimates-preview");
    expect(calls[0]).toMatchObject({ path: "/api/v1/housecall-import/estimates", body: { dryRun: true, openEstimatesAre: "sent", mapping: { estimateId: 1, email: 11 } } });
    expect(screen.getByTestId("hcp-estimates-unmatched").textContent).toContain("Row 3, estimate 2003 (Stranger)");
    const importButton = screen.getByRole("button", { name: "Import estimates" }) as HTMLButtonElement;
    expect(importButton.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/I reviewed this preview and want to import these estimates/));
    fireEvent.click(importButton);
    await screen.findByTestId("hcp-estimates-done");
    expect(calls[1]).toMatchObject({ body: { dryRun: false, openEstimatesAre: "sent" } });
    await waitFor(() => expect(screen.getByTestId("hcp-estimates-done").textContent).toContain("Nothing was sent to customers"));
  });
});
