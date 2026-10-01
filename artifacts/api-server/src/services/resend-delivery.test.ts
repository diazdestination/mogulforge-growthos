import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

import {
  customerEmailProvider,
  mockEmailProvider,
  resendEmailProvider,
  transactionalEmailProvider,
} from "./providers";
import { RESEND_SEND_TIMEOUT_MS, ResendSendError } from "./resend-delivery";

const receipt = "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794";
const privateDetails =
  "recipient@example.test re_test-secret token=private-action-token private message body";
const send = () =>
  resendEmailProvider.send("recipient@example.test", "Subject", privateDetails);
let fetchMock: MockInstance<typeof fetch>;

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("RESEND_API_KEY", "re_test-secret");
  vi.stubEnv("RESEND_FROM_EMAIL", "Platform <account@example.test>");
  vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false");
  vi.stubEnv("FLY_APP_NAME", "mogulforge-growthos");
  vi.stubEnv("APP_ORIGIN", "https://growth.example.test");
  fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Unexpected test request"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function expectSafeFailure(
  error: unknown,
  outcome: "rejected" | "unknown",
  httpStatus?: number,
) {
  expect(error).toBeInstanceOf(ResendSendError);
  expect(error).toMatchObject({
    outcome,
    httpStatus,
    provider: "resend",
    retryable: false,
  });
  expect(error).not.toHaveProperty("cause");
  const exposed = `${String(error)} ${JSON.stringify(error)} ${(error as Error).stack}`;
  for (const secret of [
    "recipient@example.test",
    "re_test-secret",
    "private-action-token",
    "private message body",
  ])
    expect(exposed).not.toContain(secret);
  expect(fetchMock).toHaveBeenCalledOnce();
}

