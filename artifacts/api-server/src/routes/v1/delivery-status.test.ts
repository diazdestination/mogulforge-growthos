import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("../../services/delivery-events", () => ({
  handleBounce: vi.fn().mockResolvedValue(undefined),
  recordTouchDelivery: vi.fn().mockResolvedValue(null),
}));

import {
  handleBounce,
  recordTouchDelivery,
} from "../../services/delivery-events";
import router from "./delivery-status";

const secretBytes = Buffer.from("synthetic-webhook-signing-key-only");
const secret = `whsec_${secretBytes.toString("base64")}`;
let server: Server;
let baseUrl: string;

const event = (
  type = "email.bounced",
  bounceType: string | undefined = "Permanent",
) => ({
  type,
  data: {
    email_id: "re_synthetic_test_message",
    to: ["qa@example.test"],
    bounce: bounceType ? { type: bounceType } : {},
  },
});

function headers(
  body: string,
  timestamp = Math.floor(Date.now() / 1000).toString(),
) {
  const id = "msg_synthetic_test_event";
  const signature = createHmac("sha256", secretBytes)
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");
  return {
    "content-type": "application/json",
    "svix-id": id,
    "svix-timestamp": timestamp,
    "svix-signature": `v1,${signature}`,
  };
}

async function send(body: string, overrides: Record<string, string> = {}) {
  return fetch(`${baseUrl}/public/webhooks/resend`, {
    method: "POST",
    body,
    headers: { ...headers(body), ...overrides },
  });
}

