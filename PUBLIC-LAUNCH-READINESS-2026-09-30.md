> **Superseded on 2026-10-29 by [BETA-LAUNCH-PLAN.md](BETA-LAUNCH-PLAN.md).** Kept as history.

# GrowthOS public-launch readiness ledger — September 30, 2026

**Decision: not ready for public launch or paid beta.** This ledger is an
operator-facing status map, not a launch authorization. The commercial wedge
remains Revenue Intelligence + Recovery for contractors: surface neglected
opportunities, guide controlled action and show an inspectable outcome trail.
Do not sell automatic SMS, AI call answering, warranty outreach or the eight
named agent profiles as fully live until each client's provider and workflow
acceptance actually passes.

Latest source of dated evidence: [controlled-pilot ledger](reports/controlled-pilot-2026-09-30.md).
The September 30 evening continuation completed the isolated 90-table schema,
Writer/Reader role separation, Session-pool proof, a real managed-backup restore
with same-image app reads, and a held staging cutover. The temporary third
cluster was deleted. By October 1, actual scheduler timed cycles, graceful
worker restart and a scoped crash-after-task drill also passed. Staging is
running again with sending and its normal scheduler held. A staff-only
rehearsal remains distinct from opening a real customer pilot or paid beta.

| P0 gate                    | Current evidence                                                                                                                                                   | Still required                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1. Exact-head CI           | Hosted application `c050067` passed run `36809476022`; test-harness repair `aca6a4a` passed run `36814582125`: 1,668 tests, types, builds and Docker parity.          | The additive readiness candidate needs its own exact-head CI and held-staging acceptance; older results do not approve it.          |
| 2. Always-on scheduling    | Hosted Session locks, heartbeats, real timed cycles, graceful worker restart and bounded crash-after-task checks passed; no duplicate task.                        | Remaining legacy/global failure windows, approved normal scheduler enablement, actual provider effects and operator coverage.      |
| 3. Isolated staging        | Separate cluster, 90-table bootstrap, Writer login and immutable c050067 cutover verified; one started held Machine, minimum one.                                  | Full intended workflow acceptance; keep environment and client sender/test identities separate.                                    |
| 4. Providers               | Code paths and mocks exist for Gmail, Resend, Twilio, OpenAI and Stripe.                                                                                           | Approved test identities and real provider receipts for the P0-4 matrix. No customer send or production activation is established. |
| 5. Failure visibility      | Runtime/operator alerts exist; bounded DB readiness, build identity and redacted idle-pool error handling now have local tests and independent review.              | Exact-candidate Docker/hosted acceptance, owned external alert destination, actual alert receipt and per-client response coverage.  |
| 6. Restore                 | Completed managed full backup restored; two-tenant fingerprints/media/decryption and same-image HTTP isolation/read-only checks passed. Temporary cluster deleted. | Preserve evidence and repeat after material changes. Observed synthetic exercise timing is not a production recovery SLA.          |
| 7. Trust/data lifecycle    | Tenant/auth guards and trusted redirects exist; source-grounded lifecycle inventory/implementation plan is documented. This is not a whole-account export/delete. | Owner-reviewed policies, complete export/retention/deletion implementation and verified customer-data lifecycle.                    |
| 8. Tenant isolation        | Local tenancy/API-key regressions and four hosted restore-mode cross-tenant read denials passed. Restore-mode 405s are not normal write-isolation evidence.       | Full normal-mode two-tenant staging matrix across read, write, delete, search, export, send and provider identities.                 |
| 9. Founding-customer proof | Local/synthetic opportunity-to-outcome workflows exist.                                                                                                            | One consented, bounded Painless or HVAC pilot with provider receipts, appointments/outcomes and conservative revenue attribution.  |
| 10. Repeatable offer       | BIE positioning, Lead Import, Revenue Desk and client operations foundation exist.                                                                                 | Only after gates 1–9: validate 2–3 packages, usage economics and a timed contractor onboarding run.                                |

## Closest safe sequence

1. Land the small code/test fixes and require exact-head CI green. Preserve
   client isolation and the draft PR until acceptance evidence is complete.
2. Preserve the [reviewed bootstrap SQL](reports/staging-schema-preview-2026-09-30/README.md)
   and completed recovery evidence. The schema has been applied; do not rerun
   the empty-database bootstrap or enable `drizzle-kit push --force` by habit.
3. Complete the remaining synthetic scheduler acceptance on the recorded
   candidate with all providers held. Hosted normal timed cycles and graceful
   worker restart and bounded crash-after-task behavior have now passed.
   Keep failed/uncertain effects visible;
   never make a retry look successful by replaying a potentially accepted send.
4. Open only a recorded staff-only test window on the isolated staging app.
   A working health endpoint is not proof of sender setup, actual delivery,
   calendar connectivity or contractor workflow usability.
5. Obtain client-specific provider/test-recipient, legal/privacy, contact-policy
   and data-import decisions. Prove each intended channel before the first
   bounded founding-customer pilot. Only then decide packaging and public
   claims.

Engineering details: [readiness operations](READINESS-OPERATIONS.md) and
[customer-data lifecycle plan](CUSTOMER-DATA-LIFECYCLE-PILOT.md). The latter
describes work still to build, not a completed feature or approved policy.

## Owner decisions not implied by this ledger

- Which Painless/HVAC staff, sender numbers/domains and **test** recipients may
  be used; each client's consent/contact policy and escalation owner.
- Public-facing legal/privacy text, retention promises and customer-data
  lifecycle commitments.
- A bounded founding-customer dataset and outreach approval. Do not copy the
  old shared-cluster staging records into the new synthetic environment.

The binding release rule remains [`PAID-BETA-READINESS-P0.md`](PAID-BETA-READINESS-P0.md).
The detailed staging state is [`STAGING-PREFLIGHT-2026-09-30.md`](STAGING-PREFLIGHT-2026-09-30.md).
