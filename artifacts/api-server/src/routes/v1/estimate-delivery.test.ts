import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Request, Response } from "express";
import {
  GetEstimateDeliveryResponse,
  PreviewEstimateDeliveryBody,
  PreviewEstimateDeliveryResponse,
  SendEstimateDeliveryBody,
  SendEstimateDeliveryResponse,
} from "@workspace/api-zod";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import {
  db,
  usersTable,
  orgSettingsTable,
  emailSenderPreferencesTable,
  gmailConnectionsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import app from "../../app";
import { createSession } from "../../lib/auth";
import {
  returningCustomerFixture,
  returningEstimateDraft,
} from "../../test-helpers/returning-customer-fixture";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";
import { createCustomerWorkEstimate } from "../../services/returning-customer";
import * as delivery from "../../services/estimate-delivery";
import * as userEmail from "../../services/user-email";
import * as apiKeys from "../../services/api-keys";
import { CustomerWorkError } from "../../services/returning-customer-contract";
import {
  EstimateDeliveryError,
  estimateEmailEvidenceSchema,
  estimateEmailPreviewSchema,
} from "../../services/estimate-delivery-contract";
import router from "./estimates";

let server: Server, origin: string;
const orgs: string[] = [];
async function session(user: { id: string; email: string | null }) {
  return createSession({
    user: {
      id: user.id,
      email: user.email,
      firstName: null,
      lastName: null,
      profileImageUrl: null,
    },
    access_token: "synthetic-session",
  });
}
async function fixture() {
  const f = await returningCustomerFixture();
  orgs.push(f.org);
  await db
    .insert(orgSettingsTable)
    .values({ organizationId: f.org, customerEmailSenderUserId: f.office.id });
  await db
    .insert(emailSenderPreferencesTable)
    .values({ organizationId: f.org, userId: f.office.id, provider: "gmail" });
  await db.insert(gmailConnectionsTable).values({
    organizationId: f.org,
    userId: f.office.id,
    email: "office@example.test",
    encryptedRefreshToken: "synthetic-not-decrypted",
    grantedScopes: ["https://www.googleapis.com/auth/gmail.send"],
  });
  const { estimate } = await createCustomerWorkEstimate(
    f.org,
    f.actor,
    returningEstimateDraft(f),
  );
  return {
    ...f,
    estimate,
    sid: await session(f.owner),
    viewerSid: await session(f.viewer),
    officeSid: await session(f.office),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const review = (f: Fixture) => ({
  expectedUpdatedAt: new Date(f.estimate.updatedAt).toISOString(),
  expectedWorkVersion: f.estimate.workVersion,
});
const send = (p: { previewId: string; payloadSha256: string }) => ({
  previewId: p.previewId,
  payloadSha256: p.payloadSha256,
  confirmed: true,
});
function request(
  sid: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return fetch(`${origin}/api/v1/estimates/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      ...(body === undefined ? {} : { Origin: "https://growth.example" }),
      ...(sid ? { cookie: `sid=${sid}` } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function privateHeaders(res: globalThis.Response) {
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
}
beforeAll(async () => {
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(() => {
  vi.stubEnv("APP_ORIGIN", "https://growth.example");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "synthetic");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "synthetic");
  vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  await deleteTestOrgs(...orgs);
});

it.each(["accepted", "uncertain"] as const)(
  "reads closed evidence and allows reviewed office sends once: %s",
  async (state) => {
    const f = await fixture();
    const unauth = await request("", `${f.estimate.id}/delivery`);
    expect(unauth.status).toBe(401);
    privateHeaders(unauth);
    const read = await request(f.viewerSid, `${f.estimate.id}/delivery`);
    expect(read.status).toBe(200);
    privateHeaders(read);
    const evidence = await read.json();
    expect(estimateEmailEvidenceSchema.safeParse(evidence).success).toBe(true);
    expect(JSON.stringify(evidence)).not.toMatch(
      /previewId|payloadSha256|senderIdentity|userId|connectionId/,
    );
    expect(
      (
        await request(
          f.viewerSid,
          `${f.estimate.id}/delivery/preview`,
          review(f),
        )
      ).status,
    ).toBe(403);
    const preview = await request(
      f.officeSid,
      `${f.estimate.id}/delivery/preview`,
      review(f),
    );
    expect(preview.status).toBe(200);
    privateHeaders(preview);
    const p = estimateEmailPreviewSchema.parse(await preview.json());
    expect(estimateEmailPreviewSchema.safeParse(p).success).toBe(true);
    const transport = vi
      .spyOn(userEmail, "sendEmailForUser")
      .mockImplementation(async (args) => {
        await args.beforeDispatch?.();
        await args.beforeFinalDispatch?.({
          provider: "gmail",
          senderEmail: "office@example.test",
        });
        if (state === "uncertain")
          throw Error(
            "synthetic lost acknowledgment with private provider text",
          );
        return {
          id: "synthetic-receipt",
          provider: "gmail",
          senderEmail: "office@example.test",
          acceptance: "accepted",
        };
      });
    const first = await request(
      f.officeSid,
      `${f.estimate.id}/delivery/send`,
      send(p),
    );
    expect(first.status).toBe(200);
    privateHeaders(first);
    expect(await first.json()).toMatchObject({
      state,
      canPrepare: false,
      deliveryConfirmed: false,
    });
    expect(
      (await request(f.officeSid, `${f.estimate.id}/delivery/send`, send(p)))
        .status,
    ).toBe(409);
    expect(
      (
        await request(
          f.officeSid,
          `${f.estimate.id}/delivery/preview`,
          review(f),
        )
      ).status,
    ).toBe(409);
    expect(transport).toHaveBeenCalledTimes(1);
  },
);
it("rejects API-key header presence, absent/foreign/unconfigured origins and non-JSON", async () => {
  const f = await fixture(),
    service = vi.spyOn(delivery, "previewEstimateEmail"),
    resolver = vi.spyOn(apiKeys, "resolveApiKey");
  for (const action of ["preview", "send"])
    for (const headers of [
      { "x-api-key": "" },
      { "x-api-key": "synthetic" },
      { Origin: "" },
      { Origin: "https://foreign.example" },
      { "Sec-Fetch-Site": "cross-site" },
      { "Sec-Fetch-Site": "same-site" },
    ] as Record<string, string>[]) {
      const res = await request(
        f.sid,
        `${f.estimate.id}/delivery/${action}`,
        review(f),
        headers,
      );
      expect(res.status).toBe(403);
      privateHeaders(res);
    }
  expect(
    (
      await request(f.sid, `${f.estimate.id}/delivery/preview`, review(f), {
        "Content-Type": "text/plain",
      })
    ).status,
  ).toBe(415);
  for (const config of [
    "",
    "https://growth.example/path",
    "https://growth.example/",
  ]) {
    vi.stubEnv("APP_ORIGIN", config);
    expect(
      (await request(f.sid, `${f.estimate.id}/delivery/preview`, review(f)))
        .status,
    ).toBe(403);
  }
  expect(service).not.toHaveBeenCalled();
  expect(resolver).not.toHaveBeenCalled();
});
it("enforces accepted verified active identities and actual/effective office roles", async () => {
  const f = await fixture();
  for (const change of [
    { isActive: false },
    { emailVerifiedAt: null },
    { role: "sales_manager" as const },
  ]) {
    await db
      .update(usersTable)
      .set(change)
      .where(eq(usersTable.id, f.owner.id));
    expect(
      (await request(f.sid, `${f.estimate.id}/delivery/preview`, review(f)))
        .status,
    ).toBe(403);
    await db
      .update(usersTable)
      .set({ isActive: true, emailVerifiedAt: new Date(), role: "owner" })
      .where(eq(usersTable.id, f.owner.id));
  }
  const [invited] = await db
    .insert(usersTable)
    .values({
      id: `invite:${randomUUID()}`,
      organizationId: f.org,
      role: "office",
      isActive: true,
      emailVerifiedAt: new Date(),
    })
    .returning();
  expect(
    (
      await request(
        await session(invited),
        `${f.estimate.id}/delivery/preview`,
        review(f),
      )
    ).status,
  ).toBe(403);
  // Exercise the downstream guard with an effective role cap and mismatched session,
  // which ordinary session middleware cannot produce by itself.
  const stack = router.stack.find(
    (layer) => layer.route?.path === "/estimates/:id/delivery/preview",
  )!.route!.stack;
  const guard = stack[stack.length - 2]!.handle;
  for (const overrides of [
    { role: "sales_manager" },
    { user: { ...f.owner, role: "sales_manager" } },
    { user: { ...f.owner, id: "invite:synthetic" } },
    { user: { ...f.owner, id: randomUUID() } },
  ]) {
    const json = vi.fn(),
      status = vi.fn().mockReturnValue({ json }),
      next = vi.fn();
    guard(
      {
        user: { id: f.owner.id },
        member: {
          user: f.owner,
          organizationId: f.org,
          role: "owner",
          ...overrides,
        },
      } as unknown as Request,
      { status } as unknown as Response,
      next,
    );
    expect(status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  }
});
it("rejects foreign targets and previews, query/body overrides and malformed requests", async () => {
  const f = await fixture(),
    other = await fixture();
  expect((await request(other.sid, `${f.estimate.id}/delivery`)).status).toBe(
    404,
  );
  const p = estimateEmailPreviewSchema.parse(
    await (
      await request(f.sid, `${f.estimate.id}/delivery/preview`, review(f))
    ).json(),
  );
  for (const [sid, target] of [
    [other.sid, other.estimate.id],
    [f.officeSid, f.estimate.id],
    [f.sid, other.estimate.id],
  ])
    expect(
      (await request(sid, `${target}/delivery/send`, send(p))).status,
    ).toBe(409);
  for (const suffix of ["delivery", "delivery/preview", "delivery/send"]) {
    const res = await request(
      f.sid,
      `${f.estimate.id}/${suffix}?organizationId=${other.org}`,
      suffix === "delivery" ? undefined : {},
    );
    expect(res.status).toBe(400);
    privateHeaders(res);
  }
  expect((await request(f.sid, "bad-id/delivery")).status).toBe(400);
  for (const body of [
    {},
    { ...review(f), recipient: "arbitrary@example.test" },
    { ...review(f), expectedWorkVersion: 0 },
  ])
    expect(
      (await request(f.sid, `${f.estimate.id}/delivery/preview`, body)).status,
    ).toBe(400);
  for (const body of [
    {},
    { ...send(p), confirmed: false },
    { ...send(p), recipient: "arbitrary@example.test" },
    { ...send(p), actionKey: "override" },
    { ...send(p), document: {} },
    { ...send(p), sender: {} },
  ])
    expect(
      (await request(f.sid, `${f.estimate.id}/delivery/send`, body)).status,
    ).toBe(400);
});
it("returns safe typed errors and hides unexpected exception text", async () => {
  const f = await fixture();
  for (const error of [
    new CustomerWorkError(409, "customer_work_changed", "Saved work changed."),
    new EstimateDeliveryError(
      409,
      "estimate_review_changed",
      "Review changed.",
    ),
    Error("private-provider-text"),
  ]) {
    vi.spyOn(delivery, "previewEstimateEmail").mockRejectedValueOnce(error);
    const res = await request(
      f.sid,
      `${f.estimate.id}/delivery/preview`,
      review(f),
    );
    privateHeaders(res);
    expect(res.status).toBe(
      error instanceof EstimateDeliveryError ||
        error instanceof CustomerWorkError
        ? 409
        : 503,
    );
    expect(JSON.stringify(await res.json())).not.toContain(
      "private-provider-text",
    );
  }
});

it("closes generated request/response objects and roundtrips generated dates over JSON", async () => {
  const f = await fixture();
  const generated = PreviewEstimateDeliveryBody.parse(review(f));
  expect(generated.expectedUpdatedAt).toBeInstanceOf(Date);
  expect(JSON.parse(JSON.stringify(generated))).toEqual(review(f));
  expect(
    PreviewEstimateDeliveryBody.safeParse({
      ...review(f),
      recipient: "override@example.test",
    }).success,
  ).toBe(false);
  const p = estimateEmailPreviewSchema.parse(
    await (
      await request(f.sid, `${f.estimate.id}/delivery/preview`, generated)
    ).json(),
  );
  expect(PreviewEstimateDeliveryResponse.safeParse(p).success).toBe(true);
  expect(
    PreviewEstimateDeliveryResponse.safeParse({
      ...p,
      sender: { ...p.sender, userId: randomUUID() },
    }).success,
  ).toBe(false);
  expect(SendEstimateDeliveryBody.safeParse(send(p)).success).toBe(true);
  expect(
    SendEstimateDeliveryBody.safeParse({ ...send(p), actionKey: "override" })
      .success,
  ).toBe(false);
  const e = estimateEmailEvidenceSchema.parse(
    await (await request(f.viewerSid, `${f.estimate.id}/delivery`)).json(),
  );
  for (const schema of [
    GetEstimateDeliveryResponse,
    SendEstimateDeliveryResponse,
  ]) {
    expect(schema.safeParse(e).success).toBe(true);
    expect(schema.safeParse({ ...e, previewId: randomUUID() }).success).toBe(
      false,
    );
  }
});

it.each(["/api/v1/estimates", "/API/V1/EsTiMaTeS"])(
  "keeps malformed and oversized JSON errors private before route admission: %s",
  async (prefix) => {
    const f = await fixture();
    for (const [body, status] of [
      ["{synthetic:", 400],
      [JSON.stringify({ synthetic: "x".repeat(110000) }), 413],
    ] as const) {
      const res = await fetch(
        `${origin}${prefix}/${f.estimate.id}/DeLiVeRy/PrEvIeW`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://growth.example",
            cookie: `sid=${f.sid}`,
          },
          body,
        },
      );
      expect(res.status).toBe(status);
      privateHeaders(res);
      expect(await res.json()).toEqual({
        error: "Invalid estimate delivery request.",
        code: "estimate_invalid_request",
      });
    }
  },
);
