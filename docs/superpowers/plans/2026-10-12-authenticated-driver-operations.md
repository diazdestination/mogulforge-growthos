# Authenticated Fly driver and read-only preparation

This dependent tooling branch keeps application candidate PR44/8df64dc, PR45's
verifier, PR46's operator and all 19 SQL inputs unchanged. It supplies explicit
private login, owned loopback SQL transport, source observations, independently
measured native policy additions and Windows-protected local admission.

Run source tests with `pnpm --dir scripts test` and `pnpm typecheck`.
Run the owned synthetic PostgreSQL rehearsal with:

    node scripts/production75-live-local.mjs --run-local

Only its PASS receipt and matching current module hashes admit its oracle.
Proxy/process ownership and approval decryption are synthetic in that fixture;
real PostgreSQL SQL, rollback, fingerprints and socket cleanup are exercised.
The fixture includes normal, lost-COMMIT connection/reply and idle Reader errors.
No provider authentication, provider extension binary or real approval proof is
claimed by the local result.

The Windows-only read-only preparation command is explicit:

    node scripts/production75-live-runner.mjs prepare <absolute-oracle-directory> <new-absolute-output-directory>

It verifies diazdestination@gmail.com / adam-diaz, both protected stopped apps,
source kzpwm0j18eg04nv3, a completed fresh backup and all three original databases.
The source is connected with default_transaction_read_only and each capture uses
a repeatable-read read-only transaction. Receipts contain metadata/fingerprints,
never customer rows, passwords, tokens or credential stores. The full preparation
packet stays private locally. Every source session and owned private proxy closes.
The configured CLI token bundle stays in memory; there is no global agent stop.

Paid execution remains a separate action:

    node scripts/production75-live-runner.mjs execute <absolute-packet-directory> <absolute-owner-dpapi-file> <absolute-review-dpapi-file>

Execution refuses absent or altered attestations and unresolved applicable pricing
before provider access. The existing custody journal binds one copy, deadlines,
source/profile/module hashes and the maximum cost. No approval-issuing CLI exists.
A trusted local operator must record exact direct human priced approval and an
independent capability review before protecting their separate attestations with
CurrentUser DPAPI and the exact purpose/plan entropy. This proves custody of a
trusted local attestation, not a human digital signature or an adversarial
same-Windows-user security boundary. Recovery after an ambiguous create can still
require owner action; no unknown creation or SQL transaction is replayed.

Expected Reader rights are proposed before creation and accepted only by the
operator's exact measured delta. The inherited PUBLIC maintenance/TEMP and
callable-function scope is explicit; no cluster-wide zero-DDL assertion is made.
Future policies come from the local oracle, never exploratory hosted DDL.
Production/source SQL writes, app starts, migrations, provider activation,
credential rotation, merge, deployment and public launch are separate decisions.
All 20 contractor gaps and each business's replacement acceptance stay open.
