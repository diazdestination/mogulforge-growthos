import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { Shell } from "./shell";
import { mockApi } from "@/test/mock-api";
import { renderWithQuery } from "@/test/render";

vi.mock("@workspace/replit-auth-web", () => ({
  useAuth: () => ({ logout: vi.fn() }),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function renderShell(role: string, path = "/") {
  mockApi(role);
  const location = memoryLocation({ path, record: true });
  renderWithQuery(
    <Router hook={location.hook}>
      <Shell>
        <p>Workspace</p>
      </Shell>
    </Router>,
  );
  return location;
}
describe("Contractor daily navigation", () => {
  it("puts the five daily destinations first and keeps subscription separate from customer invoices", async () => {
    renderShell("office");
    await screen.findAllByText("Painless");
    const daily = within(
      screen.getByRole("navigation", { name: "Daily work", exact: true }),
    );
    expect(daily.getAllByRole("link").map((link) => link.textContent)).toEqual([
      "Today",
      "Customers & Jobs",
      "Schedule",
      "Invoices",
      "Warranties & Service",
    ]);
    expect(
      daily.getByRole("link", { name: "Today" }).getAttribute("aria-current"),
    ).toBe("page");
    expect(screen.queryByText("Subscription")).toBeNull();
  });
  it.each(["viewer", "sales_rep", "inspector", "production"])(
    "keeps invoice and admin destinations out of search for %s",
    async (role) => {
      renderShell(role);
      await screen.findAllByText("Painless");
      expect(screen.queryAllByText("Invoices")).toHaveLength(0);
      fireEvent.click(
        screen.getByRole("button", { name: "Find a page", exact: true }),
      );
      const search = await screen.findByRole("combobox", {
        name: "Search pages",
      });
      for (const name of [
        "Invoices",
        "Settings",
        "Audit Log",
        "Subscription",
      ]) {
        fireEvent.change(search, { target: { value: name } });
        expect(screen.queryByRole("option", { name, exact: true })).toBeNull();
      }
      fireEvent.change(search, { target: { value: "schedule" } });
      expect(screen.getByRole("option", { name: "Schedule" })).toBeTruthy();
    },
  );
  it("keeps legacy customer URLs active and exposes their secondary tabs", async () => {
    renderShell("owner", "/projects?highlight=synthetic");
    await screen.findAllByText("Painless");
    const daily = within(
      screen.getByRole("navigation", { name: "Daily work", exact: true }),
    );
    expect(
      daily
        .getByRole("link", { name: "Customers & Jobs" })
        .getAttribute("aria-current"),
    ).toBe("page");
    const sections = within(
      screen.getByRole("navigation", { name: "Customers and jobs sections" }),
    );
    expect(
      sections.getByRole("link", { name: "Jobs" }).getAttribute("href"),
    ).toBe("/projects");
    expect(
      sections.getByRole("link", { name: "Jobs" }).getAttribute("aria-current"),
    ).toBe("page");
  });
  it("uses an accessible mobile menu that closes after following a daily link", async () => {
    const location = renderShell("owner");
    await screen.findAllByText("Painless");
    fireEvent.click(screen.getByRole("button", { name: "Menu", exact: true }));
    const menu = await screen.findByRole("dialog", { name: "Painless" });
    fireEvent.click(
      within(menu).getByRole("link", { name: "Warranties & Service" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(location.history.at(-1)).toBe("/service");
  });
});
