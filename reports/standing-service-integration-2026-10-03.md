# L5 standing service reminders — integration evidence

October 3, 2026. Owner-requested next wave, branch
`agent/growthos-standing-service-20261003`, from
`f91e1c31413a4b5307ca334c04773e3c0e5bef84` (PR19). The base candidate CI37133393339
and exact-main CI37134529680 passed; the current wave requires its own exact
candidate and explicitly dispatched main CI. This document is engineering
evidence, not hosted deployment, provider activation or contractor acceptance.

## What the office can now do

In **Warranties & Service → Customer care & booking**, an accepted owner/admin
can review an exact existing agreed service series and approve one fixed reminder
per future eligible occurrence. The decision pins the actual finite service
agreement, source/cutover review, customer/property/equipment, responsible staff,
recipient, selected sender, recurrence and sending policy. It starts disabled.
Approval does not create SMS/marketing consent or infer warranty protection.

The enrollment keeps its original root/anchor; each immutable revision adds its
reviewed occurrence cutoff. Only future notice windows qualify. No backlog sweep
or silent channel/sender substitution. Current authority is checked again before
admission and provider handoff; booked/completed services, changed details,
expiry, replies and suppressions can stop work. Provider-independent disable
retains every original receipt. Individual and standing paths share one permanent
occurrence/action identity, including pending and unknown contact allowances.

New SMS reminders retain exact parent evidence and a service routing reference.
Signed account/number/reference evidence is distinguished from ambiguous
phone-scope replies. A missing reference never guesses the newest service.
STOP/START/HELP retain precedence. The office can retain a follow-up hold, mark
actual handling complete, or dismiss genuinely unrelated evidence. None grants
consent, books a visit or rearms an original send. Encrypted text expires after
seven days; retained evidence/holds survive deletion. New referenced SMS requires
encrypted reply-storage readiness. Legacy approved SMS copy remains compatible.

Microsoft service parents accept persisted typed standing authority and retain
the original mailbox/reply relationship. Gmail sending is not monitored Gmail
reply intake. Existing customer conversation, explicit confirmed visit, actual
service completion and exactly one recurrence successor remain separate steps.
MAINTAIN continues to use canonical office tasks, not fabricated sales leads.

## Team and shared integration

Three coordinated agents own runtime, signed SMS/Microsoft intake and the existing
Service Desk experience. The coordinator owns schema/router/API projection,
lifecycle/export/recovery, independent integration review, browser QA and release.
Read the adjacent contract, operator guide and three lane reports for details.

Six API routes and eight published schemas are projected from authoritative local
contracts. Generated React/Zod clients are checked with runtime-compatible UI
fixtures. API keys cannot review authority or read the new office evidence.
Semantic member/company/role changes reset drafts; unchanged profile refreshes
preserve them. Late responses cannot replace another service's state.

Lifecycle inventory v11 explicitly covers125tables (119direct,120counted,
5excluded). The core customer export remains20datasets and explicitly excludes
these raw policy/provider/approval records; it is not a full account backup.
Four new tables are standing enrollments/revisions and SMS parents/replies.

## Reviewed schema and synthetic recovery

`node scripts/standing-service-schema-preview.mjs` generates reviewed-only
`staging-schema-preview-2026-10-01/0013_standing-service.sql` offline from the
exact base. It adds four tables and tenant/exact-parent constraints in39statements.
It opens no hosted database and rejects destructive output. SHA256:
`010c13b648a442f34801b9c30f5dde6f824cce0f897d7a98866e8f8a4a1beb39`.

`node scripts/contractor-recovery-drill.mjs` upgrades the synthetic90-table
baseline through reviewed0013 to125tables, snapshots/restores both fictional
companies, verifies matching full-table fingerprints and runs31real app GETs
using a server-enforced SELECT-only database identity. HTTP writes are rejected;
all fingerprints remain unchanged. Fourteen new FK/shape negatives roll back
without altering fixture records. Disabled authority, original unknown sends,
ambiguous evidence and purged-body holds survive. A tightly typed synthetic
paused-company exception covers only the exact restored unknown receipt; it is
not a general safety bypass. No provider calls, real records or hosted resources.

The current working-tree rehearsal passed. Final source identity and receipt
belong in the release handoff after the candidate is committed. This local proof
does not establish managed backup acceptance or production RPO/RTO.

