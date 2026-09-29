import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RuntimeHealthPanel } from "./runtime-health";
import { renderWithQuery } from "@/test/render";
import { mockApi } from "@/test/mock-api";

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const health = (overrides = {}) => ({
  serverNow: new Date().toISOString(),
  health: "healthy",
  staleAfterSeconds: 300,
  heartbeatAt: new Date().toISOString(),
  completedAt: new Date().toISOString(),
  currentStage: null,
  failedStages: [],
  queue: { pending: 2, due: 1, failed: 0, oldestDueAt: null },
  executionsNeedingReview: 0,
  failedWebhookDeliveries: 0,
  boundary: "Runtime health is not delivery proof.",
  ...overrides,
});
const setup = (admin = true, runtime: () => Response = () => reply(health())) =>
  mockApi("owner", {
    handler: (_method, path) =>
      path.endsWith("/session")
        ? reply({ id: "operator", isPlatformAdmin: admin })
        : path.endsWith("/platform/runtime")
          ? runtime()
          : undefined,
  });
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("shows fresh progress separately from business outcomes and delivery proof", async () => {
  setup();
  renderWithQuery(<RuntimeHealthPanel />);
  await screen.findByText("Background work is current");
  expect(
    screen.getByText("Runtime health is not delivery proof."),
  ).toBeTruthy();
  expect(screen.getByText("Due scheduled actions")).toBeTruthy();
});
it("does not request global runtime health for an ordinary organization owner", async () => {
  const calls = setup(false);
  renderWithQuery(<RuntimeHealthPanel />);
  // Wait for the session response to be processed without a forbidden request.
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(screen.queryByText("Follow-up reliability")).toBeNull();
  expect(
    calls.mock.calls.some(([url]) => String(url).includes("/platform/runtime")),
  ).toBe(false);
});
it("shows a stale heartbeat even if a cached status says healthy", async () => {
  setup(true, () =>
    reply(
      health({ heartbeatAt: new Date(Date.now() - 360_000).toISOString() }),
    ),
  );
  renderWithQuery(<RuntimeHealthPanel />);
  await screen.findByText("Worker heartbeat overdue");
  expect(screen.queryByText("Background work is current")).toBeNull();
});
it("shows execution reconciliation guidance without offering a blind retry", async () => {
  setup(true, () =>
    reply(
      health({
        health: "degraded",
        failedStages: ["scheduled-actions"],
        executionsNeedingReview: 1,
      }),
    ),
  );
  renderWithQuery(<RuntimeHealthPanel />);
  await screen.findByText("Background work needs attention");
  expect(screen.getByRole("alert").textContent).toContain("Do not send again");
  expect(screen.queryByRole("button", { name: /retry|send/i })).toBeNull();
});
it("hides a previously healthy snapshot after a refresh fails", async () => {
  let failed = false;
  setup(true, () =>
    failed ? reply({ error: "unavailable" }, 503) : reply(health()),
  );
  renderWithQuery(<RuntimeHealthPanel />);
  await screen.findByText("Background work is current");
  failed = true;
  fireEvent.click(
    screen.getByRole("button", { name: "Refresh runtime health" }),
  );
  await screen.findByRole("alert");
  expect(screen.queryByText("Background work is current")).toBeNull();
  expect(screen.queryByText("Due scheduled actions")).toBeNull();
});
