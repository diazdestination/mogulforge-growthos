import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contractorRequest } from "@/lib/contractor-api";
import { SourceAdoptionPanel } from "./source-adoption-panel";

vi.mock("@/lib/contractor-api", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/contractor-api")>(), contractorRequest: vi.fn() }));
const lead = "11111111-1111-4111-8111-111111111111", batchId = "22222222-2222-4222-8222-222222222222";
const index = { candidates: [{ id: lead, status: "follow_up", importSourceKey: "hcp-synthetic", externalOpportunityId: "source-42" }], campaigns: [{ id: batchId, state: "draft", createdAt: "2026-10-02T12:00:00Z" }] };
const detail = { leadId: lead, contactId: "contact", name: "Synthetic Customer", recipient: "customer@example.invalid", status: "follow_up", importSourceKey: "hcp-synthetic", externalOpportunityId: "source-42", sourceSha256: "a".repeat(64), current: false, marketingPermission: false, consentId: null,
  importedHistory: { originalCreatedAt: "2025-01-01", snapshotAsOf: "2026-10-01" }, adoption: null };
const preview = { previewId: "review", payloadSha256: "b".repeat(64), expiresAt: "2026-10-02T18:00:00Z", snapshot: detail,
  input: { evidence: "Synthetic reconciled export and source writer stopped.", sourceAsOf: "2026-10-02T12:00:00Z", cutoverAt: "2026-10-02T12:30:00Z", expiresAt: "2026-10-03T12:00:00Z" } };
const campaign = { id: batchId, version: 1, state: "draft", payloadSha256: "c".repeat(64), expiresAt: "2026-10-02T22:00:00Z",
  settings: { timezone: "America/New_York", days: ["Fri"], startHour: 9, endHour: 18, dailyLimit: 10 },
  items: [{ id: "item", leadId: lead, recipient: "customer@example.invalid", claimedAt: null as string | null,
    snapshot: { subject: "Reviewed estimate follow-up", body: "<script>not executable</script>\nSynthetic Contractor\n123 Test Street\nUnsubscribe: https://growth.example/unsubscribe/synthetic", sender: { senderEmail: "office@example.invalid", provider: "microsoft" } },
    delivery: { state: "not_sent", detail: "No send is reserved for this item.", executionId: null as string | null } }] };
let saved = structuredClone(campaign), failSend = false, failIndex = false, empty = false;
beforeEach(() => {
  saved = structuredClone(campaign); failSend = false; failIndex = false; empty = false;
  vi.mocked(contractorRequest).mockImplementation(async (path, options = {}) => {
    if (path === "/source-adoption") { if (failIndex) throw new Error("Unavailable"); return (empty ? { candidates: [], campaigns: [] } : index) as never; }
    if (path === `/source-adoption/leads/${lead}`) return detail as never;
    if (path.endsWith("/leads/" + lead + "/preview")) return preview as never;
    if (path.endsWith("/leads/" + lead + "/approve")) return { ...detail, current: true } as never;
    if (path.endsWith("/outreach/" + batchId + "/approve")) { saved = { ...saved, state: "approved", version: 2 }; return saved as never; }
    if (path.endsWith("/send")) { if (failSend) throw new Error("Acknowledgement lost"); return saved as never; }
    if (path === `/source-adoption/outreach/${batchId}` && !options.method) return saved as never;
    throw new Error(`Unexpected synthetic route ${path}`);
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });
function mount(canManage = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><SourceAdoptionPanel organizationId="org" businessName="Synthetic Contractor" timezone="America/New_York" canManage={canManage} /></QueryClientProvider>);
}
async function loadCampaign() { fireEvent.change(await screen.findByLabelText("Saved campaign"), { target: { value: batchId } }); await screen.findByText("Reviewed estimate follow-up"); }
describe("reviewed native-source office workflow", () => {
  it("distinguishes unavailable data and a genuinely empty import list", async () => {
    failIndex = true; const first = mount(); expect((await screen.findByRole("alert")).textContent).toContain("Imported opportunities are unavailable"); first.unmount();
    failIndex = false; empty = true; mount(); expect(await screen.findByText(/No imported opportunities yet/)).toBeTruthy();
  });
  it("fails closed on a malformed successful index response instead of crashing or claiming no imports", async () => {
    vi.mocked(contractorRequest).mockResolvedValueOnce({} as never);
    mount(); expect((await screen.findByRole("alert")).textContent).toContain("Imported opportunities are unavailable");
    expect(screen.queryByText(/No imported opportunities yet/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Preview|Approve|Send approved/ })).toBeNull();
  });
  it("keeps source/permission approval separate and requires unchecked explicit confirmation", async () => {
    mount(); fireEvent.change(await screen.findByLabelText("Imported opportunity"), { target: { value: lead } });
    expect(await screen.findByText(/Native management: Current review required/)).toBeTruthy();
    expect(screen.getByText(/Email-marketing permission: Not evidenced/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Preview adoption decision" }).matches(":disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText("Source verified as of"), { target: { value: "2026-10-02T12:00" } });
    fireEvent.change(screen.getByLabelText("Completed cutover time"), { target: { value: "2026-10-02T12:30" } });
    fireEvent.change(screen.getByLabelText("Reconciliation evidence"), { target: { value: "Synthetic reconciled export and source writer stopped." } });
    fireEvent.click(screen.getByLabelText(/I verified the current status/)); fireEvent.click(screen.getByRole("button", { name: "Preview adoption decision" }));
    const approve = await screen.findByRole("button", { name: "Approve source management" }); expect(approve.matches(":disabled")).toBe(true);
    fireEvent.click(screen.getByLabelText(/I approve this exact management decision/)); fireEvent.click(approve);
    await waitFor(() => expect(vi.mocked(contractorRequest)).toHaveBeenCalledWith(`/source-adoption/leads/${lead}/approve`, { method: "POST", body: { previewId: preview.previewId, payloadSha256: preview.payloadSha256, confirmed: true } }));
    expect(vi.mocked(contractorRequest).mock.calls.some(([path]) => path.endsWith("/send") || path.endsWith("/email-permission"))).toBe(false);
  });
  it("renders exact plain-text recipient/sender/content and does not assume contractor campaign days", async () => {
    const view = mount(); await loadCampaign(); expect(screen.getByText(/To: customer@example.invalid/).textContent).toContain("office@example.invalid (microsoft)");
    expect(screen.getByText(/<script>not executable<\/script>/)).toBeTruthy(); expect(view.container.querySelector("script")).toBeNull();
    for (const day of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) expect((screen.getByLabelText(day) as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole("button", { name: "Approve exact emails — does not send" }).matches(":disabled")).toBe(true);
  });
  it("requires a status check after a lost send acknowledgement and never labels uncertainty delivered", async () => {
    mount(); await loadCampaign();
    fireEvent.click(screen.getByLabelText(/I approve every exact recipient/)); fireEvent.click(screen.getByRole("button", { name: "Approve exact emails — does not send" }));
    await screen.findByRole("button", { name: "Send approved emails" }); expect(vi.mocked(contractorRequest).mock.calls.some(([path]) => path.endsWith("/send"))).toBe(false);
    failSend = true; fireEvent.click(screen.getByLabelText(/Send the remaining approved/)); fireEvent.click(screen.getByRole("button", { name: "Send approved emails" }));
    await screen.findByText(/The result is unconfirmed/); expect(screen.getByRole("button", { name: "Send approved emails" }).matches(":disabled")).toBe(true);
    saved = { ...saved, items: saved.items.map(item => ({ ...item, claimedAt: "2026-10-02T16:00:00Z", delivery: { state: "uncertain", detail: "Provider outcome uncertain; never replay.", executionId: "execution" } })) };
    fireEvent.click(screen.getByRole("button", { name: "Check saved status" })); await screen.findByText(/Provider outcome uncertain; never replay/);
    expect(screen.queryByRole("button", { name: "Send approved emails" })).toBeNull();
    expect(vi.mocked(contractorRequest).mock.calls.filter(([path]) => path.endsWith("/send"))).toHaveLength(1);
  });
  it("allows read-only staff to inspect without approval/send or permission controls", async () => {
    mount(false); await loadCampaign(); expect(screen.getByText(/Read-only: an active company owner/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Approve exact|Send approved|Record explicit|Preview complete/ })).toBeNull();
  });
});
