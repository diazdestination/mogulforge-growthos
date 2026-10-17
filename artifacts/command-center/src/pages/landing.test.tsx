import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import LandingPage from "./landing";

afterEach(cleanup);

describe("public entry accessibility", () => {
  it("lets users pinch-zoom: the viewport meta never caps scale or disables zoom (WCAG 1.4.4)", () => {
    const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
    const doc = new DOMParser().parseFromString(html, "text/html");
    const metas = doc.querySelectorAll('meta[name="viewport"]');
    expect(metas).toHaveLength(1);
    const content = (metas[0].getAttribute("content") ?? "").toLowerCase();
    expect(content).toContain("width=device-width");
    expect(content).not.toMatch(/user-scalable\s*=\s*(no|0)/);
    const max = /maximum-scale\s*=\s*([\d.]+)/.exec(content);
    if (max) expect(Number(max[1])).toBeGreaterThanOrEqual(5);
  });

  it("uses AA-contrast text on the dark canvas instead of zinc-500/600 (WCAG 1.4.3)", () => {
    const { container } = render(<LandingPage />);
    // zinc-500 measured 3.94:1 and zinc-600 2.46:1 on #05111e; zinc-400 is 7.24:1.
    expect(container.querySelector(".text-zinc-500, .text-zinc-600")).toBeNull();
    const disclaimer = screen.getByText(/Live outreach requires provider setup/);
    expect(disclaimer.className).toContain("text-zinc-400");
    expect(container.querySelector("footer div")?.className).toContain(
      "text-zinc-400",
    );
  });

  it("wraps the header navigation instead of clipping it at narrow (320px) widths", () => {
    render(<LandingPage />);
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(nav.className).toContain("flex-wrap");
    expect(nav.closest("header")?.className).toMatch(/\bflex-wrap\b/);
    expect(nav.closest("header")?.className).not.toMatch(/(^|\s)h-16(\s|$)/);
    for (const name of ["Meet the team", "Sign in", "Explore"]) {
      expect(
        Array.from(nav.querySelectorAll("a")).some((a) => a.textContent === name),
      ).toBe(true);
    }
  });
});
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
