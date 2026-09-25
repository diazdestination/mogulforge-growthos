# Twilio A2P 10DLC — MogulForge ISV + Painless Pilot Registration Packet

**Status:** PREPARED — external Twilio Console submission still required  
**Architecture:** ISV Type #1 — one Twilio subaccount + Messaging Service per contractor customer  
**First customer:** Painless Roofing and Water Restoration, LLC  
**GrowthOS branch:** `agent/mogulforge-growthos-recovery`

## 1. Architecture decision

MogulForge is an ISV because GrowthOS enables independent businesses to send customer-facing messages under each business's own brand.

Use this structure:

- Parent Twilio account: MogulForge
  - Approved **Primary Customer Profile**
  - Business Identity: **ISV Reseller or Partner**
  - MogulForge's own Brand/Campaign only if MogulForge itself sends A2P traffic
- One Twilio subaccount per GrowthOS customer
  - One **Secondary Customer Profile** containing that customer's legal identity
  - One A2P Brand for that customer
  - One or more Campaigns for that customer's actual messaging use cases
  - One Messaging Service per registered use case
  - Customer-specific number(s)
  - Customer-specific API credentials/keys

Do not share one Painless campaign, Messaging Service, or sending number across unrelated GrowthOS tenants.

## 2. Primary MogulForge profile — required before customer API onboarding

Twilio requires the ISV's Primary Customer Profile to be created in Console and reach **Twilio Approved** status before the customer-registration APIs can be used.

Open Twilio Console → Messaging → Regulatory Compliance / Trust Hub → Customer Profiles.

Select business identity:

**ISV Reseller or Partner**

### Required MogulForge identity — must be copied from authoritative business/tax records

Do not guess these fields.

- Legal business name: **REQUIRED**
- EIN / Tax ID: **REQUIRED**
- Exact registered street address: **REQUIRED**
- City/state/postal code: **REQUIRED**
- Entity/business type: **REQUIRED**
- Website: `https://mogulforge.ai`
- Authorized representative first/last name: **REQUIRED**
- Authorized representative title: **REQUIRED**
- Authorized representative email: **REQUIRED**
- Authorized representative mobile number: **REQUIRED**
- Business industry: software / technology / communications platform (select closest Twilio value)
- Business identity: **ISV Reseller or Partner**

**Blocker:** the legal entity behind the MogulForge brand has not been verified in the repository. Do not use a marketing brand name where Twilio asks for the legal business name.

Record after submission:

- Primary Customer Profile SID: `BU_______________________________`
- Submission date:
- Approval status:
- Approval date:

## 3. First customer — Painless Roofing and Water Restoration, LLC

Public verification currently supports:

- Customer-facing brand: **Painless Roofing and Water Restoration**
- Public business listing name: **Painless Roofing and Water Restoration, LLC**
- Website: `https://www.painlessroofingandwaterrestoration.com/`
- Public service area/business location: Canton, Georgia
- Public phone: `+1 404-444-4476`

Do **not** use a public-directory address or name as tax identity evidence. Confirm the exact legal name, EIN, and IRS/business-registration address directly with the owner.

### Required customer identity

- Exact EIN legal name: **REQUIRED FROM OWNER**
- EIN: **REQUIRED FROM OWNER**
- Business type: **REQUIRED FROM OWNER**
- EIN/registration address: **REQUIRED FROM OWNER**
- Authorized representative name: **REQUIRED FROM OWNER**
- Representative title: **REQUIRED FROM OWNER**
- Representative email: **REQUIRED FROM OWNER**
- Representative mobile: **REQUIRED FROM OWNER**
- Expected monthly SMS volume: **REQUIRED / estimate**
- Desired Twilio 10DLC number: **BUY IN CUSTOMER SUBACCOUNT**
- Website: `https://www.painlessroofingandwaterrestoration.com/`

## 4. Recommended Painless Brand/Campaign tier

For a normal local roofing/restoration beta with modest traffic, use **Low-Volume Standard** if the verified business has an EIN and its expected volume fits Twilio's low-volume limits.

If Painless expects to exceed low-volume limits, register a Standard Brand instead.

Messaging use-case decision:

