import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ClientLaunchpad } from "./client-launchpad";
import { renderWithQuery } from "@/test/render";
import { mockApi } from "@/test/mock-api";
const profiles = [
  { id: "hvac", name: "HVAC", services: [["repair", "Repair"]] },
  {
    id: "local-retail",
    name: "Local retail & tea shop",
    services: [["event", "Event inquiry"]],
  },
];
const organizations = [
  { id: "o1", name: "Painless local QA", slug: "painless", timezone: "UTC" },
  { id: "o2", name: "Retail local QA", slug: "retail", timezone: "UTC" },
];
const readiness = (id: string) => ({
  organization: organizations.find((o) => o.id === id),
  serverNow: "2026-09-12T15:00:00Z",
  staffing: { activeManagers: 0, activeResponders: 0 },
  releaseStatus: "not_assessed",
  releaseGates: ["Approved deployment and database migration"],
  sites: [
    {
      id: `s-${id}`,
      name: "Website",
      profile: id === "o1" ? "hvac" : "local-retail",
      source: "test",
      isActive: false,
      responseTargetMinutes: 60,
      credentialVersion: 1,
      credentialIssuedAt: null,
      credentialCheckedAt: null,
      lastSavedAt: null,
    },
  ],
});
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
function setup(
  admin = true,
  handler?: (method: string, path: string) => Response | undefined,
) {
  return mockApi("owner", {
    handler: (method, path) =>
      handler?.(method, path) ??
      (path.endsWith("/session")
        ? response({
            id: "u1",
            isPlatformAdmin: admin,
            organization: organizations[0],
          })
        : path.endsWith("/platform/orgs")
          ? response({ organizations })
          : path.endsWith("/clients/profiles")
            ? response(profiles)
            : path.endsWith("/readiness")
              ? response(readiness(path.includes("/o2/") ? "o2" : "o1"))
              : path.endsWith("/key")
                ? response({ secret: "ss_test_visible_only_once" })
                : undefined),
  });
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("copies the secret-free handoff and reports unavailable clipboard honestly", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  try {
    setup();
    renderWithQuery(<ClientLaunchpad />);
    fireEvent.click(await screen.findByText("Connection handoff · no secret"));
    fireEvent.click(
      screen.getByRole("button", { name: "Copy setup template" }),
    );
    await screen.findByText(
      "Copied. Keep credentials in server-only settings.",
    );
    const template = JSON.parse(writeText.mock.calls[0][0]);
    expect(template.siteId).toBe("s-o1");
    expect(template.serverOnly.GROWTHOS_SITE_SECRET).toBe(
      "<install-secret-on-server-only>",
    );
    writeText.mockRejectedValue(new Error("Clipboard denied"));
    fireEvent.click(
      screen.getByRole("button", { name: "Copy setup template" }),
    );
    await screen.findByText(
      "Clipboard unavailable. Select and copy the value manually.",
    );
  } finally {
    if (descriptor) Object.defineProperty(navigator, "clipboard", descriptor);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
});
it("blocks organization owners who are not platform administrators", async () => {
  const calls = setup(false);
  renderWithQuery(<ClientLaunchpad />);
  await screen.findByText("Platform access required");
  expect(
    screen.queryByRole("button", { name: "New client workspace" }),
  ).toBeNull();
  expect(
    calls.mock.calls.some(([url]) => String(url).includes("/platform/")),
  ).toBe(false);
});
it("distinguishes configured, unverified and not-assessed without pretending a draft is live", async () => {
  setup();
  renderWithQuery(<ClientLaunchpad />);
  await screen.findByText("Launch review still required");
  expect(screen.getByText("Not verified")).not.toBeNull();
  expect(screen.getByText("Not observed")).not.toBeNull();
  expect(screen.getByText("Disabled")).not.toBeNull();
  expect(screen.getByText("Missing")).not.toBeNull();
  expect(screen.queryByText("Verified")).toBeNull();
});
it("does not reuse stale readiness or keys across client selection", async () => {
  setup();
  renderWithQuery(<ClientLaunchpad />);
  const panel = await screen.findByRole("region", {
    name: "Painless local QA readiness",
  });
  fireEvent.click(within(panel).getByRole("checkbox"));
  fireEvent.click(
    within(panel).getByRole("button", { name: "Issue one-time server key" }),
  );
  await screen.findByText("ss_test_visible_only_once");
  fireEvent.change(screen.getByLabelText("Review client setup"), {
    target: { value: "o2" },
  });
  await screen.findByRole("region", { name: "Retail local QA readiness" });
  expect(screen.queryByText("ss_test_visible_only_once")).toBeNull();
  expect(
    screen.queryByRole("link", { name: /Open this organization/ }),
  ).toBeNull();
  fireEvent.change(screen.getByLabelText("Review client setup"), {
    target: { value: "o1" },
  });
  await screen.findByRole("region", { name: "Painless local QA readiness" });
  expect(screen.queryByText("ss_test_visible_only_once")).toBeNull();
});
it("requires explicit draft confirmation, configures chosen profile and reuses UUID after a failed request", async () => {
  let attempts = 0;
  const calls = setup(true, (method, path) =>
    method === "POST" && path.endsWith("/platform/clients")
      ? response(
          ++attempts === 1 ? { error: "temporary" } : { organizationId: "o2" },
          attempts === 1 ? 503 : 201,
        )
      : undefined,
  );
  renderWithQuery(<ClientLaunchpad />);
  fireEvent.click(
    await screen.findByRole("button", { name: "New client workspace" }),
  );
  await screen.findByLabelText("Company name");
  fireEvent.change(screen.getByLabelText("Company name"), {
    target: { value: "Retail local QA" },
  });
  fireEvent.change(screen.getByLabelText("Workspace identifier"), {
    target: { value: "retail-local" },
  });
  fireEvent.change(screen.getByLabelText("Service profile"), {
    target: { value: "local-retail" },
  });
  expect(screen.getByText("Event inquiry")).not.toBeNull();
  const submit = screen.getByRole("button", {
    name: "Create isolated draft",
  }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  fireEvent.click(
    within(
      screen.getByRole("form", { name: "Create isolated client" }),
    ).getByRole("checkbox"),
  );
  fireEvent.click(submit);
  await screen.findByRole("alert");
  expect(
    (screen.getByLabelText("Company name") as HTMLInputElement).value,
  ).toBe("Retail local QA");
  fireEvent.click(submit);
  await waitFor(() => expect(attempts).toBe(2));
  const payloads = calls.mock.calls
    .filter(
      ([url, init]) =>
        String(url).endsWith("/platform/clients") && init?.method === "POST",
    )
    .map(([, init]) => JSON.parse(String(init?.body)));
  expect(payloads[0].requestId).toBe(payloads[1].requestId);
  expect(payloads[0].profile).toBe("local-retail");
  expect(payloads[0].confirmed).toBe(true);
  expect(payloads[0].organizationId).toBeUndefined();
});
it("shows errors instead of green checks when readiness fails or is malformed", async () => {
  setup(true, (_m, p) => (p.endsWith("/readiness") ? response([]) : undefined));
  renderWithQuery(<ClientLaunchpad />);
  await screen.findByText(/Readiness is unavailable/);
  expect(screen.queryByText("Configured")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Retry readiness" }),
  ).not.toBeNull();
});
it("issues credentials only after acknowledgement with the expected version and handles hiding", async () => {
  const calls = setup();
  renderWithQuery(<ClientLaunchpad />);
  const issue = (await screen.findByRole("button", {
    name: "Issue one-time server key",
  })) as HTMLButtonElement;
  expect(issue.disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(issue);
  await screen.findByText("ss_test_visible_only_once");
  const call = calls.mock.calls.find(([url]) => String(url).endsWith("/key"));
  expect(JSON.parse(String(call?.[1]?.body))).toEqual({
    confirmed: true,
    expectedVersion: 1,
  });
  fireEvent.click(screen.getByRole("button", { name: "Hide key" }));
  expect(screen.queryByText("ss_test_visible_only_once")).toBeNull();
});
it("labels old credential checks as needing a recheck, not current verification", async () => {
  const old = readiness("o1");
  setup(true, (_m, p) =>
    p.endsWith("/readiness")
      ? response({
          ...old,
          sites: [
            { ...old.sites[0], credentialCheckedAt: "2026-09-10T15:00:00Z" },
          ],
        })
      : undefined,
  );
  renderWithQuery(<ClientLaunchpad />);
  await screen.findByText("Recheck needed");
  expect(screen.queryByText("Verified")).toBeNull();
});
