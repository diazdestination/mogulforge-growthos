# Current GrowthOS build

Updated October 29, 2026 against source `f0d74ab4ab2db756637cf3b4ad306b33982c9688`,
tree `d2df1e226dc9b496c66909f9c2b2a8464e72eb43`.
This refresh changes documentation, not application code or deployments.

## Status vocabulary and repository identity

**Implemented** means the named API/UI/service exists in source. **Verified**
identifies a particular check. **Live** requires the exact deployed version,
actual provider connection and accepted customer/device flow. Source tests do
not establish live acceptance.

Canonical repository: `diazdestination/mogulforge-growthos`, ID 1324860199;
`mogulforge-crm` redirects here. Last verified visibility: public. The separate
`MogulForge-crm-template-` main is an ancestor,384 commits behind this product
baseline. Product work belongs here; client exports are a separate decision.

## Implemented capabilities

| Area | Current source behavior | Source / operating reference | Remaining boundary |
| --- | --- | --- | --- |
| Office/field work | Today, tasks, overdue work and exact customer/job navigation | [Today](artifacts/command-center/src/pages/today.tsx), [Today API](artifacts/api-server/src/routes/v1/contractor-today.ts) | Actual staff/device workday acceptance |
| CRM/customer workspace | Contacts, properties, pipeline/history and audited detail corrections | [Customer workspace](artifacts/command-center/src/pages/customer-workspace.tsx), [corrections](docs/CUSTOMER-DETAIL-CORRECTIONS.md) | Contacts-only import is not full history migration |
| Estimates/jobs | New/returning work, explicit worksite, staff acceptance and native job creation | [Customer work](artifacts/api-server/src/routes/v1/customer-work.ts), [guide](GROWTHOS-RETURNING-CUSTOMER-WORK.md) | Staff-recorded acceptance is not e-signature |
| Scheduling | Appointments/projects, crews, saved capacity/travel rules and overlap/travel-gap refusal | [Scheduling core](lib/scheduling-core/src/reservations.ts), [API](artifacts/api-server/src/routes/v1/scheduling.ts) | Full company scheduling/recovery acceptance remains required |
| Workday/equipment | Property assets, checklists, completion evidence and recorded warranty facts | [Workday API](artifacts/api-server/src/routes/v1/contractor-workday.ts), [invoice equipment](artifacts/api-server/src/services/invoice-equipment.ts) | No inferred manufacturer coverage or entitlement |
| Invoices/receipts | Draft/review/issue, immutable issued content, equipment snapshots, external receipts/refunds/allocations and balances | [Invoices](artifacts/api-server/src/routes/v1/invoices.ts), [schema](lib/db/src/schema/invoices.ts) | Recording a receipt does not collect or verify money |
| Estimate/invoice email | Exact saved preview/review and delivery evidence through a selected mailbox | [Estimate delivery](artifacts/api-server/src/services/estimate-delivery.ts), [invoice delivery](artifacts/api-server/src/services/invoice-delivery.ts) | Provider acceptance is not inbox arrival; broader PDF/photo/SMS scope remains separate |
| Recurring service | Obligations, standing reminders, reply review/holds and owned follow-up tasks | [Service Desk](artifacts/command-center/src/pages/service-desk.tsx), [service SMS](artifacts/api-server/src/services/service-sms.ts) | Does not close every requested dual-channel cadence |
| Revenue Desk/BIE | Deterministic opportunities, evidence, saved-payload approvals, owned action receipts and value/outcome views | [Workspace API](artifacts/api-server/src/routes/v1/revenue-workspace.ts), [BIE](artifacts/api-server/src/routes/v1/bie.ts) | Pipeline and recorded receipts are not incremental revenue proof |
| Sites/websites | Tenant/site credentials, capture, responder coverage, delivery journal/reconciliation and launch checks | [Smart Sites](artifacts/api-server/src/routes/v1/smart-sites.ts), [adapter](examples/website-connection/README.md) | A public site does not prove CRM/provider acceptance |
| Customer email | Per-member selected Gmail/Microsoft sender, company resolution and no platform-mailbox fallback | [Customer email](artifacts/api-server/src/services/customer-email.ts), [guide](CUSTOMER-EMAIL-PILOT.md) | Actual OAuth and inbox delivery remain per-user/company gates |
| Mailbox replies | Opt-in Microsoft reply/source workflows and original-work holds | [Lead replies](artifacts/api-server/src/routes/v1/lead-mailbox-replies.ts), [service replies](artifacts/api-server/src/routes/v1/service-mailbox-replies.ts) | Gmail sending is not broad inbox reading; Yahoo is not supported by these connectors |
| Twilio SMS | Isolated account/number, signed callbacks, handset/purpose proof, staff/service replies, STOP/START and send ownership | [Twilio routes](artifacts/api-server/src/routes/v1/twilio.ts), [binding](TWILIO-TENANT-BINDING.md) | Sender approvals, installed credentials and real-phone acceptance unverified |
| Calling/missed calls | Staff-first bridge, call history, callback review/tasks and unknown callers without automatic texting | [Voice](artifacts/api-server/src/routes/v1/twilio-voice.ts), [care](artifacts/api-server/src/services/missed-call-care.ts) | No verified live client line |
| CALLIE | Separate keypad acknowledgment and ElevenLabs conversation policy/runtime foundations; office review/booking ownership | [CALLIE API](artifacts/api-server/src/routes/v1/callie.ts), [conversation guide](reports/callie-conversation-operator-2026-10-05.md) | Remote agent and live-phone acceptance remain separate |
| Staff mobile | Responsive shell, opt-in Web Push and exact lead navigation | [Staff push](artifacts/api-server/src/routes/v1/staff-push.ts), [mobile guide](MOBILE-EMAIL-PILOT.md) | Not native iOS/Android apps or actual background-device proof |
| Specialist guidance | Existing identities, directory and contextual workflow guidance | [Agent team](artifacts/command-center/src/pages/agent-team.tsx), [character contract](design/brand/CHARACTER-THEME.md) | Illustrative identities are not independently activated autonomous agents |
| Customer workspace | Contact-scoped portal/decision room, approved context and private photos | [Portal](artifacts/api-server/src/routes/v1/portal.ts), [room](artifacts/command-center/src/pages/project-room.tsx) | No inferred payment, signature or booking authority |
| Evidence Intelligence | Approved evidence, redaction, manifests, citations, human-reviewed certificates/claim graphs and guarded route packets | [Guide](EVIDENCE-INTELLIGENCE.md), [proof lab](artifacts/api-server/evals/README.md) | Synthetic trust tests do not prove expert accuracy or external claim execution |
| Email Intelligence | Cloudflare intake Worker and signed/encrypted/redacted tenant intake | [Worker](lib/integrations/cloudflare-email-intake/README.md), [setup](EMAIL-INTELLIGENCE-SETUP.md) | Domain routing and real inbox intake require activation evidence |
| Lifecycle/operations | Export/inventory, holds/offboarding review, scheduled work and reconciliation | [Lifecycle](artifacts/api-server/src/routes/v1/customer-lifecycle.ts), [inventory](artifacts/api-server/src/routes/v1/data-lifecycle-inventory.ts) | Exact-version export/recovery acceptance remains required |
| Platform billing | Subscription checkout/reconciliation and entitlement foundations | [Billing](artifacts/api-server/src/routes/v1/billing.ts) | Separate from contractor collections; real billing acceptance not claimed |

