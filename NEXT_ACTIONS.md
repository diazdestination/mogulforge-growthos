# Next acceptance work

Newest candidate: `agent/growthos-customer-care-20261002`, documented in
`reports/customer-care-integration-2026-10-02.md`. Finish exact-head CI (real
PostgreSQL concurrency, all tests, types, builds and Docker) before integration.
Reviewed reminders/office booking, individually approved missed-call recovery
and invoice email are implemented locally; they are not live or complete
replacement acceptance. The new schema is **105 tables**: review `0007` after
`0006`. Do not relabel the prior managed 103-table proof as 105-table acceptance.
The separately requested held-staging upgrade/admin-rotation approval is still
unanswered; all hosted/provider/customer holds remain. Azure first sign-in is
still an owner-return item. Next engineering is required migration/native-source
adoption, trusted inbound communication and actual staff-workday gaps.

Follow `PAID-BETA-READINESS-P0.md`; complete the exact candidate CI before a
release. The swarm foundation reports distinguish local proof from hosted proof.

October 2 integration follow-up: PR #12 merged the cumulative work as
main `47aca5beeb06e665bddfff23545640d779de51cc`; explicitly dispatched exact-main
CI37052487433 passed all release jobs. Use
`reports/geekom-contractor-integration-2026-10-02.md` and its integration PR for
current evidence. Each later candidate still needs exact-head CI;
the workflow has no push trigger, so dispatch it explicitly. The held staging
app remains the older 77f6d63 image with 95 tables until separately verified.
That earlier cumulative source expects 103 tables; the new customer-care source
expects 105. Never deploy either onto the 95-table
database or run an unreviewed automatic schema push.

Before real onboarding/cutover, satisfy `HOUSECALL-PRO-REPLACEMENT-GATE.md` for
both companies. The owner explicitly requires replacement of their actual
Housecall Pro workflows, not a reduced assisted pilot. Finish the service-due and
missed-call customer loops, invoice delivery/external receipt tracking, required migration
and source adoption, then real provider/device and uncoached staff acceptance.
The owner has deferred contractor payment collection to a later add-on; processor
selection is no longer a launch input blocker. Keep truthful invoice balances and
staff-recorded receipts without presenting them as processor-verified settlement.
The active engineering contract is `reports/customer-care-contract-2026-10-02.md`.

Azure return-to-desk item: the owner now reports a new Azure account. Wait for
the first sign-in, confirm the actual directory and account, then inspect app
registrations and configure the existing Microsoft integration. Preserve the
account and all outbound holds; do not repeat signup or send to contractors.

1. Preserve the now-integrated stacked chain. The managed restore, reviewed
   95-to-103 rehearsal and restricted exact-image app acceptance passed on the
   temporary restored copy; see `reports/managed-contractor-recovery-2026-10-02.md`
   for evidence and cleanup status. Next is the separately reviewed/authorized
   held staging rollout to the selected reviewed release/schema and exact-release
   normal-mode acceptance, not
   replaying the one-use restore-target script against the original staging DB.
   Inventory the object-storage adapter before accepting private-photo behavior.
2. Accept the implemented checkout/replacement and core export/company-hold
   flows against approved hosted billing/provider environments. Complete the
   hosted normal-mode tenant matrix, scheduler/alerts, wider export/retention
   policy and approved provider receipt/failure acceptance. Local core export
   and offboarding requests do not cancel billing or erase the account.
3. For each beta company: confirm business/source identity and responder, obtain
   approved export/access, measure lead/estimate/win baseline and connect its
   actual website through a supported secure adapter. Keep the companies in
   separate organizations. Record included beta workflow scope explicitly.
4. Accept the native replacement candidate in `reports/native-contractor-day-integration.md`:
   internal invoice lifecycle/recorded-payment reconciliation, an office/field
   scheduling day, explicit service recurrence and simpler daily navigation.
   Finish actual invoice delivery, external receipt reconciliation, opening balances
   and staff rehearsal in `BETA-CONTRACTOR-SUCCESS.md`. Housecall Pro is
   optional migration support. Preserve import holds until approved source
   reconciliation and a documented authoritative-writer/cutover decision.
5. Repeat the implemented private inquiry-to-owned-response-to-appointment/
   estimate-to-value rehearsal using each company's approved real configuration.
   Local synthetic proof now covers both named companies, lost acknowledgements,
   duplicates, missing responders and hold/resume. Actual delivery, stale-source
   reconciliation, customer response and economic value remain unproven.
6. Expand the premium tier inventory and trade workflows using those observations;
   measure revenue evidence, staff effort, communication costs and renewal intent.

Integrated runtime baseline: main `47aca5b`, including PR11's
`agent/growthos-native-contractor-day` work and the independent PR12 repairs.
Review additive `0006_native-contractor-day.sql` after0002–0005. The local synthetic
90-to103-table upgrade/restore passed with restricted real-app reads; it is not
a managed production restore. Verify actual staff invitations and trusted incoming
reply identity with approved recipients/providers. Unsigned legacy evidence and
uncertain effects remain visible for staff review. Do not cancel Housecall Pro or
activate duplicate workflow writers before the native acceptance and migration gates.

GEEKOM retains Microsoft/Azure provider work. Local ForgeLink leases do not
prove remote task coordination. Applicable production, financial and customer
contact approvals remain required; local engineering can continue autonomously.
