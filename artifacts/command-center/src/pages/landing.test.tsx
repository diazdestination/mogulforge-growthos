import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import LandingPage from "./landing";

afterEach(cleanup);
it("positions GrowthOS as a BIE with a concrete first workflow", () => {
  render(<LandingPage />);
  expect(screen.getByRole("heading", { level: 1 }).textContent).toContain(
    "clear next actions",
  );
  expect(
    screen.getByText(/Business Intelligence Ecosystem \(BIE\)/),
  ).toBeTruthy();
  expect(
    screen.getByRole("heading", { name: "Bring your existing leads" }),
  ).toBeTruthy();
  expect(
    screen
      .getByRole("link", { name: "Explore a workspace" })
      .getAttribute("href"),
  ).toBe("/signup");
});
it("keeps live-provider and outcome boundaries visible instead of promising unverified automation or ROI", () => {
  const { container } = render(<LandingPage />);
  expect(
    screen.getByText(
      /Live outreach requires provider setup and launch verification/,
    ),
  ).toBeTruthy();
  expect(
    screen.getByText(
      /Pipeline value and recorded payments remain clearly distinguished/,
    ),
  ).toBeTruthy();
  expect(container.textContent).not.toMatch(
    /runs itself|always on|Honest ROI reporting|under a minute|AI-powered CRM/,
  );
});
