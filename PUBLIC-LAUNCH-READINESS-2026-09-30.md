# GrowthOS public-launch readiness ledger — September 30, 2026

**Decision: not ready for public launch or paid beta.** This ledger is an
operator-facing status map, not a launch authorization. The commercial wedge
remains Revenue Intelligence + Recovery for contractors: surface neglected
opportunities, guide controlled action and show an inspectable outcome trail.
Do not sell automatic SMS, AI call answering, warranty outreach or the eight
named agent profiles as fully live until each client's provider and workflow
acceptance actually passes.

| P0 gate                    | Current evidence                                                                                                                      | Still required                                                                                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Exact-head CI           | Prior commit `3d54f76` passed full CI with 1,387 tests, types, builds and Docker parity.                                              | Re-run on every later release-candidate SHA, including this work batch.                                                                                                                                                     |
| 2. Always-on scheduling    | Local ownership/restart tests and guarded scheduler configuration exist.                                                              | Same-SHA, real-PostgreSQL staging idle/restart/failure test, pool-mode proof and operator heartbeat.                                                                                                                        |
| 3. Isolated staging        | Separate Basic MPG cluster `zp2wjrejd2zodn4q` is ready; a generated initial SQL preview exists.                                       | Review and authorize schema operation, safely switch app secret/image, verify isolated test identities, then exact-SHA staging acceptance. Old app is stopped and still holds the former shared-cluster secret.             |
| 4. Providers               | Code paths and mocks exist for Gmail, Resend, Twilio, OpenAI and Stripe.                                                              | Approved test identities and real provider receipts for the P0-4 matrix. No customer send or production activation is established.                                                                                          |
| 5. Failure visibility      | Runtime health has local aggregate tests; this batch adds an operator-facing alert for failed background work.                        | Owned external alert destination, uptime check, per-client triage and staged failure-injection evidence.                                                                                                                    |
| 6. Restore                 | Fly automatic backups exist; a guarded read-only comparison utility and synthetic-fixture plan are prepared.                          | Meaningful synthetic backup, actual isolated restore, same-image app boot, decrypt-context checks and measured RPO/RTO. Fly managed restore requires a temporary new cluster; do not pay for one while the source is empty. |
| 7. Trust/data lifecycle    | Tenant/auth guards and private-data patterns exist; this batch removes untrusted request-host origins from Stripe and OIDC redirects. | Owner-reviewed policies, retention/deletion/export workflow and verified customer-data lifecycle.                                                                                                                           |
| 8. Tenant isolation        | Existing local tenancy tests plus this batch's API-key/contact adversarial regression.                                                | Full two-tenant staging matrix across read, write, search, export, send and provider identities.                                                                                                                            |
| 9. Founding-customer proof | Local/synthetic opportunity-to-outcome workflows exist.                                                                               | One consented, bounded Painless or HVAC pilot with provider receipts, appointments/outcomes and conservative revenue attribution.                                                                                           |
| 10. Repeatable offer       | BIE positioning, Lead Import, Revenue Desk and client operations foundation exist.                                                    | Only after gates 1–9: validate 2–3 packages, usage economics and a timed contractor onboarding run.                                                                                                                         |

## Closest safe sequence

1. Land the small code/test fixes and require exact-head CI green. Preserve
   client isolation and the draft PR until acceptance evidence is complete.
2. Review the [initial staging SQL preview](reports/staging-schema-preview-2026-09-30/README.md).
   The database currently has zero application tables. Schema application is
   a separate explicit gate; neither a green build nor this preview is consent
   to run `drizzle-kit push --force`.
3. Apply an approved staging-only schema with the app stopped and all outbound
   paths held. Create strictly synthetic fixture data, take a completed backup,
   and run the [restore plan](reports/p0-6-restore-drill-plan-2026-09-30.md).
   A logical restore on the existing cluster can rehearse the application path;
   Fly managed-backup proof later requires a short-lived new cluster and
   cleanup. The owner conditionally approved that cost if genuinely needed,
   not an empty-backup exercise now.
4. Cut over the old staging app atomically to the new database and exact green
   image; do not use `fly mpg attach` as a shortcut because it deploys the old
   app state. Keep scheduler and provider sends disabled through first health
   inspection, then run the real-PostgreSQL acceptance matrix.
5. Obtain client-specific provider/test-recipient, legal/privacy, contact-policy
   and data-import decisions. Prove each intended channel before the first
   bounded founding-customer pilot. Only then decide packaging and public
   claims.

## Owner decisions not implied by this ledger

- Staging schema application and a controlled staging app activation.
- Which Painless/HVAC staff, sender numbers/domains and **test** recipients may
  be used; each client's consent/contact policy and escalation owner.
- Public-facing legal/privacy text, retention promises and customer-data
  lifecycle commitments.
- A bounded founding-customer dataset and outreach approval. Do not copy the
  old shared-cluster staging records into the new synthetic environment.

The binding release rule remains [`PAID-BETA-READINESS-P0.md`](PAID-BETA-READINESS-P0.md).
The detailed staging state is [`STAGING-PREFLIGHT-2026-09-30.md`](STAGING-PREFLIGHT-2026-09-30.md).
