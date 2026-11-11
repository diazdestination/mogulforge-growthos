import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HousecallJobsImport, type InvoiceCommit, type InvoicePreview, type JobsResult } from "./housecall-jobs-import";
import { suggestJobsMapping } from "@/lib/housecall-jobs";

const header = ["Invoice", "HCP Id", "Created At", "Date", "End Time", "Customer", "Email", "Mobile Phone", "Street", "City", "State", "Zip",
  "Description", "Amount", "Payment History", "Paid Amount", "Due", "Tax", "Employee", "Job Status", "Finished", "Invoice Sent"];
const csv = `${header.join(",")}\n1001,job_1,2026-03-01,2026-03-05,,"Stone, Avery",avery@example.invalid,,12 Lake Rd,Dawsonville,GA,30534,Opening,500.00,,200.00,300.00,0,Jordan,complete rated,2026-03-05,\n`;
const jobsPreview: JobsResult = {
  dryRun: true, batchId: null, totalRows: 1, newJobs: 1, updatedJobs: 0, alreadyImported: 0, completed: 1, upcoming: 0, canceled: 0,
  appointmentsCreated: 0, needsScheduling: 0, propertiesCreated: 0, listsTruncated: false, problems: [],
  unmatched: [{ row: 3, jobNumber: "1007", customer: "Stranger", reason: "no GrowthOS customer has this email or phone" }],
  sample: [{ row: 2, jobNumber: "1001", customer: "Avery Stone", status: "complete rated", date: "2026-03-05T05:00:00.000Z", totalCents: 50000, action: "history" }],
};
const invoicePreview: InvoicePreview = {
  cutoffAt: "2026-10-31T23:59:59.999Z", file: { count: 2, totalCents: 57500 },
  ready: { count: 1, totalCents: 50000, paidInFull: 0, paymentCents: 0, openBalances: 1, openingReceivableCents: 30000, estimatedPaymentDates: 0 },
  alreadyImported: { count: 0, totalCents: 0 }, notInvoiced: 0, listsTruncated: false, unreconciled: [],
  unmatched: [{ row: 3, jobNumber: "1007", customer: "Stranger", reason: "this job is not in GrowthOS yet", totalCents: 7500 }],
  reviews: [{ id: "11111111-1111-4111-8111-111111111111", digest: "a".repeat(64), invoiceCount: 1, documentTotalCents: 50000, expiresAt: "2026-11-11T00:30:00Z" }],
};
const invoiceDone: InvoiceCommit = { batchId: "b", failure: null, remaining: 0, totals: { reviews: 1, invoices: 1, receipts: 0, documentTotalCents: 50000, openingReceivableCents: 30000, paymentCents: 0 } };

function mockApi() {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ path: url, body });
    const value = url.endsWith("/housecall-import/jobs") ? { ...jobsPreview, dryRun: body.dryRun, batchId: body.dryRun ? null : "batch" }
      : url.endsWith("/invoices/preview") ? invoicePreview : invoiceDone;
    return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
  }));
  return calls;
}
const upload = () => fireEvent.change(screen.getByLabelText("Housecall Pro jobs CSV"), { target: { files: [new File([csv], "jobs.csv", { type: "text/csv" })] } });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("suggestJobsMapping", () => {
  it("matches the published jobs report headers and never reuses a column", () => {
    expect(suggestJobsMapping(header)).toMatchObject({ jobNumber: 0, jobId: 1, createdAt: 2, scheduledStart: 3, scheduledEnd: 4, customerName: 5, email: 6, phone: 7,
      street: 8, city: 9, state: 10, postalCode: 11, description: 12, amount: 13, paymentHistory: 14, paidAmount: 15, due: 16, tax: 17, employees: 18, status: 19, completedAt: 20, invoiceSentAt: 21 });
    expect(suggestJobsMapping(["Invoice Number", "HCP ID", "Status"])).toEqual({ jobNumber: 0, jobId: 1, status: 2 });
  });
});

describe("Housecall Pro jobs and invoices import", () => {
  it("previews jobs, imports only after review, then reconciles and imports invoices", async () => {
    const calls = mockApi();
    render(<HousecallJobsImport />);
    upload();
    expect(((await screen.findByLabelText(/Job ID \(HCP Id\)/)) as HTMLSelectElement).value).toBe("1");
    fireEvent.click(screen.getByRole("button", { name: "Preview jobs" }));
    await screen.findByTestId("hcp-jobs-preview");
    expect(calls[0]).toMatchObject({ path: "/api/v1/housecall-import/jobs", body: { dryRun: true, fileName: "jobs.csv", mapping: { jobId: 1, email: 6 } } });
    expect(screen.getByTestId("hcp-jobs-unmatched").textContent).toContain("Row 3, job 1007 (Stranger)");
    const importJobs = screen.getByRole("button", { name: "Import jobs" }) as HTMLButtonElement;
    expect(importJobs.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/I reviewed this preview and want to import these jobs/));
    fireEvent.click(importJobs);
    await screen.findByTestId("hcp-jobs-done");
    expect(calls[1]!.body).toMatchObject({ dryRun: false });

    fireEvent.click(screen.getByRole("button", { name: "Preview invoices" }));
    await screen.findByTestId("hcp-invoice-preview");
    expect(calls[2]!.path).toBe("/api/v1/housecall-import/invoices/preview");
    expect(screen.getByTestId("hcp-invoice-reconcile").textContent).toContain("Every invoice in the file is accounted for ($575.00)");
    const importInvoices = screen.getByRole("button", { name: "Import 1 invoices" }) as HTMLButtonElement;
    expect(importInvoices.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/I reviewed these totals/));
    fireEvent.click(importInvoices);
    expect((await screen.findByTestId("hcp-invoice-done")).textContent).toContain("Imported 1 invoices totaling $500.00, with $300.00 still due");
    expect(calls[3]!.body).toEqual({ reviews: [{ id: invoicePreview.reviews[0]!.id, digest: "a".repeat(64) }], confirmed: true, sourceFrozen: true });
  });

  it("drops the preview when a column changes and refuses Excel files", async () => {
    mockApi();
    render(<HousecallJobsImport />);
    upload();
    fireEvent.click(await screen.findByRole("button", { name: "Preview jobs" }));
    await screen.findByTestId("hcp-jobs-preview");
    fireEvent.change(screen.getByLabelText(/Customer mobile phone/), { target: { value: "" } });
    await waitFor(() => expect(screen.queryByTestId("hcp-jobs-preview")).toBeNull());
    fireEvent.change(screen.getByLabelText("Housecall Pro jobs CSV"), { target: { files: [new File(["x"], "jobs.xlsx")] } });
    expect((await screen.findByRole("alert")).textContent).toMatch(/Excel file/);
  });

  it("shows the server's reason when a request is refused", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ code: "financial_manager_required", error: "An active, accepted company owner or administrator must review financial migration." }), { status: 403 })));
    render(<HousecallJobsImport />);
    upload();
    fireEvent.click(await screen.findByRole("button", { name: "Preview invoices" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/owner or administrator/);
  });
});