- **Low-Volume Standard Brand:** use the `LOW_VOLUME` campaign use case for the bounded mix of customer care, appointment/service updates, and consented reactivation.
- **Standard Brand:** use `MIXED` if the same sender carries both customer-care/informational and consented marketing/reactivation traffic.

Do not register a campaign whose description is broader than the actual opt-in language.

## 5. Website opt-in remediation — required before campaign submission

The current public Painless contact form requires a phone number but does not visibly present the SMS consent disclosure needed for the planned messaging program.

Add an **unchecked, optional** SMS checkbox immediately adjacent to the phone/contact form.

### Proposed checkbox copy

> [ ] By checking this box, I agree to receive recurring automated informational and marketing text messages from **Painless Roofing and Water Restoration** at the mobile number I provided, including responses to my request, appointment/service updates, and occasional follow-up about roofing or restoration services. Message frequency varies, up to 4 messages per month. Message and data rates may apply. Reply **STOP** to opt out or **HELP** for help. Consent is not a condition of purchase. See our Privacy Policy and Terms & Conditions.

Requirements:

- Checkbox must be unchecked by default.
- Form submission must remain possible without SMS consent.
- Store timestamp, consent version, source page, and submitted phone number.
- Link **Privacy Policy** and **Terms & Conditions** to public pages on the Painless domain.
- Capture consent separately from merely collecting a required phone number.

## 6. Privacy Policy — SMS language to add

The public Painless Privacy Policy must clearly cover SMS collection and non-sharing. Include language substantively equivalent to:

> **SMS and mobile information.** If you opt in to receive text messages from Painless Roofing and Water Restoration, we use your mobile number and messaging consent to provide the communications described at the time of opt-in. Mobile opt-in information and consent will not be shared with third parties or affiliates for their marketing or promotional purposes. Message frequency varies and may be up to 4 messages per month. Message and data rates may apply. You may reply STOP to opt out at any time or HELP for help.

The final policy should also accurately describe the site's broader data practices.

## 7. SMS Terms section to add

Publish on the same Painless domain and include:

**Program:** Painless Roofing and Water Restoration SMS Program

Painless Roofing and Water Restoration may send informational and, where separately consented, marketing/service-follow-up messages related to roofing/restoration inquiries, appointments, inspections, estimates, projects, and services.

- Message frequency varies; up to 4 messages per month for the beta program.
- Message and data rates may apply.
- Reply **STOP** to cancel.
- Reply **HELP** for help.
- Consent to marketing texts is not a condition of purchase.
- Support: use the public Painless contact method/phone published on the site.
- Carriers are not liable for delayed or undelivered messages.
- Include a link back to the Privacy Policy.

## 8. Proposed campaign description

Use only after the website disclosures above are live and match actual behavior.

> Painless Roofing and Water Restoration sends SMS messages to customers and prospects who have expressly opted in through the company's public website or another documented consent flow. Messages include responses to roofing/restoration inquiries, inspection and appointment coordination, service/project updates, and limited follow-up to people who previously requested information and consented to SMS marketing/follow-up. Messages are sent only under Painless Roofing and Water Restoration's brand. GrowthOS/MogulForge provides the software infrastructure. Recipients can reply STOP to opt out and HELP for assistance. The system enforces consent, suppression, quiet hours, and frequency limits.

## 9. Proposed message flow

Replace URLs only after the pages are live.

> End users opt in at https://www.painlessroofingandwaterrestoration.com/contact by entering their phone number and separately checking an unchecked SMS consent box. The disclosure identifies Painless Roofing and Water Restoration, describes informational and marketing/service-follow-up texts, states that message frequency varies up to 4 messages per month, states that message and data rates may apply, explains STOP and HELP, and states that consent is not a condition of purchase. The form can be submitted without checking the SMS box. Consent records are stored with timestamp and source/version. Privacy Policy: https://www.painlessroofingandwaterrestoration.com/privacy . Terms: https://www.painlessroofingandwaterrestoration.com/terms . Additional opt-in methods must not be used unless they are separately documented in this campaign.

If the actual production paths differ, update all three URLs before submission.

## 10. Campaign sample messages

Twilio/TCR expects the Brand to be clearly identified in each sample.

