# MogulForge registration draft — do not submit yet

> **Current context — October 29, 2026:** Historical platform-specific registration wording and prices below are not ready Painless/CSS submissions or current quotes. Prepare each actual client sender/use case from verified facts and current official provider requirements. No legal submission, account approval or price authority is implied.
> See [current build](CURRENT-BUILD.md) and [documentation map](docs/DOCUMENTATION-MAP.md).


September 27, 2026. No submission, registration SID, fee payment or approval exists from this run. Adam Mach is the user's self-reported legal name; Adam@mogulforge.ai is the supplied business email. MogulForge's legal entity, EIN, legal address, representative title and legal formation remain unverified. Do not infer an address from Dawsonville, treat the brand as an LLC, or substitute Kingdom AI Group. Painless is outside authorization.

## Proposed number and billing structure

Prefer one local voice/SMS number for MogulForge's own low-volume customer-care and appointment program, with A2P 10DLC registration **if** verified entity/EIN and volume meet Low Volume Standard eligibility. A sole-proprietor path can only be considered after verifying the actual operator/eligibility; an unformed LLC must not be represented as formed. Number availability, existing numbers and current account status must be audited first.

| Option | Published one-time registration fees | Published fixed recurring fees before usage | Fit / requirements |
| --- | --- | --- | --- |
| Local + eligible Low Volume Standard mixed campaign | $4.50 brand + $15 campaign vetting = $19.50 | $1.15 number + $1.50 low-volume mixed campaign = $2.65/month | Local identity, two-way SMS and voice; verified business/EIN and appropriate reviewed campaign. Category and charges must match Console. |
| Local + sole proprietor | $4.50 brand + $15 campaign vetting = $19.50 | $1.15 number + $2 campaign = $3.15/month | Only if Twilio's real sole-proprietor eligibility is satisfied; not a workaround for inconsistent entity information. |
| Local + standard brand | $46 brand including standard vetting + $15 campaign = $61 | $1.15 number plus use-case campaign fee (commonly $10/month) | Higher volume/other reviewed use cases; not assumed needed. |
| Verified toll-free | Published verification service fee $0 | $2.15 number/month; usage extra | Two-way nationwide SMS and voice; business and opt-in review still required; business-registration-number rules apply. |

Published US SMS base price is $0.0083 per inbound or outbound segment for these number types, plus carrier fees. Multi-segment messages cost more; failures may incur a $0.001 processing fee. Voice: local incoming $0.0085/minute, US outbound $0.0140/minute, toll-free incoming $0.0220/minute. The prepared staff bridge can incur two legs: approximately $0.028/minute for two US outbound legs, or $0.0225/minute for local incoming plus US staff forwarding, before other fees and rounding. No recording storage is enabled. These are public list rates, not an account quote, fee waiver, budget authorization or delivery forecast. Confirm current Console charges, taxes, required initial funding and campaign category before purchase/submission. No approval date is promised.

For the proposed MogulForge local LVS plus WillowNote toll-free pair, the indicative fixed baseline would be **$19.50 registration once + $4.80/month**, plus usage/carrier/tax/hosting fees, only if eligibility and existing-resource audit support that structure. **No budget has been approved.**

## Prepared campaign text

Proposed use case: low-volume mixed **customer care + account/appointment notifications**, with no promotional traffic. The actual Console enum must match its currently supported options and verified volume.

Description:

> MogulForge uses GrowthOS to send its own customers requested customer-care replies and confirmations or reminders for appointments they book with MogulForge. Recipients separately select the relevant optional purposes on the MogulForge text-preferences page and confirm control of their own mobile number by sending a one-time JOIN code from that number. Messages identify MogulForge and include STOP and HELP instructions. No purchased lists, client-branded traffic, promotions, authentication codes, family invitations or emergency notifications are included. STOP suppresses messages in the application and Messaging Service; START alone does not restore purpose consent.

This description is a **draft of implemented local behavior**. Replace future-facing/public claims with verified live evidence only after approved deployment. Appointment reminder reliability still needs the scheduling release gate.

Representative samples (synthetic, never sent):

