import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { ClientStaffInvitations } from "./client-staff-invitations";

const invitation = {
  id: "invite-1",
  organizationId: "org-a",
  email: "owner@example.invalid",
  role: "owner",
  version: 1,
  state: "pending",
  deliveryState: "sent",
  expiresAt: "2099-10-01T10:00:00.000Z",
};
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
function setup(
  handler?: (
    url: string,
    init?: RequestInit,
  ) => Promise<Response> | Response | undefined,
) {
  const fetcher = vi.fn(
    (url: string, init?: RequestInit) =>
      handler?.(url, init) ??
      Promise.resolve(
        response({
          organizationId: "org-a",
          invitations: [invitation],
          truncated: false,
        }),
      ),
  );
  vi.stubGlobal("fetch", fetcher);
  renderWithQuery(
    <ClientStaffInvitations
      key="org-a"
      organizationId="org-a"
      actorId="operator"
      needsOwner
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Invite client staff" }));
  return fetcher;
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const fill = async () => {
  await screen.findByText("Awaiting acceptance", { exact: false });
  fireEvent.change(screen.getByLabelText("Staff email"), {
    target: { value: invitation.email },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: /client approved/ }));
};

it("explains accepted coverage and requires client approval before sending", async () => {
  const calls = setup();
  await screen.findByText(/Awaiting acceptance/);
  expect(screen.getByText(/Pending invitations do not count/)).toBeTruthy();
  expect(
    (
      screen.getByRole("button", {
        name: "Send invitation",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.change(screen.getByLabelText("Staff email"), {
    target: { value: invitation.email },
  });
  expect(
    (
      screen.getByRole("button", {
        name: "Send invitation",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(calls.mock.calls.every(([, init]) => init?.method === "GET")).toBe(
    true,
  );
});

it("preserves entries and request identity after a lost acknowledgement, including closing and reopening", async () => {
  let attempts = 0;
  const bodies: Array<{ requestId: string; email: string }> = [];
  setup((_url, init) => {
    if (init?.method !== "POST") return;
    bodies.push(JSON.parse(String(init.body)));
    if (++attempts === 1)
      return Promise.reject(new TypeError("network-secret-canary"));
    return response({ invitation });
  });
  await fill();
  fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));
  await screen.findByRole("alert");
  expect(screen.queryByText(/network-secret-canary/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Close staff setup" }));
  fireEvent.click(screen.getByRole("button", { name: "Invite client staff" }));
  expect((screen.getByLabelText("Staff email") as HTMLInputElement).value).toBe(
    invitation.email,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Retry same invitation request" }),
  );
  await screen.findByText(/person must still accept/);
  expect(bodies).toHaveLength(2);
  expect(bodies[0].requestId).toBe(bodies[1].requestId);
});

it("requires review before reissue, fences unknown results, and uses the refreshed version", async () => {
  let version = 1,
    attempt = 0;
  const bodies: unknown[] = [];
  setup((_url, init) => {
    if (init?.method === "POST") {
      bodies.push(JSON.parse(String(init.body)));
      if (++attempt === 1) {
        version = 2;
        return Promise.reject(new TypeError("unknown"));
      }
      return response({ ...invitation, version: 3 });
    }
    return response({
      organizationId: "org-a",
      invitations: [{ ...invitation, version, deliveryState: "unconfirmed" }],
      truncated: false,
    });
  });
  await screen.findByText(/Delivery unconfirmed/);
  fireEvent.click(screen.getByRole("button", { name: "Review fresh link" }));
  expect(screen.getByText(/Check delivery evidence first/)).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm and send fresh link" }),
  );
  await screen.findByText(/Refresh invitations to review/);
  expect(
    (
      screen.getByRole("button", {
        name: "Confirm and send fresh link",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Refresh invitations" }));
  await waitFor(() =>
    expect(screen.queryByText(/Refresh invitations to review/)).toBeNull(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Review fresh link" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm and send fresh link" }),
  );
  await screen.findByText(/Earlier links are invalid/);
  expect(bodies).toEqual([
    { expectedVersion: 1, confirmed: true },
    { expectedVersion: 2, confirmed: true },
  ]);
});

it("rejects a different workspace response without exposing its member or enabling mutations", async () => {
  const calls = setup(() =>
    response({
      organizationId: "org-b",
      invitations: [
        {
          ...invitation,
          organizationId: "org-b",
          email: "foreign-canary@example.invalid",
        },
      ],
      truncated: false,
    }),
  );
  await screen.findByText(
    "Invitation status is unavailable. Refresh before sending.",
  );
  expect(screen.queryByText(/foreign-canary/)).toBeNull();
  expect(
    (screen.getByLabelText("Staff email") as HTMLInputElement).closest(
      "fieldset",
    )?.disabled,
  ).toBe(true);
  expect(calls.mock.calls.every(([, init]) => init?.method === "GET")).toBe(
    true,
  );
});

it("disables duplicate send and keeps expired and revoked access explicit", async () => {
  let finish!: (value: Response) => void;
  setup((_url, init) =>
    init?.method === "POST"
      ? new Promise<Response>((resolve) => {
          finish = resolve;
        })
      : response({
          organizationId: "org-a",
          invitations: [
            { ...invitation, state: "expired" },
            {
              ...invitation,
              id: "revoked-2",
              email: "revoked@example.invalid",
              state: "revoked",
            },
          ],
          truncated: false,
        }),
  );
  await screen.findByText(/Expired/);
  expect(screen.getByText(/Revoked/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Staff email"), {
    target: { value: "new@example.invalid" },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: /client approved/ }));
  fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));
  await screen.findByText("Sending invitation…");
  expect(
    (
      screen.getByRole("button", {
        name: "Sending invitation…",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(
    screen
      .getAllByRole("button", { name: "Review fresh link" })
      .every((button) => (button as HTMLButtonElement).disabled),
  ).toBe(true);
  finish(
    response({
      invitation: {
        ...invitation,
        email: "new@example.invalid",
        deliveryState: "unconfirmed",
      },
    }),
  );
  await screen.findByText(/Delivery is unconfirmed. Review delivery evidence/);
});
