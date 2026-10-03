# Tracked lead replies — integration evidence

October 2, 2026. First of the owner's two requested waves. Branch
`agent/growthos-lead-replies-20261002`, based on launch-communications main
`c2d999b0c32e349e3f70cf6c642782d1c603b582` and green exact-main CI37085822984.
The second authorized wave is invoice delivery exceptions and reviewed recovery.
This is engineering, not deployment, provider activation or contractor cutover.

## What the office can do

- In Account, separately acknowledge lead-reply monitoring on an already active
  owned Microsoft reader. This does not change Graph scopes, reconnect/crawl the
  mailbox, broaden existing service permission or silently adopt old messages.
- In Revenue Desk or BIE, prepare an email's exact saved recipient, selected
  sender and message before approval. Eligible explicitly opted-in Microsoft
  sends reserve an immutable original-mailbox parent. Older approved sends,
  Gmail, general compose and bulk campaigns are not newly labelled tracked.
- Open the lead's Messages section to see its observed reply, responsible office
  worker or visible unassigned state, linked task and paused/canceled effects.
  A retained reply hold outranks generic follow-up recommendations and cannot
  be dismissed into another outbound suggestion.
- Handle the exact version with a staff note. This closes only its linked task
  and reply hold; it sends nothing, grants no consent, creates no booking and
  never resumes canceled work or releases unknown external-effect reservations.
  Already-observed work remains handleable after reader revocation, without
  accessing or reconnecting the mailbox.

The underlying email is untrusted data, not agent instructions. Raw content is
encrypted, escaped in the UI and expires after seven days. Read endpoints make
no purge writes; a separate bounded scheduler stage removes only expired text.
Identity, hash, deduplication, hold, task and review evidence survive that purge.

## Integration and verification

Read the kernel, dispatch and connector/UI lane reports beside this report for
their scoped commands and edge-case results. Coordinator and lane checks:

- Shared OpenAPI/client generation and complete workspace types passed.
- API and Command Center production builds passed; existing large-bundle warning
  is unchanged in character and is not hidden as an error-free performance claim.
- Isolated service-mailbox/inventory/scheduler regression: 85 passed, one explicit
  independent-PostgreSQL concurrency case deferred to full CI, four files.
- Existing canonical reply/lifecycle/export regression: 52 passed, three
  independent-PostgreSQL cases deferred to full CI, four files.
- Next-best-action regression: 12 passed, including retained hold, no draft,
  no snooze fallthrough and explicit hold-resolution behavior.
- Full scripts run initially exposed two historical crash-manifest failures
  because the current task schema gained a tenant key. The test-only fixture was
  recovered verbatim from its pinned c050067 Git object. The original release,
  manifest hashes and hosted readers were not changed. All 20 focused crash
  tests then passed, including rejection of the changed current source.
- Full scripts: 18 files, 229 tests passed. Reusable website adapter: 26 passed.
- Full Command Center: 88 files, 558 tests passed after the final UI changes.
- Connector/Graph/actual HTTP: 44 passed. Lead kernel/actual BIE-through-mailbox
  integration/HTTP: 31 passed, two independent-PostgreSQL cases await CI.
- Provider-free browser: the canonical lead deep link selected Messages, showed
  expired content with retained hold/task and the review-first recommendation.
  Explicit office handling succeeded with the reader disconnected, marked only
  that task done, cleared that hold and refreshed the recommendation. The saved
  note and uncertain-work warning remained. No send or automatic restart occurred.

These are provider-free local results. Exact candidate and merged-main PostgreSQL
CI and any additional release evidence are recorded below when
completed; the base release's CI does not attest this working tree.

## Schema and synthetic recovery

`node scripts/lead-replies-schema-preview.mjs` generates reviewed-only `0010`
after `0009` against the exact base above: 25 statements, no new tables, still
117 total. Only legacy source_id becomes nullable, governed by the new explicit
legacy-source XOR exact mailbox provenance CHECK and composite tenant/parent,
lead/contact/connector/task keys. No row deletion, data rewrite or generic DROP
allowance is introduced. Lead-context permission defaults off.

The first compatible drill upgraded the complete 90-table historical fixture
through all reviewed deltas to117, restored both fictional companies and booted
the real application under a SELECT-only role. All117 table fingerprints matched,
25 actual read routes passed, and six additional cross-tenant writes were rejected.
Purged typed reply holds, linked open tasks, disabled readers and uncertain sends
survived. External provider calls: zero. First source/restored fingerprint:
`fd9f6becdd8c397e3edf3ef660a24022eec537bda6b2e27390eb6b39d4d3741a`.
Snapshot SHA-256:
`7a441dbc77c22d0cc493ec4cced6bacdb93acade888552911d3f64bbea5b779f`.
This is not managed backup acceptance, production RPO/RTO or a hosted migration.

Latest repeated drill after integration also passed all 25 reads and tenant
negatives. Source/restored fingerprint:
`97d2823033811faf747b62e7badce91363d3dae5c48b68c5c821c5a2bb6d8640`.
Snapshot SHA-256:
`8ba9fcd7ce64f9be38b553dd5084efd678110696a3393edab55ec3ab9fb37187`.

The inventory remains117 tables; core export still explicitly excludes raw mail,
reader permissions, mailbox/provider identities and communication security
receipts. Canonical office tasks are exported without raw email content.

## Local preview and release boundaries

Build the UI, then run
`node artifacts/api-server/scripts/preview-runtime-isolated.mjs --lead-replies`.
The runner owns a fresh disposable loopback database, fictional users and
provider-free environment. Its printed test login is not a real credential.
The new fixture has an expired reply, active hold and office task with a disabled
reader. Do not substitute a hosted DATABASE_URL or enable a provider for this QA.

Microsoft production authorization/receipt/reply/continuity, Gmail typed intake,
general-inbox behavior and other untracked outbound contexts remain unaccepted.
Azure first sign-in, separately pending held-staging upgrade/admin rotation,
Twilio/device checks, actual source reconciliation and both complete contractor
replacement cards remain gates. Contractor payment collection stays deferred.
No live message, hosted schema/credential change, deployment or purchase occurred.
