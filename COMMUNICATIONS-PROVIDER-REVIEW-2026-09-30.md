# GrowthOS communications-provider review — September 30, 2026

Status: **decision support, not activation**. The owner is considering moving away
from Twilio for Painless and the HVAC pilot. No provider account, forwarding rule,
SIM, customer message, or production configuration was changed by this review.
The existing code remains dormant and is not evidence that either client has a
working missed-call assistant.

## What the proposed services actually cover

| Need | Candidate | Verified capability and gap |
| --- | --- | --- |
| Account/login phone verification | Message Central VerifyNow | Vendor markets pre-registered/shared US routes for **one-time verification codes**. It is not evidence of permission to send appointment reminders, missed-call follow-ups, reactivation, or marketing through that route. Treat pricing and setup-speed claims as vendor claims until a controlled account test. |
| Outbound and inbound text | textbee on an Android/SIM | Official API and webhooks cover SMS send, receive, and delivery state. The documented event list does **not** include incoming or missed calls. The Android/SIM number, not the contractor's existing iPhone number, is the SMS sender. |
| Detect a missed call to the existing number | Carrier conditional forwarding plus a separate call-event source | Apple says conditional forwarding depends on the carrier. A forwarded call ringing Android does not itself create a GrowthOS event. The original caller number, voicemail precedence, busy/unreachable handling, and event latency must be proven on the actual carrier/phones. |
| AI voice answering | Not provided by either candidate | SMS transport and OTP verification do not answer a call, speak to callers, or book by voice. This remains a separate provider/product decision. |

Sources checked September 30, 2026:

- Message Central VerifyNow USA: https://www.messagecentral.com/product/verify-now/overview/usa and shared-pool claim: https://www.messagecentral.com/blog/send-otps-usa-without-10dlc-verifynow
- textbee overview and webhook events: https://textbee.dev/docs and https://textbee.dev/docs/webhooks/events
- textbee device selection, incoming payload, and dual-SIM behavior: https://textbee.dev/docs/sending-sms ; https://textbee.dev/docs/receiving-sms ; https://textbee.dev/docs/sending-sms/choosing-a-sim
- iPhone forwarding: https://support.apple.com/guide/iphone/set-up-call-forwarding-iph7405291c4/ios
- CTIA consent/opt-out principles: https://www.ctia.org/news/ctia-updates-messaging-principles-and-best-practices-to-further-protect-consumers-from-unwanted-messages-while-supporting-the-growth-of-messaging
- Example carrier restriction, AT&T consumer wireless terms section 2.5.2: https://www.att.com/legal/terms.internetAttTermsOfService
- Android call-log permission and Play distribution restrictions: https://developer.android.com/reference/android/provider/CallLog.Calls and https://support.google.com/googleplay/android-developer/answer/10208820

## Product and compliance decision

1. **Pause Twilio activation, not delete the existing dormant connector.** The
   replacement is not equivalent yet. Keep the product's communications model
   provider-neutral so a verified provider can be substituted without changing
   the customer, consent, task, appointment, and evidence models. No new
   communications module during the paid-beta P0 feature freeze.
2. **Do not use VerifyNow as contractor messaging.** Consider it only if
   GrowthOS needs a login/phone-verification OTP flow, after controlled testing.
3. **Evaluate textbee as an optional low-volume SMS transport**, not as a way to
   evade business messaging obligations. A SIM line is not automatic permission
   for automated commercial texting: CTIA expects non-consumer senders to get
   opt-in and honor opt-outs, and the carrier/plan terms can prohibit commercial
   or unusually high-volume SMS. Get the exact line/plan terms confirmed before
   any client rollout. A missed voice call by itself is not a stored,
   purpose-specific SMS consent receipt in GrowthOS.
4. **One phone, one SIM, one contractor in any pilot.** textbee's webhook has a
   `deviceId` but no receiving-SIM identifier. Its dual-SIM send API silently
   falls back to another SIM if the requested subscription ID is stale or wrong.
   That is unacceptable for cross-client sender isolation. Likewise, sending
   without `deviceId` falls back to an account default or recent device. Every
   authorized send must resolve an exact tenant-bound device and fail closed if
   it is missing or unhealthy. Separate provider accounts/credentials per
   contractor are preferable to a shared account with multiple tenant devices.
5. **Keep the first missed-call outcome as a staff callback task.** Do not
   promise auto-text or AI answering until a supported, authenticated call-event
   source and controlled carrier tests exist. Android call-log integration would
   require sensitive permissions and Play policy review; it is not a quick
   feature of the textbee SMS app.

## Required pilot acceptance before any automatic text

- Choose one consenting test contractor, their current carrier and business
  plan, a distinct Android device/SIM and exact displayed sender number; verify
  the carrier allows the intended business/automated use and conditional
  forwarding. Record rollback instructions before changing forwarding.
- Identify an authenticated missed-call event source **separate from textbee**.
  With a third phone, prove answered, no-answer, busy and unreachable calls;
  confirm the original caller number on the event, voicemail behavior, event
  uniqueness, and callback-task creation. If any fails, leave automatic SMS off.
- Bind provider account, webhook subscription, device ID, number and secret to
  exactly one GrowthOS organization. Reject unknown/revoked IDs, bad signatures,
  duplicate events, late events, and cross-tenant combinations. Never infer the
  tenant from a free-text message, contact match, or default device.
- Before every send, require a purpose-specific consent receipt, current
  suppression/STOP state, approved copy and sender, quiet-hour/frequency rules,
  explicit device ID, budget, and launch flag. Keep ambiguous provider outcomes
  for review rather than blind retry; reconcile receipts and device health.
- Test a reply and STOP from a third phone, provider outage/recovery, phone
  offline or SIM swap, stale dual-SIM ID, webhook retry, and a staff-visible
  failure. Prove the text shows the **Android number** and that all events stay
  in that contractor's tenant. Production activation needs the paid-beta release
  gates and owner approval in addition to this pilot evidence.

## Immediate next action

Do not buy hardware or migrate providers yet. Confirm the first pilot's carrier,
plan, phone model, and whether the requested outcome is (a) staff missed-call
callback, (b) automated consented SMS follow-up, or (c) an actual AI voice
assistant. Then choose and test the separate call-event source. The current
Painless/HVAC code and local UI can continue to be tested without live sends.
