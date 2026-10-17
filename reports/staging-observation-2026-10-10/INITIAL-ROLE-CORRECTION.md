# Initial administrative role correction

The first managed-copy upgrade attempt stopped at `migration_identity` before
BEGIN or migration DDL. Its source, restored-copy and post-refusal Reader
snapshots matched across all 95 original table fingerprints, catalog, privileges
and ACLs. The owned copy was deleted, both original clusters remained present,
and protected provider/Machine metadata was unchanged. The failed attempt is
retained as a failure; it does not establish hosted upgrade or rollback proof.

A separate, fixed-target READ ONLY observation found the original staging
connection already using `schema_admin` as `current_user`, while `session_user`
was the expected `fly-user`. PostgreSQL version and numeric positive backend PID
also matched; the PID remained stable across the read-only transaction and its
explicit transaction-local role selection. This demonstrates an incompatibility
in the old guard, which required both initial users to be `fly-user`. The deleted
copy's failing initial row was not saved, so that row cannot be retrospectively
reconstructed from the diagnostic.

The correction admits only the two reviewed initial effective roles, `fly-user`
and `schema_admin`, while keeping the exact login, database, PostgreSQL16 and PID
checks. The transaction still explicitly selects `schema_admin`, verifies the
same backend, read-write mode and repeatable-read isolation, locks original
tables and checks the entire reviewed baseline before migration. Reader identity
admission is unchanged. Failure diagnostics retain field-check booleans instead
of raw identity values or provider errors.

No hosted role defaults, grants, application configuration or credentials are
changed. Local PostgreSQL acceptance must reproduce the observed role default,
and regression tests must reject unrelated initial roles and logins before BEGIN.
The managed-copy grant is consumed. A corrected paid-copy test requires a new
reviewed packet and owner approval; never replay the completed attempt.

Private content-free operator results, deletion proof, and the separate metadata
observation remain under `C:\Forge\artifacts\growthos-upgrade-rehearsal-20261010`.
Customer fingerprints and credential-bearing files are not part of this report.
