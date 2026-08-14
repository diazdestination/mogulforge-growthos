import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  extractOriginalSender,
  htmlToPlainText,
  intakeAliasFor,
  signedHeaders,
} from "./index";

describe("Cloudflare email intake worker", () => {
  it("accepts only generated aliases on the configured intake domain", () => {
    const alias = `mf-${"a".repeat(30)}`;
    expect(intakeAliasFor(`${alias}@intake.mogulforge.ai`, "intake.mogulforge.ai")).toBe(alias);
    expect(intakeAliasFor("sales@intake.mogulforge.ai", "intake.mogulforge.ai")).toBeNull();
    expect(intakeAliasFor(`${alias}@mogulforge.ai`, "intake.mogulforge.ai")).toBeNull();
  });

  it("extracts the original sender from a manual forwarded-message block", () => {
    const text = `Please review.\n\n---------- Forwarded message ---------\nFrom: Jane Customer <jane@example.test>\nSubject: Estimate\n\nPlease send a quote.`;
    expect(extractOriginalSender(text)).toBe("jane@example.test");
    expect(extractOriginalSender("ordinary message")).toBeNull();
  });

  it("drops executable HTML and emits a verifiable HMAC envelope", async () => {
    expect(htmlToPlainText("<style>.x{}</style><script>alert(1)</script><p>Hello &amp; welcome</p>"))
      .toBe("Hello & welcome");
    const body = JSON.stringify({ safe: true });
    const timestamp = 1_785_000_000;
    const secret = "a-long-test-secret-that-is-not-production";
    const headers = await signedHeaders(body, secret, timestamp);
    const expected = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
    expect(headers["x-mogulforge-signature"]).toBe(`t=${timestamp},v1=${expected}`);
  });
});
