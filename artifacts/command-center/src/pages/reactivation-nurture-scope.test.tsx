import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getGetMeQueryKey } from "@workspace/api-client-react";
import { afterEach, expect, it, vi } from "vitest";
import Reactivation from "./reactivation";
import { mockApi, type MockApiOptions } from "@/test/mock-api";
import { nurtureFixture, nurtureId, nurtureListFixture } from "@/components/source-nurture-fixtures";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function setup() {
  const detail = nurtureFixture();
  const options: MockApiOptions = { me: { id: "owner-one", organization: { id: nurtureId(1), name: "Synthetic Contractor", slug: "synthetic", timezone: "America/New_York" } }, handler: (_method, path) => {
    if (path.endsWith("/source-adoption")) return json({ candidates: [], campaigns: [], page: 0, campaignPage: 0, hasMore: false, hasMoreCampaigns: false });
    if (path.endsWith("/source-nurture")) return json(nurtureListFixture(detail));
    if (path.endsWith(`/source-nurture/${detail.id}`)) return json(detail);
    return undefined;
  } };
  mockApi("owner", options);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><Reactivation /></QueryClientProvider>);
  return { options, client };
}
async function checkReview() { fireEvent.click(await screen.findByRole("button", { name: /Review draft plan/ })); fireEvent.click(await screen.findByLabelText(/I reviewed every exact recipient/)); }
it("keeps a reviewed plan through successful unchanged profile refreshes and resets on an actual role change", async () => {
  const { options, client } = setup(); await checkReview();
  await act(async () => { await client.invalidateQueries({ queryKey: getGetMeQueryKey() }); });
  expect((screen.getByLabelText(/I reviewed every exact recipient/) as HTMLInputElement).checked).toBe(true);
  options.me = { ...options.me, role: "viewer" };
  await act(async () => { await client.invalidateQueries({ queryKey: getGetMeQueryKey() }); });
  await waitFor(() => expect(screen.queryByLabelText(/I reviewed every exact recipient/)).toBeNull());
  expect(screen.getByText(/Read-only: an accepted active owner/)).toBeTruthy();
});
it("fails closed on profile error even with retained profile data, and rechecks company-scoped evidence on organization change", async () => {
  const { options, client } = setup(); await checkReview();
  options.meStatus = 403;
  await act(async () => { await client.invalidateQueries({ queryKey: getGetMeQueryKey() }); });
  await screen.findByText(/Current company access could not be verified/);
  expect(screen.queryByLabelText(/I reviewed every exact recipient/)).toBeNull();
  options.meStatus = undefined; options.me = { ...options.me, organization: { id: nurtureId(99), name: "Other company", slug: "other", timezone: "UTC" } };
  await act(async () => { await client.invalidateQueries({ queryKey: getGetMeQueryKey() }); });
  await screen.findByText(/Nurture work is unavailable/);
  expect(screen.queryByText(/Saved plan:/)).toBeNull();
});