1. `MogulForge: We received your support request. You can reply here about that request. Reply STOP to opt out. HELP for help.`
2. `MogulForge: Your appointment is confirmed for [date/time with timezone]. Reply if you need to change it. Reply STOP to opt out. HELP for help.`
3. `MogulForge: Reminder: your appointment is scheduled for [date/time with timezone]. Reply STOP to opt out. HELP for help.`

Actual appointment content comes from the existing booking workflow. Do not insert unverified customer claims, promotions or third-party branding.

Opt-in description for the form field:

> The recipient visits https://app.mogulforge.ai/sms-preferences.html, enters their own mobile number already on their MogulForge customer record, and separately chooses initially unchecked customer-care and appointment text options. The adjacent disclosure explains frequency, optional consent, message/data rates, STOP/HELP and links to messaging privacy/terms. A required own-number assertion prevents representing third-party enrollment as consent. The page generates an expiring JOIN code; only an inbound message from the matching phone grants the selected purposes. Evidence includes phone, purpose, disclosure version, source and timestamp. Changing the phone requires new consent. STOP applies before later sends and retries. No purchased or inferred consent is accepted.

Prepared URLs, **not yet published/verified for this implementation**:

- Marketing: https://mogulforge.ai
- Product: https://app.mogulforge.ai
- Opt-in: https://app.mogulforge.ai/sms-preferences.html
- Privacy: https://app.mogulforge.ai/messaging-privacy.html
- Terms: https://app.mogulforge.ai/messaging-terms.html

Screenshot evidence must show unchecked options, number field, full disclosure, both working policy links, and phone-confirmation instructions on the deployed app. Local screenshots are implementation QA only. Estimated monthly volume, sender/number SID, service SID, brand SID and campaign SID: **awaiting verification; do not invent**.

Prepared Advanced Opt-Out replies (review and configure on this product's Messaging Service):

- STOP: `MogulForge: You are unsubscribed from text messages. No further program texts will be sent. Reply START to remove the block, then confirm your choices at https://app.mogulforge.ai/sms-preferences.html.`
- HELP: `MogulForge support: Adam@mogulforge.ai. Message and data rates may apply. Reply STOP to opt out.`
- START: `MogulForge: The text-message block is removed. To choose messages again, confirm your preferences at https://app.mogulforge.ai/sms-preferences.html. Msg & data rates may apply. STOP to opt out.`

## Facts/attestations still needed

Authoritative formation/tax records, exact legal name/type/address/EIN, current representative/title/mobile and authorization, account/billing owner, launch volume, preferred available number and staff handset, specifically authorized live-test recipient(s), and explicit spending limits. Obtain legal/tax attestations securely from the appropriate representative after the complete forms are ready for review. Never store tax documents, tax identifiers or passwords here.

## Official sources checked

- [Current A2P fees and eligibility](https://help.twilio.com/articles/1260803965530-What-pricing-and-fees-are-associated-with-the-A2P-10DLC-service), [Brand registrations](https://www.twilio.com/docs/trust-hub/registrations/a2p-10dlc-brand), [Campaign vetting](https://help.twilio.com/articles/11587910480155-A2P-10DLC-Campaign-Vetting-FAQ).
- [US SMS and number rates](https://www.twilio.com/en-us/sms/pricing/us), [US voice rates](https://www.twilio.com/en-us/voice/pricing/us).
- [Toll-free verification and fee](https://help.twilio.com/hc/en-us/articles/360038172934-Information-and-best-practices-for-using-Toll-Free-SMS-and-MMS-in-the-US-and-Canada), [Current TFV inputs](https://www.twilio.com/docs/messaging/compliance/toll-free/api-onboarding). Separate publicly accessible privacy/terms fields are mandatory from September 15, 2026; business registration numbers are required for non-sole-proprietor submissions under current policy. Verification is not a bypass.
- [Subaccounts and shared balance](https://www.twilio.com/docs/iam/api/subaccounts), [Advanced Opt-Out](https://www.twilio.com/docs/messaging/tutorials/advanced-opt-out), [Webhook security](https://www.twilio.com/docs/usage/security).
