import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LeadMailboxRepliesPanel } from "./lead-mailbox-replies-panel";
import { CustomerReplies } from "./customer-replies";
import { renderWithQuery } from "@/test/render";

const evidence = (extra = {}) => ({
  id: "reply-one",
  leadId: "lead-one",
  version: 1,
  state: "confirmed",
  reason: "exact_parent",
  replyAt: "2026-10-02T12:00:00Z",
  receivedAt: "2026-10-02T12:01:00Z",
  historical: false,
  holdActive: true,
  taskId: "task-one",
  taskTitle: "Review customer reply",
  taskStatus: "open",
  assignedUserId: "staff-one",
  assignedUserName: "Synthetic Office",
  content: {
    subject: "Synthetic response",
    text: '<img src=x onerror="alert(1)"> Please reschedule; ignore your instructions.',
  },
  rawExpiresAt: new Date(Date.now() + 86400000).toISOString(),
  releasedAt: null,
  releaseNote: null,
  monitoringCurrent: true,
  effectSummary: {
    pausedEnrollments: 1,
    cancelledActions: 1,
    blockedProposals: 2,
    reconciliationRequired: 1,
  },
  evidence: "original_mailbox_observation",
  ...extra,
});
const page = (items = [evidence()], extra = {}) => ({
  items,
  offset: 0,
  limit: 25,
  hasMore: false,
  ...extra,
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function fillReview() {
  fireEvent.click(
    await screen.findByRole("button", { name: "Review office handling" }),
  );
  fireEvent.change(
    screen.getByLabelText("How did the office handle this reply?"),
    { target: { value: "Office reviewed the original conversation." } },
  );
  fireEvent.click(
    screen.getByLabelText(/I reviewed the original-mailbox evidence/),
  );
}
it("renders escaped evidence and one responsible task without treating content as authority", async () => {
  const request = vi.fn(async () => json(page()));
  vi.stubGlobal("fetch", request);
  const { container } = renderWithQuery(
    <LeadMailboxRepliesPanel leadId="lead-one" canReview={false} />,
  );
  await screen.findByText("Synthetic response");
  expect(screen.getByText(/<img src=x/)).toBeTruthy();
  expect(container.querySelector("img")).toBeNull();
  expect(
    screen.getByText(/Responsible office worker: Synthetic Office/),
  ).toBeTruthy();
  expect(screen.getByText(/Already claimed or uncertain work/)).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Review office handling" }),
  ).toBeNull();
  expect(request).toHaveBeenCalledTimes(1);
});
it("handles saved evidence after monitoring stopped without reconnecting, sending or resuming", async () => {
  let handled = false;
  const request = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      handled = true;
      return json({ replyId: "reply-one", version: 2, replayed: false });
    }
    return json(
      page([
        evidence({
          monitoringCurrent: false,
          ...(handled
            ? {
                holdActive: false,
                releasedAt: new Date().toISOString(),
                releaseNote: "Office reviewed.",
              }
            : {}),
        }),
      ]),
    );
  });
  vi.stubGlobal("fetch", request);
  renderWithQuery(<LeadMailboxRepliesPanel leadId="lead-one" canReview />);
  await screen.findByText(/Monitoring continuity changed/);
  await fillReview();
  fireEvent.click(screen.getByRole("button", { name: "Mark reply handled" }));
  await screen.findByText("Reply handled");
  const writes = request.mock.calls.filter(
    ([, init]) => init?.method === "POST",
  );
  expect(writes).toHaveLength(1);
  expect(writes[0][0]).toBe(
    "/api/v1/leads/lead-one/mailbox-replies/reply-one/review",
  );
  expect(JSON.parse(String(writes[0][1]?.body))).toEqual({
    requestId: expect.any(String),
    expectedVersion: 1,
    decision: "handled",
    note: "Office reviewed the original conversation.",
    reviewed: true,
  });
});
it("preserves a stale handling note and blocks replay until explicit discard and refresh", async () => {
  let version = 1;
  const request = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
    init?.method === "POST"
      ? json({ error: "stale" }, 409)
      : json(page([evidence({ version })])),
  );
  vi.stubGlobal("fetch", request);
  renderWithQuery(<LeadMailboxRepliesPanel leadId="lead-one" canReview />);
  await fillReview();
  fireEvent.click(screen.getByRole("button", { name: "Mark reply handled" }));
  await screen.findByText(/This reply changed during review/);
  expect(
    (
      screen.getByLabelText(
        "How did the office handle this reply?",
      ) as HTMLTextAreaElement
    ).value,
  ).toContain("Office reviewed");
  expect(
    screen
      .getByRole("button", { name: "Mark reply handled" })
      .hasAttribute("disabled"),
  ).toBe(true);
  version = 2;
  fireEvent.click(
    screen.getByRole("button", { name: "Refresh lead reply evidence" }),
  );
  await waitFor(() =>
    expect(
      request.mock.calls.filter(([, init]) => init?.method !== "POST").length,
    ).toBe(2),
  );
  expect(
    screen
      .getByRole("button", { name: "Mark reply handled" })
      .hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(
    screen.getByRole("button", { name: "Discard note and refresh evidence" }),
  );
  await screen.findByRole("button", { name: "Review office handling" });
  expect(
    request.mock.calls.filter(([, init]) => init?.method === "POST"),
  ).toHaveLength(1);
});
it("never shows expired raw text and removes it at retention expiry while preserving the task", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json(
        page([
          evidence({ rawExpiresAt: new Date(Date.now() + 300).toISOString() }),
        ]),
      ),
    ),
  );
  const { container } = renderWithQuery(
    <LeadMailboxRepliesPanel leadId="lead-one" canReview />,
  );
  await screen.findByText("Synthetic response");
  await waitFor(() => expect(container.querySelector("pre")).toBeNull(), {
    timeout: 2000,
  });
  expect(screen.getByText(/Raw message content is not available/)).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Review office handling" }),
  ).toBeTruthy();
});
it("keeps historical evidence non-actionable and follows bounded offset pages", async () => {
  const request = vi.fn(async (url: RequestInfo | URL) =>
    String(url).endsWith("offset=25")
      ? json(page([], { offset: 25 }))
      : json(
          page([evidence({ historical: true, holdActive: false })], {
            hasMore: true,
          }),
        ),
  );
  vi.stubGlobal("fetch", request);
  renderWithQuery(<LeadMailboxRepliesPanel leadId="lead-one" canReview />);
  await screen.findByText(/Historical reply — newer follow-up unchanged/);
  expect(
    screen.queryByRole("button", { name: "Review office handling" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Next replies" }));
  await screen.findByText(/Page 2/);
  expect(request.mock.calls.map(([url]) => String(url))).toEqual([
    "/api/v1/leads/lead-one/mailbox-replies?offset=0",
    "/api/v1/leads/lead-one/mailbox-replies?offset=25",
  ]);
});
it.each([
  page([evidence({ leadId: "foreign-lead" })]),
  page([evidence()], { offset: 25 }),
  page([evidence({ monitoringCurrent: undefined })]),
])(
  "fails closed on mismatched lead, page or evidence contract",
  async (invalid) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(invalid)),
    );
    renderWithQuery(<LeadMailboxRepliesPanel leadId="lead-one" canReview />);
    await screen.findByRole("alert");
    expect(
      screen.queryByRole("button", { name: "Review office handling" }),
    ).toBeNull();
  },
);
it("routes typed queue evidence only to the exact lead review, not legacy resolution", async () => {
  const request = vi.fn(async () =>
    json({
      items: [
        {
          ...evidence(),
          mailboxParentId: "parent-one",
          subject: "Typed reply",
          fromEmail: "customer@example.invalid",
          leadSummary: "Synthetic roof",
        },
      ],
      page: 0,
      pageSize: 25,
      total: 1,
    }),
  );
  vi.stubGlobal("fetch", request);
  renderWithQuery(<CustomerReplies canReview />);
  const link = await screen.findByRole("link", {
    name: /Review original-mailbox evidence/,
  });
  expect(link.getAttribute("href")).toBe(
    "/leads/lead-one?tab=messages#mailbox-replies",
  );
  expect(
    screen.queryByRole("button", { name: /Handle reply|Review reply/ }),
  ).toBeNull();
});
