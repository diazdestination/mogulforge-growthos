# Twilio client onboarding: timing and fastest safe sequence

Checked September 30, 2026. **Planning guidance, not an approval guarantee or
evidence that either Painless or the HVAC client is registered.** No provider
resources, legal submissions, forwarding, messages or calls were changed.

The owner chose to continue with Twilio. Do not confuse three separate jobs:

| Job | What is actually approved or changed | Published timing and rollout use |
| --- | --- | --- |
| Incoming voice on a dedicated Twilio number | Configure a voice-capable number and signed inbound webhook; optionally test reversible no-answer forwarding from the incumbent business line | US voice handling is separate from A2P SMS campaign approval. Account, number, routing, release and owner gates still apply; do not call either client live based on an SMS-free code test. |
| Local-number SMS from Twilio | Client business/brand, campaign/use case, Messaging Service and sender association | Twilio's official pages disagree on the current queue: one says 5 business days, another 10–15 days, and product marketing says under one week without a guarantee. Plan **roughly 2–3 weeks plus rejection/rework buffer**, not a promised launch date. Brand checks may be fast but campaign vetting is the longer gate. |
| Toll-free SMS from Twilio | Verification for a toll-free number and the client's actual messaging use case | Twilio's API guide says reviews occur within **three business days**. This is a possible faster route when a distinct toll-free sender suits the client's experience; it is not immediate, a local-number substitute, or permission to use another client's verification. |
| Keeping an existing non-Twilio number | Either forward calls to a distinct Twilio voice number for a pilot or separately port the number | Merely verifying the incumbent number as an outbound voice caller ID does **not** route inbound calls or enable outbound SMS. US number porting is typically **5–15 days**, potentially four weeks or longer after rejections. Do not port a contractor's working line merely to accelerate a first pilot. |

Source links: [Twilio A2P quickstart](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/quickstart), [campaign vetting FAQ](https://help.twilio.com/articles/11587910480155-A2P-10DLC-Campaign-Vetting-Changes-January-2023), [campaign onboarding guide](https://help.twilio.com/articles/11847054539547-A2P-10DLC-Campaign-Approval-Best-Practices), [toll-free verification API](https://www.twilio.com/docs/messaging/compliance/toll-free/api-onboarding), [US voice guidelines](https://www.twilio.com/en-us/guidelines/us/voice), [verified caller ID limits](https://help.twilio.com/hc/en-us/articles/223180048-How-to-Add-and-Remove-a-Verified-Phone-Number-or-Caller-ID-with-Twilio), [US porting guidelines](https://www.twilio.com/en-us/guidelines/us/porting).

## Repeatable Painless/HVAC sequence

1. Confirm GrowthOS's legal/platform account model. If GrowthOS sends on each
   contractor's behalf, Twilio's ISV model needs the platform's approved Primary
   Business Profile and the **contractor's own** Secondary Customer Profile,
   Brand, Campaign, Messaging Service and preferably subaccount. Do not use
   MogulForge, Painless and the HVAC business as one campaign or legal sender.
   If the contractor owns the Twilio account instead, document who is the direct
   sender and grant GrowthOS only the appropriate scoped integration access.
2. Before paying/submitting, gather each contractor's exact legal name and tax
   identity from authorized private records, business address, working site,
   publicly accessible privacy/terms URLs, real opt-in language/screenshots,
   use cases, representative, message examples and expected volume. Separate
   service reminders and missed-call follow-up from marketing permission.
   Twilio's new campaign submissions require public privacy and terms URLs.
3. Build/review each client-specific GrowthOS account/number/secret routing and
   keep SMS off. Test signed voice callback, answered/no-answer/busy handling,
   staff task and rollback on authorized test phones. The incumbent number can
   remain with its carrier; forwarding is a separate carrier action after
   approval, not a requirement for registration.
4. With the owner's approval of the exact provider account, fee and legal
   statements, submit each client-specific SMS registration promptly and in
   parallel with voice acceptance. Track status visibly. If local 10DLC queue
   time is unsuitable and the client accepts a distinct toll-free sender,
   evaluate toll-free verification for that client—not as an unregistered bypass.
5. Do not enable customer SMS until that sender/use case is approved and
   GrowthOS has that contact's purpose-specific consent, STOP/suppression,
   delivery receipts, frequency/quiet-hour controls, two-tenant isolation,
   alerts and exact-release staging proof. Automated missed-call texting is
   later than a staff callback task, not the first voice milestone.

ISV source: [Twilio ISV onboarding architecture](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/onboarding-isv), [ISV prerequisite/profile flow](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/onboarding-isv-api). New privacy/terms URL rule: [Twilio changelog](https://www.twilio.com/en-us/changelog/a2p-10dlc-campaign-registration-will-require-privacy-policy-and-).

**Next action:** finish the existing two-client provider binding in local code
and inventory the actual authorized Twilio account/number/registration status.
Then prepare the two separate client packets for owner review, without making a
paid/legal submission or changing live routing.
