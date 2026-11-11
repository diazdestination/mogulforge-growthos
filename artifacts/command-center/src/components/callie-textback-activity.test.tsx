import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { CallieTextBackActivity } from "./callie-textback-activity";

const row = (over: Record<string, unknown>) => ({ id: `x-${Math.random()}`, state: "succeeded", detail: "Zapier action completed.", errorCode: null, linkedEntityType: "crm_task", linkedEntityId: "task-1", requestSummary: { toPhone: "+12025550101" }, createdAt: "2026-11-10T15:00:00.000Z", completedAt: "2026-11-10T15:00:05.000Z", ...over });
const stub = (body: unknown, ok = true) => vi.stubGlobal("fetch", vi.fn(async () => ({ ok, status: ok ? 200 : 403, json: async () => body }) as Response));
const view = () => render(<Router hook={memoryLocation({ path: "/calls" }).hook}><CallieTextBackActivity /></Router>);
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("CALLIE text-back activity", () => {
  it("shows office staff why each text-back did or did not go, with its callback task", async () => {
    stub({ executions: [
      row({ id: "sent" }),
      row({ id: "stop", state: "blocked", errorCode: "opted_out", detail: "Not sent: this number opted out of texts (STOP).", requestSummary: { toPhone: "+12025550102" } }),
      row({ id: "night", state: "blocked", errorCode: "quiet_hours", detail: "Not sent: outside 8am to 9pm in your company time zone. Call the customer back instead.", linkedEntityId: "task-2" }),
      row({ id: "land", state: "blocked", errorCode: "landline", detail: "Not sent: the phone system reports this number cannot receive texts (landline or similar).", requestSummary: {} }),
      row({ id: "wait", state: "pending_approval", detail: "Waiting for a human to approve this action." }),
    ] });
    view();
    const region = await screen.findByRole("region", { name: "CALLIE text-back activity" });
    const items = await within(region).findAllByRole("listitem");
    expect(items).toHaveLength(5);
    expect(items[0]!.textContent).toContain("Sent");
    expect(items[0]!.textContent).not.toContain("Zapier action completed");
    expect(items[1]!.textContent).toContain("Not sent: this number opted out of texts (STOP).");
    expect(items[2]!.textContent).toContain("outside 8am to 9pm in your company time zone");
    expect(items[3]!.textContent).toContain("Caller number not on record");
    expect(items[3]!.textContent).toContain("landline");
    expect(items[4]!.textContent).toContain("Waiting for approval");
    expect(items[4]!.textContent).toContain("checked again when someone approves");
    expect(within(items[2]!).getByRole("link", { name: "Open callback task" }).getAttribute("href")).toBe("/tasks?taskId=task-2");
    const fetchMock = vi.mocked(fetch);
    expect(String(fetchMock.mock.calls[0]![0])).toBe("/api/v1/integrations/zapier/executions?capability=callie.sms.send&limit=25");
    fireEvent.click(within(region).getByRole("button", { name: "Refresh text-back activity" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls.every(([, init]) => !init || !(init as RequestInit).method || (init as RequestInit).method === "GET")).toBe(true);
  });

  it("explains an empty list and surfaces a load failure", async () => {
    stub({ executions: [] });
    view();
    expect(await screen.findByText(/No missed-call text-backs yet/)).toBeTruthy();
    cleanup();
    stub({ error: "Not allowed" }, false);
    view();
    expect((await screen.findByRole("alert")).textContent).toBe("Not allowed");
  });
});
