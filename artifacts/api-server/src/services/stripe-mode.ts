import type { StripeConnectMode } from "@workspace/db";

/**
 * BILL collection runs in exactly one Stripe mode per deployment.
 *
 * - STRIPE_CONNECT_MODE=test|live (default test).
 * - The key must match the mode: sk_test_/rk_test_ for test, sk_live_/rk_live_ for live.
 * - A webhook signing secret for the same mode's endpoint is required.
 * - Live in production also needs STRIPE_CONNECT_LIVE_CONFIRMED=true.
 *
 * Anything else is "not configured" with a plain reason (never the key itself).
 */
export type ConnectConfig =
  | { enabled: false; mode: StripeConnectMode; issue: null }
  | { enabled: true; mode: StripeConnectMode; ok: true; secretKey: string | null; webhookSecret: string; issue: null }
  | { enabled: true; mode: StripeConnectMode; ok: false; issue: string };

type Env = Record<string, string | undefined>;

function keyMode(secret: string): StripeConnectMode | null {
  const match = /^(?:sk|rk)_(test|live)_/.exec(secret);
  return match ? (match[1] as StripeConnectMode) : null;
}

/** Configured mode, even when collection is off or misconfigured (invalid values read as test). */
export function configuredStripeMode(env: Env = process.env): StripeConnectMode {
  return (env.STRIPE_CONNECT_MODE ?? "").trim().toLowerCase() === "live" ? "live" : "test";
}

/**
 * Resolve the Connect configuration. `injectedClient` is the test seam: with a
 * fake client a missing key is allowed, but a key that is set must still match.
 */
export function resolveConnectConfig(env: Env = process.env, injectedClient = false): ConnectConfig {
  const rawMode = (env.STRIPE_CONNECT_MODE ?? "").trim().toLowerCase();
  const mode = configuredStripeMode(env);
  if (!injectedClient && env.STRIPE_CONNECT_ENABLED !== "true") return { enabled: false, mode, issue: null };
  const fail = (issue: string): ConnectConfig => ({ enabled: true, mode, ok: false, issue });
  if (rawMode && rawMode !== "test" && rawMode !== "live") return fail("STRIPE_CONNECT_MODE must be test or live.");
  const secret = env.STRIPE_CONNECT_SECRET_KEY?.trim() || null;
  if (!secret && !injectedClient) return fail("STRIPE_CONNECT_SECRET_KEY is not set.");
  if (secret) {
    const actual = keyMode(secret);
    if (!actual) return fail("STRIPE_CONNECT_SECRET_KEY is not a Stripe secret or restricted key.");
    if (actual !== mode) {
      return fail(mode === "test"
        ? "A live Stripe key is set but STRIPE_CONNECT_MODE is test. Use a test key, or switch the mode to live."
        : "STRIPE_CONNECT_MODE is live but the Stripe key is a test key. Use a live key.");
    }
  }
  const webhookSecret = env.STRIPE_CONNECT_WEBHOOK_SECRET?.trim();
  if (!webhookSecret) return fail(`STRIPE_CONNECT_WEBHOOK_SECRET (the ${mode} endpoint's signing secret) is not set.`);
  if (mode === "live" && env.NODE_ENV === "production" && env.STRIPE_CONNECT_LIVE_CONFIRMED !== "true") {
    return fail("Live payments in production also need STRIPE_CONNECT_LIVE_CONFIRMED=true.");
  }
  return { enabled: true, mode, ok: true, secretKey: secret, webhookSecret, issue: null };
}
