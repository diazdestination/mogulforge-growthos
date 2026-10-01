import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CustomerEmailSender } from "./customer-email-sender";
import { renderWithQuery } from "@/test/render";
import { mockApi } from "@/test/mock-api";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("makes selection explicit, excludes inactive/read-only members and saves only the selected sender", async () => {
  const calls = mockApi("owner", {
    handler: (method, path) => {
      if (path.endsWith("/settings/email-provider"))
        return json({
          provider: "disabled",
          reason: "No company sender selected.",
        });
      if (path.endsWith("/settings"))
        return json({
          id: "settings",
          organizationId: "org-a",
          businessProfile: {},
          services: [],
          serviceAreas: [],
          customerEmailSenderUserId: null,
        });
      if (path.endsWith("/users"))
        return json([
          {
            id: "a",
            firstName: "Alex",
            email: "alex@example.test",
            role: "office",
            isActive: true,
          },
          {
            id: "inactive",
            firstName: "Inactive",
            role: "admin",
            isActive: false,
          },
          { id: "viewer", firstName: "Reader", role: "viewer", isActive: true },
        ]);
      return undefined;
    },
  });
  renderWithQuery(<CustomerEmailSender />);
  const select = await screen.findByLabelText("Company default sender");
  await screen.findByRole("option", { name: /Alex/ });
  expect(screen.queryByRole("option", { name: "Inactive" })).toBeNull();
  expect(screen.queryByRole("option", { name: "Reader" })).toBeNull();
  expect(
    screen
      .getByRole("button", { name: "Save customer sender" })
      .hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.change(select, { target: { value: "a" } });
  fireEvent.click(screen.getByRole("button", { name: "Save customer sender" }));
  await waitFor(() =>
    expect(
      calls.mock.calls.some(
        ([, init]) =>
          init?.method === "PUT" &&
          init.body === JSON.stringify({ customerEmailSenderUserId: "a" }),
      ),
    ).toBe(true),
  );
});
