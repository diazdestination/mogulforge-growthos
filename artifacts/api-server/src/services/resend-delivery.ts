/** One budget for connection, response headers and the complete receipt body. */
export const RESEND_SEND_TIMEOUT_MS = 10_000;
const MAX_RECEIPT_BYTES = 16_384;
const MESSAGE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// These HTTP responses explicitly reject the request. A timeout, conflict,
// server error or unfamiliar response cannot establish whether a send occurred.
const REJECTION_STATUSES = new Set([
  400, 401, 403, 404, 405, 413, 415, 422, 429,
]);

export class ResendSendError extends Error {
  readonly provider = "resend";
  readonly retryable = false;
  readonly code: "resend_send_rejected" | "resend_send_outcome_unknown";
  readonly httpStatus: number | undefined;

  constructor(
    readonly outcome: "rejected" | "unknown",
    httpStatus?: number,
  ) {
    super(
      outcome === "rejected"
        ? "Transactional email was rejected by Resend. Check the sending configuration or provider limits before sending again."
        : "Transactional email outcome is unknown. Check Resend delivery records before sending again.",
    );
    this.name =
      outcome === "rejected"
        ? "ResendSendRejectedError"
        : "ResendSendOutcomeUnknownError";
    this.code =
      outcome === "rejected"
        ? "resend_send_rejected"
        : "resend_send_outcome_unknown";
    this.httpStatus =
      typeof httpStatus === "number" &&
      Number.isInteger(httpStatus) &&
      httpStatus >= 100 &&
      httpStatus <= 599
        ? httpStatus
        : undefined;
    // Never attach a raw provider/transport error as a cause: it may contain
    // addresses, the message, action tokens or authorization headers.
  }
}

/**
 * Called only after the provider's outbound, exact-recipient and config gates.
 * Returns an accepted message receipt, not proof of inbox delivery. There is
 * deliberately no retry/fallback: callers supply no stable logical event key,
 * and replaying a request with an uncertain effect could duplicate an email.
 */
export async function sendResendEmail(input: {
  apiKey: string;
  from: string;
  to: string;
  subject: string;
  text: string;
}): Promise<{ id: string; provider: string }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("resend_deadline"));
    }, RESEND_SEND_TIMEOUT_MS);
  });
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let outcome: "rejected" | "unknown" = "unknown";

  try {
    response = await Promise.race([
      fetch("https://api.resend.com/emails", {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${input.apiKey}`,
        },
        body: JSON.stringify({
          from: input.from,
          to: [input.to],
          subject: input.subject,
          text: input.text,
        }),
        signal: controller.signal,
      }),
      deadline,
    ]);
    if (!response.ok) {
      if (REJECTION_STATUSES.has(response.status)) outcome = "rejected";
      // Do not read error content, including a slow or never-ending body.
      throw new Error("resend_http_error");
    }
    reader = response.body?.getReader();
    if (!reader) throw new Error("resend_missing_receipt");
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = "";
    while (true) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RECEIPT_BYTES)
        throw new Error("resend_receipt_too_large");
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    const data: unknown = JSON.parse(text);
    if (
      !data ||
      typeof data !== "object" ||
      Array.isArray(data) ||
      !("id" in data) ||
      typeof data.id !== "string" ||
      !MESSAGE_ID.test(data.id)
    ) {
      throw new Error("resend_invalid_receipt");
    }
    return { id: data.id, provider: "resend" };
  } catch {
    // Only fixed local messages and a numeric HTTP status cross this boundary.
    throw new ResendSendError(outcome, response?.status);
  } finally {
    clearTimeout(timer);
    controller.abort();
    // Cleanup must not extend the deadline or surface provider body errors.
    if (reader) {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    } else if (response?.body) {
      void response.body.cancel().catch(() => {});
    }
  }
}
