import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SmsDesk } from "./sms-desk";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("SmsDesk", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders an older disabled status response without usage data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          enabled: false,
          inbound: [],
          outbound: [],
        }),
      ),
    );

    render(<SmsDesk />);

    await waitFor(() => {
      expect(
        screen.getByText(/Text delivery is disabled for this organization/i),
      ).toBeTruthy();
    });
    expect(screen.queryByText(/^Today:/i)).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Send reply" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
