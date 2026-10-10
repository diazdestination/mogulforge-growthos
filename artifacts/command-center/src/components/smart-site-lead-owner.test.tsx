import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getGetMeQueryKey } from "@workspace/api-client-react";
import { afterEach, expect, it, vi } from "vitest";
import { memberAuthorityScope } from "@/lib/member-authority-scope";
import { sampleMe } from "@/test/mock-api";
import { SmartSiteLeadOwner } from "./smart-site-lead-owner";

const me = sampleMe("owner");
const scopeKey = memberAuthorityScope(me as never);
const props = {
  organizationId: "o1",
  leadId: "lead-beyond-25",
  userId: "u1",
  scopeKey,
  canWrite: true,
};
const inquiry = {
  organizationId: "o1",
  leadId: props.leadId,
  siteName: "Roofing website",
  status: "new",
  assignedUserId: null,
  ownerName: null,
  ownerEligible: false,
  canClaim: true,
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const owned = {
  ...inquiry,
  assignedUserId: "u1",
  ownerName: "Ryan",
  ownerEligible: true,
  canClaim: false,
};

function setup(
  handler: (method: string, url: string) => Response | Promise<Response>,
  initialProps = props,
) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) =>
    handler(init?.method || "GET", String(url)),
  );
  vi.stubGlobal("fetch", fetchMock);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(getGetMeQueryKey(), me);
  const renderPanel = (nextProps: typeof props) => (
    <QueryClientProvider client={client}>
      <SmartSiteLeadOwner {...nextProps} />
    </QueryClientProvider>
  );
  const view = render(renderPanel(initialProps));
  return {
    fetchMock,
    client,
    unmount: view.unmount,
    remount: () => render(renderPanel(initialProps)),
    rerender: (nextProps: typeof props) =>
      view.rerender(renderPanel(nextProps)),
  };
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("loads the exact inquiry and claims only an unassigned owner, without consulting the capped queue", async () => {
  let claimed = false;
  const { fetchMock } = setup((method) => {
    if (method === "PATCH") {
      claimed = true;
      return json({ leadId: props.leadId, assignedUserId: "u1" });
    }
    return json(claimed ? owned : inquiry);
  });
  fireEvent.click(await screen.findByRole("button", { name: "Claim inquiry" }));
  await screen.findByText("Your claim was saved.");
  expect(screen.getByText("You")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Claim inquiry" })).toBeNull();
  const writes = fetchMock.mock.calls.filter(
    ([, init]) => init?.method === "PATCH",
  );
  expect(writes).toHaveLength(1);
  expect(writes[0][0]).toBe(`/api/v1/smart-sites/leads/${props.leadId}/owner`);
  expect(JSON.parse(String(writes[0][1]?.body))).toEqual({
    assignedUserId: "u1",
    expectedOwnerId: null,
  });
  expect(
    fetchMock.mock.calls.some(
      ([url]) => url === "/api/v1/smart-sites/follow-up",
    ),
  ).toBe(false);
});

it("shows the existing owner without offering to take their inquiry", async () => {
  const { fetchMock } = setup(() =>
    json({ ...owned, assignedUserId: "u2", ownerName: "Jesse" }),
  );
  await screen.findByText("Jesse");
  expect(screen.queryByRole("button", { name: "Claim inquiry" })).toBeNull();
  expect(fetchMock.mock.calls.every(([, init]) => !init?.method)).toBe(true);
});

it("keeps read-only staff from claiming even if cached server eligibility is true", async () => {
  setup(() => json(inquiry), { ...props, canWrite: false });
  await screen.findByText("Unassigned");
  expect(screen.queryByRole("button", { name: "Claim inquiry" })).toBeNull();
});

it.each([{ organizationId: "another-company" }, { leadId: "another-lead" }])(
  "rejects a mismatched ownership response: %j",
  async (mismatch) => {
    setup(() => json({ ...inquiry, ...mismatch }));
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: "Claim inquiry" })).toBeNull();
    expect(screen.queryByText("Unassigned")).toBeNull();
  },
);

it("makes a failed read visible and allows a fresh retry", async () => {
  let available = false;
  setup(() => (available ? json(inquiry) : json({}, 503)));
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: "Claim inquiry" })).toBeNull();
  available = true;
  fireEvent.click(screen.getByRole("button", { name: "Refresh ownership" }));
  await screen.findByRole("button", { name: "Claim inquiry" });
  expect(screen.queryByRole("alert")).toBeNull();
});

