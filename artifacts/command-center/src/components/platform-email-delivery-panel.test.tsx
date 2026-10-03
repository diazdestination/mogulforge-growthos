import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlatformEmailDeliveryPanel } from "./platform-email-delivery-panel";

const org = "10000000-0000-4000-8000-000000000001", invite = "10000000-0000-4000-8000-000000000002";
const row = { id: "10000000-0000-4000-8000-000000000003", organizationId: org, invitationId: invite, purpose: "staff_invitation", outcome: "accepted",
  recipientLabel: "approved-staff@example.invalid",
  outcomeCode: "provider_accepted", provider: "resend", providerMessageId: "10000000-0000-4000-8000-000000000004", deliveryState: "unconfirmed", deliveryConfirmed: false,
  retryAllowed: false, claimedAt: "2026-10-02T12:00:00.000Z", finishedAt: "2026-10-02T12:00:01.000Z", lastEventAt: null };
const payload = (deliveries: unknown[] = [row]) => ({ deliveries, page: 1, pageSize: 25, hasMore: false, unmatchedCallbackCount: null, unmatchedCallbackLimit: 1000 });
const mount = (scope: "member" | "platform" = "member") => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
  <PlatformEmailDeliveryPanel actorId="staff" scope={scope} organizationId={org} invitationId={invite} />
</QueryClientProvider>);
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("read-only platform delivery evidence", () => {
  it("distinguishes provider acceptance from inbox delivery and refresh never sends", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload()), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock); mount();
    expect(await screen.findByText("Accepted by the sender — inbox delivery unconfirmed")).not.toBeNull();
    expect(screen.getByText("approved-staff@example.invalid")).not.toBeNull();
    expect(fetchMock.mock.calls[0][0]).toContain("/staff-invitations/email-deliveries?");
    expect(fetchMock.mock.calls[0][0]).not.toContain("organizationId");
    fetchMock.mockResolvedValue(new Response(JSON.stringify(payload([{ ...row, deliveryState: "delivered", deliveryConfirmed: true }])), { status: 200 }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh delivery status" }));
    expect(await screen.findByText("Delivered to the recipient's mail server")).not.toBeNull();
    expect(fetchMock.mock.calls.every((call: unknown[]) => !(call[1] as RequestInit).method || (call[1] as RequestInit).method === "GET")).toBe(true);
    expect(screen.queryByRole("button", { name: /send|retry/i })).toBeNull();
  });

  it.each([{}, payload([{ ...row, deliveryState: "bounced", deliveryConfirmed: true }]), payload([{ ...row, organizationId: "20000000-0000-4000-8000-000000000001" }])])("fails closed for malformed, contradictory or foreign response data", async value => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(value), { status: 200 }))); mount();
    expect((await screen.findByRole("alert")).textContent).toContain("Delivery evidence is unavailable");
    expect(screen.queryByText("Delivered to the recipient's mail server")).toBeNull();
  });

  it("shows unknown effects without a resend control", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(payload([{ ...row, recipientLabel: null, outcome: "unknown", providerMessageId: null, outcomeCode: "provider_outcome_unknown" }])), { status: 200 }))); mount();
    expect(await screen.findByText("Outcome unknown — do not send again")).not.toBeNull();
    expect(screen.getByText("Original account address unavailable or changed")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /send|retry/i })).toBeNull();
  });

  it("never renders extra token, source, link or body fields", async () => {
    const canary = "private-token-link-body-canary";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(payload([{ ...row, identityTokenId: canary, token: canary, sourceRecordId: canary, body: canary, link: canary }])), { status: 200 })));
    mount();
    expect(await screen.findByText("Accepted by the sender — inbox delivery unconfirmed")).not.toBeNull();
    expect(document.body.textContent).not.toContain(canary);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("shows bounded unmatched callback backlog only in the platform response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...payload([]), unmatchedCallbackCount: 1000 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock); mount("platform");
    await waitFor(() => expect(screen.getByText(/1000 authenticated callback records/)).not.toBeNull());
    expect(fetchMock.mock.calls[0][0]).toContain(`organizationId=${org}`);
  });
});
