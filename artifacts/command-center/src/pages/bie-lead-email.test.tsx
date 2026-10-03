import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { mockApi } from "@/test/mock-api";
vi.mock("@/components/revenue-workspace", () => ({
  RevenueWorkspace: () => null,
}));
vi.mock("@/components/customer-replies", () => ({
  CustomerReplies: () => null,
}));
import Bie from "./bie";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
const briefing = {
  generatedAt: "2026-10-02T12:00:00Z",
  totalLeads: 1,
  importedLeads: 0,
  dataReadiness: {
    score: 1,
    leadsWithContactMethod: 1,
    leadsWithKnownValue: 0,
    googleSourcesConnected: 0,
    totalGoogleSources: 4,
  },
  revenueAtRiskCents: 0,
  unknownValueLeadCount: 1,
  opportunityCount: 0,
  opportunities: [],
  narrative: "Synthetic BIE review",
  sources: [],
  policy: { enabled: false, allowedActions: [], dailyEmailCap: 1 },
};
const emailReview = {
  version: 1,
  preparedByUserId: "staff-one",
  preparedAt: "2026-10-02T12:00:00Z",
  recipient: "customer@example.invalid",
  sender: { provider: "microsoft", senderEmail: "staff@example.invalid" },
  leadId: "lead-one",
  contactId: "contact-one",
  leadCreatedAt: "2026-10-01T12:00:00Z",
  leadUpdatedAt: "2026-10-01T12:00:00Z",
};
const proposal = (status = "proposed") => ({
  id: "action-one",
  actionType: "send_email",
  status,
  title: "Synthetic reviewed email",
  rationale: "Test only",
  evidence: {},
  payload: {
    subject: "Synthetic subject",
    body: "Synthetic content",
  } as Record<string, unknown>,
  estimatedValueCents: null,
  executionDetail: null,
  createdAt: "2026-10-02T12:00:00Z",
});
function setup(
  current: ReturnType<typeof proposal>,
  mutate: (path: string) => Response,
) {
  const request = mockApi("owner", {
    handler: (method, path) => {
      if (path.endsWith("/bie/briefing")) return json(briefing);
      if (path.endsWith("/bie/actions")) return json([current]);
      if (path.endsWith("/email-intelligence"))
        return json({
          source: null,
          providerConfigured: false,
          messagesAccepted: 0,
          factsAwaitingReview: 0,
          rawMessagesHeld: 0,
        });
      if (method === "POST" && path.includes("/bie/actions/"))
        return mutate(path);
      return undefined;
    },
  });
  renderWithQuery(<Bie />);
  return request;
}
async function advanced() {
  fireEvent.click(
    await screen.findByText("Advanced BIE analysis, integrations & policy"),
  );
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("expert queue prepares and displays frozen evidence before approving exactly what was shown", async () => {
  const current = proposal();
  const request = setup(current, (path) => {
    if (path.endsWith("/prepare-email"))
      current.payload = { ...current.payload, emailReview };
    if (path.endsWith("/approve")) current.status = "approved";
    return json(current);
  });
  await advanced();
  expect(
    screen.getByRole("button", { name: "Approve" }).hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(
    screen.getByRole("button", { name: "Prepare recipient and sender" }),
  );
  await screen.findByText(/customer@example.invalid/);
  expect(screen.getByText(/staff@example.invalid/)).toBeTruthy();
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Approve" }).hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Approve" }));
  await waitFor(() =>
    expect(
      request.mock.calls.some(([url]) => String(url).endsWith("/approve")),
    ).toBe(true),
  );
  expect(
    JSON.parse(
      String(
        request.mock.calls.find(([url]) =>
          String(url).endsWith("/approve"),
        )?.[1]?.body,
      ),
    ),
  ).toEqual({ expectedPayload: current.payload });
});
it("expert queue stops stale decisions until an explicit saved-action refresh", async () => {
  const current = proposal();
  current.payload = { ...current.payload, emailReview };
  const request = setup(current, () =>
    json({ error: "Proposal changed" }, 409),
  );
  await advanced();
  fireEvent.click(screen.getByRole("button", { name: "Approve" }));
  await screen.findByText(/The saved action changed/);
  expect(
    screen.getByRole("button", { name: "Approve" }).hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(
    screen.getByRole("button", { name: "Refresh saved action for review" }),
  );
  await waitFor(() =>
    expect(screen.queryByText(/The saved action changed/)).toBeNull(),
  );
  expect(
    request.mock.calls.filter(([, init]) => init?.method === "POST"),
  ).toHaveLength(1);
});
it("legacy approved execution stays explicitly untracked and sends a JSON body to the guarded endpoint", async () => {
  const current = proposal("approved");
  const request = setup(current, () =>
    json({ ...current, status: "executed" }),
  );
  await advanced();
  expect(screen.getByText(/Legacy or unavailable email review/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Execute/ }));
  await waitFor(() =>
    expect(
      request.mock.calls.some(([url]) => String(url).endsWith("/execute")),
    ).toBe(true),
  );
  const send = request.mock.calls.find(([url]) =>
    String(url).endsWith("/execute"),
  )!;
  expect(send[1]?.body).toBe("{}");
  expect(new Headers(send[1]?.headers).get("content-type")).toBe(
    "application/json",
  );
});