it("holds a conflicting claim until a refresh reveals the teammate who claimed first", async () => {
  let conflict = false;
  const { fetchMock } = setup((method) => {
    if (method === "PATCH") {
      conflict = true;
      return json({ error: "owner_changed_refresh_first" }, 409);
    }
    return json(
      conflict
        ? { ...owned, assignedUserId: "u2", ownerName: "Jesse" }
        : inquiry,
    );
  });
  fireEvent.click(await screen.findByRole("button", { name: "Claim inquiry" }));
  await screen.findByText(/This inquiry changed/);
  expect(
    (screen.getByRole("button", { name: "Claim inquiry" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Refresh ownership" }));
  await screen.findByText("Jesse");
  expect(screen.queryByRole("button", { name: "Claim inquiry" })).toBeNull();
  expect(
    fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH"),
  ).toHaveLength(1);
});

it("preserves an acknowledged claim when its subsequent ownership refresh fails", async () => {
  let saved = false;
  setup((method) => {
    if (method === "PATCH") {
      saved = true;
      return json({ leadId: props.leadId, assignedUserId: "u1" });
    }
    return saved ? json({}, 503) : json(inquiry);
  });
  fireEvent.click(await screen.findByRole("button", { name: "Claim inquiry" }));
  await screen.findByText("Your claim was saved.");
  await screen.findByRole("alert");
  expect(screen.getByText("You")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Claim inquiry" })).toBeNull();
});

it("reconciles a lost claim acknowledgment by reading ownership before any retry", async () => {
  let claimed = false;
  const { fetchMock } = setup((method) => {
    if (method === "PATCH") {
      claimed = true;
      throw new TypeError("Network failed");
    }
    return json(claimed ? owned : inquiry);
  });
  fireEvent.click(await screen.findByRole("button", { name: "Claim inquiry" }));
  await screen.findByText(/Your claim was not confirmed/);
  expect(
    (screen.getByRole("button", { name: "Claim inquiry" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Refresh ownership" }));
  await screen.findByText("You");
  expect(screen.queryByRole("button", { name: "Claim inquiry" })).toBeNull();
  expect(screen.queryByText("Your claim was saved.")).toBeNull();
  expect(
    fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH"),
  ).toHaveLength(1);
});

it("does not treat a mismatched write acknowledgment as a successful claim", async () => {
  setup((method) =>
    json(
      method === "PATCH"
        ? { leadId: "different-lead", assignedUserId: "u1" }
        : inquiry,
    ),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Claim inquiry" }));
  await screen.findByText(/Your claim was not confirmed/);
  expect(screen.queryByText("Your claim was saved.")).toBeNull();
});

it.each(["lost", "conflict"])(
  "reads fresh ownership after returning from a %s claim",
  async (failure) => {
    let changed = false;
    let finishRead!: (value: Response) => void;
    const nextRead = new Promise<Response>((resolve) => {
      finishRead = resolve;
    });
    const { unmount, remount, fetchMock } = setup((method) => {
      if (method === "PATCH") {
        changed = true;
        if (failure === "lost") throw new TypeError("Connection lost");
        return json({}, 409);
      }
      return changed ? nextRead : json(inquiry);
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Claim inquiry" }),
    );
    await screen.findByRole("alert");
    unmount();
    remount();
    const claim = screen.getByRole("button", {
      name: "Claim inquiry",
    }) as HTMLButtonElement;
    expect(claim.disabled).toBe(true);
    fireEvent.click(claim);
    await act(async () => {
      finishRead(json(owned));
      await nextRead;
    });
    await screen.findByText("You");
    expect(screen.queryByRole("button", { name: "Claim inquiry" })).toBeNull();
    expect(
      fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH"),
    ).toHaveLength(1);
  },
);

it("reads ownership after an acknowledgment arrives while the panel is unmounted", async () => {
  let saved = false;
  let finish!: (value: Response) => void;
  const late = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const { unmount, remount, fetchMock } = setup((method) =>
    method === "PATCH" ? late : json(saved ? owned : inquiry),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Claim inquiry" }));
  await screen.findByRole("button", { name: "Claiming…" });
  unmount();
  saved = true;
  await act(async () => {
    finish(json({ leadId: props.leadId, assignedUserId: "u1" }));
    await late;
  });
  remount();
  await screen.findByText("You");
  expect(screen.queryByRole("button", { name: "Claim inquiry" })).toBeNull();
  expect(
    fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH"),
  ).toHaveLength(1);
});

it("discards a late claim result after member authority changes", async () => {
  let finish!: (value: Response) => void;
  const response = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const { client, rerender } = setup((method) =>
    method === "PATCH" ? response : json(inquiry),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Claim inquiry" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Claiming…" })).toBeTruthy(),
  );
  const readonlyMe = { ...me, role: "viewer" };
  act(() => {
    client.setQueryData(getGetMeQueryKey(), readonlyMe);
  });
  rerender({
    ...props,
    scopeKey: memberAuthorityScope(readonlyMe as never),
    canWrite: false,
  });
  await act(async () => {
    finish(json({ leadId: props.leadId, assignedUserId: "u1" }));
    await response;
  });
  await screen.findByText("Unassigned");
  expect(screen.queryByText("Your claim was saved.")).toBeNull();
  expect(screen.queryByRole("button", { name: "Claim inquiry" })).toBeNull();
});

it("checks the newest cached member authority before dispatching a claim", async () => {
  const { client, fetchMock } = setup(() => json(inquiry));
  const claim = await screen.findByRole("button", { name: "Claim inquiry" });
  act(() => {
    client.setQueryData(getGetMeQueryKey(), { ...me, isActive: false });
  });
  fireEvent.click(claim);
  expect(
    fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH"),
  ).toHaveLength(0);
});

it("hides the Smart Site panel for an ordinary lead without an inquiry receipt", async () => {
  const { fetchMock } = setup(() => json({ error: "inquiry_not_found" }, 404));
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  await waitFor(() =>
    expect(
      screen.queryByRole("region", { name: "Website inquiry ownership" }),
    ).toBeNull(),
  );
  expect(screen.queryByRole("alert")).toBeNull();
});
