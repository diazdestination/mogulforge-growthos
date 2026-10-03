import { assertOutboundDeliveryAllowed } from "./outbound-hold";

export interface CallieDispatchIdentity {
  accountSid: string;
  apiKeySid: string;
  apiKeySecret: string;
  messagingServiceSid: string;
  to: string;
  message: string;
  callbackUrl: string;
}

/** One physical attempt only. Resolve current authority immediately before POST. */
export async function postCallieAcknowledgment(current: () => Promise<CallieDispatchIdentity>, onDispatch: () => void) {
  const identity = await current();
  assertOutboundDeliveryAllowed();
  onDispatch();
  return fetch(`https://api.twilio.com/2010-04-01/Accounts/${identity.accountSid}/Messages.json`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${Buffer.from(`${identity.apiKeySid}:${identity.apiKeySecret}`).toString("base64")}` },
    body: new URLSearchParams({ To: identity.to, MessagingServiceSid: identity.messagingServiceSid, Body: identity.message, StatusCallback: identity.callbackUrl }).toString(),
  });
}
