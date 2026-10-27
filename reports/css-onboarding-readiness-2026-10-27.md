# CSS onboarding readiness — October 27, 2026

**NOT READY for real onboarding or Housecall Pro replacement.** This is a current
readiness checkpoint, not a launch approval. Keep one isolated organization per
company and retain the complete workday acceptance requirement.

## Verified this session

- Source base: GitHub main `f0d74ab4ab2db756637cf3b4ad306b33982c9688`, freshly fetched
  under the expected GitHub identity. Isolated branch:
  `agent/css-onboarding-readiness-20261027`.
- Fly CLI identity matched the account map. Production machine `d8de506c72d608`
  in `iad` was initially **stopped**, then **started** at final readback. Its
  events report `source=proxy` at `2026-10-27T07:58:35.892Z`; autostart is true.
  The image tag matches the October 23 rollback receipt, but the originating
  request and current health are unverified. This is not database-content,
  private readiness or full rollback proof. No app request, proxy,
  start/stop, database mutation or provider activation was issued.
- Windows Time remained stopped/manual. Three samples each from Microsoft and
  Cloudflare NTP measured the local clock approximately **12.65 seconds slow**.
  Clock synchronization is not verified. This does not retrospectively prove
  why the October 23 log frames were rejected.
- Exact-main check-runs returned no checks; the latest main CI listed was an
  older SHA (`7091af8`). No fresh exact-main CI pass is claimed or paid CI run
  started. Draft PR publication does not clear CI.
- Customer-import regression: four failing cases reproduced superseded file
  reads overwriting a newer selection or reporting stale failures. A selection
  generation now ignores stale success/error/abort results, including when a
  replacement is rejected. All 26 focused import/CSV/invitation tests pass.
- All 211 selected acceptance-guard and synthetic onboarding-seeder tests pass.
  These are local tooling tests, not actual hosted workday executions.
- Library builds and Command Center typecheck pass. The first package-only
  typecheck failed because dependency declaration builds were absent in this
  fresh worktree; both original and corrected receipts are retained.
- Command Center production build passes. Browser Harness exercised the actual
  import component with synthetic local API results: upload, preview, disabled
  import before review, explicit review, then completion. At 390px the rendered
  page had no horizontal overflow. This fixture has no backend/provider
  connection and does not prove hosted import or actual iPhone acceptance.
  Recordings and telemetry were off. A background-tab screenshot timed out;
  activating the owned fixture tab restored rendering and the screenshot passed.

Private receipts: `C:/Forge/artifacts/growthos-css-onboarding-20261027/`.

## Required work and evidence

| Area | Existing evidence / limit | Required before CSS acceptance |
| --- | --- | --- |
| Runtime and recovery | October 23 cutover rolled back; machine now started by proxy, health unverified | Repair and verify clock, reconcile current runtime and retained V2 data, obtain a fresh scoped cutover decision after reviewing the concrete plan, then exact-release readiness, logs, recovery and browser proof |
| Client setup and staff | Onboarding UI and invitation outcome tests exist | Verify actual organization, office/field identities, roles, sender and phone routing; actual sign-in and iPhone acceptance |
| History migration | Housecall customer import previews contact data; this does not transfer the entire account | Approved export inventory, contacts/properties, completed jobs and original values, open work/balances, equipment, documents/photos and reconciliation with the source |
| Scheduling | Saved scheduling and conflict tooling exists | Confirm company time zone/hours and actual crew/helper availability; verify recorded diagnostic/maintenance/travel requirements against real office and field work |
| Quotes and customer care | Local source and dated synthetic cases only | Signed approval; three text+email follow-ups 24 hours apart, response/acceptance/decline/opt-out stops and staff-call handoff; customer correction form; confirmation and on-the-way behavior |
| Invoices and reports | Invoice equipment/warranty snapshot source exists | Office review for multi-repair work, actual document/report/photo delivery, preserved warranty evidence and accurate balances |
| Payment collection | October 9 owner direction restored engineering scope; no processor acceptance established | Select supported provider and merchant arrangement, prepare deposit/progress-payment/refund reconciliation and financing path, test without real charges, then separately authorize activation; do not infer surcharge or payout terms |
| Maintenance and warranty | Source supports service records and recurrence | Residential/commercial cadence, annual plan terms, approximately one-month notice, any major-service due-date changes, actual warranty sources and failure/stop cases |
| Website / phone / email | Separate source and provider gates | Correct-company intake, both required recipients, approved after-hours policy, inbox/handset receipt and replies, opt-out, failure ownership and recovery |
| Company sign-off | CSS workday card remains NOT ACCEPTED | Office/field representatives and company owner complete required workflows with dated evidence and accept migration/cutover; no silent manual substitute |

## Scope reconciliation

The private October 9 CSS intake supersedes October 2 payment deferral. Earlier
acceptance packets incorrectly carried `OWNER-DEFERRED` into G-01. The dated
corrections in AGENTS, P0, the replacement gate and acceptance packet restore
the requirement without inventing implementation, selecting a provider or
changing historical run results. Names/contact details stay in private intake.
Do not silently broaden this CSS correction to another company's acceptance.

## Next execution order

1. Finish source review and preserve the local regression evidence in a draft PR.
2. Complete the prepared Windows Time repair review and owner administrator/UAC
   step, then independently verify service state and offset. No time-zone change
   or manual date setting; no GrowthOS action is bundled with clock repair.
3. Reconcile the October 23 retained V2/TEST state and prepare a fresh bounded
   hosted plan. The consumed one-more-run approval cannot be replayed. Preserve
   all old run intents, evidence and databases.
4. Resolve provider/merchant and source-export inputs from existing authorized
   records; close required implementation gaps and test them locally.
5. Execute authorized hosted/provider/device checks, full migration reconciliation
   and the complete CSS workday card before a real switch.

No merge, deployment, financial action, customer message or public launch is
part of this checkpoint. The source repair removes one onboarding risk; it does
not establish client readiness.
