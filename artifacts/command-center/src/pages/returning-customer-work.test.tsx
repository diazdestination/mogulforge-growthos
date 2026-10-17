import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getGetMeQueryKey } from "@workspace/api-client-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { makeSchedulingContext } from "@/test/scheduling-ui-fixtures";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import Estimates from "./estimates";
import Projects from "./projects";
import Invoices from "./invoices";
import { CustomerWorkForm } from "@/components/customer-work-form";
import { customerWorkCommandKey } from "@/hooks/use-customer-work-command";
import { invoiceRequestStorageKey } from "@/hooks/use-invoice-command";
import { memberAuthorityScope } from "@/lib/member-authority-scope";
import { sampleDelivery } from "@/test/invoice-delivery-fixtures";
import {
  workId as id,
  workOrg as org,
  workContact as contact,
  workRoot as root,
  workMember,
  workCustomer,
  workEstimate,
  workProject,
  workInvoice,
  workProperties,
  workPropertyRow,
} from "@/test/customer-work-fixtures";

beforeEach(() => {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: webcrypto,
  });
});
function schedulingRead(input: RequestInfo | URL) {
  const url = new URL(
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
          "http://localhost",
        );
  const context = makeSchedulingContext({
    organizationId: org,
    policyRevision: 0,
    policyDigest: null,
    inspection: null,
    applicableRules: {
      newTravelGapMinutes: 0,
      companyCeiling: null,
      inspectionCeiling: null,
    },
    source: {
      sourceKind: "direct_customer",
      leadId: null,
      contactId: url.searchParams.get("sourceId") ?? contact,
      propertyId: url.searchParams.get("propertyId"),
      estimateId: url.searchParams.get("estimateId"),
    },
    targetVersion: url.searchParams.has("targetId")
      ? workProject().updatedAt
      : null,
    targetFingerprint: url.searchParams.has("targetId")
      ? workProject().schedulingTargetFingerprint
      : null,
  });
  if (url.pathname.endsWith("/scheduling/review-context")) return json(context);
  if (url.pathname.endsWith("/settings/scheduling-policy"))
    return json({ policy: null, context });
}
async function reviewJob() {
  fireEvent.click(
    await screen.findByRole("button", { name: "Review unscheduled job" }),
  );
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
type Request = { url: URL; method: string; body: Record<string, any> };
function setup(
  page: "estimates" | "projects" | "invoices",
  search = "",
  override?: (
    request: Request,
  ) => Response | undefined | Promise<Response | undefined>,
) {
  const state = {
    me: { ...workMember },
    profileStatus: 200,
    estimate: workEstimate(),
    project: workProject(),
    invoice: workInvoice(),
    listEstimate: true,
    listProject: true,
  };
  const requests: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = {
        url: new URL(
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
          "http://localhost",
        ),
        method: init?.method || "GET",
        body: init?.body ? JSON.parse(String(init.body)) : {},
      };
      requests.push(request);
      const scheduling = schedulingRead(input);
      if (scheduling) return scheduling;
      const changed = await override?.(request);
      if (changed) return changed;
      const path = request.url.pathname;
      if (path === "/api/v1/me")
        return json(
          state.profileStatus === 200
            ? state.me
            : { error: "Profile unavailable" },
          state.profileStatus,
        );
      if (request.method === "GET") {
        if (path === "/api/v1/contacts")
          return json([workCustomer(), workCustomer(id(709))]);
        if (/\/contacts\/[^/]+$/.test(path))
          return json(workCustomer(path.split("/").at(-1)));
        if (path.includes("/workspace/properties"))
          return json(workProperties(path.split("/")[4]));
        if (path === "/api/v1/users") return json([]);
        if (path === "/api/v1/leads") return json([]);
        if (path === "/api/v1/estimates")
          return json(state.listEstimate ? [state.estimate] : []);
        if (path === `/api/v1/estimates/${state.estimate.id}`)
          return json(state.estimate);
        if (path === "/api/v1/projects")
          return json(state.listProject ? [state.project] : []);
        if (path === `/api/v1/projects/${state.project.id}`)
          return json(state.project);
        if (path === "/api/v1/invoices")
          return json({
            items: [state.invoice],
            total: 1,
            page: 0,
            pageSize: 25,
          });
        if (path === `/api/v1/invoices/${state.invoice.id}`)
          return json(state.invoice);
        if (path.endsWith("/delivery"))
          return json(sampleDelivery({ invoiceId: state.invoice.id }));
      }
      return json({ code: "unexpected_test_route", error: path }, 500);
    }),
  );
  const location = memoryLocation({ path: `/${page}${search}`, record: true });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <Router hook={location.hook}>
        {page === "estimates" ? (
          <Estimates />
        ) : page === "projects" ? (
          <Projects />
        ) : (
          <Invoices />
        )}
      </Router>
    </QueryClientProvider>,
  );
  return { state, requests, client, location, view };
}
const writes = (requests: Request[]) =>
  requests.filter((request) => request.method !== "GET");