describe("bounded Resend transactional delivery", () => {
  it("returns only a validated receipt after one request to the fixed provider", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: receipt, ignored: privateDetails })),
    );
    await expect(send()).resolves.toEqual({ id: receipt, provider: "resend" });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "https://api.resend.com/emails",
      {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer re_test-secret",
        },
        body: JSON.stringify({
          from: "Platform <account@example.test>",
          to: ["recipient@example.test"],
          subject: "Subject",
          text: privateDetails,
        }),
        signal: expect.any(AbortSignal),
      },
    );
  });

  it.each([400, 401, 403, 404, 405, 413, 415, 422, 429])(
    "reports HTTP %i as a safe rejection without reading provider error text",
    async (status) => {
      const response = new Response(privateDetails, { status });
      const readText = vi.spyOn(response, "text");
      const readJson = vi.spyOn(response, "json");
      const readBody = vi.spyOn(response.body!, "getReader");
      fetchMock.mockResolvedValue(response);
      const error = await send().catch((value: unknown) => value);
      expectSafeFailure(error, "rejected", status);
      expect(error).toMatchObject({ code: "resend_send_rejected" });
      expect(readText).not.toHaveBeenCalled();
      expect(readJson).not.toHaveBeenCalled();
      expect(readBody).not.toHaveBeenCalled();
    },
  );

  it.each([307, 408, 409, 500, 502, 503])(
    "keeps HTTP %i indeterminate and does not replay the request",
    async (status) => {
      fetchMock.mockResolvedValue(new Response(privateDetails, { status }));
      const error = await send().catch((value: unknown) => value);
      expectSafeFailure(error, "unknown", status);
      expect(error).toMatchObject({ code: "resend_send_outcome_unknown" });
      expect((error as Error).message).toMatch(
        /Check Resend delivery records before sending again/,
      );
    },
  );

  it.each([
    ["absent", {}],
    ["number", { id: 42 }],
    ["boolean", { id: true }],
    ["object", { id: { message: privateDetails } }],
    ["array", { id: [receipt] }],
    ["empty", { id: "" }],
    ["non-UUID", { id: privateDetails }],
    ["whitespace", { id: `${receipt}\n` }],
    ["null response", null],
    ["array response", [{ id: receipt }]],
  ])(
    "does not treat an invalid %s message receipt as acceptance",
    async (_, data) => {
      fetchMock.mockResolvedValue(new Response(JSON.stringify(data)));
      const error = await send().catch((value: unknown) => value);
      expectSafeFailure(error, "unknown", 200);
    },
  );

  it("redacts malformed JSON parser errors and preserves an unknown outcome", async () => {
    fetchMock.mockResolvedValue(new Response(privateDetails));
    expectSafeFailure(
      await send().catch((value: unknown) => value),
      "unknown",
      200,
    );
  });

  it("redacts a broken response stream without claiming the email was rejected", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(
              new Error(privateDetails, { cause: { body: privateDetails } }),
            );
          },
        }),
      ),
    );
    expectSafeFailure(
      await send().catch((value: unknown) => value),
      "unknown",
      200,
    );
  });

  it("rejects oversized receipt content and cancels the remaining stream", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              JSON.stringify({ id: receipt, padding: "é".repeat(8_192) }),
            ),
          );
          // No close: the byte limit must stop the read without waiting for EOF.
        },
        cancel,
      }),
    );
    fetchMock.mockResolvedValue(response);
    expectSafeFailure(
      await send().catch((value: unknown) => value),
      "unknown",
      200,
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it("sanitizes transport errors, including their names and nested causes", async () => {
    const rawError = new Error(privateDetails, {
      cause: { authorization: privateDetails },
    });
    rawError.name = privateDetails;
    fetchMock.mockRejectedValue(rawError);
    expectSafeFailure(await send().catch((value: unknown) => value), "unknown");
  });

  it("sanitizes non-Error transport rejections", async () => {
    fetchMock.mockRejectedValue({ message: privateDetails, statusCode: 401 });
    expectSafeFailure(await send().catch((value: unknown) => value), "unknown");
  });

  it("aborts an unresolved request at the finite deadline without retry or fallback", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    const mockSend = vi.spyOn(mockEmailProvider, "send");
    const customerSend = vi.spyOn(customerEmailProvider, "send");
    let completed = false;
    const pending = transactionalEmailProvider
      .send("recipient@example.test", "Subject", privateDetails)
      .catch((value: unknown) => {
        completed = true;
        return value;
      });
    await vi.advanceTimersByTimeAsync(RESEND_SEND_TIMEOUT_MS - 1);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expectSafeFailure(await pending, "unknown");
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(mockSend).not.toHaveBeenCalled();
    expect(customerSend).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the same deadline for delayed headers and a stalled partial response body", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          setTimeout(
            () =>
              resolve(
                new Response(
                  new ReadableStream({
                    start(controller) {
                      controller.enqueue(new TextEncoder().encode('{"id":"'));
                    },
                    cancel,
                  }),
                ),
              ),
            6_000,
          );
        }),
    );
    let completed = false;
    const pending = send().catch((value: unknown) => {
      completed = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(completed).toBe(false);
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(RESEND_SEND_TIMEOUT_MS - 6_000);
    expectSafeFailure(await pending, "unknown", 200);
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("finishes a rejection without waiting for an error body that never closes", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    fetchMock.mockResolvedValue(
      new Response(new ReadableStream({ cancel }), { status: 429 }),
    );
    expectSafeFailure(
      await send().catch((value: unknown) => value),
      "rejected",
      429,
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("Resend pre-dispatch gates", () => {
  it.each([resendEmailProvider, transactionalEmailProvider])(
    "enforces an active hold before any request",
    async (provider) => {
      vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "true");
      await expect(
        provider.send("recipient@example.test", "Subject", "Body"),
      ).rejects.toThrow("staging safety hold");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([resendEmailProvider, transactionalEmailProvider])(
    "enforces the exact staging recipient before any request",
    async (provider) => {
      vi.stubEnv("FLY_APP_NAME", "mogulforge-growthos-staging");
      vi.stubEnv("STAGING_OUTBOUND_APPROVED", "true");
      vi.stubEnv("STAGING_EMAIL_RECIPIENT_ALLOWLIST", "approved@example.test");
      await expect(
        provider.send("recipient@example.test", "Subject", "Body"),
      ).rejects.toThrow("not approved");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("rejects header injection before dispatch", async () => {
    await expect(
      resendEmailProvider.send(
        "recipient@example.test\r\nBcc: other@example.test",
        "Subject",
        "Body",
      ),
    ).rejects.toThrow("invalid recipient");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["RESEND_API_KEY", "RESEND_FROM_EMAIL"])(
    "rejects blank %s before dispatch",
    async (key) => {
      vi.stubEnv(key, "  ");
      await expect(send()).rejects.toThrow(
        "Transactional email is not configured",
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});
