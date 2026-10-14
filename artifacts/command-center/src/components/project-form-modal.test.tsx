import { createHash, webcrypto } from "node:crypto";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import ProjectFormModal from "./project-form-modal";
import { Toaster } from '@/components/ui/toaster';
import { renderWithQuery } from '@/test/render';
import { mockApi } from "@/test/mock-api";
import { workId, workMember, workContact } from "@/test/customer-work-fixtures";
import { projectContext } from "@/lib/scheduling-ui-contract.fixtures";
import { canonicalSchedulingEnvelope } from "@workspace/scheduling-core";
const leadId = workId(707),
  estimateId = workId(708),
  projectId = workId(709);
const context = {
  ...projectContext,
  organizationId: workMember.organization.id,
  companyTimeZone: workMember.organization.timezone,
  policyRevision: 0,
  policyDigest: null,
  applicableRules: {
    newTravelGapMinutes: 0,
    companyCeiling: null,
    inspectionCeiling: null,
  },
  source: {
    sourceKind: "lead" as const,
    leadId,
    contactId: workContact,
    propertyId: null,
    estimateId,
  },
};
const record = {
  id: projectId,
  leadId,
  name: "Roof Replacement",
  estimateId,
  status: "scheduled",
  scheduledStart: null,
  scheduledEnd: null,
  crewUserIds: [],
  crewNotes: null,
  createdAt: "2035-01-01T00:00:00Z",
};
const json = (value: unknown, status = 200) => Response.json(value, { status });
type Request = { method: string; path: string; body: Record<string, any> };
function renderStartProject(
  handler?: (request: Request) => Response | Promise<Response> | undefined,
) {
  const requests: Request[] = [];
  const fetchMock = mockApi("office", { me: workMember }),
    fallback = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url, init) => {
    const path = String(url).split("?")[0],
      method = init?.method ?? "GET",
      body = init?.body ? JSON.parse(String(init.body)) : {};
    const request = { method, path, body };
    requests.push(request);
    const response = handler?.(request);
    if (response) return response;
    if (path.endsWith("/scheduling/review-context")) return json(context);
    if (path.endsWith("/settings/scheduling-policy"))
      return json({ policy: null, context: { ...context, source: null } });
    if (method === "POST" && path.endsWith("/projects")) {
      const { operationId, schedulingReview, ...original } = body;
      return json(
        {
          ...record,
          schedulingOperation: {
            operationId,
            organizationId: workMember.organization.id,
            actorUserId: workMember.id,
            kind: "project_create",
            source: context.source,
            payloadSha256: createHash("sha256")
              .update(
                canonicalSchedulingEnvelope({
                  organizationId: workMember.organization.id,
                  actorUserId: workMember.id,
                  kind: "project_create",
                  body: original,
                  review: schedulingReview,
                }),
              )
              .digest("hex"),
            outcome: "committed",
            target: { kind: "project", id: projectId, available: true },
            refusalCode: null,
          },
        },
        201,
      );
    }
    if (method === "PATCH" && path.endsWith("/leads/" + leadId))
      return json({ id: leadId, status: "production_scheduled" });
    return fallback(url, init);
  });
  const onClose = vi.fn();
  function Host() {
    const [shown, setShown] = useState(true);
    return (
      <>
        {shown && (
          <ProjectFormModal
            project={null}
            defaults={{
              leadId,
              estimateId,
              name: "Roof Replacement",
              offerLeadAdvance: true,
            }}
            onClose={() => {
              onClose();
              setShown(false);
            }}
          />
        )}
        <Toaster />
      </>
    );
  }
  const view = renderWithQuery(<Host />);
  return { ...view, requests, onClose };
}
async function submit() {
  fireEvent.click(
    await screen.findByRole("button", { name: "Review unscheduled job" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Start Project" }));
}
beforeEach(() => {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: webcrypto,
  });
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("Start Project original command and separate lead advancement", () => {
  it.each(["notes", "release", "closure"] as const)(
    "preserves raw legacy-null schedule and target authority for historical %s despite failed current policy reads",
    async (change) => {
      const original = {
        ...record,
        updatedAt: "2035-01-01T00:00:00Z",
        contactId: workContact,
        propertyId: null,
        scheduledStart: "2035-01-01T17:00:00.125Z",
        scheduledEnd: null,
        crewUserIds: ["tech"],
        schedulingReservation: null,
        schedulingEvidence: "legacy" as const,
        schedulingTargetFingerprint: "b".repeat(64),
      };
      const writes: Record<string, any>[] = [];
      const fetcher = mockApi("office", { me: workMember }),
        fallback = fetcher.getMockImplementation()!;
      fetcher.mockImplementation(async (url, init) => {
        if (
          String(url).includes("/scheduling/") ||
          String(url).includes("/scheduling-policy")
        )
          return json({ error: "unavailable" }, 503);
        if (init?.method === "PATCH") {
          writes.push(JSON.parse(String(init.body)));
          return json(original);
        }
        return fallback(url, init);
      });
      const close = vi.fn();
      renderWithQuery(
        <ProjectFormModal project={original as any} onClose={close} />,
      );
      await screen.findByText(/Current scheduling review is unavailable/);
      if (change === "notes")
        fireEvent.change(screen.getByLabelText("Crew notes"), {
          target: { value: "Reviewed historical notes" },
        });
      if (change === "release")
        fireEvent.click(
          screen.getByRole("button", { name: "Remove tech from saved crew" }),
        );
      if (change === "closure")
        fireEvent.change(screen.getByLabelText("Job status"), {
          target: { value: "completed" },
        });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(close).toHaveBeenCalledOnce());
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({
        scheduledStart: original.scheduledStart,
        scheduledEnd: null,
        expectedUpdatedAt: original.updatedAt,
        expectedTargetFingerprint: original.schedulingTargetFingerprint,
        crewUserIds: change === "release" ? [] : ["tech"],
      });
      expect(writes[0]).not.toHaveProperty("schedulingReview");
      expect(writes[0]).not.toHaveProperty("operationId");
    },
  );
  it("creates only the explicitly reviewed job then advances its actual lead", async () => {
    const api = renderStartProject();
    await submit();
    await waitFor(() => expect(api.onClose).toHaveBeenCalledTimes(1));
    const create = api.requests.find((r) => r.method === "POST")!;
    expect(create.body).toMatchObject({
      leadId,
      estimateId,
      name: "Roof Replacement",
      schedulingReview: { context },
    });
    expect(create.body.operationId).toMatch(/^[a-f0-9-]{36}$/);
    expect(api.requests.filter((r) => r.method === "PATCH")).toHaveLength(1);
  });
  it("retains an unknown create and offers original reconciliation without a new POST", async () => {
    const api = renderStartProject((r) =>
      r.method === "POST" ? json({ error: "lost" }, 503) : undefined,
    );
    await submit();
    await screen.findByRole("button", {
      name: "Reconcile original project command",
    });
    expect(api.onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Start Project" }));
    expect(api.requests.filter((r) => r.method === "POST")).toHaveLength(1);
    expect(
      screen
        .getByRole("button", { name: "Start Project" })
        .matches(":disabled"),
    ).toBe(true);
  });
  it("shows a separate lead-update error after the job commit and retries only that lead update", async () => {
    let fail = true;
    const api = renderStartProject((r) =>
      r.method === "PATCH" && fail
        ? json({ error: "lost lead update" }, 500)
        : undefined,
    );
    await submit();
    await waitFor(() => expect(api.onClose).toHaveBeenCalledTimes(1));
    await screen.findByText(/lead status not updated/i);
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: /^Retry$/ }));
    await waitFor(() =>
      expect(api.requests.filter((r) => r.method === "PATCH")).toHaveLength(2),
    );
    expect(api.requests.filter((r) => r.method === "POST")).toHaveLength(1);
    await waitFor(() =>
      expect(screen.queryByText(/lead status not updated/i)).toBeNull(),
    );
  });
  it("retains the lead retry action if that separate update fails again", async () => {
    const api = renderStartProject((r) =>
      r.method === "PATCH"
        ? json({ error: "still unavailable" }, 500)
        : undefined,
    );
    await submit();
    await waitFor(() => expect(api.onClose).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByRole("button", { name: /^Retry$/ }));
    await waitFor(() =>
      expect(api.requests.filter((r) => r.method === "PATCH")).toHaveLength(2),
    );
      expect(screen.getByText(/lead status not updated/i)).toBeTruthy();
    expect(api.requests.filter((r) => r.method === "POST")).toHaveLength(1);
  });
  it("does not automatically replay a retained native command on remount", async () => {
    const first = renderStartProject((r) =>
      r.method === "POST" ? json({ error: "lost" }, 503) : undefined,
    );
    await submit();
    await screen.findByRole("button", {
      name: "Reconcile original project command",
    });
    first.unmount();
    const second = renderStartProject();
    await screen.findByRole("button", {
      name: "Reconcile original project command",
    });
    expect(second.requests.filter((r) => r.method !== "GET")).toHaveLength(0);
  });
});
