# Supervised HVAC beta preparation

This describes the prepared source path for a supervised contractor beta. It is not evidence of a deployed release, provider delivery, payment acceptance or complete migration from another system. The active working plan remains BETA-LAUNCH-PLAN.md; historical V1 migration and P0/freeze procedures are retired.

## Initial runtime

The prepared Fly production configuration holds outbound delivery, disables scheduler autostart and allows zero idle Machines for an on-demand supervised test. Applying it remains a separate release decision. All staged provider settings must be reviewed before deployment because a release can activate more than the newly staged values.

Both Fly configs invoke the read-only beta schema preflight. Production requires the paired expected database/login settings and checks both on the same connection before required visible columns. Other environments can omit both expectations; partial settings refuse admission. Separately establish the intended cluster/endpoint, writer rights and compatible full schema; a passing preflight is not that proof. Staging needs its own isolated database validation and must not borrow production's database to pass admission.

Build only from a clean tracked-source export. Do not include ignored local credentials or private operational receipts in the image or public source. Keep source/tree/image/config identity in a private release manifest.

## First account and contractor workspace

The first user of a fresh default organization becomes its owner and a platform administrator before verification finishes. Keep self-registration restricted to the trusted internal operator until that bootstrap is verified. A successful registration response alone is not evidence of mailbox receipt or a verified session.

The internal operator only needs normal signup, actual verification-link completion and login with the expected internal organization/platform role. A full fictional contractor-company rehearsal is unnecessary.

Then use Platform → Client Launchpad → New client workspace → Create isolated draft. Enter approved contractor business details and operating policy. Draft creation does not activate a public site, subscribe the company, impersonate it or send invitations.

Use Client staff setup to invite the company's actual Owner and Office user separately. Signed invitations bind the address, role, organization and revision and provide mailbox proof on acceptance. Active token-bound invitations do not require opening general self-registration. Each person sets their own password. Check their organization, role, non-platform-admin status and denied platform/other-company access after acceptance.

## Identity window and held business rehearsal

The global outbound hold also prevents verification, invitation and password-reset emails. It is not a selective business-message switch, and production does not acquire the staging recipient guard merely by setting a staging allowlist variable.

Use a separately authorized identity-only window with the scheduler still disabled and no imported customers or connected business delivery accounts. Finish the internal bootstrap and authorized staff invitations. Then restore and verify the effective runtime outbound hold before synthetic business work; staged metadata is insufficient. Include required same-image configuration restarts/releases in that approval. Later account-email recovery requires another deliberate identity window while the global hold is used.

## First business session

Run a supervised 45–60 minute session on the actual office and field devices. Use clearly labeled synthetic records with unreachable contact channels. Rehearse customer/property lookup, estimate draft, scheduling/reschedule, assigned visit, field notes/evidence and invoice draft where supported. Record any missing step as a defect or explicitly agreed deferred beta requirement. Do not silently waive it.

Actual iPhone/Safari acceptance, real message receipt/replies/opt-out, payment collection, external AI use, customer imports/history/open balances and recurring automation remain separate checks. Draft screens and a contactless test lead do not establish provider success. Keep the existing system's source-of-truth and duplicate-effect rules explicit until a separately accepted cutover.

## Local checks and recovery

Use `node scripts/local-dev.mjs test` for the isolated PostgreSQL suites; focused paths may be supplied. The runner owns a disposable loopback PostgreSQL16 instance and excludes inherited provider/database credentials. Local tests do not count as hosted signup or company acceptance.

Local workday acceptance requires an explicit fresh absolute `GROWTHOS_ACCEPTANCE_EVIDENCE_ROOT` before invoking `scripts/acceptance/acceptance-runtime.mjs`. It refuses to reuse an existing directory. The current local fixture has its own exact schema attestation; historical hosted admission remains separate. Browser photo testing may opt in to one exact local reservation-bound upload, with fresh session, bytes and admission checks; arbitrary query-bearing writes remain blocked.

The live legacy V1 database is retired. An initial release without a verified compatible V2 rollback image must fall back to a complete application hold while preserving the retained V2 database. Historical V1 archives do not back up new beta records. Establish current V2 recovery before entering meaningful customer data.
