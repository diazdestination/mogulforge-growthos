# Staging upgrade preparation, October 10

Adam authorized continuing the migration rehearsal and permission review after
the database backup and separate secret-recovery proofs passed. This engineering
slice prepares a new 95-to-142 migration core and local execution evidence. It
does not consume or replay either completed temporary-resource grant.

Application source remains main7091af8; observer baseline is draft PR33/72b9166.
Work continues on agent/growthos-staging-upgrade-20261010. The accepted earlier
synthetic 95-to-142 rehearsal and unchanged SQL remain evidence; new tests cover
the new executor, not a repeat of unchanged application suites.

Root owns migration core, integration, execution authority and release records.
The independent reviewer owns permission/source review. The fixture lane owns
new tests and the disposable local PostgreSQL harness. Preserve other edits.

The core is import-safe and receives an existing client; it has no credentials,
provider APIs, application imports, process execution or runnable hosted CLI.
Prepare exact canonical SQL0003-0018 and catalog95/142 from the pinned main
manifest. Refuse changed bytes, wrong identity, drifted baseline or policy.
Use one bounded transaction, SET LOCAL ROLE schema_admin, and ordered original
table locks. Require server-side original-column fingerprints, retained physical
metadata, all26 original-column default values, 47 empty new tables, unchanged
original ACLs and complete Reader/Writer table/column privilege coverage.

Persist BEGIN/step/outcome intent and acknowledgments through an injected journal
before dispatch. A lost COMMIT acknowledgment is unknown and never auto-retried.
Successful commit still requires a separate fresh Reader snapshot. Local tests
must cover refusals, late SQL failure and rollback, same-count non-key corruption,
empty original tables, exact successful upgrade, postcommit recapture and cleanup.

Hosted adapter admission remains separate: fresh account/cluster/app holds,
schema-admin role evidence, accepted provider extension policy, current baseline
and recovery point, pinned executable hashes, single-attempt durable journal,
owner's exact migration/runtime authority and independent source review.
No hosted DDL, grants, app startup, outbound traffic or new paid resource is
authorized by this preparation document.