const fresh = `?new=customer&contactId=${contact}&organizationId=${org}`;
const chosen = () =>
  screen.getByRole("checkbox", { name: /I checked this customer/ });
const reviewed = () =>
  screen.getByRole("checkbox", { name: /I reviewed this native work/ });
const propertyPicker = () =>
  screen.getByRole("combobox", { name: /Property for this new/ });
async function estimateDraft() {
  await screen.findByRole("option", { name: /704 Fictional Lane/ });
  fireEvent.change(screen.getByLabelText("Estimate title"), {
    target: { value: "Annual return service" },
  });
  fireEvent.change(screen.getByLabelText("Line 1 description"), {
    target: { value: "Company reviewed scope" },
  });
  fireEvent.change(screen.getByLabelText("Line 1 unit price (USD)"), {
    target: { value: "125.00" },
  });
  fireEvent.click(chosen());
  fireEvent.click(reviewed());
}
function estimateAck(request: Request, extra: Record<string, unknown> = {}) {
  const estimate = workEstimate({
    title: request.body.title,
    propertyId: request.body.source?.propertyId ?? null,
    workVersion:
      request.method === "PATCH" ? request.body.expectedWorkVersion + 1 : 1,
    ...extra,
  });
  return json({
    organizationId: org,
    estimate,
    command: {
      requestId: request.body.requestId,
      action:
        request.method === "PATCH" ? "estimate_updated" : "estimate_created",
      customerWorkId: estimate.customerWorkId,
      targetId: estimate.id,
      version:
        request.method === "PATCH" ? request.body.expectedWorkVersion + 1 : 1,
      duplicate: false,
    },
  });
}
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("native existing-customer work", () => {
  it("creates an estimate with explicitly confirmed null property and no acquisition call", async () => {
    const api = setup("estimates", fresh, (request) =>
      request.url.pathname === "/api/v1/customer-work/estimates"
        ? estimateAck(request)
        : undefined,
    );
    await estimateDraft();
    expect(propertyPicker()).toHaveProperty("value", "");
    fireEvent.click(
      screen.getByRole("button", { name: "Save customer estimate" }),
    );
    await screen.findByText("Native estimate saved");
    const [write] = writes(api.requests);
    expect(write.body).toMatchObject({
      confirmed: true,
      source: {
        kind: "existing_customer",
        contactId: contact,
        propertyId: null,
      },
      title: "Annual return service",
      lineItems: [
        {
          description: "Company reviewed scope",
          quantity: 1,
          unitPriceCents: 12500,
        },
      ],
    });
    expect(write.body).not.toHaveProperty("leadId");
    expect(writes(api.requests)).toHaveLength(1);
    expect(
      screen
        .getByRole("link", { name: "Open saved estimate" })
        .getAttribute("href"),
    ).toBe(`/estimates?estimateId=${workEstimate().id}&organizationId=${org}`);
  });
  it("uses a later property page and clears both source review and old property after customer changes", async () => {
    const api = setup("estimates", fresh, (request) =>
      request.url.pathname.endsWith("/workspace/properties")
        ? json(
            workProperties(
              request.url.pathname.split("/")[4],
              request.url.search ? [workPropertyRow(740)] : [workPropertyRow()],
              request.url.search ? null : "next_page",
            ),
          )
        : undefined,
    );
    await estimateDraft();
    fireEvent.click(
      screen.getByRole("button", { name: "Load more customer properties" }),
    );
    await screen.findByRole("option", { name: /740 Fictional Lane/ });
    expect(chosen()).toHaveProperty("checked", false);
    fireEvent.change(propertyPicker(), { target: { value: id(740) } });
    fireEvent.click(chosen());
    fireEvent.change(
      screen.getByRole("combobox", { name: "Existing customer" }),
      { target: { value: id(709) } },
    );
    await waitFor(() => expect(propertyPicker()).toHaveProperty("value", ""));
    expect(chosen()).toHaveProperty("checked", false);
    expect(reviewed()).toHaveProperty("checked", false);
    expect(writes(api.requests)).toHaveLength(0);
  });
  it("holds failed property reads rather than treating them as deliberate no-property", async () => {
    const api = setup("estimates", fresh, (request) =>
      request.url.pathname.endsWith("/workspace/properties")
        ? json({ error: "No proof" }, 503)
        : undefined,
    );
    await screen.findByText(/not an empty-property result/);
    expect(chosen()).toHaveProperty("disabled", true);
    expect(writes(api.requests)).toHaveLength(0);
  });
  it("preserves draft and source review through unchanged profile polling", async () => {
    const api = setup("estimates", fresh);
    await estimateDraft();
    await act(async () => {
      await api.client.invalidateQueries({ queryKey: getGetMeQueryKey() });
    });
    await waitFor(() =>
    expect(screen.getByLabelText("Estimate title")).toHaveProperty(
      "value",
      "Annual return service",
    ),
    );
    expect(chosen()).toHaveProperty("checked", true);
    expect(reviewed()).toHaveProperty("checked", true);
    expect(
      api.requests.filter((request) =>
        request.url.pathname.endsWith("/workspace/properties"),
      ),
    ).toHaveLength(1);
  });
  it.each([
    "role",
    "company",
    "identity",
    "inactive",
    "profile-error",
  ] as const)(
    "ignores a save acknowledgement after %s authority changed and retains original request",
    async (mode) => {
      let release!: (value: Response) => void, submitted!: Request;
      const api = setup("estimates", fresh, (request) =>
        request.method === "POST" &&
        request.url.pathname.endsWith("/customer-work/estimates")
          ? ((submitted = request),
            new Promise<Response>((resolve) => {
              release = resolve;
            }))
          : undefined,
      );
      await estimateDraft();
      fireEvent.click(
        screen.getByRole("button", { name: "Save customer estimate" }),
      );
      await waitFor(() => expect(release).toBeDefined());
      if (mode === "role")
        api.state.me = { ...api.state.me, role: "viewer" as any };
      if (mode === "company")
        api.state.me = {
          ...api.state.me,
          organization: { ...api.state.me.organization, id: id(799) },
        };
      if (mode === "identity")
        api.state.me = { ...api.state.me, id: "another-fictional-member" };
      if (mode === "inactive")
        api.state.me = { ...api.state.me, isActive: false };
      if (mode === "profile-error") api.state.profileStatus = 503;
      await act(async () => {
        await api.client.invalidateQueries({ queryKey: getGetMeQueryKey() });
        release(estimateAck(submitted));
      });
      expect(screen.queryByText("Native estimate saved")).toBeNull();
      expect(writes(api.requests)).toHaveLength(1);
      expect(
        sessionStorage.getItem(
          customerWorkCommandKey(workMember.id, org, "estimates:new"),
        ),
      ).toContain(submitted.body.requestId);
    },
  );
  it("retains a lost acknowledgement across remount and reconciles only the original request key", async () => {
    let count = 0;
    const api = setup("estimates", fresh, (request) =>
      request.url.pathname.endsWith("/customer-work/estimates")
        ? ++count === 1
          ? Promise.reject(new TypeError("Response lost"))
          : estimateAck(request)
        : undefined,
    );
    await estimateDraft();
    fireEvent.click(
      screen.getByRole("button", { name: "Save customer estimate" }),
    );
    await screen.findByRole("button", {
      name: "Reconcile original work request",
    });
    const first = writes(api.requests)[0];
    fireEvent.click(screen.getByRole("button", { name: "Close work form" }));
    fireEvent.click(screen.getByRole("button", { name: "New Estimate" }));
    await waitFor(() =>
    expect(screen.getByLabelText("Estimate title")).toHaveProperty(
      "value",
      "Annual return service",
    ),
    );
    expect(writes(api.requests)).toHaveLength(1);
    fireEvent.click(
      screen.getByRole("button", { name: "Reconcile original work request" }),
    );
    await screen.findByText("Native estimate saved");
    expect(writes(api.requests)[1].body).toEqual(first.body);
    expect(
      sessionStorage.getItem(
        customerWorkCommandKey(workMember.id, org, "estimates:new"),
      ),
    ).toBeNull();
  });
  it("does not accept a response for a different root/target and keeps its uncertain command", async () => {
    const api = setup("estimates", fresh, (request) =>
      request.url.pathname.endsWith("/customer-work/estimates")
        ? json({
            organizationId: org,
            estimate: workEstimate(),
            command: {
              requestId: request.body.requestId,
              action: "estimate_created",
              customerWorkId: id(799),
              targetId: id(799),
              version: 1,
              duplicate: false,
            },
          })
        : undefined,
    );
    await estimateDraft();
    fireEvent.click(
      screen.getByRole("button", { name: "Save customer estimate" }),
    );
    await screen.findByRole("button", {
      name: "Reconcile original work request",
    });
    expect(screen.queryByText("Native estimate saved")).toBeNull();
    expect(writes(api.requests)).toHaveLength(1);
  });
  it("opens exact older estimates outside the list and uses versioned edits with immutable source", async () => {
    const api = setup(
      "estimates",
      `?estimateId=${workEstimate().id}&organizationId=${org}`,
      (request) =>
        request.url.pathname ===
        `/api/v1/customer-work/estimates/${workEstimate().id}`
          ? estimateAck(request)
          : undefined,
    );
    api.state.listEstimate = false;
    await screen.findByRole("heading", {
      name: "Fictional repeat service estimate",
    });
    const card = screen
      .getByRole("heading", { name: "Fictional repeat service estimate" })
      .closest('[class*="rounded-2xl"]')!;
    const edit = within(card as HTMLElement)
      .getAllByRole("button")
      .find(
        (button) =>
          button.querySelector(".lucide-pen") ||
          button.querySelector(".lucide-square-pen"),
      );
    // Existing edit icon remains in the native card.
    fireEvent.click(
      edit || within(card as HTMLElement).getAllByRole("button")[0],
    );
    await screen.findByRole("dialog", { name: "Existing customer estimate" });
    fireEvent.change(screen.getByLabelText("Recorded estimate status"), {
      target: { value: "accepted" },
    });
    fireEvent.click(reviewed());
    fireEvent.click(
      screen.getByRole("button", { name: "Save customer estimate" }),
    );
    await screen.findByText("Native estimate saved");
    const [write] = writes(api.requests);
    expect(write.method).toBe("PATCH");
    expect(write.body).toMatchObject({
      expectedWorkVersion: 1,
      status: "accepted",
      notes: "Original staff notes",
    });
    expect(write.body).not.toHaveProperty("source");
    expect(write.url.pathname).toContain("/customer-work/");
  });
  it("creates a direct job from existing customer with explicit null property, no estimate or lead stage effect", async () => {
    const api = setup("projects", fresh, async (request) =>
      request.url.pathname === "/api/v1/customer-work/projects"
        ? json({
            organizationId: org,
            project: workProject({ name: request.body.name }),
            commandOutcome: {
              formatVersion: 1,
              organizationId: org,
              actorUserId: workMember.id,
              requestId: request.body.requestId,
              action: "project_created",
              payloadSha256: (await import("node:crypto"))
                .createHash("sha256")
                .update(
                  JSON.stringify(
                    {
                      action: "project_created",
                      actorUserId: workMember.id,
                      targetId: null,
                      input: (
                        await import("../../../api-server/src/services/returning-customer-contract")
                      ).createCustomerWorkProjectSchema.parse(request.body),
                    },
                    (_key, value) =>
                      value &&
                      typeof value === "object" &&
                      !Array.isArray(value)
                        ? Object.fromEntries(
                            Object.entries(value)
                              .filter(([, item]) => item !== undefined)
                              .sort(([a], [b]) => a.localeCompare(b)),
                          )
                        : value,
                  ),
                )
                .digest("hex"),
              customerWorkId: root,
              target: {
                kind: "project",
                id: workProject().id,
                available: true,
              },
              resultWorkVersion: 1,
              outcome: "committed",
            },
            command: {
              requestId: request.body.requestId,
              action: "project_created",
              customerWorkId: root,
              targetId: workProject().id,
              version: 1,
              duplicate: false,
            },
          })
        : undefined,
    );
  await screen.findByRole("option", { name: /704 Fictional Lane/ });
    fireEvent.change(screen.getByLabelText("Job name"), {
      target: { value: "Existing customer job" },
    });
    fireEvent.click(chosen());
    fireEvent.click(reviewed());
    await reviewJob();
    fireEvent.click(screen.getByRole("button", { name: "Save customer job" }));
    await screen.findByText("Native job saved");
    const [write] = writes(api.requests);
    expect(write.body.source).toEqual({
      kind: "existing_customer",
      contactId: contact,
      propertyId: null,
    });
    expect(write.body).not.toHaveProperty("estimateId");
    expect(writes(api.requests)).toHaveLength(1);
  });
  it("keeps an edit draft on a version refusal until explicitly discarding and loading the exact current version", async () => {
    let changed = false;
    const api = setup(
      "estimates",
      `?estimateId=${workEstimate().id}&organizationId=${org}`,
      (request) => {
        if (
          request.url.pathname.endsWith(
            `/customer-work/estimates/${workEstimate().id}`,
          )
        ) {
          if (!changed) {
            changed = true;
            return json(
              {
                code: "customer_work_version_changed",
                error: "Latest version required",
              },
              409,
            );
          }
          return estimateAck(request, { workVersion: 3 });
        }
        if (
          changed &&
          request.url.pathname === `/api/v1/estimates/${workEstimate().id}`
        )
          return json(
            workEstimate({ title: "Latest staff revision", workVersion: 2 }),
          );
        return undefined;
      },
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Edit Fictional repeat service estimate",
      }),
    );
    fireEvent.change(screen.getByLabelText("Estimate title"), {
      target: { value: "My unsubmitted revision" },
    });
    fireEvent.click(reviewed());
    fireEvent.click(
      screen.getByRole("button", { name: "Save customer estimate" }),
    );
    await screen.findByRole("button", {
      name: "Discard my edits and load latest work version",
    });
    expect(screen.getByLabelText("Estimate title")).toHaveProperty(
      "value",
      "My unsubmitted revision",
    );
    expect(
      screen
        .getByRole("button", { name: "Save customer estimate" })
        .matches(":disabled"),
    ).toBe(true);
    expect(writes(api.requests)).toHaveLength(1);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Discard my edits and load latest work version",
      }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Estimate title")).toHaveProperty(
        "value",
        "Latest staff revision",
      ),
    );
    expect(reviewed()).toHaveProperty("checked", false);
    fireEvent.click(reviewed());
    fireEvent.click(
      screen.getByRole("button", { name: "Save customer estimate" }),
    );
    await screen.findByText("Native estimate saved");
    expect(writes(api.requests)[1].body.expectedWorkVersion).toBe(2);
    expect(writes(api.requests)[1].body.requestId).not.toBe(
      writes(api.requests)[0].body.requestId,
    );
  });
  it("keeps an original replay pinned through later access refusal without minting another command", async () => {
    let count = 0;
    const api = setup("estimates", fresh, (request) =>
      request.url.pathname.endsWith("/customer-work/estimates")
        ? ++count === 1
          ? Promise.reject(new TypeError("lost"))
          : json(
              {
                code: "customer_work_access_denied",
                error: "No longer allowed",
              },
              403,
            )
        : undefined,
    );
    await estimateDraft();
    fireEvent.click(
      screen.getByRole("button", { name: "Save customer estimate" }),
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Reconcile original work request",
      }),
    );
    await screen.findByRole("button", {
      name: "Reconcile original work request",
    });
    expect(writes(api.requests)).toHaveLength(2);
    expect(writes(api.requests)[1].body).toEqual(writes(api.requests)[0].body);
    expect(
      sessionStorage.getItem(
        customerWorkCommandKey(workMember.id, org, "estimates:new"),
      ),
    ).toContain(writes(api.requests)[0].body.requestId);
    expect(
      screen
        .getByRole("button", { name: "Save customer estimate" })
        .matches(":disabled"),
    ).toBe(true);
  });
  it("allows no mutation controls when the new-customer link is opened read-only", async () => {
    const api = setup("projects", fresh);
    api.state.me = { ...api.state.me, role: "viewer" as any };
    await screen.findByRole("heading", { name: "Projects" });
    expect(
      screen.queryByRole("button", { name: "Save customer job" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "New Project" })).toBeNull();
    expect(writes(api.requests)).toHaveLength(0);
  });
  it("converts the exact staff-accepted estimate without fabricated lead assignment", async () => {
    const accepted = workEstimate({
      status: "accepted",
      acceptedAt: "2026-10-01T12:00:00Z",
    });
    let body: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const scheduling = schedulingRead(input);
        if (scheduling) return scheduling;
        if (init?.method === "POST") {
          body = JSON.parse(String(init.body));
          return json({
            organizationId: org,
            project: workProject({ estimateId: accepted.id }),
            commandOutcome: {
              formatVersion: 1,
              organizationId: org,
              actorUserId: workMember.id,
              requestId: body.requestId,
              action: "project_created",
              payloadSha256: (await import("node:crypto"))
                .createHash("sha256")
                .update(
                  JSON.stringify(
                    {
                      action: "project_created",
                      actorUserId: workMember.id,
                      targetId: null,
                      input: (
                        await import("../../../api-server/src/services/returning-customer-contract")
                      ).createCustomerWorkProjectSchema.parse(body),
                    },
                    (_key, value) =>
                      value &&
                      typeof value === "object" &&
                      !Array.isArray(value)
                        ? Object.fromEntries(
                            Object.entries(value)
                              .filter(([, item]) => item !== undefined)
                              .sort(([a], [b]) => a.localeCompare(b)),
                          )
                        : value,
                  ),
                )
                .digest("hex"),
              customerWorkId: root,
              target: {
                kind: "project",
                id: workProject().id,
                available: true,
              },
              resultWorkVersion: 1,
              outcome: "committed",
            },
            command: {
              requestId: body.requestId,
              action: "project_created",
              customerWorkId: root,
              targetId: workProject().id,
              version: 1,
              duplicate: false,
            },
          });
        }
        return json([]);
      }),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(getGetMeQueryKey(), workMember);
    render(
      <QueryClientProvider client={client}>
        <Router>
          <CustomerWorkForm
            kind="projects"
            actor={{
              id: workMember.id,
              organizationId: org,
              scopeKey: memberAuthorityScope(workMember),
            }}
            fromEstimate={accepted}
            onClose={vi.fn()}
          />
        </Router>
      </QueryClientProvider>,
    );
    fireEvent.click(reviewed());
    await reviewJob();
    fireEvent.click(screen.getByRole("button", { name: "Save customer job" }));
    await screen.findByText("Native job saved");
    expect(body.source).toEqual({
      kind: "estimate",
      estimateId: accepted.id,
      expectedWorkVersion: 1,
    });
    expect(body).not.toHaveProperty("leadId");
  });
  it("keeps the original submitted estimate when an unresolved conversion is reopened from another estimate", async () => {
    const accepted = workEstimate({
      status: "accepted",
      acceptedAt: "2026-10-01T12:00:00Z",
    });
    const unrelated = workEstimate({
      id: id(795),
      customerWorkId: id(796),
      contactId: id(797),
      title: "Unrelated saved estimate",
      status: "accepted",
    });
    const submitted: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const scheduling = schedulingRead(_input);
        if (scheduling) return scheduling;
        if (init?.method !== "POST") return json([]);
        const body = JSON.parse(String(init.body));
        submitted.push(body);
        if (submitted.length === 1) throw new TypeError("Acknowledgement lost");
        return json({
          organizationId: org,
          project: workProject({ estimateId: accepted.id, workVersion: 3 }),
          commandOutcome: {
            formatVersion: 1,
            organizationId: org,
            actorUserId: workMember.id,
            requestId: body.requestId,
            action: "project_created",
            payloadSha256: (await import("node:crypto"))
              .createHash("sha256")
              .update(
                JSON.stringify(
                  {
                    action: "project_created",
                    actorUserId: workMember.id,
                    targetId: null,
                    input: (
                      await import("../../../api-server/src/services/returning-customer-contract")
                    ).createCustomerWorkProjectSchema.parse(body),
                  },
                  (_key, value) =>
                    value && typeof value === "object" && !Array.isArray(value)
                      ? Object.fromEntries(
                          Object.entries(value)
                            .filter(([, item]) => item !== undefined)
                            .sort(([a], [b]) => a.localeCompare(b)),
                        )
                      : value,
                ),
              )
              .digest("hex"),
            customerWorkId: root,
            target: { kind: "project", id: workProject().id, available: true },
            resultWorkVersion: 1,
            outcome: "committed",
          },
          command: {
            requestId: body.requestId,
            action: "project_created",
            customerWorkId: root,
            targetId: workProject().id,
            version: 1,
            duplicate: true,
          },
        });
      }),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(getGetMeQueryKey(), workMember);
    const form = (estimate: ReturnType<typeof workEstimate>) => (
      <QueryClientProvider client={client}>
        <Router>
          <CustomerWorkForm
            kind="projects"
            actor={{
              id: workMember.id,
              organizationId: org,
              scopeKey: memberAuthorityScope(workMember),
            }}
            fromEstimate={estimate}
            onClose={vi.fn()}
          />
        </Router>
      </QueryClientProvider>
    );
    const view = render(form(accepted));
    fireEvent.click(reviewed());
    await reviewJob();
    fireEvent.click(screen.getByRole("button", { name: "Save customer job" }));
    await screen.findByRole("button", {
      name: "Reconcile original work request",
    });
    view.rerender(form(unrelated));
    expect(
      (await screen.findByRole("region", { name: "Original submitted source" }))
        .textContent,
    ).toContain(accepted.id);
    expect(
      screen.queryByText(/Accepted estimate: Unrelated saved estimate/),
    ).toBeNull();
    expect(submitted).toHaveLength(1);
    fireEvent.click(
      screen.getByRole("button", { name: "Reconcile original work request" }),
    );
    await screen.findByText("Native job saved");
    expect(submitted[1]).toEqual(submitted[0]);
    expect(screen.getByRole("status").textContent).toContain(
      "Original request reconciled at work version 1. Current saved work version: 3.",
    );
  });
  it.each(["estimates", "projects", "invoices"] as const)(
    "rejects a foreign-company %s shortcut before record reads",
    async (page) => {
      const api = setup(
        page,
        `?new=customer&contactId=${contact}&organizationId=${id(799)}`,
      );
      await screen.findByRole("alert");
      expect(
        api.requests.filter(
          (request) =>
            request.url.pathname !== "/api/v1/me" &&
            request.url.pathname.includes("/contacts/"),
        ),
      ).toHaveLength(0);
      expect(writes(api.requests)).toHaveLength(0);
    },
  );
});