### Sample 1 — inquiry/customer care

> Painless Roofing and Water Restoration: Thanks for contacting us about [service/request]. A team member can help with your next step. Reply here with a good time to talk. Reply STOP to opt out, HELP for help.

### Sample 2 — appointment

> Painless Roofing and Water Restoration: Reminder — your [inspection/appointment] is scheduled for [date] at [time]. Reply C to confirm or contact us if you need to reschedule. Reply STOP to opt out, HELP for help.

### Sample 3 — consented reactivation/follow-up

> Painless Roofing and Water Restoration: You previously asked us about [roofing/restoration service]. If you still need help, reply YES and we'll help schedule the next step. Reply STOP to opt out, HELP for help.

### Sample 4 — estimate follow-up

> Painless Roofing and Water Restoration: Following up on your [roofing/restoration] estimate. If you have questions or want to review next steps, reply here and our team can help. Reply STOP to opt out, HELP for help.

## 11. Keyword messages

### STOP response

> Painless Roofing and Water Restoration: You are unsubscribed and will no longer receive automated text messages. Reply START to opt back in.

### START response

> Painless Roofing and Water Restoration: You are subscribed again to text messages. Message frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help.

### HELP response

> Painless Roofing and Water Restoration: For help, reply here or call 404-444-4476. Msg & data rates may apply. Reply STOP to opt out.

## 12. GrowthOS/Twilio production endpoints

Current GrowthOS route inventory exposes:

- Inbound STOP/START webhook:
  `https://app.mogulforge.ai/api/v1/public/sms/inbound`
- Twilio delivery-status callback:
  `https://app.mogulforge.ai/api/v1/public/sms/status`

Before live traffic:

1. Verify both URLs against the exact deployed release SHA.
2. Configure/verify Twilio request-signature validation.
3. Ensure outbound message creation explicitly supplies the status callback or prove the chosen Messaging Service/account configuration supplies it.
4. Prove outbound → delivery callback → GrowthOS touch receipt end-to-end.
5. Prove STOP → suppression → subsequent send blocked.
6. Prove START reverses only an SMS STOP suppression.
7. Keep GrowthOS SMS disabled until campaign approval.

## 13. Twilio resource order for Painless

After MogulForge Primary Customer Profile is **Twilio Approved**:

1. Create Painless Twilio subaccount.
2. Create Painless Secondary Customer Profile inside the Painless subaccount.
3. Add Painless legal business information.
4. Add required authorized representatives.
5. Submit/check Secondary Customer Profile.
6. Register Painless A2P Brand.
7. Respond to any OTP/verification promptly.
8. Create campaign using the approved website evidence and copy above.
9. Buy/select US local 10DLC number in Painless subaccount.
10. Create Painless Messaging Service.
11. Link approved campaign to Messaging Service.
12. Add Painless number to Messaging Service.
13. Configure inbound/status callback routes.
14. Run controlled test to separately authorized phones.
15. Record Brand SID, Campaign SID, Messaging Service SID, Phone Number SID and status in GrowthOS onboarding metadata (never expose auth token/secret to browser/UI).

## 14. GrowthOS product work for repeatable ISV onboarding

Paid beta should expose a compliance status per tenant:

- Twilio subaccount: not_created / active / suspended
- Customer Profile: draft / pending_review / approved / rejected
- Brand: draft / pending / approved / rejected
- Campaign: draft / pending / approved / rejected
- Messaging Service: not_ready / ready
- Phone number: unassigned / assigned
- Production SMS: blocked / enabled

GrowthOS must fail closed: automated SMS cannot become active until the customer's own Campaign and sender are approved.

## 15. Immediate human inputs still required

### MogulForge / Primary ISV
- Exact legal entity name
- EIN/Tax ID
- exact registered address
- entity type
- authorized representative name/title/email/mobile

### Painless / first customer
- exact EIN legal name
- EIN
- registered address
- business type
- authorized representative name/title/email/mobile
- approximate monthly SMS volume
- approval to add the public SMS opt-in disclosure, Privacy Policy, and Terms

Do not paste Twilio Auth Tokens, API secrets, EIN documents, or other credentials into source control.
