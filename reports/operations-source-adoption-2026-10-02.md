# Reviewed source adoption and one-touch email

Engineering evidence for the October 2 contractor operations wave. This is
synthetic, provider-free implementation evidence, not customer cutover, consent
verification, a deployed migration, or authorization to contact customers.

## Delivered workflow

The Reactivation page now contains a separate **Reviewed source cutover & recovery
email** panel. An active, accepted, email-verified company owner/admin can:

1. Inspect an imported opportunity and its original history, source identity,
   current contact and operational state.
2. Prepare and approve an exact, actor-bound management decision documenting
   source reconciliation, the completed cutover, and cessation of the old sender.
   This approval does not change import provenance or grant contact permission.
3. Separately record or withdraw staff-attested customer permission for marketing
   email to the current exact address. Generic email consent, an import, a prior
   purchase or a source-management decision is not substituted for this evidence.
4. Select up to ten eligible opportunities, supply an approved business mailing
   address and exact copy, and choose campaign days, hours, expiry and a cap.
   Every complete plain-text email, recipient, selected mailbox, disclosure and
   signed unsubscribe link is displayed before approval.
5. Approve the frozen campaign, then use a separate explicit send action. Approval
   never starts a worker. Review saved status after an uncertain HTTP response.

There is no autonomous enrollment, generic playbook exemption, SMS campaign,
fallback sender or automatic retry. The existing `revenue.autopilot` entitlement
applies. Regular contact and company sending controls continue to apply.

## Persistence and integration

`lib/db/src/schema/source-adoption.ts` adds three tenant-bound tables:

- `source_adoptions`: the current versioned decision, complete original imported
  history, source/operational digests, exact contact/address, actor, evidence and
  validity. Approval/revocation audits retain the prior complete decisions.
- `source_outreach_batches`: immutable reviewed settings, exact cohort digest,
  versioned approval/revocation, short review expiry and campaign expiry.
- `source_outreach_items`: frozen decision/version/digest, recipient, independent
  permission record, mailbox identity and exact final message for each item.

Composite tenant foreign keys bind the lead, contact, decision, batch and staff.
Partial unique reservations on company/opportunity and company/address prevent
another batch or revision from reclaiming a touch. Shared source-import and
source-outreach advisory locks serialize decisions and claims. Schema activation,
export/offboarding/recovery integration and generated API contracts are owned by
the coordinator, not performed by this lane.

`send-gate.ts` accepts a narrow server-resolved `sourceOutreachItemId` only for
email with an explicit lead. It resolves an approved, unexpired, exact digest and
active source decision from the database. Ordinary playbooks omit the field and
retain the imported-source hold. No public boolean bypass was added.

Routes are in `routes/v1/source-adoption.ts`, mounted by the coordinator:

- `GET /source-adoption`, `GET /source-adoption/leads/:id`, and
  `GET /source-adoption/outreach/:id` provide permission-scoped reads.
- `POST /source-adoption/leads/:id/preview`, `/approve`, `/revoke`, and
  `/email-permission` provide owner/admin decisions.
- `POST /source-adoption/outreach/preview` and
  `/source-adoption/outreach/:id/approve`, `/revoke`, `/send` provide campaign work.

Only the index permits query parameters: `page` and `campaignPage` are decimal
integers from 0 through 100000, defaulting to zero. The response includes numeric
`page`/`campaignPage` and boolean `hasMore`/`hasMoreCampaigns`. Stable pages contain
up to 100 opportunities and 25 campaigns; the panel exposes older records and
retains its selected cohort across pages. Other selectors, unknown body fields,
API keys, foreign origins, unverified or `invite:` staff identities, wrong roles,
and foreign references fail closed. Responses are non-cacheable.

## Dispatch and retention guarantees

Current approval, digest, imported and operational data, exact recipient,
permission, opt-out/suppression, contact-wide reply holds, sender identity,
company/environment holds, entitlement, hours and expiry are rechecked at
approval/claim and immediately before the provider boundary, after credential
preparation. A reply hold applies even when the incoming reply has no resolved
opportunity. The final callback also requires current ownership of the same
unexpired processing receipt and exact payload fingerprint.

The initial limits are ten recipients per campaign, a maximum of 25 newly
reserved company touches in a rolling 24 hours (or a lower chosen cap), and one
touch per company/address and opportunity for the lifetime of this initial
workflow. The source decision expires within 30 days; a campaign within 24 hours
and no later than its source decisions; exact approval previews expire in ten
minutes. Stricter existing company limits still win.

Each item reserves its permanent slot before `runDurableAction`, using the fixed
logical key `source-outreach:<leadId>:email`. A crash between reservation and
receipt creation is explicitly uncertain, not unsent. A known final-dispatch
block is held with its slot retained. Unknown provider effects remain
indeterminate. Reconciliation, a different request, re-adoption, another batch,
or a new revision cannot rearm any of those slots. This conservative initial
policy deliberately has no resend endpoint, including held-after-claim sends.

