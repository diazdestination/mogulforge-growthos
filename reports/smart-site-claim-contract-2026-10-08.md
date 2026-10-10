# Smart Site inquiry ownership: October 8 source contract

Adam asked WILLOWFORGE to help close current GrowthOS production gaps. Fresh
GitHub inspection found main `2162aa296281473dda170291ff95d64e0e6e9b79` green in
CI `37500458053`; the October 1 local candidate/gap entries are historical.
Work branch: `agent/growthos-production-gaps-20261008` from that main.

## Bounded L9 outcome

A notification already opens the exact native `/leads/:id` page. An accepted,
verified responder must be able to see and claim that inquiry there, including
when it is outside Capture's first 25 waiting rows. Two owners may be alerted;
only one initial claim commits. Adam's Painless policy is alert Ryan and Jesse,
then one claims; actual tenant/recipient/phone activation is separate.

Keep canonical lead assignment, the existing first-response task and audit.
Do not add a second ownership record, notification channel, schema, automatic
assignment, customer send, imported lead, provider setup or deployment.

## Runtime contract and ownership

Runtime lane owns `services/smart-site-followup.ts`, its tests,
`routes/v1/smart-sites.ts` and dedicated route tests. Root owns the UI, this
contract, integration, current release records and Git/CI. Independent review
must inspect final authority, conflict and failure behavior. Shared edits are
preserved; lanes do not edit files outside their ownership without agreement.

- Recheck accepted, verified, active, same-company actor and target with
  `crm.write` in the final assignment/attempt transaction, with membership rows
  protected through commit. Pending invitations are not responders.
- Preserve the existing lead lock, expected-owner comparison, atomic task
  assignment, attempt idempotency and audit. A stale claim returns conflict.
- Protect staff owner/attempt mutations against cross-origin requests,
  cross-site/same-site Fetch Metadata, non-JSON input and API keys including
  empty key headers. Preserve authorized same-origin browser operation.
- Exclude ineligible members from Capture's owner choices.
- Add `GET /smart-sites/leads/:id/follow-up` with tenant-scoped `crm.read`,
  no-store and strict ID handling. Return only `organizationId`, `leadId`,
  `siteName`, `status`, `assignedUserId`, `ownerName`, `ownerEligible`,
  `receivedAt`, `dueAt`, `firstAttemptAt`, `canClaim`, `serverNow`. No contact,
  message, credential or device payload. An ordinary or inaccessible lead is
  404. An eligible reader's `canClaim` requires current write authority, a
  nonterminal inquiry and no current owner. The lookup has no queue cap.

## Experience contract

Root adds a compact native lead-page ownership panel using this exact read.
It verifies the returned company/lead identity, displays current ownership and
offers Claim inquiry only from a fresh eligible response. The mutation always
sends `expectedOwnerId: null`; it cannot reassign another person's inquiry.
No optimistic ownership claim. Preserve an acknowledged claim if a later
refresh fails; require a fresh read after ambiguous failure or conflict.
Disable writes during requests, stale/error states and member/tenant changes.
404 hides this Smart Site-only panel; other read errors are visible and
retryable. Read-only staff may view ownership but cannot claim.

## Verification and evidence

Required: accepted-staff/API-key/origin/JSON negatives, two-owner conflict,
membership changes across lock waits, exact lookup beyond 25 and tenant
isolation, UI read/claim/conflict/ambiguous-save/refresh-failure/access-change
cases, desktop/mobile keyboard/overflow checks, workspace types/builds and
fresh full PostgreSQL CI. Local synthetic evidence is not hosted or provider
acceptance. No schema migration is introduced.

Current read-only hosted observations: the public application readiness path
returned HTTP 404; the staging readiness request timed out after 20 seconds.
Neither establishes deployed release identity or a working intake. Actual
dual alert receipt, phones, accepted owner access, hosting/recovery, source
migration and both contractor workday cards remain open.

## Separate release-safety repair in this candidate

Independent inspection reproduced an unsafe existing default: the generic
Fly release command bypasses its staging guard for production/unknown identity,
then invokes `drizzle-kit push --force`. An old test explicitly permits this.
The release lane owns `scripts/release-schema.mjs`, its tests, `Dockerfile` and
a release-safety operator note. Refuse generic forced reconciliation for hosted
and unknown targets, including a lone approval environment flag; no new broad
production bypass. Retire that generic hosted mutation entry point; an
unrecognized or missing identity must fail before child/database access. The existing Docker
parity schema service provisions only its own database directly and is unchanged.
Keep database-error detection for existing isolated test callers. Document that
hosted rollout still needs its exact reviewed SQL/backup/target procedure; this
repair does not implement or authorize that rollout. Pin Docker dependency
installation to the committed lockfile so the tested source builds reproducibly.
The lane also owns `artifacts/api-server/build-identity.mjs` and its dedicated
tests: a Git command failure inside a known checkout cannot fall back to a
supplied SHA as though `.git` were absent. Keep legitimate explicit Docker
build-context identity behavior. Test these failures and complete full CI.

### Same-risk startup follow-up

During integration, root found the optional `AUTO_MIGRATE` startup path still
invoked forced schema push directly, and `.env.example` recommended it. Extend
the release lane to `lib/auto-migrate.ts`, its focused tests, the startup comment
and example-environment guidance. Disabled startup remains a no-op; enabled
spellings must refuse with a fixed message before database/child access. Preserve
restore-only startup and isolated explicit CI provisioning. No fallback flag or
new migration executor. Finish the in-progress first CI before pushing this
follow-up, then require a fresh full exact-head run for the complete candidate.
