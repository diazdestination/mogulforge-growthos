# Managed app connections and flow choices

Open **Settings → Connections → Zapier Connected Apps**. MogulForge manages and pays for the automation connection; you do not need a Zapier account or subscription. Your company still authorizes its own business-app access and business actions. A company member with settings-management permission manages permitted flows.

## Client setup

1. Check connection status. If setup is pending or needs review, contact MogulForge. Do not buy a Zapier subscription or share passwords/tokens.
2. Ask MogulForge to connect the approved app accounts and make the supported actions available. A connection alone does not prove destination delivery.
3. Select a reviewed available action and its required settings, such as calendar, business location or sender. Choose the intended company account and named staff member where required.
4. Select **Save flow**. New/changed flows start Off. Choose Approve each for reviewed writes or Automatic for eligible requested actions, within the applicable limits.
5. Review the original request in **Waiting for your approval**. A stale, rejected or uncertain result is not a completed action; inspect existing receipts/destination before another request.

Connected means GrowthOS has stored an admitted company connection, not that every app workflow has passed a live test. MogulForge's monthly action ceiling applies in addition to company policies. You may disconnect your company's connection; MogulForge handles credential setup/reconnection.

## Supported flow choices

| Flow | Reviewed apps | Setup / behavior |
| --- | --- | --- |
| Watch reviews | Google Business Profile; Facebook Pages | Business location or page. Creates follow-up tasks; does not post review replies. |
| Pull marketplace leads | Facebook Lead Ads; Housecall Pro; Jobber | Facebook page, optional form; other candidates need no extra GrowthOS setting. Reads available records into opportunities. This does not import historical jobs or invoices. |
| Create calendar event | Google Calendar; Microsoft Outlook | Calendar setting. Select an existing appointment to request event creation. This is not calendar availability sync or automatic job-to-calendar mirroring. |
| Text appointment reminder | Twilio; Quo | Sender and an existing appointment for a customer with SMS consent. Built-in and own-number reminders share ownership checks. |
| Export issued invoice | QuickBooks Online; Xero | Select an issued invoice. Export does not collect payment, record a customer receipt or prove settlement. |
| Log calls | CallRail; Quo | Optional company/number. Automatic call sync can also request missed-call texts under the separately chosen text-back policy. |
| Text missed callers | Twilio; Quo | Approved sender and eligible callback context. Policy and consent/authority gates still apply. |
| Text crew day sheet | Twilio; Quo | Sender, named crew member's mobile, company date. Includes that member's booked jobs and appointments. |
| Text service reminder | Twilio; Quo | Sender and an eligible service due within its notice window. Requires SMS consent, sending hours, shared contact allowance, no reply hold and no prior reminder ownership. |

The exact enabled app/action choices displayed in GrowthOS are authoritative for this version. Zapier's larger app catalog does not mean every app has a reviewed GrowthOS mapping. Request a mapping for a missing app or use a separately reviewed Zapier workflow; do not select a similar-looking action as a substitute.

Reviews, marketplace leads and calls can run as configured-window reads through the GrowthOS scheduler when their policy is Automatic. CALLIE call sync may also request texts under its separate SMS policy. Calendar events, accounting exports and crew sheets require explicit requests; Automatic controls how those requests execute, rather than creating a new trigger. The client action panel intentionally excludes call sync and standalone text-back because it cannot yet present callback eligibility and send-consent review. Their existing governed API/scheduler paths are separate.

Appointment and service texts add an explicit client request. The automated
appointment reminder may use the enabled own-number route when built-in texting
is off; service texts through Zapier are requested by staff. Choose Approve each
when first enabling either flow. An uncertain text must be reconciled rather
than retried or followed by fallback email. Replies and STOP requests arrive in
the contractor's phone app; record an opt-out as do not text in GrowthOS too.
The contractor's own number and provider must have their required approvals;
connecting Zapier does not remove carrier registration requirements.

## Fix a blocked setup

- **Setup pending / legacy connection:** ask MogulForge to review the company connection. A staged setting is not an active connection.
- **Permission required:** ask your company administrator to review flow settings and policies. Do not share passwords.
- **No matching actions:** ask MogulForge to configure the exact supported app action and verified company account, then refresh actions. Do not choose an unrelated action as a substitute.
- **Saved but not running:** review policy, daily allowance, operator monthly ceiling, required settings and eligible source record. Replaced credentials pause policies and invalidate stale bindings.
- **Awaiting approval:** inspect and approve the original request. A rejected/stale request has not completed.
- **Running / uncertain:** review the existing receipt and destination. A network error does not prove no action occurred; do not replay an uncertain write.

## Operator acceptance before client use

See `ZAPIER-OPERATOR-SETUP.md`. The operator verifies account/plan, dedicated connection, client app authorizations, deployed revision/holds, permission/isolation, approved destination result and revoke/recovery. Company app consent, business sends, paid operations and deployment retain their separate authorization. Local tests and mock browser checks do not establish provider/client acceptance.