## Local verification and known limitations

Run from the canonical private checkout with isolated synthetic providers/data:

```powershell
node scripts/standing-service-api-spec.mjs
pnpm --filter @workspace/api-spec codegen
node scripts/standing-service-schema-preview.mjs
node scripts/contractor-recovery-drill.mjs
pnpm --filter @workspace/scripts test
pnpm --filter @workspace/command-center test
pnpm run typecheck
pnpm -r --if-present run build
node --test examples/website-connection/adapter.test.mjs examples/website-connection/operations.test.mjs
```

Recorded passing local checks: operational scripts229/18files; full UI639/93files
including the parent-refresh regressions; focused shared API139/1pre-existing
PG-only skip across10files;26website adapter checks; API generation, full workspace
types and API/UI builds. Runtime and intake selections overlap: do not add their
counts together. The final runtime/intake checks cover four new independent-session
PostgreSQL races, including the real Microsoft final-claim task writer barrier;
those must run in release CI, not remain skipped. The local
full API PGlite harness has an inherited default-playbook pool deadlock; no claim
of a passing full local API suite is made. Real PostgreSQL CI is required.

Build/tooling warnings remain: pnpm legacy configuration notice, Vite plugin
esbuild/oxc notices and the existing large frontend bundle. Passing is not
warning-free. No test assertion or safety check was weakened to close the wave.

## Built-browser rehearsal

The isolated `--standing-service` preview uses fictional services, all DNC flags,
an inert shop binding, ephemeral reply encryption, no provider credentials,
outbound held and scheduler disabled. The office walkthrough verified default
off, exact SMS wrapper/reference preview, saved-but-held approval, persisted
provider-independent disable and explicit no-backlog rejection. Empty SMS
evidence remains labelled incomplete, not proof that no reply exists elsewhere.
Phone-width390/320 rendered without horizontal overflow. This is local layout
and behavior evidence, not an actual installed-phone push or provider test.

Browser QA caught a parent refresh unmount that hid the successful save notice.
The fix and four parent-level regressions passed; the built browser now retains
the successful stop result across the list refresh. The final390/320checks again
showed no horizontal overflow; temporary viewport overrides were restored.
Independent review also found the inherited Microsoft reply mutation could erase
a staff plan. Intake now leaves task fields unchanged; actual standing Microsoft
in-progress/completed-task reply tests pass. The final mailbox/care/watch selection
passed115tests/5existingPG-onlyskips across9files, overlapping earlier selections.
The monitor now publishes its checkpoint under the shared lock only when the
observed latest revision and checkpoint still match, so old work cannot postpone
a fresh approval or overwrite another worker's result. SMS/Microsoft final parent
claims explicitly lock the staff task row; ordinary readiness, reservation and
historical/GET reads remain unlocked. Deterministic checkpoint and real generic
task-close regressions pass. Final standing/care/HTTP/scheduler selection:
73passed/4PG-onlyskips, including27standing passes. The additional real PostgreSQL
final-claim writer-barrier test belongs to the exact release CI gate. The final
Microsoft/SMS/care selection passed87tests/3PG-onlyskips across6files; the actual
standing Microsoft file passed7tests with its one PG barrier skipped locally.
Committed task closure and reassignment during synthetic OAuth both block the
provider POST. The PG barrier calls the real authority guard and uses an
independent database session to prove the generic task writer waits until the
final parent claim commits. Source is frozen for the exact candidate release.

## Release and remaining launch gates

Finish exact candidate PostgreSQL CI, all suites/types/builds/Docker, then merge
the approved source and explicitly dispatch CI on the exact main SHA (the workflow
has no push trigger). A green source release is not production-live.

The fixed checklist still needs bounded ongoing lead nurture (L6), necessary
unified customer workday/history (L7), actual approved migration layouts/cutover
(L8), and unresolved required L1/L4 capabilities. Hosted current-release schema,
staging/backup/admin-rotation acceptance, actual selected email/Twilio/device/site
proof, pricing/onboarding acceptance and both complete company replacement cards
remain separate gates. Azure first sign-in remains owner-return. Payment
collection is deferred. No deployment, provider change, customer contact, new
cluster, credentials/DNS mutation, spending or old-subscription cancellation.
