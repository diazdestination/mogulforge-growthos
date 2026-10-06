import { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { InvoiceDelivery } from "./invoice-delivery";
import { renderWithQuery } from "@/test/render";
import { sampleInvoice, invoiceId } from "@/test/invoice-fixtures";
import {
  sampleAcceptedDelivery,
  sampleAttempt,
  sampleDelivery,
} from "@/test/invoice-delivery-fixtures";
import { ContractorApiError, contractorRequest } from "@/lib/contractor-api";

vi.mock("@/lib/contractor-api", async (original) => ({
  ...(await original<typeof import("@/lib/contractor-api")>()),
  contractorRequest: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const issued = sampleInvoice({
  status: "issued",
  version: 2,
  invoiceNumber: "INV-000001",
  issuedAt: "2026-10-02T12:00:00Z",
});
const preview = (id = invoiceId, recipient = "original@example.test") => ({
  previewId: "00000000-0000-4000-8000-000000000555",
  payloadSha256: "a".repeat(64),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  invoiceId: id,
  invoiceVersion: 2,
  recipient,
  sender: {
    userId: "staff-a",
    source: "lead_assignee",
    provider: "microsoft",
    senderEmail: "office@example.test",
  },
  subject: "Exact original invoice",
  body: "Original immutable invoice text",
  intent: "initial",
  expectedLatestExecutionId: null,
  reason: null,
  prospectiveAttemptNumber: 1,
  maxAttempts: 5,
});
const unknown = () =>
  sampleAcceptedDelivery({
    state: "uncertain",
    detail: "Fresh unknown original receipt",
    canPrepare: false,
    nextIntents: [],
    attentionReason: "effect_requires_review",
    attempts: [sampleAttempt({ state: "indeterminate", proof: "none" })],
  });
function deferred() {
  let resolve!: (value: unknown) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const check = () =>
  screen.getByRole("button", { name: "Check delivery status" });
const mutations = () =>
  vi
    .mocked(contractorRequest)
    .mock.calls.filter(([, options]) => options?.method === "POST");
async function startSend() {
  fireEvent.click(
    await screen.findByRole("button", { name: "Preview invoice email" }),
  );
  fireEvent.click(await screen.findByRole("checkbox"));
  fireEvent.click(
    screen.getByRole("button", { name: "Approve and send invoice" }),
  );
}
const overlaps = ["prepare", "send", "refresh"].flatMap((operation) =>
  ["version", "status"].flatMap((change) =>
    ["success", "failure"].map(
      (result) => [operation, change, result] as const,
    ),
  ),
);
it.each(overlaps)(
  "releases only the owned %s spinner after a billing %s change and late %s",
  async (operation, change, result) => {
    const old = deferred();
    let reads = 0,
      waiting = false,
      currentEvidence = sampleDelivery();
    vi.mocked(contractorRequest).mockImplementation(async (path, options) => {
      if (path.endsWith("/preview")) {
        if (operation === "prepare") {
          waiting = true;
          return old.promise;
        }
        return preview();
      }
      if (path.endsWith("/send")) {
        currentEvidence = unknown();
        if (operation === "send") {
          waiting = true;
          return old.promise;
        }
        throw new ContractorApiError(503, "invoice_unavailable");
      }
      if (options?.method === "POST") throw new Error("Unexpected mutation");
      if (++reads === 2 && operation === "refresh") {
        waiting = true;
        return old.promise;
      }
      return currentEvidence;
    });
    function Harness() {
      const [changed, setChanged] = useState(false);
      return (
        <>
          <button onClick={() => setChanged(true)}>
            Apply accepted billing change
          </button>
          <InvoiceDelivery
            invoice={
              changed
                ? {
                    ...issued,
                    ...(change === "version"
                      ? { version: 3 }
                      : { status: "void" as const }),
                  }
                : issued
            }
            organizationId="org-a"
            canManage
          />
        </>
      );
    }
    renderWithQuery(<Harness />);
    if (operation === "prepare")
      fireEvent.click(
        await screen.findByRole("button", { name: "Preview invoice email" }),
      );
    else {
      await startSend();
      if (operation === "refresh") {
        await screen.findByText(
          /Check delivery status before doing anything else/,
        );
        fireEvent.click(check());
      }
    }
    await waitFor(() => expect(waiting).toBe(true));
    expect(check()).toHaveProperty("disabled", true);
    fireEvent.click(
      screen.getByRole("button", { name: "Apply accepted billing change" }),
    );
    await waitFor(() =>
      expect(reads).toBeGreaterThanOrEqual(operation === "refresh" ? 3 : 2),
    );
    await act(async () => {
      if (result === "failure")
        old.reject(new Error("Old operation could not be confirmed"));
      else
        old.resolve(
          operation === "prepare"
            ? preview()
            : sampleAcceptedDelivery({
                detail:
                  "Stale accepted read must not replace the current unknown receipt",
              }),
        );
    });
    await waitFor(() => expect(check()).toHaveProperty("disabled", false));
    expect(
      screen.queryByText(
        "Stale accepted read must not replace the current unknown receipt",
      ),
    ).toBeNull();
    if (operation === "prepare") {
      expect(screen.queryByText("original@example.test")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(mutations().map(([path]) => path.split("/").at(-1))).toEqual([
        "preview",
      ]);
    } else {
      expect(
        screen.getByText(
          /Check delivery status to reconcile the saved request/,
        ),
      ).toBeTruthy();
      expect(screen.getByText("Fresh unknown original receipt")).toBeTruthy();
      expect(screen.getByText("execution-a")).toBeTruthy();
      expect(screen.getByText(`invoice-delivery:${invoiceId}`)).toBeTruthy();
      expect(
        screen.queryByRole("button", {
          name: /Preview invoice email|Review a safe retry|Review another copy|Discard preview and review again/,
        }),
      ).toBeNull();
      expect(mutations().map(([path]) => path.split("/").at(-1))).toEqual([
        "preview",
        "send",
      ]);
    }
    // After the old operation settles, only a deliberate read can reconcile. It
    // does not convert the retained unknown receipt into authority for another send.
    fireEvent.click(check());
    await waitFor(() => expect(check()).toHaveProperty("disabled", false));
    if (operation !== "prepare") {
      await waitFor(() =>
        expect(
          screen.queryByText(
            /Check delivery status to reconcile the saved request/,
          ),
        ).toBeNull(),
      );
      expect(screen.getByText("Fresh unknown original receipt")).toBeTruthy();
      expect(
        screen.queryByRole("button", {
          name: /Preview invoice email|Review a safe retry|Review another copy/,
        }),
      ).toBeNull();
    }
    expect(mutations()).toHaveLength(operation === "prepare" ? 1 : 2);
  },
);

it.each(
  ["authority", "target", "unmount"].flatMap((change) =>
    ["success", "failure"].map((result) => [change, result] as const),
  ),
)(
  "cannot release a newer operation after %s replacement when the old response is a %s",
  async (change, result) => {
    const old = deferred(),
      fresh = deferred();
    let preparations = 0;
    const nextId = "00000000-0000-4000-8000-000000000789";
    vi.mocked(contractorRequest).mockImplementation(async (path, options) => {
      if (path.endsWith("/preview"))
        return ++preparations === 1 ? old.promise : fresh.promise;
      if (options?.method === "POST") throw new Error("Unexpected mutation");
      return sampleDelivery({
        invoiceId: path.includes(nextId) ? nextId : invoiceId,
      });
    });
    function Harness() {
      const [replacement, setReplacement] = useState(false);
      return (
        <>
          <button onClick={() => setReplacement(true)}>
            Replace actual owner or target
          </button>
          <InvoiceDelivery
            key={
              change === "unmount" && replacement ? "replacement" : "original"
            }
            invoice={
              replacement && change === "target"
                ? { ...issued, id: nextId }
                : issued
            }
            organizationId="org-a"
            authorityScope={
              replacement && change === "authority"
                ? "current-actor"
                : "original-actor"
            }
            canManage
          />
        </>
      );
    }
    renderWithQuery(<Harness />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Preview invoice email" }),
    );
    await waitFor(() => expect(preparations).toBe(1));
    fireEvent.click(
      screen.getByRole("button", { name: "Replace actual owner or target" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Preview invoice email" }),
      ).toHaveProperty("disabled", false),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Preview invoice email" }),
    );
    await waitFor(() => expect(preparations).toBe(2));
    await act(async () => {
      if (result === "success") old.resolve(preview());
      else old.reject(new Error("Old owner's response failed"));
    });
    expect(check()).toHaveProperty("disabled", true);
    expect(screen.queryByText("original@example.test")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () =>
      fresh.resolve(
        preview(
          change === "target" ? nextId : invoiceId,
          "current-owner@example.test",
        ),
      ),
    );
    await screen.findByText("current-owner@example.test");
    expect(check()).toHaveProperty("disabled", false);
    expect(
      screen.getByRole("button", { name: "Approve and send invoice" }),
    ).toHaveProperty("disabled", true);
    expect(mutations().map(([path]) => path.split("/").at(-1))).toEqual([
      "preview",
      "preview",
    ]);
  },
);
