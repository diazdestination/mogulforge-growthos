# Connect your apps and choose a flow

Open **Settings -> Integrations -> Zapier Connected Apps**. An owner, admin or other member with settings-management permission manages the company's connection. Each company connects its own Zapier account and app accounts.

## Client setup

1. Select **Connect Zapier**. Sign in inside Zapier and connect the account you use for your business. Passwords and app permissions stay in Zapier.
2. In the embedded Zapier screen, add the app and enable the exact supported action shown beside the GrowthOS flow. Connecting an app alone does not necessarily make an action available. Use **Manage apps in Zapier** to return to this step.
3. GrowthOS automatically loads enabled actions and refreshes when Zapier reports tool changes. Select a matching action and fill its required settings, such as calendar, business location or sending number. For crew texts, select a named team member and save their mobile number.
4. Select **Save flow**. Saving or changing a flow sets it **Off**. Choose its policy afterward: **Approve each** for reviewed writes, or **Automatic** when you want a requested action to run without a separate approval. Set a daily action limit. A zero limit prevents execution.
5. Use **Request an app flow** for an explicit request. Select an existing appointment, issued invoice, or named crew member and company date where required. Pending writes appear under **Waiting for your approval**; inspect them before approving.

**Connected** means GrowthOS has stored a verified Zapier server connection. A usable flow also needs a supported action, saved settings, enabled policy, positive daily limit and eligible GrowthOS record. Discovery does not execute a sample write or prove destination delivery.

## Supported flow choices

| Flow | Reviewed apps | Setup / behavior |
| --- | --- | --- |
| Watch reviews | Google Business Profile; Facebook Pages | Business location or page. Creates follow-up tasks; does not post review replies. |
| Pull marketplace leads | Facebook Lead Ads; Housecall Pro; Jobber | Facebook page, optional form; other candidates need no extra GrowthOS setting. Reads available records into opportunities. This does not import historical jobs or invoices. |
| Create calendar event | Google Calendar; Microsoft Outlook | Calendar setting. Select an existing appointment to request event creation. This is not calendar availability sync or automatic job-to-calendar mirroring. |
| Export issued invoice | QuickBooks Online; Xero | Select an issued invoice. Export does not collect payment, record a customer receipt or prove settlement. |
| Log calls | CallRail; Quo | Optional company/number. Automatic call sync can also request missed-call texts under the separately chosen text-back policy. |
| Text missed callers | Twilio; Quo | Approved sender and eligible callback context. Policy and consent/authority gates still apply. |
| Text crew day sheet | Twilio; Quo | Sender, named crew member's mobile, company date. Includes that member's booked jobs and appointments. |

The exact enabled app/action choices displayed in GrowthOS are authoritative for this version. Zapier's larger app catalog does not mean every app has a reviewed GrowthOS mapping. Request a mapping for a missing app or use a separately reviewed Zapier workflow; do not select a similar-looking action as a substitute.

Reviews, marketplace leads and calls can run as hourly-idempotent reads through the GrowthOS scheduler when their policy is Automatic. CALLIE call sync may also request texts under its separate SMS policy. Calendar events, accounting exports and crew sheets require explicit requests; Automatic controls how those requests execute, rather than creating a new trigger. The client action panel intentionally excludes call sync and standalone text-back because it cannot yet present callback eligibility and send-consent review. Their existing governed API/scheduler paths are separate.

## Fix a blocked setup

- **Not available on this deployment:** ask your MogulForge operator to finish deployment configuration. A staged secret is not an active connection.
- **Only an owner or administrator can manage it:** ask your company administrator to connect apps and save policies. Do not share passwords.
- **No matching actions:** open Zapier, connect the right app account and enable the exact action listed for the flow, then reload actions. A fixed-tool managed server cannot be mapped to these specialist flows; use Zapier's app/action discovery setup or contact your operator.
- **Embed did not load / action discovery failed:** use the inline retry. If it persists, check browser permissions and your app sign-in in Zapier. Do not paste server URLs or credentials into support messages.
- **Saved but not running:** check the flow's policy, daily limit, selected account and required settings. A changed server connection pauses policies; review them for the new account before enabling.
- **Awaiting approval:** review the original request in GrowthOS. A rejected or stale request is not a completed action.
- **Running / uncertain outcome:** review the existing ledger and destination before requesting again. A network failure does not prove the app did nothing. Do not retry an uncertain write to force a result.

## Operator acceptance before client use

Configure `ZAPIER_MCP_EMBED_ID` and server-only `ZAPIER_MCP_EMBED_SECRET`, plus the existing encryption key. Configure the exact allowed application domains in Zapier: root and `www` hosts are separate. Zapier does not permit `localhost` as an allowed embed domain. Keep sandbox/local QA synthetic; external-domain setup is a separate deployment decision.

Verify the deployed schema, API/frontend revision and scheduler/outbound holds. Test an authorized company's actual app sign-in and discovery, required settings, role/tenant isolation, explicit approval, successful destination result, revoked access, daily limit and uncertain-result recovery. Pending approvals from an older source version require review and a fresh request because request identity now includes the destination account. Use fictional records and a separately approved destination for any external test. Keep credentials and returned connection URLs out of browser recordings, logs and screenshots.

This source branch's local tests and mocked component/browser checks are separate from hosted/provider/client acceptance. They do not establish a live Zapier connection or authorize deployment, customer traffic or paid tasks.

Provider reference: [Zapier embed setup](https://docs.zapier.com/mcp/embed/getting-started), [embed events and attributes](https://docs.zapier.com/mcp/embed/getting-embed-code), [server-side connection guide](https://docs.zapier.com/mcp/embed/sdk-connection-guide).
