# GrowthOS project state

Updated October 1, 2026. Latest candidate: `agent/growthos-native-contractor-day`,
stacked on `agent/growthos-contractor-operations` (PR #10), beta PR #9, swarm PR #8, contractor PR #7, Revenue Desk PR #6 and
recovery PR #1. GitHub main remains the eventual canonical integration target.
No merge or deployment is implied by a local candidate or green CI.

Adam's current replacement direction is in `GROWTHOS-CONTRACTOR-OPERATIONS.md`:
native scheduling, invoices, warranty tracking and clear daily navigation.
Housecall Pro is optional migration support. Native internal invoice lifecycle
and recorded-payment reconciliation are now implemented in this candidate;
customer delivery, hosted collection and opening-balance migration still need
acceptance. GrowthOS subscription billing is separate. Commercial scope
is in `GROWTHOS-CONTRACTOR-PRODUCT.md`: two waiting
roofing/HVAC companies at a limited $500/month beta, a flagship target of at
least $1,500/month, shared trade packs and both Smart Sites/existing websites.
Payment, activation, actual source access and starting conversion data remain
unverified. The $1,500 price is a value target, not measured willingness to pay.

Current evidence: `reports/native-contractor-day-integration.md` and its invoice,
scheduling and experience lane reports. This wave adds a five-destination daily
workspace, exact overdue-task links, native invoices, scheduling conflict/version
guards, agreed service recurrence and preserved financial/service exports.
Additive0006 extends the synthetic upgrade/recovery to103 tables and12 restricted
real-app read checks. The prior contractor wave added staff coverage/invitations,
trusted reply holds, consistent owner reporting and upgrade/recovery. Beta work added
checkout/replacement, exports, company holds and website delivery. Current CSS
worker/recovery candidate is draft PR2, stacked on its website-adapter PR1. Neither
company is activated, and no real provider sends or charges were performed.
Feature and readiness inventory: `reports/swarm-release-audit-2026-10-01.md`.
Exact candidate CI and release evidence are recorded on its draft PR and in
`C:\Forge\GROWTHOS_NATIVE_CONTRACTOR_DAY_2026-10-01.md` and the Forge launch ledger.
`BETA-CONTRACTOR-SUCCESS.md` defines the staff rehearsal, baseline and renewal
proof needed before expanding the commercial offer. New native modules do not
by themselves complete hosted acceptance or wider tier enforcement.
Hosted evidence in `reports/controlled-pilot-2026-09-30.md` is historical;
it is not a current production verification of this candidate.

Next: `NEXT_ACTIONS.md`. Operating references: `RUNBOOK.md`.
