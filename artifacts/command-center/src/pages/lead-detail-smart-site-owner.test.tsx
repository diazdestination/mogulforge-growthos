import { cleanup, fireEvent, screen } from "@testing-library/react";
import { Route, Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { afterEach, expect, it, vi } from "vitest";
import LeadDetail from "./lead-detail";
import { mockApi, sampleLead } from "@/test/mock-api";
import { renderWithQuery } from "@/test/render";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });

it("lets a notification recipient claim directly on the exact native lead page", async () => {
  let assigned = false;
  const calls = mockApi("owner", {
    handler: (method, path) => {
      if (path.endsWith(`/smart-sites/leads/${sampleLead.id}/follow-up`))
        return json({
          organizationId: "o1",
          leadId: sampleLead.id,
          siteName: "Roofing website",
          status: "new",
          assignedUserId: assigned ? "u1" : null,
          ownerName: assigned ? "Ryan" : null,
          ownerEligible: assigned,
          canClaim: !assigned,
        });
      if (
        path.endsWith(`/smart-sites/leads/${sampleLead.id}/owner`) &&
        method === "PATCH"
      ) {
        assigned = true;
        return json({ leadId: sampleLead.id, assignedUserId: "u1" });
      }
      if (path.endsWith(`/leads/${sampleLead.id}`))
        return json({ ...sampleLead, organizationId: "o1", scoreReasons: [] });
      return undefined;
    },
  });
  const { hook } = memoryLocation({ path: `/leads/${sampleLead.id}` });
  renderWithQuery(
    <Router hook={hook}>
      <Route path="/leads/:id">
        <LeadDetail />
      </Route>
    </Router>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Claim inquiry" }));
  await screen.findByText("Your claim was saved.");
  expect(
    calls.mock.calls.filter(([, init]) => init?.method === "PATCH"),
  ).toHaveLength(1);
  expect(
    calls.mock.calls.some(([url]) =>
      String(url).endsWith("/smart-sites/follow-up"),
    ),
  ).toBe(false);
});

it("does not load ownership for a cached lead from a different current company", async () => {
  const calls = mockApi("owner", {
    handler: (_method, path) =>
      path.endsWith(`/leads/${sampleLead.id}`)
        ? json({
            ...sampleLead,
            organizationId: "other-company",
            scoreReasons: [],
          })
        : undefined,
  });
  const { hook } = memoryLocation({ path: `/leads/${sampleLead.id}` });
  renderWithQuery(
    <Router hook={hook}>
      <Route path="/leads/:id">
        <LeadDetail />
      </Route>
    </Router>,
  );
  await screen.findByRole("heading", { name: sampleLead.summary });
  expect(
    screen.queryByRole("region", { name: "Website inquiry ownership" }),
  ).toBeNull();
  expect(
    calls.mock.calls.some(([url]) =>
      String(url).includes("/smart-sites/leads/"),
    ),
  ).toBe(false);
});
