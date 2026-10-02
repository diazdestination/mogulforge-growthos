import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import Invoices from "./invoices";
import { mockApi } from "@/test/mock-api";
import { renderWithQuery } from "@/test/render";
import {
  invoiceId,
  invoiceLeadId,
  sampleInvoice,
} from "@/test/invoice-fixtures";
import { invoiceRequestStorageKey } from "@/hooks/use-invoice-command";
import type { InvoiceDetail, InvoiceDraft } from "@/lib/invoice-ui";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
type Request = { path: string; method: string; body: Record<string, unknown> };
function server(
  role: string,
  initial = sampleInvoice(),
  override?: (
    request: Request,
  ) => Response | undefined | Promise<Response | undefined>,
) {
  let current = initial;
  const requests: Request[] = [];
  const mock = mockApi(role);
  const fallback = mock.getMockImplementation()!;
  mock.mockImplementation(async (input, init) => {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const path = new URL(raw, "http://localhost").pathname;
    const method = init?.method ?? "GET";
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : {};
    const request = { path, method, body };
    requests.push(request);
    const replaced = await override?.(request);
    if (replaced) return replaced;
    if (method === "GET" && path === `/api/v1/invoices/${invoiceId}`)
      return json(current);
    if (method === "GET" && path === "/api/v1/invoices")
      return json({ items: [current], total: 1, page: 0, pageSize: 25 });
    if (method === "GET" && path === "/api/v1/leads")
      return json([
        {
          id: invoiceLeadId,
          organizationId: "o1",
          contactName: "Synthetic Customer",
          status: "won",
          summary: "Approved service work",
        },
      ]);
    if (method === "GET" && path === `/api/v1/leads/${invoiceLeadId}`)
      return json({
        id: invoiceLeadId,
        organizationId: "o1",
        contactName: "Synthetic Customer",
        status: "won",
        summary: "Approved service work",
      });
    return fallback(input, init);
  });
  return {
    requests,
    set: (value: InvoiceDetail) => {
      current = value;
    },
  };
}
function renderInvoices(path = `/invoices/${invoiceId}`) {
  const location = memoryLocation({ path, record: true });
  const rendered = renderWithQuery(
    <Router hook={location.hook}>
      <Invoices />
    </Router>,
  );
  return { ...rendered, location };
}
const writes = (requests: Request[]) =>
  requests.filter(
    (request) =>
      ["POST", "PATCH"].includes(request.method) &&
      request.path.includes("/invoices"),
  );
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Customer invoices", () => {
  it("retains an earlier unconfirmed request when reconciliation is denied after access changes", async () => {
    const key = invoiceRequestStorageKey("u1", "o1", invoiceId);
    const saved = {
      path: `/invoices/${invoiceId}/payments`,
      method: "POST",
      label: "Record payment",
      body: {
        requestId: "00000000-0000-4000-8000-000000000999",
        expectedVersion: 1,
        confirmed: true,
        amountCents: 2500,
        sourceReference: "synthetic-receipt",
        occurredAt: "2026-10-01T12:00:00Z",
      },
    };
    sessionStorage.setItem(key, JSON.stringify(saved));
    const api = server(
      "office",
      sampleInvoice({
        status: "issued",
        issuedAt: "2026-10-01T12:00:00Z",
        invoiceNumber: "INV-000001",
      }),
      (request) =>
        request.method === "POST"
          ? json({ code: "invoice_access_denied" }, 403)
          : undefined,
    );
    renderInvoices();
    fireEvent.click(
      await screen.findByRole("button", { name: "Retry saved request" }),
    );
    expect(
      (await screen.findByText(/earlier result is still unconfirmed/))
        .textContent,
    ).toContain("retained");
    expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual(saved);
    expect(writes(api.requests)[0].body).toEqual(saved.body);
    expect(
      screen
        .getAllByRole("button", { name: "Record payment" })
        .every((button) => button.matches(":disabled")),
    ).toBe(true);
  });
  it("does not offer a saved mutation retry to a read-only sales manager", async () => {
    const key = invoiceRequestStorageKey("u1", "o1", invoiceId);
    sessionStorage.setItem(
      key,
      JSON.stringify({
        path: `/invoices/${invoiceId}/payments`,
        method: "POST",
        label: "Record payment",
        body: {
          requestId: "00000000-0000-4000-8000-000000000999",
          amountCents: 2500,
        },
      }),
    );
    const api = server("sales_manager");
    renderInvoices();
    await screen.findByText(/Your current role is read-only/);
    expect(
      screen.queryByRole("button", { name: "Retry saved request" }),
    ).toBeNull();
    expect(sessionStorage.getItem(key)).not.toBeNull();
    expect(writes(api.requests)).toHaveLength(0);
  });
  it.each(["viewer", "sales_rep", "inspector", "production"])(
    "denies %s without requesting invoice data",
    async (role) => {
      const api = server(role);
      renderInvoices();
      expect((await screen.findByRole("alert")).textContent).toContain(
        "Invoices are not available for this role",
      );
      expect(
        api.requests.some((request) => request.path.includes("/invoices")),
      ).toBe(false);
    },
  );

  it("gives sales managers read access without draft or finance actions", async () => {
    const api = server("sales_manager");
    renderInvoices();
    await screen.findByRole("heading", { name: "Draft invoice" });
    expect(screen.queryByRole("button", { name: "Edit draft" })).toBeNull();
    expect(
      screen.queryByRole("region", { name: "Invoice actions" }),
    ).toBeNull();
    expect(writes(api.requests)).toHaveLength(0);
  });

  it("preserves a failed draft and retries the same signed-in request and exact decimal amounts", async () => {
    let attempts = 0;
    const api = server("office", sampleInvoice(), (request) => {
      if (request.method === "POST" && request.path === "/api/v1/invoices") {
        attempts += 1;
        if (attempts === 1)
          throw new TypeError("Synthetic lost acknowledgement");
        return json({ invoice: sampleInvoice(), duplicate: true });
      }
      return undefined;
    });
    renderInvoices("/invoices");
    fireEvent.click(await screen.findByRole("button", { name: "New invoice" }));
    await screen.findByRole("option", { name: /Synthetic Customer/ });
    fireEvent.change(screen.getByTestId("invoice-lead-select"), {
      target: { value: invoiceLeadId },
    });
    await waitFor(() =>
      expect((screen.getByLabelText("Bill to") as HTMLInputElement).value).toBe(
        "Synthetic Customer",
      ),
    );
    fireEvent.change(screen.getByLabelText("Invoice title"), {
      target: { value: "Prepared repair invoice" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add line" }));
    fireEvent.change(screen.getByLabelText("Description 1"), {
      target: { value: "Approved labor" },
    });
    fireEvent.change(screen.getByLabelText("Quantity 1"), {
      target: { value: "1.25" },
    });
    fireEvent.change(screen.getByLabelText("Price 1 (USD)"), {
      target: { value: "80.00" },
    });
    fireEvent.change(screen.getByLabelText("Approved tax amount (USD)"), {
      target: { value: "1.23" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByRole("button", { name: "Retry saved request" });
    expect(
      (screen.getByLabelText("Invoice title") as HTMLInputElement).value,
    ).toBe("Prepared repair invoice");
    expect(screen.getByLabelText("Invoice title").matches(":disabled")).toBe(
      true,
    );
    expect(attempts).toBe(1);
    fireEvent.click(
      screen.getByRole("button", { name: "Retry saved request" }),
    );
    await screen.findByRole("heading", { name: "Draft invoice" });
    const sent = writes(api.requests);
    expect(sent).toHaveLength(2);
    expect(sent[1].body).toEqual(sent[0].body);
    expect(sent[0].body.document).toMatchObject({
      title: "Prepared repair invoice",
      taxCents: 123,
      lineItems: [
        {
          description: "Approved labor",
          quantity: "1.25",
          unitPriceCents: 8000,
        },
      ],
    });
    expect(
      sessionStorage.getItem(invoiceRequestStorageKey("u1", "o1", "new")),
    ).toBeNull();
  });

  it("requires fresh status after a stale version while preserving the draft contents", async () => {
    let edits = 0;
    const api = server("office", sampleInvoice(), (request) => {
      if (request.method === "PATCH") {
        edits += 1;
        if (edits === 1) {
          api.set(sampleInvoice({ version: 2 }));
          return json(
            { error: "Changed", code: "invoice_version_changed" },
            409,
          );
        }
        const document = request.body.document as InvoiceDraft;
        return json({
          invoice: sampleInvoice({
            version: 3,
            document: {
              ...sampleInvoice().document,
              ...document,
              lineItems: sampleInvoice().document.lineItems,
            },
          }),
          duplicate: false,
        });
      }
      return undefined;
    });
    renderInvoices();
    fireEvent.click(await screen.findByRole("button", { name: "Edit draft" }));
    fireEvent.change(screen.getByLabelText("Invoice title"), {
      target: { value: "Keep this review text" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText(/Someone changed this invoice/);
    expect(
      (screen.getByLabelText("Invoice title") as HTMLInputElement).value,
    ).toBe("Keep this review text");
    expect(
      screen.getByRole("button", { name: "Save draft" }).matches(":disabled"),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Refresh invoice" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Save draft" }).matches(":disabled"),
      ).toBe(false),
    );
    expect(
      (screen.getByLabelText("Invoice title") as HTMLInputElement).value,
    ).toBe("Keep this review text");
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("Invoice record saved.");
    expect(
      writes(api.requests).map((request) => request.body.expectedVersion),
    ).toEqual([1, 2]);
  });

  it("requires reviewed issuance and never implies email delivery or a charge", async () => {
    const issued = sampleInvoice({
      status: "issued",
      version: 2,
      invoiceNumber: "INV-000001",
      issuedAt: "2026-10-01T12:05:00Z",
      balanceDueCents: 10000,
    });
    const api = server("office", sampleInvoice(), (request) =>
      request.method === "POST"
        ? json({ invoice: issued, duplicate: false })
        : undefined,
    );
    renderInvoices();
    fireEvent.click(
      await screen.findByRole("button", { name: "Review & issue" }),
    );
    const form = screen.getByRole("form", { name: "Issue invoice" });
    expect(
      within(form)
        .getByRole("button", { name: "Issue invoice" })
        .matches(":disabled"),
    ).toBe(true);
    fireEvent.click(within(form).getByRole("checkbox"));
    fireEvent.click(
      within(form).getByRole("button", { name: "Issue invoice" }),
    );
    await screen.findByRole("heading", { name: "INV-000001" });
    expect(writes(api.requests)).toHaveLength(1);
    expect(writes(api.requests)[0]).toMatchObject({
      path: `/api/v1/invoices/${invoiceId}/issue`,
      body: { expectedVersion: 1, confirmed: true },
    });
    expect(screen.getByText(/Issuing does not mean it was sent/)).toBeTruthy();
  });

  it("recovers an unconfirmed recorded-payment request after remount without auto replay", async () => {
    let attempts = 0;
    const issued = sampleInvoice({
      status: "issued",
      invoiceNumber: "INV-000001",
      balanceDueCents: 10000,
    });
    const api = server("office", issued, (request) => {
      if (request.method === "POST" && request.path.endsWith("/payments")) {
        attempts += 1;
        if (attempts === 1) throw new TypeError("Synthetic dropped response");
        return json({
          invoice: sampleInvoice({
            ...issued,
            version: 2,
            recordedPaidCents: 2500,
            recordedBalanceCents: 7500,
            balanceDueCents: 7500,
            paymentState: "partial",
          }),
          duplicate: true,
        });
      }
      return undefined;
    });
    const view = renderInvoices();
    fireEvent.click(
      await screen.findByRole("button", { name: "Record payment" }),
    );
    const form = screen.getByRole("form", { name: "Record payment" });
    fireEvent.change(within(form).getByLabelText("Amount (USD)"), {
      target: { value: "25.00" },
    });
    fireEvent.change(within(form).getByLabelText("Original source reference"), {
      target: { value: "synthetic-check-2026" },
    });
    fireEvent.click(within(form).getByRole("checkbox"));
    fireEvent.click(
      within(form).getByRole("button", { name: "Record payment" }),
    );
    await screen.findByRole("button", { name: "Retry saved request" });
    const first = writes(api.requests)[0].body;
    view.unmount();
    renderInvoices();
    await screen.findByRole("button", { name: "Retry saved request" });
    expect(attempts).toBe(1);
    fireEvent.click(
      screen.getByRole("button", { name: "Retry saved request" }),
    );
    await screen.findByText(/saved request was already completed/);
    expect(writes(api.requests)[1].body).toEqual(first);
    expect(
      screen.getByRole("region", { name: "Invoice balance" }).textContent,
    ).toContain("$75.00");
  });

  it("withholds paid claims during refund reconciliation and applies existing evidence without another receipt", async () => {
    const receiptId = "00000000-0000-4000-8000-000000000444";
    const held = sampleInvoice({
      status: "issued",
      invoiceNumber: "INV-000001",
      recordedPaidCents: 10000,
      recordedBalanceCents: 0,
      paymentState: "reconciliation_required",
      reconciliationRequired: true,
      unallocatedRefundCents: 2500,
      availableValueEntries: [
        {
          id: receiptId,
          kind: "refund",
          sourceReference: "synthetic-refund",
          amountCents: 2500,
          availableCents: 2500,
          occurredAt: "2026-10-01T12:00:00Z",
        },
      ],
    });
    const api = server("office", held, (request) =>
      request.method === "POST"
        ? json({
            invoice: sampleInvoice({
              ...held,
              version: 2,
              recordedPaidCents: 7500,
              recordedBalanceCents: 2500,
              balanceDueCents: 2500,
              paymentState: "partial",
              reconciliationRequired: false,
              unallocatedRefundCents: 0,
            }),
            duplicate: false,
          })
        : undefined,
    );
    renderInvoices();
    await screen.findAllByText("Needs reconciliation");
    expect(screen.queryByText("Recorded paid")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Apply existing record" }),
    );
    const form = screen.getByRole("form", { name: "Apply existing record" });
    fireEvent.change(within(form).getByLabelText("Existing record"), {
      target: { value: receiptId },
    });
    fireEvent.click(within(form).getByRole("checkbox"));
    fireEvent.click(
      within(form).getByRole("button", { name: "Apply existing record" }),
    );
    await screen.findByText("Invoice record saved.");
    expect(writes(api.requests)[0]).toMatchObject({
      path: `/api/v1/invoices/${invoiceId}/allocations`,
      body: { valueEntryId: receiptId, amountCents: 2500, confirmed: true },
    });
    expect(
      writes(api.requests).some((request) =>
        request.path.endsWith("/payments"),
      ),
    ).toBe(false);
  });

  it("preserves a list failure rather than displaying no invoices", async () => {
    server("office", sampleInvoice(), (request) =>
      request.path === "/api/v1/invoices"
        ? json({ error: "Unavailable" }, 503)
        : undefined,
    );
    renderInvoices("/invoices");
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Invoices could not load",
    );
    expect(screen.queryByText("No invoices match this view.")).toBeNull();
  });

  it("retains an unissued voided draft without claiming it was issued or paid", async () => {
    const api = server("office", sampleInvoice(), (request) =>
      request.method === "POST" && request.path.endsWith("/void")
        ? json({
            invoice: sampleInvoice({
              status: "void",
              version: 2,
              voidReason: "Duplicate preparation removed",
              voidedAt: "2026-10-01T13:00:00Z",
            }),
            duplicate: false,
          })
        : undefined,
    );
    renderInvoices();
    fireEvent.click(
      await screen.findByRole("button", { name: "Void invoice" }),
    );
    const form = screen.getByRole("form", { name: "Void invoice" });
    fireEvent.change(within(form).getByLabelText("Reason for this change"), {
      target: { value: "Duplicate preparation removed" },
    });
    expect(
      within(form)
        .getByRole("button", { name: "Void invoice" })
        .matches(":disabled"),
    ).toBe(true);
    fireEvent.click(within(form).getByRole("checkbox"));
    fireEvent.click(within(form).getByRole("button", { name: "Void invoice" }));
    await screen.findByRole("heading", { name: "Voided draft" });
    expect(
      screen.getByRole("heading", { name: "Voided draft document" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "Issued document" }),
    ).toBeNull();
    expect(
      screen.getByRole("region", { name: "Invoice balance" }).textContent,
    ).toContain("Not issued");
    expect(writes(api.requests)[0]).toMatchObject({
      path: `/api/v1/invoices/${invoiceId}/void`,
      body: {
        reason: "Duplicate preparation removed",
        confirmed: true,
        expectedVersion: 1,
      },
    });
    expect(screen.queryByRole("button", { name: "Record payment" })).toBeNull();
  });

  it("reverses only a reviewed allocation and keeps the original cash evidence", async () => {
    const allocation = {
      id: "00000000-0000-4000-8000-000000000555",
      valueEntryId: "00000000-0000-4000-8000-000000000444",
      kind: "payment" as const,
      sourceReference: "synthetic-receipt",
      amountCents: 2500,
      occurredAt: "2026-10-01T12:00:00Z",
      allocatedAt: "2026-10-01T12:00:00Z",
      reversedAt: null,
      reversalReason: null,
    };
    const issued = sampleInvoice({
      status: "issued",
      issuedAt: "2026-10-01T12:00:00Z",
      invoiceNumber: "INV-000001",
      recordedPaidCents: 2500,
      balanceDueCents: 7500,
      paymentState: "partial",
      allocations: [allocation],
    });
    const api = server("office", issued, (request) =>
      request.method === "POST" && request.path.endsWith("/reverse")
        ? json({
            invoice: sampleInvoice({
              ...issued,
              version: 2,
              recordedPaidCents: 0,
              balanceDueCents: 10000,
              paymentState: "unpaid",
              allocations: [
                {
                  ...allocation,
                  reversedAt: "2026-10-01T13:00:00Z",
                  reversalReason: "Applied to the incorrect invoice",
                },
              ],
            }),
            duplicate: false,
          })
        : undefined,
    );
    renderInvoices();
    fireEvent.click(
      await screen.findByRole("button", { name: "Reverse allocation" }),
    );
    const form = screen.getByRole("form", { name: "Reverse allocation" });
    expect(form.textContent).toContain("No money is refunded");
    fireEvent.change(within(form).getByLabelText("Allocation to reverse"), {
      target: { value: allocation.id },
    });
    fireEvent.change(within(form).getByLabelText("Reason for this change"), {
      target: { value: "Applied to the incorrect invoice" },
    });
    fireEvent.click(within(form).getByRole("checkbox"));
    fireEvent.click(
      within(form).getByRole("button", { name: "Reverse allocation" }),
    );
    await screen.findByText("Invoice record saved.");
    expect(writes(api.requests)).toHaveLength(1);
    expect(writes(api.requests)[0]).toMatchObject({
      path: `/api/v1/invoices/${invoiceId}/allocations/${allocation.id}/reverse`,
      body: {
        reason: "Applied to the incorrect invoice",
        expectedVersion: 1,
        confirmed: true,
      },
    });
    expect(screen.getByText("synthetic-receipt")).toBeTruthy();
    expect(
      screen.getByRole("region", { name: "Invoice balance" }).textContent,
    ).toContain("$100.00");
  });
});
