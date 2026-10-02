import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import webpush from "web-push";
import { isPushEndpointAllowed, pushConfiguration, staffPushAllowed, type DevicePushSubscription } from "./staff-push-policy";

/** Only thrown before the HTTPS request exists. An uncertain network attempt is different. */
export class StaffPushDispatchBlockedError extends Error {
  constructor() { super("push_authorization_changed_before_dispatch"); }
}

/** A deliberately stricter public-address policy than a generic webhook client. */
export function isPublicPushAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || b === 2)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) === 6) {
    const lower = address.toLowerCase();
    return /^[23][0-9a-f]{3}:/.test(lower) && !lower.startsWith("2001:db8:") &&
      !lower.startsWith("2001:0:") && !lower.startsWith("2002:");
  }
  return false;
}

/**
 * web-push creates the standards-based encrypted payload/VAPID headers only.
 * This bounded HTTPS transport pins a vetted DNS address, verifies TLS for the
 * original hostname, refuses redirects/proxies and discards response content.
 */
export async function sendStaffPush(subscription: DevicePushSubscription, payload: string, userId: string, beforeDispatch?: () => Promise<boolean>): Promise<number> {
  const config = pushConfiguration();
  if (!userId || !config || !staffPushAllowed(userId) || !isPushEndpointAllowed(subscription.endpoint)) throw new Error("push_configuration_unavailable");
  const details = webpush.generateRequestDetails(subscription, payload, {
    vapidDetails: config, TTL: 60, urgency: "high", contentEncoding: "aes128gcm",
  });
  if (details.endpoint !== subscription.endpoint) throw new Error("push_endpoint_changed");
  const endpoint = new URL(subscription.endpoint);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 5_000);
  let abortListener: (() => void) | undefined;
  let authorizationAbortListener: (() => void) | undefined;
  try {
    const records = await Promise.race([
      lookup(endpoint.hostname, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        abortListener = () => reject(new Error("push_timeout"));
        abort.signal.addEventListener("abort", abortListener, { once: true });
      }),
    ]);
    if (abort.signal.aborted || !staffPushAllowed(userId) || records.length === 0 || records.some((r) => !isPublicPushAddress(r.address))) {
      throw new Error("push_destination_unavailable");
    }
    // DNS can take seconds. Recheck current owner, case, device and membership
    // after it completes; a stale alert must not escape through that gap.
    if (beforeDispatch) {
      // Share the original deadline: a stalled authorization lookup must not
      // hold the scheduler indefinitely. Promise.race also observes a late
      // callback rejection after timeout; it cannot resume the HTTPS path.
      const authorized = await Promise.race([
        Promise.resolve().then(beforeDispatch),
        new Promise<never>((_, reject) => {
          authorizationAbortListener = () => reject(new StaffPushDispatchBlockedError());
          abort.signal.addEventListener("abort", authorizationAbortListener, { once: true });
          if (abort.signal.aborted) authorizationAbortListener();
        }),
      ]);
      if (!authorized) throw new StaffPushDispatchBlockedError();
    }
    if (abort.signal.aborted || !staffPushAllowed(userId)) throw new StaffPushDispatchBlockedError();
    return await new Promise<number>((resolve, reject) => {
      const req = request({
        protocol: "https:", hostname: records[0].address, servername: endpoint.hostname,
        port: 443, path: endpoint.pathname, method: "POST", agent: false,
        headers: { ...details.headers, Host: endpoint.hostname }, signal: abort.signal,
      }, (response) => {
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 4096) response.destroy(new Error("push_response_too_large"));
        });
        response.on("end", () => resolve(response.statusCode ?? 0));
        response.on("error", () => reject(new Error("push_response_unavailable")));
      });
      req.on("error", () => reject(new Error("push_request_unavailable")));
      req.end(details.body);
    });
  } finally {
    clearTimeout(timer);
    if (abortListener) abort.signal.removeEventListener("abort", abortListener);
    if (authorizationAbortListener) abort.signal.removeEventListener("abort", authorizationAbortListener);
  }
}
