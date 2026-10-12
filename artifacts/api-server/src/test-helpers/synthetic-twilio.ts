import { randomInt, randomUUID } from "node:crypto";

/**
 * Test-only synthetic Twilio identities for columns that are unique across
 * ALL organizations (for example `twilio_client_binding_phone_uq` on
 * `twilio_client_bindings.phone_number` and `twilio_dispatch_sid` on
 * `twilio_dispatches.provider_sid`).
 *
 * Why it exists: vitest runs test files in parallel workers against one
 * shared Postgres database. Hard-coded values such as the Twilio magic number
 * `+15005550009` or `SM${"a".repeat(32)}` were reused by several files, so two
 * files holding a binding/dispatch at the same moment collided on the global
 * unique index and failed intermittently. Per-org cleanup cannot prevent that
 * overlap; only distinct values per file/fixture can.
 *
 * No production code special-cases any Twilio magic number, and every
 * provider call in these suites is mocked, so a random NANP-shaped value is
 * semantically equivalent for the code under test.
 */
const issuedNumbers = new Set<string>();

/**
 * A fictional `+1500XXXXXXX` E.164 number accepted by `phoneE164`.
 *
 * The 7-digit subscriber part is random across workers and de-duplicated
 * within a worker. It never falls in 555-0000..555-0099, so it can never equal
 * a literal Twilio magic number (`+15005550000`..`+15005550099`) that a test
 * still uses as a deliberately mismatched/invalid identity.
 */
export function syntheticTwilioNumber(): string {
  for (;;) {
    const subscriber = randomInt(1_000_000, 10_000_000);
    if (subscriber >= 5_550_000 && subscriber <= 5_550_099) continue;
    const number = `+1500${subscriber}`;
    if (issuedNumbers.has(number)) continue;
    issuedNumbers.add(number);
    return number;
  }
}

type SidPrefix = "AC" | "CA" | "MG" | "SM";

/** A random 34-character Twilio-shaped SID (`SM…`, `CA…`, `AC…`, `MG…`). */
export function syntheticTwilioSid(prefix: SidPrefix): string {
  return `${prefix}${randomUUID().replaceAll("-", "")}`;
}

/**
 * Ordered SIDs for one test file: a random 24-hex base unique to the caller
 * plus an 8-hex counter. Replaces `prefix + (++n).toString(16).padStart(32)`,
 * which produced the same SIDs in every file using that pattern.
 */
export function syntheticTwilioSidSequence(prefix: SidPrefix): () => string {
  const base = randomUUID().replaceAll("-", "").slice(0, 24);
  let counter = 0;
  return () => `${prefix}${base}${(++counter).toString(16).padStart(8, "0")}`;
}
