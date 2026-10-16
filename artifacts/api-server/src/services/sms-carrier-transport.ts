import { assertOutboundDeliveryAllowed } from "./outbound-hold";

export interface TwilioSmsCarrierIdentity {
  accountSid: string;
  apiKeySid: string;
  apiKeySecret: string;
  messagingServiceSid: string;
  to: string;
  message: string;
  callbackUrl: string;
  from?: string;
}

export type SmsCarrierAttempt =
  | { provider: "twilio"; current: () => Promise<TwilioSmsCarrierIdentity>; onDispatch: () => void }
  | { provider: "telnyx" };

export class SmsCarrierUnsupportedError extends Error {
  readonly code = "sms_carrier_unsupported" as const;
  constructor() {
    super("SMS carrier is unsupported");
    this.name = "SmsCarrierUnsupportedError";
  }
}

/** Physical handoff only; grants, response parsing and settlement stay with the owner. */
export async function postSmsOnce(attempt: SmsCarrierAttempt): Promise<Response> {
  if (attempt.provider !== "twilio") throw new SmsCarrierUnsupportedError();
  const identity = await attempt.current();
  assertOutboundDeliveryAllowed();
  attempt.onDispatch();
  return fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${identity.accountSid}/Messages.json`,
    {
      method: "POST",
      // Never replay this irreversible POST through a redirect.
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(`${identity.apiKeySid}:${identity.apiKeySecret}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        To: identity.to,
        MessagingServiceSid: identity.messagingServiceSid,
        ...(identity.from !== undefined ? { From: identity.from } : {}),
        Body: identity.message,
        StatusCallback: identity.callbackUrl,
      }).toString(),
    },
  );
}