beforeAll(() => {
  const app = express();
  app.use(
    express.json({
      verify: (req, _res, body) => {
        (req as Request & { rawBody?: Buffer }).rawBody = body;
      },
    }),
  );
  app.use((req, _res, next) => {
    if (req.headers["x-test-no-raw-body"])
      delete (req as Request & { rawBody?: Buffer }).rawBody;
    next();
  });
  app.use(router);
  app.use(
    (_error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      res.status(503).json({ error: "persistence failed" });
    },
  );
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => {
  vi.stubEnv("RESEND_WEBHOOK_SECRET", secret);
  vi.mocked(handleBounce).mockResolvedValue(undefined);
  vi.mocked(recordTouchDelivery).mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

afterAll(async () => {
  if (server)
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
});

describe("authenticated Resend delivery callbacks", () => {
  it.each(["production", "development", "test"])(
    "rejects a missing signing secret in %s",
    async (environment) => {
      vi.stubEnv("NODE_ENV", environment);
      vi.stubEnv("RESEND_WEBHOOK_SECRET", "");
      expect((await send(JSON.stringify(event()))).status).toBe(403);
      expect(handleBounce).not.toHaveBeenCalled();
      expect(recordTouchDelivery).not.toHaveBeenCalled();
    },
  );

  it("also rejects missing secrets for a staging app with a mistaken dev NODE_ENV", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("FLY_APP_NAME", "mogulforge-growthos-staging");
    vi.stubEnv("RESEND_WEBHOOK_SECRET", "");
    expect((await send(JSON.stringify(event()))).status).toBe(403);
    expect(handleBounce).not.toHaveBeenCalled();
  });

  it.each([
    "not-a-key",
    "whsec_",
    "whsec_%%%%",
    "whsec_YQ==",
    `whsec_${secretBytes.toString("base64")}garbage`,
  ])("rejects malformed signing configuration", async (configured) => {
    vi.stubEnv("RESEND_WEBHOOK_SECRET", configured);
    expect((await send(JSON.stringify(event()))).status).toBe(403);
    expect(handleBounce).not.toHaveBeenCalled();
  });

  it("requires raw bytes and accepts a valid signature over formatted JSON", async () => {
    const body = JSON.stringify(event(), null, 2);
    expect((await send(body, { "x-test-no-raw-body": "true" })).status).toBe(
      403,
    );
    expect(handleBounce).not.toHaveBeenCalled();
    expect((await send(body)).status).toBe(200);
    expect(handleBounce).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "resend",
        channel: "email",
        address: "qa@example.test",
        providerMessageId: "re_synthetic_test_message",
        reason: "hard_bounce",
      }),
    );
  });

  it("rejects tampering, forged signatures and missing headers before persistence", async () => {
    const body = JSON.stringify(event());
    const signed = headers(body);
    expect(
      (
        await send(
          body.replace("qa@example.test", "victim@example.test"),
          signed,
        )
      ).status,
    ).toBe(403);
    for (const override of [
      { "svix-id": "" },
      { "svix-signature": "" },
      { "svix-signature": `v1,${Buffer.alloc(32, 1).toString("base64")}` },
    ] as Record<string, string>[])
      expect((await send(body, override)).status).toBe(403);
    expect(handleBounce).not.toHaveBeenCalled();
  });

  it.each(["v2", "", "v01"])(
    "rejects unsupported signature version %s",
    async (version) => {
      const body = JSON.stringify(event());
      const signature = headers(body)["svix-signature"].replace(
        "v1,",
        `${version},`,
      );
      expect((await send(body, { "svix-signature": signature })).status).toBe(
        403,
      );
    },
  );

  it("supports signature rotation but rejects malformed base64 and extra delimiters", async () => {
    const body = JSON.stringify(event());
    // Reuse the signed timestamp; a fresh one from send() can cross a second.
    const signed = headers(body);
    const signature = signed["svix-signature"];
    for (const invalid of [
      `${signature},extra`,
      `${signature}=`,
      "v1,not_base64",
      "v1,A===",
      "v1,!!!",
    ])
      expect(
        (await send(body, { ...signed, "svix-signature": invalid })).status,
      ).toBe(403);
    expect(
      (
        await send(body, {
          ...signed,
          "svix-signature": `v2,ignored ${signature}`,
        })
      ).status,
    ).toBe(200);
  });

  it.each(["stale", "future", "fraction", "exponent"])(
    "rejects a correctly signed %s timestamp",
    async (kind) => {
      // Keep the 301-second boundary fixed across asynchronous HTTP handling.
      // Under load a future timestamp could enter the valid window before the
      // handler checked it, without any replay-protection defect.
      const fixedNow = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(fixedNow);
      try {
        const body = JSON.stringify(event());
        const now = Math.floor(fixedNow / 1000);
        const timestamp =
          kind === "stale"
            ? String(now - 301)
            : kind === "future"
              ? String(now + 301)
              : kind === "fraction"
                ? `${now}.0`
                : `${now / 10}e1`;
        expect((await send(body, headers(body, timestamp))).status).toBe(403);
        expect(handleBounce).not.toHaveBeenCalled();
      } finally {
        clock.mockRestore();
      }
    },
  );

  it.each([
    { to: [] },
    { to: ["qa@example.test", "victim@example.test"] },
    { to: ["QA <qa@example.test>"] },
    { to: ["qa@example.test\r\nBcc: victim@example.test"] },
  ])("rejects ambiguous recipient data", async ({ to }) => {
    const payload = event();
    payload.data.to = to;
    expect((await send(JSON.stringify(payload))).status).toBe(400);
    expect(handleBounce).not.toHaveBeenCalled();
  });

  it.each(["Transient", "Undetermined", "unknown", undefined])(
    "does not permanently suppress a non-permanent bounce (%s)",
    async (bounceType) => {
      const payload = event();
      payload.data.bounce = bounceType ? { type: bounceType } : {};
      expect((await send(JSON.stringify(payload))).status).toBe(200);
      expect(handleBounce).not.toHaveBeenCalled();
      expect(recordTouchDelivery).toHaveBeenCalledWith(
        expect.objectContaining({
          signal: bounceType === "Transient" ? "delayed" : "failed",
        }),
      );
    },
  );

  it.each(["email.delivery_delayed", "email.failed"])(
    "records %s without permanent suppression",
    async (type) => {
      expect((await send(JSON.stringify(event(type)))).status).toBe(200);
      expect(handleBounce).not.toHaveBeenCalled();
      expect(recordTouchDelivery).toHaveBeenCalledWith(
        expect.objectContaining({
          signal: type === "email.delivery_delayed" ? "delayed" : "failed",
        }),
      );
    },
  );

  it("records a complaint as an unsubscribe in one persistence operation", async () => {
    expect((await send(JSON.stringify(event("email.complained")))).status).toBe(
      200,
    );
    expect(handleBounce).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "unsubscribed" }),
    );
    expect(recordTouchDelivery).not.toHaveBeenCalled();
  });

  it("acknowledges signed unrelated event types without delivery mutations", async () => {
    expect((await send(JSON.stringify({ type: "email.opened" }))).status).toBe(
      200,
    );
    expect(handleBounce).not.toHaveBeenCalled();
    expect(recordTouchDelivery).not.toHaveBeenCalled();
  });

  it("returns a failure to the provider until suppression persistence succeeds", async () => {
    vi.mocked(handleBounce).mockRejectedValueOnce(
      new Error("synthetic database outage"),
    );
    const body = JSON.stringify(event());
    expect((await send(body)).status).toBe(503);
    expect((await send(body)).status).toBe(200);
    expect(handleBounce).toHaveBeenCalledTimes(2);
  });
});
