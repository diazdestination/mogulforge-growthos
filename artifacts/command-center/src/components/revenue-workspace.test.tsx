import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RevenueWorkspace,
  ValueLedger,
  parseRecordedCents,
} from "./revenue-workspace";
import { renderWithQuery } from "@/test/render";
import { mockApi } from "@/test/mock-api";
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const desk = () => ({
  queue: [
    {
      leadId: "lead-one",
      contactName: "Local Customer",
      title: "Review this inquiry",
      reasons: ["No recorded response"],
      assignedUserId: null,
      receivedAt: "2026-09-14T12:00:00Z",
      source: "qa",
      proposals: [],
    },
  ],
  records: [{ id: "lead-one", summary: "LOCAL QA roof", status: "new" }],
  proposals: [],
  profile: null,
  executions: [],
  staff: [],
  followup: {
    summary: { unassigned: 1, overdue: 1, awaitingAttempt: 1 },
    pending: [],
  },
  boundary: "Suggestions are not delivery.",
});
const ledger = () => ({
  entryCount: 0,
  receiptEntryCount: 0,
  costEntryCount: 0,
  acceptedEstimateCount: 0,
  acceptedEstimateCents: 0,
  completedProjectCount: 0,
  netReceiptsCents: 0,
  netDirectCostsCents: 0,
  recordedContributionCents: null,
  entries: [],
  boundary: "Staff-recorded data is not a bank feed or causal ROI.",
});
it('labels returning receipts separately, links exact customer history and never fabricates acquisition evidence', async () => {
  const organizationId = '00000000-0000-4000-8000-000000000001', contactId = '00000000-0000-4000-8000-000000000002', customerWorkId = '00000000-0000-4000-8000-000000000003';
  mockApi('owner', { handler: (_method, path) => path.endsWith('/revenue/value') ? response({ ...ledger(), entryCount: 2, receiptEntryCount: 2, netReceiptsCents: 7500, entries: [{ id: 'receipt', organizationId, contactId, leadId: null, customerWorkId, refundOfValueEntryId: null, kind: 'payment', amountCents: 10000, sourceReference: 'ACTUAL-RECORDED-CHECK', occurredAt: '2026-10-01T00:00:00Z' }, { id: 'refund', organizationId, contactId, leadId: null, customerWorkId, refundOfValueEntryId: 'receipt', kind: 'refund', amountCents: 2500, sourceReference: 'ACTUAL-EXTERNAL-CORRECTION', occurredAt: '2026-10-02T00:00:00Z' }], sourceBreakdown: [{ source: 'lead', entryCount: 0, netReceiptsCents: 0, netDirectCostsCents: 0 }, { source: 'customer_work', entryCount: 2, netReceiptsCents: 7500, netDirectCostsCents: 0 }] }) : undefined });
  renderWithQuery(<ValueLedger />); await screen.findByText('Existing-customer work'); expect(screen.getByText(/Returning work is not new acquisition/)).toBeTruthy(); expect(screen.getByText(/External refund correction of receipt receipt/)).toBeTruthy(); expect(screen.getByRole('link', { name: 'ACTUAL-RECORDED-CHECK' }).getAttribute('href')).toBe(`/contacts/${contactId}?organizationId=${organizationId}&section=invoices`); expect(document.querySelector('a[href*="leads/null"]')).toBeNull(); expect(screen.getByText('Not available')).toBeTruthy();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
describe("Revenue Desk workflows", () => {
  const proposal = () => ({
    id: "email-one",
    leadId: "lead-one",
    title: "Review follow-up",
    actionType: "send_email",
    status: "proposed",
    rationale: "LOCAL QA only",
    executionDetail: null,
    payload: { subject: "Original subject", body: "Original message" },
  });
  async function openProposal() {
    const saved = proposal();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const spy = mockApi("owner", {
      handler: (_method, path) =>
        path.endsWith("/revenue/desk")
          ? response({ ...desk(), proposals: [saved] })
          : undefined,
    });
    render(
      <QueryClientProvider client={client}>
        <RevenueWorkspace />
      </QueryClientProvider>,
    );
    await screen.findByText("Review follow-up");
    fireEvent.click(screen.getByText("Review message content"));
    let revision = 0;
    return {
      saved,
      spy,
      update: async (next: ReturnType<typeof proposal>) => {
        const title = `Review follow-up ${++revision}`;
        act(() =>
          client.setQueryData(["revenue", "desk"], {
            ...desk(),
            proposals: [{ ...next, title }],
          }),
        );
        await screen.findByText(title);
      },
    };
  }
  it("shows the current approved message after a server refresh", async () => {
    const { saved, update } = await openProposal();
    await update({
      ...saved,
      status: "approved",
      payload: { subject: "Approved subject", body: "Approved message" },
    });
    expect(
      (screen.getByLabelText("Email subject") as HTMLInputElement).value,
    ).toBe("Approved subject");
    expect(
      (screen.getByLabelText("Email body") as HTMLTextAreaElement).value,
    ).toBe("Approved message");
    expect(
      (
        screen.getByRole("button", {
          name: "Send approved email",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });
  it("requires explicit prepare, displays exact frozen recipient and sender, then approves the complete saved payload", async () => {
    const { saved, spy } = await openProposal();
    const original = spy.getMockImplementation()!,
      originalPayload = { ...saved.payload };
    const emailReview = {
      version: 1,
      preparedByUserId: "staff-one",
      preparedAt: "2026-10-02T12:00:00Z",
      recipient: "customer@example.invalid",
      sender: { provider: "microsoft", senderEmail: "staff@example.invalid" },
      leadId: saved.leadId,
      contactId: "contact-one",
      leadCreatedAt: "2026-10-01T12:00:00Z",
      leadUpdatedAt: "2026-10-01T12:00:00Z",
    };
    const snapshot = {
      version: 1,
      kind: "bie_lead_email",
      recipient: emailReview.recipient,
      mailboxIdentity: {
        provider: "microsoft",
        mailboxEmail: emailReview.sender.senderEmail,
      },
      leadMonitoringApproval: {
        version: 3,
        approvedAt: "2026-10-02T11:00:00Z",
      },
    };
    spy.mockImplementation(async (url, init) => {
      if (String(url).endsWith("/prepare-email")) {
        Object.assign(saved.payload, {
          emailReview,
          deliverySnapshot: snapshot,
        });
        return response(saved);
      }
      if (String(url).endsWith("/approve")) {
        saved.status = "approved";
        return response(saved);
      }
      return original(url, init);
    });
    expect(
      screen
        .getByRole("button", { name: "Approve saved action" })
        .hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: "Prepare recipient and sender" }),
    );
    await screen.findByText(/customer@example.invalid/);
    expect(screen.getByText(/staff@example.invalid/)).toBeTruthy();
    await screen.findByText(/Tracked Microsoft lead reply/);
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Approve saved action" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Approve saved action" }),
    );
    await screen.findByText("Action approved; not yet executed.");
    expect(
      JSON.parse(
        String(
          spy.mock.calls.find(([url]) =>
            String(url).endsWith("/prepare-email"),
          )?.[1]?.body,
        ),
      ),
    ).toEqual({ expectedPayload: originalPayload });
    expect(
      JSON.parse(
        String(
          spy.mock.calls.find(([url]) => String(url).endsWith("/approve"))?.[1]
            ?.body,
        ),
      ),
    ).toEqual({
      expectedPayload: {
        ...originalPayload,
        emailReview,
        deliverySnapshot: snapshot,
      },
    });
    expect(
      spy.mock.calls.some(([url]) => String(url).endsWith("/execute")),
    ).toBe(false);
  });
  it("stops stale prepare after a conflict until an explicit workspace refresh", async () => {
    const { spy } = await openProposal(),
      original = spy.getMockImplementation()!;
    spy.mockImplementation(async (url, init) =>
      String(url).endsWith("/prepare-email")
        ? response({ error: "Saved email changed. Review again." }, 409)
        : original(url, init),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Prepare recipient and sender" }),
    );
    await screen.findByText("Saved email changed. Review again.");
    expect(
      screen
        .getByRole("button", { name: "Prepare recipient and sender" })
        .matches(":disabled"),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Refresh workspace" }));
    await screen.findByText("Workspace refreshed.");
    expect(
      screen
        .getByRole("button", { name: "Prepare recipient and sender" })
        .hasAttribute("disabled"),
    ).toBe(false);
    expect(
      spy.mock.calls.filter(([url]) => String(url).endsWith("/prepare-email")),
    ).toHaveLength(1);
  });
  it("freezes the reviewed draft while a save is pending and sends it only once", async () => {
    const { spy } = await openProposal();
    const original = spy.getMockImplementation()!;
    let finishSave!: () => void;
    const pending = new Promise<void>((resolve) => {
      finishSave = resolve;
    });
    spy.mockImplementation(async (url, init) => {
      if (init?.method === "PATCH") {
        await pending;
        return response({ saved: true });
      }
      return original(url, init);
    });
    fireEvent.change(screen.getByLabelText("Email body"), {
      target: { value: "Message being saved" },
    });
    const save = screen.getByRole("button", { name: "Save draft edits" });
    fireEvent.click(save);
    fireEvent.click(save);
    expect(
      (screen.getByLabelText("Email subject") as HTMLInputElement).readOnly,
    ).toBe(true);
    expect(
      (screen.getByLabelText("Email body") as HTMLTextAreaElement).readOnly,
    ).toBe(true);
    expect(
      spy.mock.calls.filter(([, init]) => init?.method === "PATCH"),
    ).toHaveLength(1);
    await act(async () => finishSave());
    await screen.findByText("Draft updated. Review it before approval.");
  });
  it("preserves conflicting local edits and blocks save and approval until explicitly discarded", async () => {
    const { saved, update, spy } = await openProposal();
    fireEvent.change(screen.getByLabelText("Email body"), {
      target: { value: "My unsaved message" },
    });
    await update({
      ...saved,
      payload: { subject: "New saved subject", body: "Other operator message" },
    });
    expect(
      (screen.getByLabelText("Email body") as HTMLTextAreaElement).value,
    ).toBe("My unsaved message");
    expect(screen.getByRole("alert").textContent).toContain(
      "saved action changed",
    );
    for (const name of ["Save draft edits", "Approve saved action"]) {
      const control = screen.getByRole("button", { name }) as HTMLButtonElement;
      expect(control.disabled).toBe(true);
      fireEvent.click(control);
    }
    expect(
      spy.mock.calls.filter(
        ([, init]) => init?.method === "POST" || init?.method === "PATCH",
      ),
    ).toHaveLength(0);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Discard local edits and load saved message",
      }),
    );
    expect(
      (screen.getByLabelText("Email body") as HTMLTextAreaElement).value,
    ).toBe("Other operator message");
    expect(
      (
        screen.getByRole("button", {
          name: "Approve saved action",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
  it.each([false, true])(
    "blocks sending when local edits outlive external approval (payload changed: %s)",
    async (changed) => {
      const { saved, update, spy } = await openProposal();
      fireEvent.change(screen.getByLabelText("Email body"), {
        target: { value: "Unsaved local content" },
      });
      await update({
        ...saved,
        status: "approved",
        payload: changed
          ? { subject: "New approved subject", body: "New approved content" }
          : saved.payload,
      });
      const send = screen.getByRole("button", {
        name: "Send approved email",
      }) as HTMLButtonElement;
      expect(send.disabled).toBe(true);
      fireEvent.click(send);
      expect(
        spy.mock.calls.some(([url]) => String(url).endsWith("/execute")),
      ).toBe(false);
      expect(
        (screen.getByLabelText("Email body") as HTMLTextAreaElement).value,
      ).toBe("Unsaved local content");
      fireEvent.click(
        screen.getByRole("button", {
          name: "Discard local edits and load saved message",
        }),
      );
      expect(
        (screen.getByLabelText("Email body") as HTMLTextAreaElement).value,
      ).toBe(changed ? "New approved content" : "Original message");
      expect(send.disabled).toBe(false);
    },
  );
  it("accepts a saved draft acknowledgement and keeps following later server content", async () => {
    const { saved, update } = await openProposal();
    fireEvent.change(screen.getByLabelText("Email body"), {
      target: { value: "My saved message" },
    });
    await update({
      ...saved,
      payload: { ...saved.payload, body: "My saved message" },
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      (
        screen.getByRole("button", {
          name: "Approve saved action",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    await update({
      ...saved,
      status: "approved",
      payload: { ...saved.payload, body: "Later approved message" },
    });
    expect(
      (screen.getByLabelText("Email body") as HTMLTextAreaElement).value,
    ).toBe("Later approved message");
  });
  it("preserves local edits through refresh failure and never reports a failed refresh as successful", async () => {
    let offline = false;
    mockApi("owner", {
      handler: (_method, path) =>
        path.endsWith("/revenue/desk")
          ? response(
              offline
                ? { error: "offline" }
                : { ...desk(), proposals: [proposal()] },
              offline ? 503 : 200,
            )
          : undefined,
    });
    renderWithQuery(<RevenueWorkspace />);
    await screen.findByText("Review follow-up");
    fireEvent.click(screen.getByText("Review message content"));
    fireEvent.change(screen.getByLabelText("Email body"), {
      target: { value: "Keep these edits" },
    });
    offline = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh workspace" }));
    await screen.findByText(/Last loaded data is shown/);
    expect(
      (screen.getByLabelText("Email body") as HTMLTextAreaElement).value,
    ).toBe("Keep these edits");
    expect(screen.queryByText("Workspace refreshed.")).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Save draft edits" })
        .matches(":disabled"),
    ).toBe(true);
    offline = false;
    fireEvent.click(screen.getByRole("button", { name: "Refresh workspace" }));
    await screen.findByText("Workspace refreshed.");
    expect(
      (screen.getByLabelText("Email body") as HTMLTextAreaElement).value,
    ).toBe("Keep these edits");
    expect(
      screen
        .getByRole("button", { name: "Save draft edits" })
        .matches(":disabled"),
    ).toBe(false);
  });
  it("separates successful action receipts from failed data refreshes and retries only reads", async () => {
    let claimed = false;
    let offline = false;
    const spy = mockApi("owner", {
      handler: (method, path) => {
        if (path.endsWith("/claim") && method === "POST") {
          claimed = true;
          offline = true;
          return response({ id: "lead-one" });
        }
        if (path.endsWith("/revenue/desk"))
          return response(
            offline
              ? { error: "offline" }
              : {
                  ...desk(),
                  queue: desk().queue.map((item) => ({
                    ...item,
                    assignedUserId: claimed ? "u1" : null,
                  })),
                },
            offline ? 503 : 200,
          );
        return undefined;
      },
    });
    renderWithQuery(<RevenueWorkspace />);
    await screen.findByText("Local Customer");
    fireEvent.click(screen.getByRole("button", { name: "Claim for me" }));
    await screen.findByText(/The action completed, but/);
    expect(
      screen.getByText(
        "You now own this inquiry. No contact attempt was recorded.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Claim for me" }).matches(":disabled"),
    ).toBe(true);
    offline = false;
    fireEvent.click(screen.getByRole("button", { name: "Refresh workspace" }));
    await screen.findByText("Workspace refreshed.");
    expect(screen.queryByRole("button", { name: "Claim for me" })).toBeNull();
    expect(
      spy.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
  });
  it("renders recorded context and makes claim ownership an explicit action", async () => {
    const spy = mockApi("owner", {
      handler: (method, path) =>
        path.endsWith("/revenue/desk")
          ? response(desk())
          : path.endsWith("/revenue/leads/lead-one/claim")
            ? response({ id: "lead-one" })
            : undefined,
    });
    renderWithQuery(<RevenueWorkspace />);
    expect(await screen.findByText("Local Customer")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Claim for me" }));
    await screen.findByText(
      "You now own this inquiry. No contact attempt was recorded.",
    );
    expect(
      spy.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
    const sent = spy.mock.calls.find(([url]) => String(url).includes("/claim"));
    expect(JSON.parse(String(sent?.[1]?.body))).toEqual({ confirmed: true });
  });
  it("hides consequential controls from viewers", async () => {
    mockApi("viewer", {
      handler: (_m, p) =>
        p.endsWith("/revenue/desk") ? response(desk()) : undefined,
    });
    renderWithQuery(<RevenueWorkspace />);
    await screen.findByText("Local Customer");
    expect(screen.queryByRole("button", { name: "Claim for me" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Business knowledge" }));
    expect(
      screen.queryByRole("button", { name: "Approve knowledge version" }),
    ).toBeNull();
    expect(
      (screen.getByLabelText("Services offered") as HTMLTextAreaElement)
        .disabled,
    ).toBe(true);
  });
  it("requires explicit knowledge approval and preserves unsaved content after failure", async () => {
    mockApi("owner", {
      handler: (m, p) =>
        p.endsWith("/revenue/desk")
          ? response(desk())
          : p.endsWith("/revenue/profile") && m === "POST"
            ? response({ error: "Profile changed. Refresh." }, 409)
            : undefined,
    });
    renderWithQuery(<RevenueWorkspace />);
    await screen.findByText("Local Customer");
    fireEvent.click(screen.getByRole("button", { name: "Business knowledge" }));
    const save = screen.getByRole("button", {
      name: "Approve knowledge version",
    });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    for (const label of [
      "Services offered",
      "Service area",
      "Business hours",
      "Human escalation and response policy",
      "Approved materials and brands",
      "Verified warranty terms",
      "Pricing and commitment boundaries",
      "Approval source / reference",
    ])
      fireEvent.change(screen.getByLabelText(label), {
        target: { value: `LOCAL QA ${label}` },
      });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(save);
    await screen.findByText("Profile changed. Refresh.");
    expect(
      (screen.getByLabelText("Services offered") as HTMLTextAreaElement).value,
    ).toBe("LOCAL QA Services offered");
  });
  it("renders unavailable rather than invented healthy or zero states", async () => {
    mockApi("owner", {
      handler: (_m, p) =>
        p.endsWith("/revenue/desk")
          ? response({ error: "offline" }, 503)
          : undefined,
    });
    renderWithQuery(<RevenueWorkspace />);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "No empty totals",
    );
    expect(screen.queryByText("Inquiries needing an owner")).toBeNull();
  });
  it("keeps an empty ledger distinct from zero verified revenue", async () => {
    mockApi("owner", {
      handler: (_m, p) =>
        p.endsWith("/revenue/value") ? response(ledger()) : undefined,
    });
    renderWithQuery(<ValueLedger />);
    expect(await screen.findByText("Not available")).toBeTruthy();
    expect(screen.getAllByText("Not recorded")).toHaveLength(2);
    expect(
      screen.getByText("Staff-recorded data is not a bank feed or causal ROI."),
    ).toBeTruthy();
  });
  it("provides a true project-story empty state and no publish control", async () => {
    mockApi("owner", {
      handler: (_m, p) =>
        p.endsWith("/revenue/desk")
          ? response(desk())
          : p.endsWith("/revenue/growth")
            ? response({
                projects: [],
                stories: [],
                boundary: "Nothing publishes from this screen.",
              })
            : undefined,
    });
    renderWithQuery(<RevenueWorkspace />);
    await screen.findByText("Local Customer");
    fireEvent.click(screen.getByRole("button", { name: "Project stories" }));
    await screen.findByText(/No completed projects are recorded/);
    expect(screen.queryByRole("button", { name: /publish/i })).toBeNull();
  });
  it("does not present missing job costs as zero contribution expenses", async () => {
    mockApi("owner", {
      handler: (_m, p) =>
        p.endsWith("/revenue/value")
          ? response({
              ...ledger(),
              entryCount: 1,
              receiptEntryCount: 1,
              costEntryCount: 0,
              netReceiptsCents: 50000,
              recordedContributionCents: null,
            })
          : undefined,
    });
    renderWithQuery(<ValueLedger />);
    expect(await screen.findByText("Not available")).toBeTruthy();
    expect(screen.getByText("Not recorded")).toBeTruthy();
    expect(screen.getByText("$500.00")).toBeTruthy();
  });
  it("shows indeterminate receipts and gates owner reconciliation", async () => {
    mockApi("owner", {
      handler: (_m, p) =>
        p.endsWith("/revenue/desk")
          ? response({
              ...desk(),
              executions: [
                {
                  id: "e-one",
                  kind: "send_email",
                  state: "indeterminate",
                  createdAt: "2026-09-14T12:00:00Z",
                  expiresAt: "2026-09-14T12:15:00Z",
                  detail: "Check provider before replay.",
                },
              ],
            })
          : undefined,
    });
    renderWithQuery(<RevenueWorkspace />);
    await screen.findByText("Local Customer");
    fireEvent.click(screen.getByText("Execution history · 1 recent records"));
    const save = screen.getByRole("button", {
      name: "Record reconciliation without replay",
    });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByText("Check provider before replay.", { exact: false }),
    ).toBeTruthy();
  });
  it("parses monetary inputs exactly without floating-point rounding", () => {
    expect(parseRecordedCents("19.99")).toBe(1999);
    expect(parseRecordedCents("0.01")).toBe(1);
    for (const value of ["-1", "0", "12.999", "1e4", "NaN", "10000000.01"])
      expect(() => parseRecordedCents(value)).toThrow();
  });
});
