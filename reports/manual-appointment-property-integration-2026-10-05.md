# Manual appointment property selection — integration evidence

October 5, 2026. Bounded follow-on to PR22/main `6cbf0ae`, whose candidate and
exact-main PostgreSQL16 CI gates are complete. This slice uses the separately
frozen contract and operator guide in this directory. Root owns release; three
coordinated lanes implemented runtime/UI and independently reviewed the result.

## Implemented

- New native appointments offer an optional, paged customer-property choice.
  The default is explicitly null, including for a one-property customer. Customer
  or lead changes clear the choice; stale pages and changed membership cannot
  preserve or submit an old choice. Unchanged profile polling preserves drafts.
- The shared picker retains its service wording by default and adds accessible
  appointment-specific text. Historical edits do not receive a property field
  or rewrite old notes. Unmounted form mutation callbacks do not affect new scope.
- Native creation share-locks the selected lead, customer and sorted property
  parents through appointment/reminder insertion. New work rejects contradictory
  lead/property ancestry; unchanged historical edits keep their earlier semantics.
  All callers retain company schedule locking, capacity/resource checks, versions
  and the existing native reminder writer. No alternate booking path was added.
- OpenAPI and generated create validation accept explicit null for propertyId;
  this aligns with the already-nullable database. No table or migration change:
  130 tables and the reviewed-only delta0014 remain unchanged.

## Pre-commit verification

- Runtime: nine focused files, **120 passed / 6 PostgreSQL-only skips** using the
  isolated PGlite harness. Two new files contain 10 ordinary passes and two real
  PG-only barriers. These are subsets of the nine-file result, not added totals.
- UI: full command-center suite **795/795 across 104 files**, including 20 new
  property-flow cases. Focused appointment/picker and service/workday/accessibility
  selections also passed. Independent companion review found no concrete blocker.
- Final workspace typecheck passed. UI and API production builds passed; the
  existing large-bundle warning remains. Codegen ran twice with stable generated
  content; its unrelated extra trailing blank line was excluded from the change.
- Synthetic compatible recovery passed: 90-to-130-table restore, 47 SELECT-only
  app probes, unchanged source/restored fingerprint, zero provider calls. This
  pre-commit run reports base6cbf0ae with candidateCommitted=false and is not
  exact-commit or managed-backup proof. Fresh pinned evidence belongs in the
  private release receipt after the candidate is committed.
- Built UI in a disposable, held, credential-isolated loopback runtime: at390px,
  chose the 27th/later-page property for a service-only fictional customer, saved
  one new native appointment with notes, then opened its canonical workspace card
  and exact native appointment at1280px. The property and times persisted; no
  horizontal overflow at either width and no browser warning/error logs. Screenshots
  and synthetic record IDs are retained privately. Browser date entry initially
  left an empty native control; inspection and native date entry resolved it
  before the single successful save. No application change or duplicate save.

## Required release proof still pending at this commit

Local PGlite is not proof of independent PostgreSQL concurrency. Both new actual
writer-barrier cases must execute on PG16, including creator-first locks through
reminder insertion and writer-first reassignment followed by rejection without
a visit or reminder. A fresh owned local PG16 check is supplemental; full reviewed
candidate GitHub CI and exact merged-main CI remain mandatory. The private receipt
records actual candidate/tree/run identities and final counts without self-referential
commit edits. Do not report a pending check as passed from this document.

No production deployment, hosted schema/credential action, provider activation,
real messages/imports, spending/payments or subscription cancellation. This slice
does not complete the fixed launch checklist or either contractor replacement
card. Actual contractor equipment/checklist/workday and migration inputs remain
required; no requirements were invented. The unrelated workspace backup and all
original Docker fixtures/backups remain preserved.
