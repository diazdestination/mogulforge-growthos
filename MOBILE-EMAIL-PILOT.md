# Mobile lead response and Microsoft email pilot

## Scope and evidence boundary

October 1, 2026: the user explicitly requested this narrow controlled-pilot
addition after selecting the first contractor. It is an exception to the P0
feature freeze for mailbox compatibility and human-in-the-loop lead response,
not approval for more modules, deployment, account activation, spending, DNS,
customer import, invites, phone forwarding or real outbound messages.

This source adds Microsoft 365 / Outlook alongside Gmail, opt-in staff Web
Push, a Home Screen app shell and three manual service-reply drafts. It does
not implement a native iOS application, general mailbox hosting, an Outlook
inbox reader, shared-mailbox send-as, or two-way personal-phone SMS sync.

The private intake is outside this repository and all Docker build contexts.
Actual client contacts, member IDs, sender selection and device identifiers
must never be hardcoded into source, examples, screenshots or tests.

## Staff workflow

1. An owner/admin sets **Settings → Scheduling → New-lead phone alerts**:
   IANA time zone, business days, opening/closing times, daytime responders,
   after-hours responders and explicit routing enablement. Missing/invalid
   configuration fails closed. Recipients must be active same-company writers.
2. Each responder opens **My Profile → GrowthOS on your phone**. On iPhone,
   use Safari → Share → Add to Home Screen, open that tile, then opt in with
   **Enable lead notifications**. iOS/iPadOS 16.4+ is required. A browser
   permission prompt is never fired automatically on page load.
3. A newly created canonical lead queues one generic notice per eligible
   device, transactionally. Normal hours select daytime staff; all other times
   select after-hours staff. Imports, existing-lead merges and replayed intake
   do not create another new-lead notice. See `STAFF-PUSH-PILOT.md` for bounds.
4. Tapping the notification navigates to the exact lead and organization.
   Expired sign-in returns to that same safe local route. A different-company
   account is blocked before the lead is loaded; the app never switches tenants
   automatically. API membership/isolation is still authoritative.
5. On the lead, **Reply from your phone** offers **First response**, **Arrange
   a visit**, and **Service follow-up**. The responder reviews/edits a requested
   service reply, confirms its purpose and prepares the draft. A fresh server
   policy check precedes the native **Open phone messages** link. The human
   reviews the recipient and presses Send. A Copy message fallback is included.

Staff notification hours are NOT customer outreach hours. Offering 24-hour
service never grants blanket permission to contact customers at any hour.
Web Push is best effort, not emergency dispatch or a delivery guarantee.

## Manual SMS contract and limits

- Session-only `GET /api/v1/leads/:id/manual-sms` and
  `POST /api/v1/leads/:id/manual-sms/draft-opened`, both `crm.write`.
- POST accepts only `{templateId, confirmedServiceReply:true}`. Lead, company,
  recipient and actor come from authorized database/session state, not the body.
- Canonical global/per-SMS do-not-contact flags, address suppressions (including
  STOP), and latest affirmative SMS consent apply. Preparing a draft does not
  manufacture consent or bypass restrictions while Twilio is unavailable.
- The templates are requested-service replies, not promotional blasts or a
  reactivation campaign. Human review is required. No automatic appointment,
  response-time guarantee or unverified promise is inserted.
- Strict one-recipient normalization rejects query strings, multiple numbers,
  extensions, control characters and ambiguous international numbers.
- Preparation writes only `lead.manual_sms_prepared` with template, actor and
  intent. It does not write a sent/contacted activity, change the lead stage,
  count a conversion, or claim that the phone composer opened. No raw message
  body, customer name or telephone number is copied into that audit metadata.
- Native links expire in the UI after 60 seconds and are invalidated on changes.
  This reduces stale drafts; it cannot recall content already copied to a phone.