describe("unproven returning-project errors retain original custody", () => {
  it.each([
    "customer_work_version_changed",
    "customer_work_request_conflict",
    "customer_work_source_changed",
  ])(
    "holds %s after refresh and remount without creating a new request",
    async (code) => {
      const api = setup("projects", fresh, (request) =>
        request.method === "POST"
          ? json({ code, error: "Unproven original result" }, 409)
          : undefined,
      );
  await screen.findByRole("option", { name: /704 Fictional Lane/ });
      fireEvent.change(screen.getByLabelText("Job name"), {
        target: { value: "Original reviewed job" },
      });
      fireEvent.click(chosen());
      fireEvent.click(reviewed());
      await reviewJob();
    fireEvent.click(screen.getByRole("button", { name: "Save customer job" }));
    await screen.findByRole("button", {
      name: "Reconcile original work request",
    });
      const original = writes(api.requests)[0].body;
      expect(
        screen.queryByRole("button", { name: /Discard my edits/ }),
      ).toBeNull();
      fireEvent.click(
        screen.getByRole("button", { name: "Refresh scheduling review" }),
      );
      expect(writes(api.requests)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Close work form" }));
      fireEvent.click(screen.getByRole("button", { name: "New Project" }));
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Reconcile original work request",
      }),
    );
      await waitFor(() => expect(writes(api.requests)).toHaveLength(2));
      expect(writes(api.requests)[1].body).toEqual(original);
      expect(
        screen
          .getByRole("button", { name: "Save customer job" })
          .matches(":disabled"),
      ).toBe(true);
    },
  );
});