## Provider posture and unfinished scope

Twilio is the selected immediate SMS/basic calling setup path. Its code and local
checks exist; account/sender inventory, credentials and handset acceptance are
pending. Telnyx partial implementation remains parked outside this main baseline.
ElevenLabs conversation integration exists in source, but live client phone
answering is not established.

Gmail/Microsoft capabilities require each real identity's consent and acceptance.
The optional Google module catalog is not a declaration of working Calendar,
Drive, Sheets, Analytics, Ads or Business Profile adapters. Contractor online
collection/financing, automatic after-hours customer replies, general text-to-book
and live AI phone answering remain separate unfinished scope. Preserve the full
contractor requirements rather than treating a reduced channel test as cutover.

## Verification and hosted status

Existing [full CI 39174960772](https://github.com/diazdestination/mogulforge-growthos/actions/runs/39174960772)
passed on Linux Node 22.23.3. Actual checkout `7b4cbc3be11e680f9416aafcb441cc66fc6b6637`
has the identical tree to the baseline above. Tests, types, both builds, Docker
staging parity and cleanup passed. Older refused CI runs retain their failures;
they do not describe this later successful run.

October 29 on unchanged source: 314 tests in 16 selected PostgreSQL 16 suites and 45 tests
in 4 UI suites passed, zero skips. An earlier isolated Twilio/PGlite run passed 79
tests in 8 files. These are recorded executions, not new CI for this docs commit or
carrier proof. Private operator receipts remain outside the public repository.

The last October 29 operator metadata check found the older production image
stopped, without Twilio secret names. The last cutover rolled back before reopen
after log admission rejected 15 frames; backup/copy/compare had passed. Raw frames
were not retained, so cause is unproven. Current workstation clock repair remains
pending. Preserve retained target data and consumed cutover intents.

Exact hosted source/image/operator/SQL/backup/recovery binding, provider/device
proof and both contractor workday/replacement cards remain release gates. This
document does not verify current uptime or authorize deployment.

## Build and documentation ownership

See [architecture](GROWTHOS-ARCHITECTURE.md), [local development](DEV-LOCAL.md)
and [deployment](DEPLOY.md). Optional Compose configuration is not migration
approval. The generic release-schema command intentionally refuses.

This is the current feature/status inventory. Specialist guides retain their
technical contracts with updated context. Dated reports, frozen plans and
fixtures retain their original evidence. [The documentation map](docs/DOCUMENTATION-MAP.md)
classifies every tracked Markdown file; an old checkpoint is not today's status.