- The chosen phone/SIM supplies the outbound number. Carrier charges may apply.
  Replies and opt-outs remain in the phone's Messages app; the staff member must
  record them in GrowthOS. There is no automatic delivery/reply sync.
- iPhone/Android message-body prefill is best effort and requires device
  acceptance; Copy message remains available if an app ignores the body.

## Mailbox connection

Configure an environment-specific Entra application with delegated `Mail.Send`,
`User.Read` and `offline_access`, then its client ID/secret/tenant and the exact
APP_ORIGIN callback. Owners connect their own mailbox and explicitly select
**Microsoft 365 / Outlook** in **My Profile → My Connections**. Organization
default sender selection remains explicit under Settings; assigned leads use
the assigned member's selected mailbox. No automatic provider/identity failover.

Connecting is not permission to release outbound holds. Missing/revoked tokens,
inactive membership, identity changes, invalid OAuth state or unavailable
configuration block sending. OAuth uses PKCE, one-use actor/company state,
encrypted credentials and bounded requests. Local disconnect removes GrowthOS
credentials and cancels pending flows; it does not revoke remote Microsoft
consent. Account verification/invites/recovery stay on platform Resend, separate
from customer mailboxes. Yahoo is not covered by the Microsoft connector.

Microsoft `202 Accepted` is recorded as provider acceptance with a nullable
message ID and separate request correlation, never as delivery/read. Ambiguous
dispatches must not be blindly replayed. See `CUSTOMER-EMAIL-PILOT.md` for
sender selection and controlled acceptance. The registered Microsoft redirect
must be exactly `APP_ORIGIN/api/v1/integrations/microsoft/callback`; the default
tenant is `common` unless the deployment deliberately restricts it.

## Release and real-device acceptance still required

The new source/schema is not the existing hosted `c050067` image. Its completed
backup/restore/scheduler evidence remains historical, with original hash pins
and one-shot receipts preserved. Current code tests are not hosted acceptance.

Before activation:

- Review/apply the five additive tables under the authorized schema-release
  procedure: `microsoft_connections`, `email_sender_preferences`,
  `staff_push_policies`, `staff_push_subscriptions`, `staff_push_deliveries`.
  The review-only export is
  `reports/staging-schema-preview-2026-10-01/0002_mobile-microsoft-pilot.sql`;
  it has not been applied to a hosted database. Its isolated regression test
  composes it with the earlier reviewed 90-table schema.
  Do not run an ambient production `drizzle push --force`.
- Build/push/review the exact candidate with a green release gate, then obtain
  its held-staging deployment/controlled send authorization. Keep automatic
  migrations off and stage/provider approval flags off by default.
- Verify actual mailbox hosting and approved company default sender. The
  intake's assumed Microsoft provider is not verified by the mail domain's MX.
- Provision the isolated contractor tenant and individual owner accounts in an
  authorized workflow. Apply the private approved schedule and actual member
  IDs. Do not activate synthetic/local test identities.
- Configure matched VAPID keys securely, with no private key in a client bundle.
  Both staff must install and opt in themselves. Prove one approved new lead
  during normal hours and after hours, actual lock-screen receipt, authenticated
  exact-lead navigation, no duplicate on replay, logout/account switch and opt-out.
- Verify the three text drafts on an actual iPhone and Android; test prefill or
  copy fallback without sending customer messages. Any bounded staff test send
  must have an explicit recipient, purpose and maximum count approved first.
- Confirm real email acceptance and recipient receipt within the separately
  approved staff test window. Preserve the distinction between accepted and
  delivered. Resume the remaining P0 release/lifecycle/alerting gates.

Authoritative platform references:

- [WebKit Home Screen Web Push](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
- [Microsoft Graph sendMail](https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0)
- [Microsoft auth-code and PKCE flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)
- [Apple SMS URL reference](https://developer.apple.com/library/archive/featuredarticles/iPhoneURLScheme_Reference/SMSLinks/SMSLinks.html)
