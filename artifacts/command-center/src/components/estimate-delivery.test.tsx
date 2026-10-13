import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { getGetMeQueryKey } from "@workspace/api-client-react";
import { EstimateDelivery } from "./estimate-delivery";
import type { Estimate } from "@workspace/api-client-react";
const id = "11111111-1111-4111-8111-111111111111";
const estimate = {
  id,
  leadId: "lead",
  status: "draft",
  updatedAt: "2026-10-13T00:00:00Z",
  lineItems: [
    {
      description: "Complete item",
      quantity: 1,
      unitPriceCents: 100,
      totalCents: 100,
    },
  ],
  subtotalCents: 100,
  taxCents: 0,
  totalCents: 100,
  title: "Saved quote",
  notes: "All original notes",
  sentAt: null,
  acceptedAt: null,
} as Estimate;
const document = {
  estimateId: id,
  businessName: "Fictional HVAC",
  customerLabel: "Fictional customer",
  propertyLabel: null,
  title: estimate.title,
  lineItems: estimate.lineItems,
  subtotalCents: 100,
  taxCents: 0,
  totalCents: 100,
  notes: estimate.notes,
};
const message = {
  recipient: "customer@example.test",
  subject: "Exact complete subject",
  body: "Complete item\nAll original notes\nFinal untruncated line",
};
const preview = {
  estimateId: id,
  previewId: "22222222-2222-4222-8222-222222222222",
  payloadSha256: "a".repeat(64),
  expiresAt: new Date(Date.now() + 600000).toISOString(),
  document,
  message,
  sender: {
    provider: "gmail",
    senderEmail: "office@example.test",
    source: "lead_assignee",
  },
};
const evidence = {
  estimateId: id,
  integrity: "valid",
  state: "not_sent",
  executionId: null,
  canPrepare: true,
  detail: "No send recorded",
  document: null,
  message: null,
  provider: null,
  providerMessageId: null,
  providerRequestId: null,
  acceptedAt: null,
  deliveryConfirmed: false,
};
function mount(
  handler?: (path: string, init?: RequestInit) => unknown,
  initialEstimate = estimate,
) {
  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    const result = await handler?.(path, init);
    return new Response(
      JSON.stringify(
        result ?? (path.endsWith("/preview") ? preview : evidence),
      ),
      { headers: { "Content-Type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", fetch);
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const ui = (record = initialEstimate, scope = "member") => (
    <QueryClientProvider client={cache}>
      <EstimateDelivery
        estimate={record}
        organizationId="company"
        authorityScope={scope}
        canSend
      />
    </QueryClientProvider>
  );
  const view = render(ui());
  return { fetch, cache, ui, ...view };
}
async function review() {
  fireEvent.click(
    await screen.findByRole("button", { name: "Review estimate email" }),
  );
  await screen.findByText(message.subject);
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("Estimate email review", () => {
  it.each([
    {
      quantity: 1,
      line: 9007199254740990,
      tax: 0,
      total: 9007199254740990,
      expectedLine: "90071992547409.90",
      expectedTax: "0.00",
      expectedTotal: "90071992547409.90",
    },
    {
      quantity: 1e-9,
      line: 9007199,
      tax: 9007199245733790,
      total: 9007199254740989,
      expectedLine: "90071.99",
      expectedTax: "90071992457337.90",
      expectedTotal: "90071992547409.89",
    },
  ])(
    "preserves exact large saved cents in approved and retained amounts: $quantity",
    async ({
      quantity,
      line,
      tax,
      total,
      expectedLine,
      expectedTax,
      expectedTotal,
    }) => {
      const record = {
        ...estimate,
        lineItems: [
          {
            description: "Exact large-cent item",
            quantity,
            unitPriceCents: 9007199254740990,
            totalCents: line,
          },
        ],
        subtotalCents: line,
        taxCents: tax,
        totalCents: total,
      };
      const exactDocument = {
        ...document,
        lineItems: record.lineItems,
        subtotalCents: line,
        taxCents: tax,
        totalCents: total,
      };
      const exactPreview = { ...preview, document: exactDocument };
      const retained = {
        ...evidence,
        state: "accepted",
        canPrepare: false,
        document: exactDocument,
        message,
      };
      const { fetch } = mount(
        (path) =>
          path.endsWith("/preview")
            ? exactPreview
            : path.endsWith("/send")
              ? retained
              : undefined,
        record,
      );
      await review();
      const reviewRegion = screen.getByLabelText("Complete email review");
      expect(
        within(reviewRegion).getByText(
          `Exact large-cent item · ${quantity} × $90071992547409.90 = $${expectedLine}`,
        ),
      ).toBeTruthy();
      expect(
        within(reviewRegion).getByText(
          `Subtotal $${expectedLine} · Tax $${expectedTax} · Total $${expectedTotal}`,
        ),
      ).toBeTruthy();
      expect(within(reviewRegion).getByText("All original notes")).toBeTruthy();
      expect(
        within(reviewRegion).getByText(
          (_, element) =>
            element?.tagName === "PRE" && element.textContent === message.body,
        ),
      ).toBeTruthy();
      fireEvent.click(within(reviewRegion).getByRole("checkbox"));
      fireEvent.click(
        within(reviewRegion).getByRole("button", {
          name: "Send reviewed email",
        }),
      );
      await screen.findByText("Provider accepted");
      const details = screen
        .getByText("Retained original email evidence")
        .closest("details")!;
      fireEvent.click(
        within(details).getByText("Retained original email evidence"),
      );
      expect(
        within(details).getByText(
          `Exact large-cent item · ${quantity} × $90071992547409.90 = $${expectedLine}`,
        ),
      ).toBeTruthy();
      expect(
        within(details).getByText(
          `Subtotal $${expectedLine} · Tax $${expectedTax} · Total $${expectedTotal}`,
        ),
      ).toBeTruthy();
      expect(within(details).getByText("All original notes")).toBeTruthy();
      expect(
        within(details).getByText(
          (_, element) =>
            element?.tagName === "PRE" && element.textContent === message.body,
        ),
      ).toBeTruthy();
      expect(
        fetch.mock.calls.filter(([path]) => path.endsWith("/send")),
      ).toHaveLength(1);
    },
  );
  it("accepted send releases the spinner for evidence refresh", async () => {
    mount((path) =>
      path.endsWith("/send")
        ? { ...evidence, state: "accepted", canPrepare: false }
        : undefined,
    );
    await review();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(
      screen.getByRole("button", { name: "Send reviewed email" }),
    );
    await screen.findByText("Provider accepted");
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Refresh delivery evidence",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
  });
  it("shows full immutable email and requires approval; double click sends exactly once", async () => {
    const { fetch } = mount();
    await review();
    expect(screen.getByText("office@example.test")).toBeTruthy();
    expect(screen.getByText(message.recipient)).toBeTruthy();
    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === "PRE" && element.textContent === message.body,
      ),
    ).toBeTruthy();
    expect(screen.getByText("All original notes")).toBeTruthy();
    const send = screen.getByRole("button", {
      name: "Send reviewed email",
    }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(send);
    fireEvent.click(send);
    await waitFor(() =>
      expect(
        fetch.mock.calls.filter(([p]) => p.endsWith("/send")),
      ).toHaveLength(1),
    );
    expect(
      JSON.parse(
        fetch.mock.calls.find(([p]) => p.endsWith("/send"))![1]!.body as string,
      ),
    ).toEqual({
      previewId: preview.previewId,
      payloadSha256: preview.payloadSha256,
      confirmed: true,
    });
  });
  it("lost acknowledgement is uncertain and refresh only reads evidence", async () => {
    const { fetch } = mount((path) => {
      if (path.endsWith("/send")) throw new Error("lost");
    });
    await review();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(
      screen.getByRole("button", { name: "Send reviewed email" }),
    );
    await screen.findByText(/result is uncertain/i);
    const posts = fetch.mock.calls.filter(
      ([, i]) => i?.method === "POST",
    ).length;
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh delivery evidence" }),
    );
    await waitFor(() =>
      expect(
        fetch.mock.calls.filter(([, i]) => i?.method === "POST"),
      ).toHaveLength(posts),
    );
    expect(
      screen.queryByRole("button", { name: "Review estimate email" }),
    ).toBeNull();
  });
  it("rejects additional approval fields in read evidence", async () => {
    mount(() => ({ ...evidence, previewId: preview.previewId }));
    await screen.findByText(/evidence unavailable/i);
    expect(
      screen.queryByRole("button", { name: "Review estimate email" }),
    ).toBeNull();
  });
  it("clears review on saved version, target and member changes", async () => {
    const { rerender, ui } = mount();
    await review();
    rerender(ui({ ...estimate, updatedAt: "2026-10-13T01:00:00Z" }));
    expect(screen.queryByRole("checkbox")).toBeNull();
    rerender(ui({ ...estimate, id: "33333333-3333-4333-8333-333333333333" }));
    expect(screen.queryByRole("checkbox")).toBeNull();
    rerender(ui(estimate, "other-member"));
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
  it("rejects a stale async preview after target changes", async () => {
    let release!: (value: unknown) => void;
    const deferred = new Promise((resolve) => (release = resolve));
    const { rerender, ui } = mount((path) =>
      path.endsWith("/preview") ? deferred : undefined,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Review estimate email" }),
    );
    rerender(ui({ ...estimate, id: "33333333-3333-4333-8333-333333333333" }));
    release(preview);
    await waitFor(() => expect(screen.queryByText(message.subject)).toBeNull());
  });
  it("uses latest cached member authority before React commits", async () => {
    const { cache } = mount();
    await review();
    fireEvent.click(screen.getByRole("checkbox"));
    cache.setQueryData(getGetMeQueryKey(), {
      id: "revoked",
      organization: { id: "company" },
      role: "rep",
      isActive: false,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Send reviewed email" }),
    );
    expect(screen.getByRole("checkbox")).toBeTruthy();
  });
  it("latest cached estimate revision blocks approval", async () => {
    const { cache, fetch } = mount();
    await review();
    fireEvent.click(screen.getByRole("checkbox"));
    cache.setQueryData(
      ["estimates"],
      [{ ...estimate, updatedAt: "2026-10-13T01:00:00Z" }],
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Send reviewed email" }),
    );
    expect(
      fetch.mock.calls.filter(([path]) => path.endsWith("/send")),
    ).toHaveLength(0);
  });
  it("latest cached retained evidence blocks stale approval", async () => {
    const { cache, fetch } = mount();
    await review();
    fireEvent.click(screen.getByRole("checkbox"));
    const key = cache
      .getQueryCache()
      .getAll()
      .find((query) => query.queryKey[0] === "estimate-delivery")!.queryKey;
    cache.setQueryData(key, {
      ...evidence,
      state: "processing",
      canPrepare: false,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Send reviewed email" }),
    );
    expect(
      fetch.mock.calls.filter(([path]) => path.endsWith("/send")),
    ).toHaveLength(0);
  });
  it("unknown submission ownership survives remount without replay", async () => {
    const { rerender, ui, fetch } = mount((path) => {
      if (path.endsWith("/send")) throw new Error("lost");
    });
    await review();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(
      screen.getByRole("button", { name: "Send reviewed email" }),
    );
    await screen.findByText(/result is uncertain/i);
    rerender(<></>);
    rerender(ui());
    await screen.findByText(
      "The original submission still needs review. No new send is available.",
    );
    expect(
      screen.queryByRole("button", { name: "Review estimate email" }),
    ).toBeNull();
    expect(
      fetch.mock.calls.filter(([path]) => path.endsWith("/send")),
    ).toHaveLength(1);
  });
  it("provider acceptance explicitly does not prove inbox or approval", async () => {
    mount(() => ({ ...evidence, state: "accepted", canPrepare: false }));
    await screen.findByText("Provider accepted");
    expect(
      screen.getByText(
        "Acceptance does not confirm inbox delivery or customer approval.",
      ),
    ).toBeTruthy();
  });
});
