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
import Tasks from "./tasks";
import { mockApi } from "@/test/mock-api";
import { renderWithQuery } from "@/test/render";

const id = "00000000-0000-4000-8000-000000000777";
const oldTask = {
  id,
  organizationId: "o1",
  title: "Old overdue task outside the recent 200",
  description: "Keep this context",
  status: "open",
  priority: "normal",
  dueAt: "2020-01-01T12:00:00Z",
  createdAt: "2020-01-01T12:00:00Z",
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
function renderTask(role = "office", response = json(oldTask)) {
  const requests: { method: string; path: string }[] = [];
  mockApi(role, {
    handler: (method, path) => {
      requests.push({ method, path });
      if (method === "GET" && path === "/api/v1/tasks") return json([]);
      if (method === "GET" && path === `/api/v1/tasks/${id}`)
        return response.clone();
      return undefined;
    },
  });
  const location = memoryLocation({
    path: `/tasks?taskId=${id}`,
    record: true,
  });
  renderWithQuery(
    <Router hook={location.hook}>
      <Tasks />
    </Router>,
  );
  return { requests, location };
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Exact task links from Today", () => {
  it("opens and edits the exact overdue task even when absent from the list", async () => {
    const { requests } = renderTask();
    const dialog = await screen.findByRole("dialog", { name: "Task details" });
    expect(
      await within(dialog).findByRole("heading", { name: oldTask.title }),
    ).toBeTruthy();
    expect(
      requests.some((request) => request.path === `/api/v1/tasks/${id}`),
    ).toBe(true);
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Edit this task" }),
    );
    const editor = await screen.findByRole("dialog", { name: "Edit Task" });
    expect(
      (
        within(editor).getByRole("textbox", {
          name: "Title",
        }) as HTMLInputElement
      ).value,
    ).toBe(oldTask.title);
    expect(
      (
        within(editor).getByRole("textbox", {
          name: "Description",
        }) as HTMLInputElement
      ).value,
    ).toBe(oldTask.description);
  });
  it("allows a viewer to read the exact task without mutation controls", async () => {
    const { requests } = renderTask("viewer");
    await screen.findByRole("heading", { name: oldTask.title });
    expect(screen.queryByRole("button", { name: "Edit this task" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Mark task done" })).toBeNull();
    expect(requests.some((request) => request.method !== "GET")).toBe(false);
  });
  it.each(["missing", "foreign", "wrong-id"])(
    "shows %s lookup as unavailable without falling back to another task",
    async (scenario) => {
      renderTask(
        "office",
        scenario === "missing"
          ? json({ error: "Not found" }, 404)
          : json({
              ...oldTask,
              ...(scenario === "foreign"
                ? { organizationId: "other-company" }
                : { id: "00000000-0000-4000-8000-000000000888" }),
            }),
      );
      expect((await screen.findByRole("alert")).textContent).toContain(
        "This task is unavailable",
      );
      expect(screen.queryByRole("heading", { name: oldTask.title })).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Edit this task" }),
      ).toBeNull();
    },
  );
  it("clears the task query on close", async () => {
    const { location } = renderTask();
    const dialog = await screen.findByRole("dialog", { name: "Task details" });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Close", exact: true }),
    );
    await waitFor(() => expect(location.history.at(-1)).toBe("/tasks"));
  });
});
