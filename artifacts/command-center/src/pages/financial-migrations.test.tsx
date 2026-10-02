import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import FinancialMigrations from "./financial-migrations";
import { mockApi } from "@/test/mock-api";
import { renderWithQuery } from "@/test/render";

const invoice = {
  externalId: "source-1",
  invoiceNumber: "OLD-001",
  leadId: "lead-1",
  issuedAt: "2026-08-01T12:00:00Z",
  basis: "opening_receivable",
  balanceAtCutoffCents: 7000,
  document: {
    title: "Original invoice",
    customerName: "Synthetic Customer",
    totalCents: 10000,
  },
};
function review(state = "review") {
  return {
    id: "review-1",
    digest: "d".repeat(64),
    rawSha256: "a".repeat(64),
    state,
    source: {
      format: "growthos-financial-migration",
      version: 1,
      sourceSystem: "synthetic",
      sourceAccount: "source-company",
      cutoffAt: "2026-09-01T00:00:00Z",
      invoices: [invoice],
      receipts: [],
      controlTotals: {
        invoiceCount: 1,
        documentTotalCents: 10000,
        openingReceivableCents: 7000,
        balanceDueCents: 7000,
        paymentCents: 0,
        refundCents: 0,
      },
    },
    mappings: [
      {
        leadId: "lead-1",
        contactId: "contact-1",
        customerName: "Synthetic Customer",
      },
    ],
    duplicateInvoices: 0,
    duplicateReceipts: 0,
    expiresAt: new Date(Date.now() + 30 * 60000).toISOString(),
    createdAt: "2026-10-02T12:00:00Z",
    committedAt: state === "committed" ? "2026-10-02T12:05:00Z" : null,
    result:
      state === "committed"
        ? {
            importedInvoices: 1,
            importedReceipts: 0,
            duplicateInvoices: 0,
            duplicateReceipts: 0,
            invoiceIds: ["invoice-1"],
          }
        : null,
  };
}
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
function server(
  role = "owner",
  options: { invalid?: boolean; lostAck?: boolean } = {},
) {
  const calls: {
    path: string;
    method: string;
    body: Record<string, unknown>;
  }[] = [];
  const mock = mockApi(role),
    fallback = mock.getMockImplementation()!;
  let committed = false;
  mock.mockImplementation(async (input, init) => {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const path = new URL(raw, "http://localhost").pathname,
      method = init?.method ?? "GET",
      body = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : {};
    calls.push({ path, method, body });
    if (path === "/api/v1/financial-migrations")
      return json({ items: [], limit: 30 });
    if (path === "/api/v1/financial-migrations/preview")
      return json(
        options.invalid
          ? {
              valid: false,
              issues: [
                {
                  path: "invoices.0",
                  message:
                    "Unsupported credit: reconcile instead of inventing cash.",
                },
              ],
            }
          : { valid: true, review: review() },
      );
    if (path === "/api/v1/financial-migrations/review-1/commit") {
      committed = true;
      if (options.lostAck)
        throw new TypeError("Synthetic lost acknowledgement");
      return json(review("committed"));
    }
    if (path === "/api/v1/financial-migrations/review-1")
      return json(review(committed ? "committed" : "review"));
    return fallback(input, init);
  });
  return calls;
}
async function prepare() {
  await screen.findByRole("heading", { name: "Bring over invoice history" });
  fireEvent.change(screen.getByLabelText("Normalized source JSON"), {
    target: { value: '{"format":"synthetic-fixture"}' },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Preview and reconcile" }),
  );
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("financial migration owner review", () => {
  it.each(["office", "sales_manager", "viewer"])(
    "does not fetch financial reviews for %s",
    async (role) => {
      const calls = server(role);
      renderWithQuery(<FinancialMigrations />);
      await screen.findByRole("heading", {
        name: "Financial migration is restricted",
      });
      expect(
        calls.some((c) => c.path.startsWith("/api/v1/financial-migrations")),
      ).toBe(false);
    },
  );
  it("shows unsupported source exceptions and never offers commit", async () => {
    const calls = server("owner", { invalid: true });
    renderWithQuery(<FinancialMigrations />);
    await prepare();
    await screen.findByText(/Unsupported credit/);
    expect(
      screen.queryByRole("button", { name: "Approve and import exact review" }),
    ).toBeNull();
    expect(calls.some((c) => c.path.endsWith("/commit"))).toBe(false);
  });
  it("requires both exact-review and one-writer confirmations and sends only the server digest", async () => {
    const calls = server();
    renderWithQuery(<FinancialMigrations />);
    await prepare();
    const commit = await screen.findByRole("button", {
      name: "Approve and import exact review",
    });
    expect((commit as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByText(/Opening receivable — prior cash unknown/),
    ).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/I reviewed the original documents/));
    expect((commit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(
      screen.getByLabelText(/source financial records are frozen/),
    );
    fireEvent.click(commit);
    await screen.findByRole("heading", {
      name: "Financial migration committed",
    });
    const sends = calls.filter((c) => c.path.endsWith("/commit"));
    expect(sends).toHaveLength(1);
    expect(sends[0]!.body).toEqual({
      expectedDigest: "d".repeat(64),
      confirmed: true,
      sourceFrozen: true,
    });
    expect(
      screen.getByRole("link", { name: "Open invoice 1" }).getAttribute("href"),
    ).toBe("/invoices/invoice-1");
  });
  it("invalidates an existing approval whenever source text changes", async () => {
    const calls = server();
    renderWithQuery(<FinancialMigrations />);
    await prepare();
    await screen.findByRole("button", {
      name: "Approve and import exact review",
    });
    fireEvent.click(screen.getByLabelText(/I reviewed the original documents/));
    fireEvent.change(screen.getByLabelText("Normalized source JSON"), {
      target: { value: "changed source" },
    });
    expect(
      screen.queryByRole("button", { name: "Approve and import exact review" }),
    ).toBeNull();
    expect(calls.some((c) => c.path.endsWith("/commit"))).toBe(false);
  });
  it("blocks new preview/commit after a lost acknowledgement until the same saved review is checked", async () => {
    const calls = server("owner", { lostAck: true });
    renderWithQuery(<FinancialMigrations />);
    await prepare();
    const commit = await screen.findByRole("button", {
      name: "Approve and import exact review",
    });
    fireEvent.click(screen.getByLabelText(/I reviewed the original documents/));
    fireEvent.click(
      screen.getByLabelText(/source financial records are frozen/),
    );
    fireEvent.click(commit);
    await screen.findByText(/Commit acknowledgement is unavailable/);
    expect((commit as HTMLButtonElement).disabled).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "Preview and reconcile",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Check saved review" }));
    await screen.findByRole("heading", {
      name: "Financial migration committed",
    });
    await waitFor(() =>
      expect(calls.filter((c) => c.path.endsWith("/commit"))).toHaveLength(1),
    );
  });
});
