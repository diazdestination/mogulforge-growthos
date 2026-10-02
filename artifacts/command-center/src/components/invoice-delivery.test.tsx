import { useState } from "react";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InvoiceDelivery, type InvoiceEmailEvidence } from "./invoice-delivery";
import { renderWithQuery } from "@/test/render";
import { sampleInvoice, invoiceId } from "@/test/invoice-fixtures";
import { ContractorApiError, contractorRequest } from "@/lib/contractor-api";

vi.mock("@/lib/contractor-api", async (original) => ({
  ...(await original<typeof import("@/lib/contractor-api")>()),
  contractorRequest: vi.fn(),
}));
const invoice = sampleInvoice({
  status: "issued",
  invoiceNumber: "INV-000001",
  issuedAt: "2026-10-02T12:00:00Z",
  version: 2,
});
let evidence: InvoiceEmailEvidence;
let failure = false;
let readFailure = false;
const preview = {
  previewId: "00000000-0000-4000-8000-000000000555",
  payloadSha256: "a".repeat(64),
  expiresAt: "2026-10-02T17:00:00Z",
  invoiceId,
  invoiceVersion: 2,
  recipient: "customer@example.invalid",
  sender: {
    userId: "staff-a",
    source: "lead_assignee",
    provider: "microsoft",
    senderEmail: "office@example.invalid",
  },
  subject: "Invoice INV-000001 from Synthetic Contractor",
  body: "Issued document\n<script>plain text, never HTML</script>\nInvoice total: USD 100.00",
};
beforeEach(() => {
  failure = false;
  readFailure = false;
  evidence = {
    invoiceId,
    state: "not_sent",
    executionId: null,
    detail: "No invoice email has been sent through this flow.",
    provider: null,
    providerMessageId: null,
    providerRequestId: null,
    acceptedAt: null,
    deliveryConfirmed: false,
    deliveryDetail:
      "Acceptance is not inbox delivery. Delivery/bounce monitoring is not connected.",
    canPrepare: true,
  };
  vi.mocked(contractorRequest).mockImplementation(async (path, options) => {
    if (path.endsWith("/preview")) return preview;
    if (path.endsWith("/send")) {
      if (failure) throw new ContractorApiError(503, "invoice_unavailable");
      evidence = {
        ...evidence,
        state: "accepted",
        canPrepare: false,
        provider: "microsoft",
        providerRequestId: "request-only",
        acceptedAt: "2026-10-02T12:30:00Z",
        executionId: "execution-a",
      };
      return evidence;
    }
    if (options?.method === "POST") throw new Error("Unexpected mutation");
    if (readFailure) throw new Error("Evidence unavailable");
    return evidence;
  });
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const render = (manage = true) =>
  renderWithQuery(
    <InvoiceDelivery
      invoice={invoice}
      organizationId="org-a"
      canManage={manage}
    />,
  );

it("requires exact visible review and confirmation before explicit send, then shows acceptance rather than delivery", async () => {
  render();
  fireEvent.click(
    await screen.findByRole("button", { name: "Preview invoice email" }),
  );
  expect(await screen.findByText("customer@example.invalid")).toBeTruthy();
  expect(screen.getByText(/office@example.invalid/)).toBeTruthy();
  expect(
    screen.getByLabelText("Exact invoice email content").textContent,
  ).toContain("<script>");
  expect(document.querySelector("script")).toBeNull();
  const send = screen.getByRole("button", { name: "Approve and send invoice" });
  expect(send.hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(send);
  await screen.findByText("Provider accepted — delivery unconfirmed");
  expect(
    screen.getByText(/request correlation \(not a delivered-message receipt\)/),
  ).toBeTruthy();
  const calls = vi
    .mocked(contractorRequest)
    .mock.calls.filter(([path]) => path.endsWith("/send"));
  expect(calls).toHaveLength(1);
  expect(calls[0]![1]?.body).toEqual({
    previewId: preview.previewId,
    payloadSha256: preview.payloadSha256,
    confirmed: true,
  });
  expect(
    screen.queryByRole("button", { name: "Preview invoice email" }),
  ).toBeNull();
});
it("keeps an uncertain HTTP send from being retried and requires a read-only status check", async () => {
  failure = true;
  render();
  fireEvent.click(
    await screen.findByRole("button", { name: "Preview invoice email" }),
  );
  fireEvent.click(await screen.findByRole("checkbox"));
  fireEvent.click(
    screen.getByRole("button", { name: "Approve and send invoice" }),
  );
  await screen.findByText(/Check delivery status before doing anything else/);
  expect(
    screen
      .getByRole("button", { name: "Approve and send invoice" })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(
    screen.queryByRole("button", { name: "Discard preview and review again" }),
  ).toBeNull();
  evidence = {
    ...evidence,
    state: "uncertain",
    canPrepare: false,
    executionId: "uncertain-execution",
  };
  fireEvent.click(
    screen.getByRole("button", { name: "Check delivery status" }),
  );
  await screen.findByText("Uncertain — review required");
  expect(
    vi
      .mocked(contractorRequest)
      .mock.calls.filter(([path]) => path.endsWith("/send")),
  ).toHaveLength(1);
});
it("blocks delivery controls when evidence cannot load, never showing fabricated not-sent status", async () => {
  readFailure = true;
  render();
  await screen.findByText(/missing evidence is not proof/i);
  expect(screen.queryByText("Not sent")).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Preview invoice email" }),
  ).toBeNull();
});
it("shows evidence but no approval controls for invoice read-only staff", async () => {
  render(false);
  await screen.findByText("Not sent");
  expect(screen.getByText(/Your invoice role is read-only/)).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Preview invoice email" }),
  ).toBeNull();
});
it("invalidates a displayed approval when the invoice version changes", async () => {
  function Harness() {
    const [version, setVersion] = useState(2);
    return (
      <>
        <button onClick={() => setVersion(3)}>Synthetic new version</button>
        <InvoiceDelivery
          invoice={{ ...invoice, version }}
          organizationId="org-a"
          canManage
        />
      </>
    );
  }
  renderWithQuery(<Harness />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Preview invoice email" }),
  );
  fireEvent.click(await screen.findByRole("checkbox"));
  fireEvent.click(
    screen.getByRole("button", { name: "Synthetic new version" }),
  );
  await screen.findByText(/The invoice changed after this preview/);
  expect(
    screen
      .getByRole("button", { name: "Approve and send invoice" })
      .hasAttribute("disabled"),
  ).toBe(true);
  await waitFor(() =>
    expect(
      vi
        .mocked(contractorRequest)
        .mock.calls.filter(([path]) => path.endsWith("/send")),
    ).toHaveLength(0),
  );
});
