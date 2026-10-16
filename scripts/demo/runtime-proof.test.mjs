import { describe, expect, it } from "vitest";
import { fakePlan, fakeExecutionProof } from "./fake-growthos-api.mjs";
import { proofHash, validateExecutionProof } from "./execution-proof.mjs";

// Synthetic metadata for the reviewed extended-runtime contract. No collector,
// auth, helper or actual deployment/runtime proof is invoked by these tests.
const BEFORE = Date.parse("2026-10-16T21:59:59.999Z");
function extended(change = () => {}) {
  const plan = fakePlan().plan;
  plan.target = "staging";
  plan.origin = "https://mogulforge-growthos-staging.fly.dev";
  plan.release = { ...plan.release, environment: "staging" };
  plan.executionProof = fakeExecutionProof(
    plan,
    Date.parse("2026-10-16T21:58:00Z"),
  );
  Object.assign(plan.executionProof, { expiresAt: "2026-10-16T22:00:00Z" });
  Object.assign(plan.executionProof.runtime, {
    stopAt: "2026-10-18T04:00:00Z",
    taskNextUtc: "2026-10-18T04:00:00Z",
    anchorUpperAt: "2026-10-16T21:40:00Z",
    capSeconds: 109200, // 30h20m: this fixed upper bound ends exactly at 04Z.
  });
  change(plan.executionProof);
  plan.executionProofSha256 = proofHash(plan.executionProof);
  return plan;
}

describe("staging runtime availability and setup dispatch have separate bounds", () => {
  it("accepts the exact extended runtime with fresh proof immediately before setup cutoff", () => {
    expect(() => validateExecutionProof(extended(), BEFORE)).not.toThrow();
  });
  it("accepts an earlier actual runtime stop when its task and anchor cap agree", () => {
    const plan = extended((p) => {
      p.runtime.stopAt = "2026-10-18T03:59:59Z";
      p.runtime.taskNextUtc = p.runtime.stopAt;
      p.runtime.capSeconds = 109199;
    });
    expect(() => validateExecutionProof(plan, BEFORE)).not.toThrow();
  });
  it.each(["2026-10-16T22:00:00Z", "2026-10-16T22:00:00.001Z"])(
    "rejects setup dispatch at %s despite extended availability",
    (now) => {
      expect(() =>
        validateExecutionProof(extended(), Date.parse(now)),
      ).toThrow();
    },
  );
  it("rejects proof expiry one millisecond after setup cutoff while proof is still fresh", () => {
    const plan = extended((p) => {
      p.expiresAt = "2026-10-16T22:00:00.001Z";
    });
    expect(() => validateExecutionProof(plan, BEFORE)).toThrow();
  });
  it("rejects a runtime stop one millisecond after the reviewed maximum", () => {
    const plan = extended((p) => {
      p.runtime.stopAt = "2026-10-18T04:00:00.001Z";
      p.runtime.taskNextUtc = p.runtime.stopAt;
    });
    expect(() => validateExecutionProof(plan, BEFORE)).toThrow();
  });
  it("rejects an anchor cap ending one second after the actual runtime stop", () => {
    expect(() =>
      validateExecutionProof(
        extended((p) => {
          p.runtime.capSeconds = 109201;
        }),
        BEFORE,
      ),
    ).toThrow();
  });
  it("rejects a native task that still stops at 22Z when runtime proof claims 04Z", () => {
    expect(() =>
      validateExecutionProof(
        extended((p) => {
          p.runtime.taskNextUtc = "2026-10-16T22:00:00Z";
        }),
        BEFORE,
      ),
    ).toThrow();
  });
  it("rejects an extended-runtime proof older than five minutes", () => {
    const plan = extended((p) => {
      p.observedAt = "2026-10-16T21:54:59.998Z";
    });
    expect(() => validateExecutionProof(plan, BEFORE)).toThrow();
  });
});
