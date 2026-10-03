import { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InvoiceDelivery, type InvoiceEmailEvidence } from "./invoice-delivery";
import { renderWithQuery } from "@/test/render";
import { sampleInvoice, invoiceId } from "@/test/invoice-fixtures";
import { ContractorApiError, contractorRequest } from "@/lib/contractor-api";
import {
  sampleAcceptedDelivery,
  sampleAttempt,
  sampleDelivery,
} from "@/test/invoice-delivery-fixtures";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

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
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
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
  intent: "initial",
  expectedLatestExecutionId: null,
  reason: null,
  prospectiveAttemptNumber: 1,
  maxAttempts: 5,
};
beforeEach(() => {
  failure = false;
  readFailure = false;
  evidence = sampleDelivery();
  preview.expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  vi.mocked(contractorRequest).mockImplementation(async (path, options) => {
    if (path.endsWith("/preview")) {
      const body = options?.body as Record<string, unknown>;
      return {
        ...preview,
        intent: body.intent ?? "initial",
        expectedLatestExecutionId: body.expectedLatestExecutionId ?? null,
        reason: body.reason ?? null,
        prospectiveAttemptNumber: evidence.attemptCount + 1,
      };
    }
    if (path.endsWith("/send")) {
      if (failure) throw new ContractorApiError(503, "invoice_unavailable");
      evidence = sampleAcceptedDelivery();
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
  vi.useRealTimers();
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
  await screen.findAllByText("Provider accepted — delivery unconfirmed");
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
  evidence = sampleAcceptedDelivery({
    state: "uncertain",
    canPrepare: false,
    nextIntents: [],
    attempts: [sampleAttempt({ state: "indeterminate", proof: "none" })],
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Check delivery status" }),
  );
  await screen.findAllByText("Uncertain — check the original mailbox");
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

it("requires a reason and a fresh duplicate-copy acknowledgement after the exact preview", async () => {
  evidence = sampleAcceptedDelivery();
  render();
  const review = await screen.findByRole("button", {
    name: "Review another copy",
  });
  expect(review.hasAttribute("disabled")).toBe(true);
  expect(screen.queryByLabelText(/I understand the previous email/)).toBeNull();
  fireEvent.change(screen.getByLabelText(/Reason for another invoice email/), {
    target: { value: "  Customer requested another copy.  " },
  });
  fireEvent.click(review);
  const copy = await screen.findByLabelText(/I understand the previous email/);
  const send = screen.getByRole("button", {
    name: "Approve and send another copy",
  });
  fireEvent.click(screen.getByLabelText(/I reviewed this recipient/));
  expect(send.hasAttribute("disabled")).toBe(true);
  expect(
    vi
      .mocked(contractorRequest)
      .mock.calls.find(([path]) => path.endsWith("/preview"))![1]?.body,
  ).toEqual({
    expectedVersion: 2,
    intent: "additional_copy",
    expectedLatestExecutionId: "execution-a",
    reason: "Customer requested another copy.",
  });
  fireEvent.click(copy);
  expect(send.hasAttribute("disabled")).toBe(false);
  fireEvent.click(send);
  fireEvent.click(send);
  await waitFor(() =>
    expect(
      vi
        .mocked(contractorRequest)
        .mock.calls.filter(([path]) => path.endsWith("/send")),
    ).toHaveLength(1),
  );
  expect(
    vi
      .mocked(contractorRequest)
      .mock.calls.find(([path]) => path.endsWith("/send"))![1]?.body,
  ).toEqual({
    previewId: preview.previewId,
    payloadSha256: preview.payloadSha256,
    confirmed: true,
    duplicateCopyAcknowledged: true,
  });
});

it("discards both approvals when the copy reason changes and never prechecks a new review", async () => {
  evidence = sampleAcceptedDelivery();
  render();
  await screen.findByRole("button", { name: "Review another copy" });
  const reason = screen.getByLabelText(/Reason for another invoice email/);
  fireEvent.change(reason, {
    target: { value: "Customer requested another copy." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review another copy" }));
  fireEvent.click(await screen.findByLabelText(/I reviewed this recipient/));
  fireEvent.click(screen.getByLabelText(/I understand the previous email/));
  fireEvent.change(reason, {
    target: { value: "Customer confirmed their invoice copy request." },
  });
  expect(
    screen.queryByRole("button", { name: "Approve and send another copy" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Review another copy" }));
  expect(
    (
      await screen.findByLabelText(/I understand the previous email/)
    ).getAttribute("checked"),
  ).toBeNull();
  expect(
    screen
      .getByRole("button", { name: "Approve and send another copy" })
      .hasAttribute("disabled"),
  ).toBe(true);
});

it("offers only the server-reviewed safe retry, bound to the exact previous execution", async () => {
  evidence = sampleAcceptedDelivery({
    state: "held",
    nextIntents: ["retry_not_dispatched"],
    attempts: [
      sampleAttempt({
        state: "blocked",
        proof: "not_dispatched",
        provider: null,
        acceptedAt: null,
        providerRequestId: null,
      }),
    ],
  });
  render();
  await screen.findByRole("button", { name: "Review a safe retry" });
  expect(
    screen.queryByRole("button", { name: "Review another copy" }),
  ).toBeNull();
  fireEvent.change(screen.getByLabelText(/Reason for another invoice email/), {
    target: { value: "The connection hold has been resolved." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review a safe retry" }));
  fireEvent.click(await screen.findByLabelText(/I reviewed this recipient/));
  expect(screen.queryByLabelText(/I understand the previous email/)).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Approve and send invoice" }),
  );
  await waitFor(() =>
    expect(
      vi
        .mocked(contractorRequest)
        .mock.calls.filter(([path]) => path.endsWith("/send")),
    ).toHaveLength(1),
  );
  expect(
    vi
      .mocked(contractorRequest)
      .mock.calls.find(([path]) => path.endsWith("/preview"))![1]?.body,
  ).toMatchObject({
    intent: "retry_not_dispatched",
    expectedLatestExecutionId: "execution-a",
  });
  expect(
    vi
      .mocked(contractorRequest)
      .mock.calls.find(([path]) => path.endsWith("/send"))![1]?.body,
  ).not.toHaveProperty("duplicateCopyAcknowledged");
});

it.each(["uncertain", "reconciled", "processing"] as const)(
  "never offers a send for %s even if an old canPrepare flag says true",
  async (state) => {
    evidence = sampleAcceptedDelivery({
      state,
      canPrepare: true,
      nextIntents: [],
    });
    render();
    await screen.findByText("1 of 5 lifetime email attempts");
    expect(
      screen.queryByRole("button", {
        name: /Preview invoice|Review another|Review a safe/,
      }),
    ).toBeNull();
  },
);

it("shows the five-attempt cap and immutable earlier history without another send control", async () => {
  const attempts = Array.from({ length: 5 }, (_, index) =>
    sampleAttempt({
      ordinal: index + 1,
      executionId: `execution-${index}`,
      legacy: index === 0,
      intent: index ? "additional_copy" : "initial",
    }),
  );
  evidence = sampleAcceptedDelivery({
    attemptCount: 5,
    attempts,
    latestExecutionId: "execution-4",
    nextIntents: [],
    attentionReason: "attempt_limit_reached",
  });
  render();
  await screen.findByText("5 of 5 lifetime email attempts");
  expect(screen.getByText(/limit of five lifetime/)).toBeTruthy();
  expect(screen.getByText(/Earlier saved attempt/)).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: /Review another|Review a safe/ }),
  ).toBeNull();
});

it("invalidates a saved preview when background evidence acquires a different head", async () => {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  renderWithQuery(
    <QueryClientProvider client={cache}>
      <InvoiceDelivery invoice={invoice} organizationId="org-a" canManage />
    </QueryClientProvider>,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Preview invoice email" }),
  );
  fireEvent.click(await screen.findByRole("checkbox"));
  act(() =>
    cache.setQueryData(
      ["invoice-delivery", "org-a", invoiceId],
      sampleAcceptedDelivery(),
    ),
  );
  await screen.findByText(/delivery history changed/);
  expect(
    screen
      .getByRole("button", { name: "Approve and send invoice" })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(
    vi
      .mocked(contractorRequest)
      .mock.calls.filter(([path]) => path.endsWith("/send")),
  ).toHaveLength(0);
});

it("expires an open reviewed preview without waiting for a failed provider request", async () => {
  render();
  fireEvent.click(
    await screen.findByRole("button", { name: "Preview invoice email" }),
  );
  fireEvent.click(await screen.findByRole("checkbox"));
  const clock = vi
    .spyOn(Date, "now")
    .mockReturnValue(Date.parse(preview.expiresAt) + 1);
  fireEvent.click(
    screen.getByRole("button", { name: "Approve and send invoice" }),
  );
  expect(
    vi
      .mocked(contractorRequest)
      .mock.calls.filter(([path]) => path.endsWith("/send")),
  ).toHaveLength(0);
  clock.mockRestore();
});

it("does not turn missing or mismatched chain metadata into an initial send", async () => {
  evidence = sampleDelivery({
    attemptCount: 1,
    latestExecutionId: "unexplained",
  });
  render();
  await screen.findByText(/missing evidence is not proof/i);
  expect(screen.queryByText("Not sent")).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Preview invoice email" }),
  ).toBeNull();
});
