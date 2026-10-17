import { postSmsOnce } from "./sms-carrier-transport";

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
  return postSmsOnce({
    provider: "twilio",
    current: async () => {
      const identity = await current();
      // Preserve this wrapper's original closed wire shape, even at runtime.
      return {
        accountSid: identity.accountSid,
        apiKeySid: identity.apiKeySid,
        apiKeySecret: identity.apiKeySecret,
        messagingServiceSid: identity.messagingServiceSid,
        to: identity.to,
        message: identity.message,
        callbackUrl: identity.callbackUrl,
      };
    },
    onDispatch,
  });
}
