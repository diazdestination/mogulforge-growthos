import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { afterEach, describe, expect, it, vi } from "vitest";
import TechDay, { type MyDay, type MyDayJob } from "./tech";
import { mockApi } from "@/test/mock-api";
import { renderWithQuery } from "@/test/render";

vi.mock("@/components/visit-work-panel", () => ({
  default: ({ appointmentId }: { appointmentId: string }) => <section aria-label="Visit work">Visit work for {appointmentId}</section>,
}));

function job(overrides: Partial<MyDayJob> = {}): MyDayJob {
  return {
    id: "a1",
    type: "service_call",
    status: "scheduled",
    scheduledStart: "2026-11-11T15:00:00.000Z",
    scheduledEnd: "2026-11-11T17:00:00.000Z",
    notes: "Gate code is with the office.",
    leadId: "l1",
    contactId: "c1",
    customerName: "Dana Reyes",
    customerPhone: "(512) 555-0142",
    propertyId: "p1",
    address: "12 Oak St, Austin, TX 78701",
    directionsUrl: "https://www.google.com/maps/dir/?api=1&destination=12%20Oak%20St",
    invoices: [{ id: "i1", invoiceNumber: "INV-7", title: "Repair", totalCents: 25000, balanceDueCents: 25000, paymentState: "unpaid" }],
    onMyWay: null,
    ...overrides,
  };
}
function day(overrides: Partial<MyDay> = {}): MyDay {
  return {
    organizationId: "o1",
    userId: "u1",
    generatedAt: "2026-11-11T12:00:00Z",
    date: "2026-11-11",
    timeZone: "America/Chicago",
    canReadInvoices: true,
    canCollectPayments: true,
    texting: { onMyWay: true, payLink: true },
    today: [job()],
    upcoming: [job({ id: "a2", customerName: "Lee Park", scheduledStart: "2026-11-12T15:00:00.000Z", scheduledEnd: null })],
    ...overrides,
  };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Call = { method: string; path: string; body: unknown };

function renderTech(data: MyDay, options: { path?: string; role?: string; handler?: (method: string, path: string) => Response | undefined } = {}) {
  const calls: Call[] = [];
  const fetchMock = mockApi(options.role ?? "production", {
    handler: (method, path) => {
      if (path.endsWith("/api/v1/contractor/my-day")) return json(data);
      return options.handler?.(method, path);
    },
  });
  const original = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ method: (init?.method ?? "GET").toUpperCase(), path: raw.split("?")[0]!, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    return original(input, init);
  });
  const location = memoryLocation({ path: options.path ?? "/tech", record: true });
  renderWithQuery(
    <Router hook={location.hook}>
      <TechDay />
    </Router>,
  );
  return { calls, location };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("My day tech screen", () => {
  it("lists today's jobs with tap-to-call, directions and the next days collapsed", async () => {
    renderTech(day());
    const card = await screen.findByRole("article", { name: /Dana Reyes/ });
    expect(within(card).getByText(/^9:00\sAM – 11:00\sAM$/)).toBeTruthy();
    expect(within(card).getByText("12 Oak St, Austin, TX 78701")).toBeTruthy();
    expect(within(card).getByRole("link", { name: "Call Dana Reyes" }).getAttribute("href")).toBe("tel:5125550142");
    expect(within(card).getByRole("link", { name: /Directions to/ }).getAttribute("href")).toContain("https://www.google.com/maps/dir/");
    expect(within(card).getByRole("link", { name: "Open job" }).getAttribute("href")).toBe("/tech?job=a1");
    const upcoming = screen.getByText("Next few days (1)").closest("details")!;
    expect(upcoming.open).toBe(false);
    expect(within(upcoming).getByText(/Lee Park/)).toBeTruthy();
  });

  it("sends On My Way with the chosen ETA and reports that it waits for approval", async () => {
    const { calls } = renderTech(day(), {
      path: "/tech?job=a1",
      handler: (method, path) => (method === "POST" && path.endsWith("/flows/appointments/a1/on-my-way") ? json({ execution: { state: "pending_approval" } }) : undefined),
    });
    expect(await screen.findByRole("heading", { name: "Dana Reyes" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Visit work" }).textContent).toContain("a1");
    fireEvent.change(screen.getByLabelText("Arriving in about"), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Send On My Way" }));
    expect(await screen.findByText("Waiting for approval. Not sent yet.")).toBeTruthy();
    expect(calls.find((call) => call.method === "POST" && call.path.endsWith("/on-my-way"))?.body).toEqual({ etaMinutes: 20 });
    expect((screen.getByRole("button", { name: "Send On My Way" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("explains when On My Way texting is not set up and shows an existing request", async () => {
    renderTech(day({ texting: { onMyWay: false, payLink: false } }), { path: "/tech?job=a1" });
    expect(await screen.findByText(/On My Way texts are not set up/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send On My Way" })).toBeNull();
    cleanup();
    renderTech(day({ today: [job({ onMyWay: { state: "succeeded", etaMinutes: 15 } })] }), { path: "/tech?job=a1" });
    expect(await screen.findByText("On My Way sent to Zapier · about 15 minutes")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Send On My Way" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("creates a pay link for the balance, shows the QR and texts the link", async () => {
    let links: unknown[] = [];
    const { calls } = renderTech(day(), {
      path: "/tech?job=a1",
      handler: (method, path) => {
        if (path.endsWith("/appointments/a1/invoices/i1/payment-links") && method === "GET") return json({ links });
        if (path.endsWith("/appointments/a1/invoices/i1/payment-links") && method === "POST") {
          links = [{ id: "pl1", amountCents: 25000, url: "https://checkout.stripe.test/c/1", state: "open", expiresAt: new Date(Date.now() + 86_400_000).toISOString() }];
          return json({ link: links[0] }, 201);
        }
        if (path.endsWith("/appointments/a1/invoices/i1/payment-links/pl1/qr")) return json({ linkId: "pl1", url: "https://checkout.stripe.test/c/1", qrDataUrl: "data:image/png;base64,AAAA" });
        if (path.endsWith("/flows/appointments/a1/invoices/i1/pay-link-text") && method === "POST") return json({ execution: { state: "succeeded" } });
        return undefined;
      },
    });
    const section = await screen.findByRole("region", { name: "Collect payment" });
    expect(within(section).getByText("$250.00")).toBeTruthy();
    expect(within(section).getByText(/Stripe test mode/)).toBeTruthy();
    fireEvent.click(await within(section).findByRole("button", { name: "Create pay link for $250.00" }));
    fireEvent.click(await within(section).findByRole("button", { name: "Show QR code" }));
    const qr = await within(section).findByRole("img", { name: "QR code to pay $250.00" });
    expect(qr.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(within(section).getByRole("link", { name: "Open pay page on this phone" }).getAttribute("href")).toBe("https://checkout.stripe.test/c/1");
    fireEvent.click(within(section).getByRole("button", { name: "Text pay link" }));
    expect(await within(section).findByText("Sent to Zapier. Your phone app sends it from your business number.")).toBeTruthy();
    expect(calls.filter((call) => call.method === "POST").map((call) => call.path.replace(/^.*\/api\/v1/, ""))).toEqual([
      "/appointments/a1/invoices/i1/payment-links",
      "/integrations/zapier/flows/appointments/a1/invoices/i1/pay-link-text",
    ]);
  });

  it("says why a pay link can't be made and labels live mode", async () => {
    renderTech(day(), {
      path: "/tech?job=a1",
      handler: (method, path) => (path.endsWith("/appointments/a1/invoices/i1/payment-links") && method === "GET"
        ? json({ links: [], readiness: { configured: true, mode: "live", onboarding: "needs_info", canCreateLinks: false, message: "Stripe setup is not finished, so pay links are off. The owner can finish it in Settings → Connections." } })
        : undefined),
    });
    const section = await screen.findByRole("region", { name: "Collect payment" });
    expect(await within(section).findByText(/Stripe setup is not finished, so pay links are off/)).toBeTruthy();
    expect(within(section).getByText(/Live: the customer's card or bank is charged for real/)).toBeTruthy();
    expect(within(section).queryByRole("button", { name: /Create pay link/ })).toBeNull();
  });

  it("shows what is needed when there is no invoice, or no invoice access, instead of inventing one", async () => {
    renderTech(day({ today: [job({ invoices: [] })] }), { path: "/tech?job=a1" });
    const section = await screen.findByRole("region", { name: "Collect payment" });
    expect(within(section).getByText(/No issued invoice with a balance/)).toBeTruthy();
    expect(within(section).getByRole("link", { name: "Open invoices" }).getAttribute("href")).toBe("/invoices?leadId=l1");
    cleanup();
    renderTech(day({ canReadInvoices: false, canCollectPayments: false, today: [job({ invoices: null })] }), { path: "/tech?job=a1" });
    expect(await screen.findByText(/needs field collection access/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Create pay link/ })).toBeNull();
  });

  it("lets a field tech without invoice access collect on their own job, scoped to that job", async () => {
    const { calls } = renderTech(day({ canReadInvoices: false, canCollectPayments: true }), {
      path: "/tech?job=a1",
      handler: (method, path) => (path.endsWith("/appointments/a1/invoices/i1/payment-links") && method === "GET" ? json({ links: [] }) : undefined),
    });
    const section = await screen.findByRole("region", { name: "Collect payment" });
    expect(await within(section).findByRole("button", { name: "Create pay link for $250.00" })).toBeTruthy();
    expect(calls.some((call) => call.path.endsWith("/api/v1/appointments/a1/invoices/i1/payment-links"))).toBe(true);
    expect(calls.some((call) => /\/api\/v1\/invoices\//.test(call.path))).toBe(false);
    cleanup();
    renderTech(day({ canReadInvoices: false, today: [job({ invoices: [] })] }), { path: "/tech?job=a1" });
    const empty = await screen.findByRole("region", { name: "Collect payment" });
    expect(within(empty).getByText(/No issued invoice with a balance is linked to this job/)).toBeTruthy();
    expect(within(empty).queryByRole("link", { name: "Open invoices" })).toBeNull();
  });

  it("says Sent to Zapier when the tap goes straight out under the Automatic policy", async () => {
    renderTech(day(), {
      path: "/tech?job=a1",
      handler: (method, path) => (method === "POST" && path.endsWith("/flows/appointments/a1/on-my-way") ? json({ execution: { state: "succeeded" } }) : undefined),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Send On My Way" }));
    expect(await screen.findByText("Sent to Zapier. Your phone app sends it from your business number.")).toBeTruthy();
  });

  it("goes back to the list from a job", async () => {
    const { location } = renderTech(day(), { path: "/tech?job=a1" });
    fireEvent.click(await screen.findByRole("button", { name: "Back to my day" }));
    await waitFor(() => expect(location.history.at(-1)).toBe("/tech"));
  });
});
