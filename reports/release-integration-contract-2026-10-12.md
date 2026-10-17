# GrowthOS release integration contract

Adam requested continued GrowthOS progress on October 12, 2026 after the current
status review. This milestone integrates the prepared launch improvements and
creates one tested, inspectable release candidate. It preserves the complete
client requirements and existing source/recovery evidence.

Canonical repository: diazdestination/mogulforge-growthos, GitHub ID1324860199.
Canonical main:7091af816715cfd437925eb0af82fb47d3411e34.
Existing isolated workspace:C:\Forge\worktrees\growthos-db-recovery-20261010.
Integration branch:agent/growthos-release-integration-20261012.
Starting head:87adc3eb21599e84aedcf3a9719b9e996f84f8e0 (PR35, includes33/34).

## Selected source

- PR39 accessibility:677f23ebc29d9b4e596b8459f30b139709966e54.
- PR40 acceptance documentation:01dc4bb19b2d59572e0771b70028a6bbb3ac2ca1.
- PR41 isolated provider-test fixtures:750e6031da8336fae5e74b6e74e87bdc6e0091ae.
- PR42 invoice equipment and recorded warranty:6664df1f4b0a4cfbcafe480b68c8f878fab1c8a5.
- PR43 customer onboarding import:5937fbc403c6f6d59c44b9bb690689bf9c6c04e2.

All five exact heads had passing CI when selected. Combined-source acceptance
must be new; separate green branches do not establish the combined result.
The invoice and import changes use existing JSONB/schema and add no migration.
Existing source remains142 tables. Verify all19 reviewed SQL-source hashes and
the schema definition against the starting head after integration.

Independent review reproduced three necessary corrections within this milestone:
reject malformed CSV and invalid/unbounded mapped addresses before saving contacts;
render recorded warranty source even when dates were not recorded; and preserve
every preexisting provider-owned metadata object in the75-core comparison.
These require failing regressions, minimal corrections and renewed independent
review. The metadata fix changes the mechanism hash, so its earlier native proof
remains historical and new native verification must run. No hosted authority is
expanded. The CSV worker owns CSV fixes; root owns the invoice render/tests;
the mechanism worker owns only75-core/local proof/tests and its design note.

Invoice equipment stays tenant/customer/property scoped, uses only active assets,
and freezes recorded terms in issued document fingerprints. It does not assert
provider warranty eligibility. Legacy invoices retain their original fingerprints.
Housecall customer import creates contacts with import provenance and no leads or
nurture activity. Preview rolls back. Missing real exports, full job/estimate/
invoice history, provider delivery, payments and contractor acceptance remain
explicit gaps; no fictional business facts or consent are introduced.

## Boundaries and ownership

Root owns merges, OpenAPI regeneration, conflict resolution, combined tests,
durable integration evidence, source push/draft PR and release preparation.
Independent reviewers own their additive review receipts only. Mechanism planning
owns a separate artifact note and makes no source/provider changes.
Preserve existing PROJECT_STATE.md edits and every untracked historical receipt.
Never reset, clean or force-push another branch.

No new paid resource, live database migration, credential rotation/revocation,
provider-generation migration, app start/update, customer communication, real-data
import or public launch is admitted by this source milestone. The approved
credential rotation remains a separate pending maintenance operation; consumed
restore/helper grants cannot be reused. Prepare a concrete reviewed upgrade/
rollback/rotation packet before any later request for owner admission.

## Acceptance

1. Exact-head source reviews cover invoice/import boundaries and the remaining
   selected launch changes; address every critical or important issue.
2. Integrate original commits with preserved history. Resolve overlapping API
   specifications semantically, then regenerate clients using the pinned generator.
3. Run the complete disposable-PostgreSQL suites, website adapter, TypeScript,
   both builds and Docker parity against the combined source. No real credentials.
4. Inspect representative invoice/import/UI flows in fictional local browser
   fixtures where the repository harness supports them; recordings remain off.
5. Scan only the intended source changes for secrets with redacted output.
6. Independently review the combined result, publish an exact-head draft PR to
   canonical main and require its CI. A source candidate is not production proof.
7. Record the next production75 upgrade/rollback and rotation gates with exact
   source, target, expected permission policy, recovery evidence and exclusions.

Post-launch experiments36/37/38 retain their separate draft scope and source.
No requirement is dropped because it is not yet part of this release candidate.