describe("existing customer native invoices and corrections", () => {
  it.each(["draft", "issued"] as const)(
    "hides the internal work ID in a %s invoice label while preserving its customer history and receipt boundary",
    async (status) => {
      const invoice = workInvoice({
        status,
        invoiceNumber: status === "issued" ? "SYN-100" : null,
        issuedAt: status === "issued" ? "2026-10-01T00:00:00Z" : null,
      });
      const api = setup("invoices", `/${invoice.id}?organizationId=${org}`);
      api.state.invoice = invoice;

      const label = await screen.findByText(/Receipt accounting is isolated to this work/);
      expect(label.textContent).toContain("Existing-customer work");
      expect(label.textContent).not.toContain(root);
      expect(label.textContent).toContain("not this customer’s other jobs");
      expect(screen.getByText(/Synthetic service work · Version 1/)).toBeTruthy();
      expect(screen.getByRole("heading", { name: status === "issued" ? "SYN-100" : "Draft invoice" })).toBeTruthy();
      expect(screen.getByRole("link", { name: "Customer invoice history" }).getAttribute("href"))
        .toBe(`/contacts/${contact}?organizationId=${org}&section=invoices`);
      expect(writes(api.requests)).toHaveLength(0);
      expect(api.requests.some(request => request.url.pathname.endsWith("/leads/null"))).toBe(false);
    },
  );
  it("does not show a work label or customer history for an invoice response from another company", async () => {
    const invoice = workInvoice({ organizationId: id(799) });
    const api = setup("invoices", `/${invoice.id}?organizationId=${org}`);
    api.state.invoice = invoice;

    await screen.findByRole("heading", { name: "This invoice could not load" });
    expect(screen.queryByText(/Existing-customer work/)).toBeNull();
    expect(screen.queryByRole("link", { name: "Customer invoice history" })).toBeNull();
    expect(writes(api.requests)).toHaveLength(0);
  });
  it("requires a fresh explicit customer/property review after changing invoice source mode", async () => {
    const api = setup("invoices", fresh);
    await screen.findByRole("option", { name: /704 Fictional Lane/ });
    fireEvent.change(propertyPicker(), { target: { value: id(704) } });
    fireEvent.click(chosen());
    expect(chosen()).toHaveProperty("checked", true);
    fireEvent.click(
      screen.getByRole("button", { name: "Customer opportunity" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Existing customer · No new lead" }),
    );
    expect(
      screen.getByRole("combobox", { name: "Existing customer" }),
    ).toHaveProperty("value", "");
    expect(propertyPicker()).toHaveProperty("value", "");
    expect(chosen()).toHaveProperty("checked", false);
    expect(chosen()).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Save draft" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(writes(api.requests)).toHaveLength(0);
  });
  it("does not adopt a newly opened job into a pending standalone invoice", async () => {
    let count = 0;
    const api = setup("invoices", fresh, (request) =>
      request.method === "POST" && request.url.pathname === "/api/v1/invoices"
        ? ++count === 1
          ? Promise.reject(new TypeError("Acknowledgement lost"))
          : json({ invoice: workInvoice(), duplicate: true })
        : undefined,
    );
    await screen.findByRole("option", { name: /704 Fictional Lane/ });
    fireEvent.click(chosen());
    fireEvent.change(screen.getByLabelText("Bill to"), {
      target: { value: "Original standalone customer" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByRole("button", { name: "Retry saved request" });
    const original = writes(api.requests)[0];
    await act(async () => {
      api.location.navigate(
        `/invoices?projectId=${workProject().id}&organizationId=${org}`,
      );
    });
    await screen.findByText(/Original submitted source: existing_customer/);
    expect(screen.queryByText(`Job: ${workProject().name}`)).toBeNull();
    expect(screen.getByLabelText("Bill to")).toHaveProperty(
      "value",
      "Original standalone customer",
    );
    expect(
      api.requests.some(
        (request) =>
          request.url.pathname === `/api/v1/projects/${workProject().id}`,
      ),
    ).toBe(false);
    expect(writes(api.requests)).toHaveLength(1);
    fireEvent.click(
      screen.getByRole("button", { name: "Retry saved request" }),
    );
    await screen.findByRole("heading", { name: "Draft invoice" });
    expect(writes(api.requests)[1].body).toEqual(original.body);
    expect(writes(api.requests)[1].body).not.toHaveProperty("projectId");
  });
  it("creates a standalone native invoice with deliberate no property and no made-up opportunity", async () => {
    const api = setup("invoices", fresh, (request) =>
      request.method === "POST" && request.url.pathname === "/api/v1/invoices"
        ? json({ invoice: workInvoice(), duplicate: false })
        : undefined,
    );
    await screen.findByRole("option", { name: /704 Fictional Lane/ });
    expect(screen.getByRole("button", { name: "Save draft" })).toHaveProperty(
      "disabled",
      true,
    );
    fireEvent.click(chosen());
    fireEvent.change(screen.getByLabelText("Bill to"), {
      target: { value: "Fictional Customer" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByRole("heading", { name: "Draft invoice" });
    const [write] = writes(api.requests);
    expect(write.body.source).toEqual({
      kind: "existing_customer",
      contactId: contact,
      propertyId: null,
    });
    expect(write.body).not.toHaveProperty("leadId");
    expect(write.body).not.toHaveProperty("projectId");
    expect(
      api.requests.some((request) =>
        request.url.pathname.endsWith("/leads/null"),
      ),
    ).toBe(false);
  });
  it("uses a returning job’s immutable work root instead of a customer-wide or null-lead source", async () => {
    const api = setup(
      "invoices",
      `?projectId=${workProject().id}&organizationId=${org}`,
      (request) =>
        request.method === "POST" && request.url.pathname === "/api/v1/invoices"
          ? json({
              invoice: workInvoice({ projectId: workProject().id }),
              duplicate: false,
            })
          : undefined,
    );
    fireEvent.click(await screen.findByRole("button", { name: "New invoice" }));
    await screen.findByText(
      "Receipts and corrections remain scoped to this exact work record, not all work for this customer.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByRole("heading", { name: "Draft invoice" });
    expect(writes(api.requests)[0].body).toMatchObject({
      source: { kind: "customer_work", customerWorkId: root },
      projectId: workProject().id,
    });
    expect(writes(api.requests)[0].body).not.toHaveProperty("leadId");
  });
  it("retains a lost invoice save and ignores acknowledgement after authority changes", async () => {
    let release!: (response: Response) => void;
    const api = setup("invoices", fresh, (request) =>
      request.method === "POST" && request.url.pathname === "/api/v1/invoices"
        ? new Promise<Response>((resolve) => {
            release = resolve;
          })
        : undefined,
    );
    await screen.findByRole("option", { name: /704 Fictional Lane/ });
    fireEvent.click(chosen());
    fireEvent.change(screen.getByLabelText("Bill to"), {
      target: { value: "Fictional Customer" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(release).toBeDefined());
    api.state.me = { ...api.state.me, role: "sales_manager" as any };
    await act(async () => {
      await api.client.invalidateQueries({ queryKey: getGetMeQueryKey() });
      release(json({ invoice: workInvoice(), duplicate: false }));
    });
    expect(screen.queryByRole("heading", { name: "Draft invoice" })).toBeNull();
    expect(
      sessionStorage.getItem(
        invoiceRequestStorageKey(workMember.id, org, "new"),
      ),
    ).toContain(writes(api.requests)[0].body.requestId);
    expect(writes(api.requests)).toHaveLength(1);
  });
  it("records an explicit external refund correction tied to its original receipt and preserves the key on response loss", async () => {
    const originalId = id(730),
      invoice = workInvoice({
        status: "issued",
        issuedAt: "2026-10-01T00:00:00Z",
        invoiceNumber: "SYN-100",
        recordedPaidCents: 10000,
        balanceDueCents: 0,
        allocations: [
          {
            id: id(731),
            valueEntryId: originalId,
            refundOfValueEntryId: null,
            kind: "payment",
            sourceReference: "ORIGINAL-CHECK-123",
            amountCents: 10000,
            occurredAt: "2026-10-01T00:00:00Z",
            allocatedAt: "2026-10-01T00:00:00Z",
            reversedAt: null,
            reversalReason: null,
          },
        ],
      });
    let count = 0;
    const api = setup(
      "invoices",
      `/${invoice.id}?organizationId=${org}`,
      (request) =>
        request.url.pathname.endsWith("/refunds")
          ? ++count === 1
            ? Promise.reject(new TypeError("ack lost"))
            : json({ invoice: { ...invoice, version: 2 }, duplicate: true })
          : undefined,
    );
    api.state.invoice = invoice;
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Record external refund correction",
      }),
    );
    const form = screen.getByRole("form", {
      name: "Record external refund correction",
    });
    fireEvent.change(
      within(form).getByLabelText("Original receipt for this external refund"),
      { target: { value: originalId } },
    );
    fireEvent.change(within(form).getByLabelText("Amount (USD)"), {
      target: { value: "25.00" },
    });
    fireEvent.change(within(form).getByLabelText("Original source reference"), {
      target: { value: "REFUND-CHECK-456" },
    });
    fireEvent.change(within(form).getByLabelText(/Refund occurred at/), {
      target: { value: "2026-10-02T12:00" },
    });
    fireEvent.change(within(form).getByLabelText("Reason for this change"), {
      target: { value: "Recorded external correction with source evidence" },
    });
    fireEvent.click(within(form).getByRole("checkbox"));
    fireEvent.click(
      within(form).getByRole("button", {
        name: "Record external refund correction",
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Retry saved request" }),
    );
    await screen.findByText(
      "The saved request was already completed. Its confirmed result is shown.",
    );
    const records = writes(api.requests);
    expect(records).toHaveLength(2);
    expect(records[0].body).toMatchObject({
      expectedVersion: 1,
      confirmed: true,
      originalPaymentValueEntryId: originalId,
      amountCents: 2500,
      sourceReference: "REFUND-CHECK-456",
      reason: "Recorded external correction with source evidence",
    });
    expect(records[1].body).toEqual(records[0].body);
    expect(records[0].url.pathname.endsWith("/refunds")).toBe(true);
  });
});
