import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InvoiceDeliveryWorklist } from "./invoice-delivery-worklist";
import { renderWithQuery } from "@/test/render";
import { contractorRequest } from "@/lib/contractor-api";
import { invoiceId, invoiceLeadId } from "@/test/invoice-fixtures";
import { sampleAttempt } from "@/test/invoice-delivery-fixtures";

vi.mock("@/lib/contractor-api", async (original) => ({
  ...(await original<typeof import("@/lib/contractor-api")>()),
  contractorRequest: vi.fn(),
}));
const item = () => ({
  invoiceId,
  invoiceNumber: "INV-000001",
  title: "Synthetic issued repair",
  customerName: "Synthetic Customer",
  status: "issued",
  version: 2,
  leadId: invoiceLeadId,
  projectId: null,
  delivery: {
    attemptCount: 1,
    maxAttempts: 5,
    latestExecutionId: "execution-a",
    nextIntents: [],
    attentionReason: "effect_requires_review",
    integrity: "valid",
    latestAttempt: sampleAttempt({
      state: "indeterminate",
      proof: "none",
      provider: null,
      acceptedAt: null,
    }),
  },
});
beforeEach(() => {
  vi.mocked(contractorRequest).mockImplementation(async (path) => ({
    items: [item()],
    total: 26,
    page: Number(
      new URL(path, "https://synthetic.invalid").searchParams.get("page"),
    ),
    pageSize: 25,
    boundary: "Canonical invoice pages only.",
  }));
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const render = (canManage = true, leadId = "", projectId = "") =>
  renderWithQuery(
    <InvoiceDeliveryWorklist
      organizationId="org-a"
      canManage={canManage}
      leadId={leadId}
      projectId={projectId}
    />,
  );

it("shows authoritative unknown evidence and a canonical invoice link without offering a resend or pretending counts are exceptions", async () => {
  render();
  await screen.findByText("Uncertain — check the original mailbox");
  expect(screen.getByText(/26 matching invoices/)).toBeTruthy();
  expect(screen.getByText(/not a global exception queue/)).toBeTruthy();
  expect(screen.getByText(/No new send is available/)).toBeTruthy();
  expect(
    screen.getByRole("link", { name: "Open invoice" }).getAttribute("href"),
  ).toBe(`/invoices/${invoiceId}#invoice-delivery`);
  expect(screen.queryByRole("button", { name: /send|retry|copy/i })).toBeNull();
  expect(
    vi
      .mocked(contractorRequest)
      .mock.calls.every(
        ([, options]) => !options?.method || options.method === "GET",
      ),
  ).toBe(true);
});
it("pages invoices and resets to the first invoice page when a document filter changes", async () => {
  render();
  await screen.findByText(/26 matching invoices/);
  fireEvent.click(screen.getByRole("button", { name: "Next invoice page" }));
  await screen.findByText(/Page 2/);
  expect(
    screen
      .getByRole("button", { name: "Next invoice page" })
      .hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.change(screen.getByLabelText("Document status"), {
    target: { value: "issued" },
  });
  await screen.findByText(/Page 1/);
  expect(
    vi
      .mocked(contractorRequest)
      .mock.calls.some(
        ([path]) => path === "/invoices/delivery-worklist?page=0&status=issued",
      ),
  ).toBe(true);
});
it("keeps inherited lead/project filters and read-only roles, with no command surface", async () => {
  const project = "00000000-0000-4000-8000-000000000666";
  vi.mocked(contractorRequest).mockResolvedValue({
    items: [{ ...item(), projectId: project }],
    total: 1,
    page: 0,
    pageSize: 25,
    boundary: "Canonical invoices only.",
  });
  render(false, invoiceLeadId, project);
  await screen.findByText(/1 matching invoice/);
  expect(screen.getByText(/Read-only view/)).toBeTruthy();
  const url = new URL(
    vi.mocked(contractorRequest).mock.calls[0]![0],
    "https://synthetic.invalid",
  );
  expect(url.searchParams.get("leadId")).toBe(invoiceLeadId);
  expect(url.searchParams.get("projectId")).toBe(project);
  expect(url.searchParams.has("state")).toBe(false);
});
it("displays permission/read failures and mismatched pages without fabricating an unsent record", async () => {
  vi.mocked(contractorRequest).mockRejectedValue(
    new Error("Synthetic failure"),
  );
  render();
  await screen.findByRole("alert");
  expect(screen.queryByText("Not sent")).toBeNull();
  expect(screen.queryByRole("link", { name: "Open invoice" })).toBeNull();
  vi.mocked(contractorRequest).mockResolvedValue({
    items: [item()],
    total: 1,
    page: 4,
    pageSize: 25,
    boundary: "bad page",
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Refresh delivery list" }),
  );
  await waitFor(() =>
    expect(vi.mocked(contractorRequest)).toHaveBeenCalledTimes(2),
  );
  expect(screen.queryByRole("link", { name: "Open invoice" })).toBeNull();
});
it("shows corrupt history as unavailable even when the count exceeds the normal cap", async () => {
  const row = item();
  vi.mocked(contractorRequest).mockResolvedValue({
    items: [
      {
        ...row,
        delivery: {
          ...row.delivery,
          attemptCount: 6,
          integrity: "unavailable",
          latestAttempt: null,
          attentionReason: "chain_evidence_unavailable",
        },
      },
    ],
    total: 1,
    page: 0,
    pageSize: 25,
    boundary: "Canonical invoices only.",
  });
  render();
  await screen.findByText("Delivery evidence unavailable — review required");
  expect(screen.getByText(/Ask an administrator/)).toBeTruthy();
  expect(screen.queryByText("Not sent")).toBeNull();
});
it("does not label a legacy blocked receipt as verified not dispatched", async () => {
  const row = item();
  vi.mocked(contractorRequest).mockResolvedValue({
    items: [
      {
        ...row,
        delivery: {
          ...row.delivery,
          latestAttempt: sampleAttempt({
            state: "blocked",
            proof: "none",
            legacy: true,
            attemptId: null,
          }),
          attentionReason: "no_typed_no_dispatch_proof",
        },
      },
    ],
    total: 1,
    page: 0,
    pageSize: 25,
    boundary: "Canonical invoices only.",
  });
  render();
  await screen.findByText("Held — review required");
  expect(screen.queryByText(/Verified not dispatched/)).toBeNull();
  expect(screen.getByText(/no verified proof/)).toBeTruthy();
});
