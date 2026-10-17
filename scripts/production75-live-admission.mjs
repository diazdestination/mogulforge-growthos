/** Trusted local attestations, not human signatures. No automatic approval issuer. */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { operatorPlanDigest } from "./production75-custody.mjs";
import { liveEnvironment } from "./production75-live-transport.mjs";
const sha = (v) => createHash("sha256").update(v).digest("hex");
const check = (ok) => {
  if (!ok)
    throw Object.assign(new Error("production75_live_admission"), {
      safeCode: "production75_live_admission",
    });
};
const KINDS = ["owner-approval", "independent-capability-review"];
export function attestationEntropy(plan, kind) {
  check(KINDS.includes(kind));
  return Buffer.from(
    `Forge GrowthOS admission v1:${kind}:${operatorPlanDigest(plan)}`,
  );
}
export async function authenticateAttestation({
  unprotect,
  blob,
  plan,
  kind,
  bindings,
  now = Date.now,
} = {}) {
  try {
    check(
      typeof unprotect === "function" &&
        Buffer.isBuffer(blob) &&
        blob.length >= 32 &&
        blob.length <= 65536 &&
        typeof now === "function",
    );
    const entropy = attestationEntropy(plan, kind);
    check(
      bindings &&
        ["pricingSha256", "protectedAppsSha256"].every((k) =>
          /^[a-f0-9]{64}$/.test(bindings[k] ?? ""),
        ),
    );
    let timer;
    const bytes = await Promise.race([
      unprotect(blob, entropy),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("deadline")), 10000);
      }),
    ]).finally(() => clearTimeout(timer));
    check(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 32768);
    const v = JSON.parse(bytes.toString("utf8")),
      digest = operatorPlanDigest(plan);
    check(
      v.version === 1 &&
        v.kind === kind &&
        v.planSha256 === digest &&
        Number.isSafeInteger(v.issuedAt) &&
        v.issuedAt >= plan.preparedAt &&
        v.issuedAt <= now() &&
        v.expiresAt === plan.cleanupUntil &&
        now() < v.expiresAt &&
        v.sourceSnapshotSha256 === plan.sourceSnapshotSha256 &&
        v.profileSha256 === plan.profileSha256 &&
        v.moduleManifestSha256 === plan.moduleManifestSha256 &&
        v.maxCostUsdMicros === plan.maxCostUsdMicros &&
        v.maxCopies === 1 &&
        v.sourceWritesAuthorized === false &&
        v.pricingSha256 === bindings.pricingSha256 &&
        v.protectedAppsSha256 === bindings.protectedAppsSha256,
    );
    check(
      v.provenance?.type ===
        (kind === "owner-approval"
          ? "direct-human-priced-approval"
          : "independent-capability-review") &&
        /^[a-f0-9]{64}$/.test(v.provenance.evidenceSha256 ?? "") &&
        /^[a-zA-Z0-9_.:/ -]{1,256}$/.test(v.provenance.reference ?? ""),
    );
    const common = {
      authenticated: true,
      kind,
      planSha256: digest,
      receiptSha256: sha(bytes),
    };
    return Object.freeze(
      kind === "owner-approval"
        ? {
            ...common,
            maxCopies: 1,
            maxCostUsdMicros: plan.maxCostUsdMicros,
            expiresAt: plan.cleanupUntil,
            sourceWritesAuthorized: false,
          }
        : {
            ...common,
            profileSha256: plan.profileSha256,
            sourceSnapshotSha256: plan.sourceSnapshotSha256,
            scope: "fixed-query-observation-with-inherited-capabilities",
            zeroDdlClusterWideVerified: false,
          },
    );
  } catch {
    check(false);
  }
}
/** Private stdin/stdout only; caller never logs blobs, plaintext or provider values. */
export function createNativeAttestationAuthenticator() {
  check(process.platform === "win32");
  return (blob, entropy) =>
    new Promise((resolve, reject) => {
      const code =
        "Add-Type -AssemblyName System.Security; $v=ConvertFrom-Json ([Console]::In.ReadToEnd()); $b=[Convert]::FromBase64String($v.blob); $e=[Convert]::FromBase64String($v.entropy); $p=[Security.Cryptography.ProtectedData]::Unprotect($b,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($p))";
      const c = spawn("powershell.exe", ["-NoProfile", "-Command", code], {
        env: liveEnvironment(),
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let chunks = [],
        size = 0,
        settled = false;
      const finish = (ok, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ok ? resolve(value) : reject(new Error("production75_live_admission"));
      };
      const timer = setTimeout(() => {
        c.kill();
        finish(false);
      }, 9000);
      c.stdout.on("data", (b) => {
        size += b.length;
        if (size > 65536) {
          c.kill();
          finish(false);
        } else chunks.push(b);
      });
      c.stderr.resume();
      c.on("error", () => finish(false));
      c.on("close", (exit) => {
        const text = Buffer.concat(chunks).toString("ascii");
        finish(
          exit === 0 && /^[a-zA-Z0-9+/=]+$/.test(text),
          Buffer.from(text, "base64"),
        );
      });
      c.stdin.on("error", () => {
        c.kill();
        finish(false);
      });
      c.stdin.end(
        JSON.stringify({
          blob: blob.toString("base64"),
          entropy: entropy.toString("base64"),
        }),
      );
    });
}
