import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import Onboarding from "./onboarding";
import { Toaster } from "@/components/ui/toaster";
import { renderWithQuery } from "@/test/render";
import { mockApi } from "@/test/mock-api";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function renderInvite(response: Response) {
  const calls = mockApi("owner", { handler: (method, path) => {
    if (path.endsWith("/onboarding")) return json({ state: { completedSteps: [], completedAt: null } });
    if (path.endsWith("/settings") || path.endsWith("/installation")) return json({});
    if (method === "POST" && path.endsWith("/users/invite")) return response;
    return undefined;
  } });
  renderWithQuery(<><Onboarding /><Toaster /></>);
  return calls;
}
async function sendInvite() {
  fireEvent.change(await screen.findByTestId("invite-email-input"), { target: { value: "teammate@example.test" } });
  fireEvent.submit(screen.getByTestId("invite-team-form"));
}

it.each([false, undefined])("does not mark onboarding complete when invite acceptance is %s", async (sent) => {
  const calls = renderInvite(json({ id: "invited", email: "teammate@example.test", inviteEmail: sent === undefined ? undefined : { sent, error: "CANARY_PRIVATE_ERROR" } }));
  await sendInvite();
  await screen.findByText("Invite created; email outcome unconfirmed");
  expect(screen.queryByText(/cannot activate|CANARY_PRIVATE_ERROR/)).toBeNull();
  expect(screen.queryByTestId("invited-emails-list")).toBeNull();
  expect(calls.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(0);
});

it("labels successful transport acceptance without promising delivery", async () => {
  renderInvite(json({ id: "invited", email: "teammate@example.test", inviteEmail: { sent: true, error: null } }));
  await sendInvite();
  await screen.findByText("Invitation email accepted for sending");
  expect(screen.getByText("Inbox delivery is not yet confirmed.")).toBeTruthy();
  await waitFor(() => expect(screen.getByTestId("invited-emails-list").textContent).toContain("teammate@example.test"));
});

it("treats a lost invitation request response as uncertain without exposing provider content", async () => {
  renderInvite(json({ error: "CANARY_PRIVATE_ERROR" }, 500));
  await sendInvite();
  await screen.findByText("Invitation request unconfirmed");
  expect(screen.getByText(/Check the team list and provider delivery records/)).toBeTruthy();
  expect(screen.queryByText(/CANARY_PRIVATE_ERROR/)).toBeNull();
  expect(screen.queryByTestId("invited-emails-list")).toBeNull();
});