Gmail/Microsoft use the existing guarded customer-email transport. Acceptance
records one signed canonical `email_sent` response parent. The additional
`automation_message_sent` entry contains only cap/count context, not a duplicate
provider parent. Provider acceptance is displayed separately from delivery;
`deliveryConfirmed` is always false here. Nothing claims revenue, a reply, money
movement or verified settlement.

## Verification

Provider-free disposable runner:

```text
node artifacts/api-server/scripts/test-scheduler-isolated.mjs src/services/source-adoption.test.ts src/routes/v1/source-adoption.test.ts src/services/send-source-history.test.ts src/services/playbook-source-hold.test.ts
```

Result: **42 passed, 1 PostgreSQL-only concurrency test skipped**, four files.
Coverage includes exact preview/approval/send for Gmail and Microsoft, tenant/
role/session controls, unchanged provenance, independent permission, stale data,
expiry, suppression, contact-only reply holds, revocation during credential
preparation, changed sender/recipient, company/global holds, durable ownership,
reserved-slot crash, unknown effects, cloned-batch/new-key denial, caps, and
preservation of generic imported-source holds. The real PostgreSQL concurrency
case remains for integrated CI; PGlite is not claimed as that evidence.

```text
pnpm --filter @workspace/command-center exec vitest run src/components/source-adoption-panel.test.tsx src/accessible-names.test.tsx
```

Result: **23 passed**, two files. This covers unchecked human confirmations,
independent permission, exact safe text rendering, explicit campaign days,
read-only roles, uncertain acknowledgment/status check, unavailable-versus-empty,
and malformed successful index responses failing closed rather than crashing.
Both API and command-center `tsc --noEmit` passed after these changes.

### Full-suite PGlite limitation investigated separately

The coordinator's attempted full API run timed out first in
`automation-dnc.test.ts`. Running only that unchanged file through the fresh
disposable runner reproduced four 20-second test timeouts and the ten-second
cleanup-hook timeout (91.53 seconds total). This was not attributed to test
contamination without investigation.

The existing `ensureDefaultPlaybook` opens a database transaction, then awaits
`isLegacyDefaultOrg`, which reads through the global pool instead of that
transaction. Those same blocks are present in base `602131d`. A separate bounded
in-memory PGlite/socket probe demonstrated that a second pooled query remains
blocked while the first connection owns a transaction and completes immediately
after its COMMIT. The installed socket package documents its single-backend
multiplexer, which is not independent PostgreSQL sessions. New-organization DNC
tests enter this cold-cache seeding path before the sending gate; subsequent
queries and cleanup queue behind the stalled transaction.

No production code, DNC assertions, timeout, skip or database setting was changed
to obtain a pass. Both diagnostic processes exited and their disposable database
resources closed. This explains the local PGlite limitation; it is not a passing
full-suite result or a substitute for the required real PostgreSQL CI run.

### Built loopback preview index investigation

During final browser QA of the built `--operations` preview after `9084608`, the
source panel displayed its unavailable state. Against that same running preview,
a fresh fictional local session received a 200 index with the expected one
fictional imported opportunity and empty campaigns. Three sequential index reads
passed the panel's exact Zod response schema. Sequential reads of source index,
reactivation segments, campaigns and lead imports all returned the expected
status/shape; three rounds of the same four requests concurrently also returned
200 and correct shapes (twelve concurrent responses). No session tokens were
printed or retained.

The coordinator subsequently confirmed that the panel's explicit Retry loaded
the expected index. These bounded checks did not reproduce a source-route/schema
defect or prove a particular PGlite result-corruption mechanism. No source guard,
auth/database semantics, timeout, retry policy or preview harness was changed to
hide the failure. The shared preview was not restarted by this lane. This is
loopback synthetic evidence only, not hosted-browser or PostgreSQL concurrency
acceptance.

Independent cross-review found duplicate signed outbound-parent activities;
the regression first failed with `needs_review` and no linked lead/hold. After
removing provider-parent metadata from the cap-only activity, an actual accepted
source email followed by `registerEmailResponse` now yields one confirmed parent,
the canonical lead and an active contact hold. A second review finding led to
the 101-opportunity/26-campaign pagination regression and visible navigation.

## Remaining acceptance and deliberately unsupported cases

No real import, send, provider connection, credentials, hosted schema, deployment,
source cancellation or customer activation was performed. Full integrated CI,
PostgreSQL concurrency, final mobile browser inspection and staging/recovery
acceptance belong to the coordinator's release gates.

Each contractor must supply its actual reconciled source export and stable source
IDs, a named cutover approver, current source status/replies, proof the old sender
has stopped, separate customer email-marketing permission evidence, eligible
connected mailbox, approved business identity/address, and campaign copy/window.
Staff attestations are not independent verification of legal or provider consent.
Suppressed or replied contacts must be reconciled through their existing guarded
workflow; this panel does not clear holds. Azure first sign-in remains deferred.

This is a deliberately bounded, individually reviewed recovery-email workflow,
not a general marketing platform or evidence that either contractor can yet
cancel Housecall Pro. Wider campaigns, repeated nurture, verified delivery,
arbitrary historical-source adapters, and changes to retention/resend policy
require separate design and acceptance.
