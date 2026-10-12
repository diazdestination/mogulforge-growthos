# Owner input checklist

Every item below waits on Adam or on one of the contractor companies. Engineering
cannot supply these, and no agent may assume, simulate or self-approve them
(`GROWTHOS-RESUME.md`, "Accounts and approvals that cannot be pre-created in code").

How to provide inputs safely:

- Give each answer through the private intake or the approved secure credential
  flow. Never paste secrets, card or bank details, or customer PII into chat or
  Git.
- Apply each authorization within its recorded scope, target, limits and
  expiry. A consumed one-time grant cannot authorize another attempt; retain
  existing decisions and reusable authorizations that are still applicable.

**Who answers:**

- **A** = Adam
- **CSS** = Climate Simulation Solutions owners
- **PNL** = Painless owners

## A. Release and recovery

| ID | Who | Exact ask | Unblocks |
| --- | --- | --- | --- |
| O-01 | A | **Only if a reviewed remaining backup-restore gate requires a new paid resource:** approve that exact test with (1) a price ceiling in USD, (2) a maximum lifetime and cleanup deadline, and (3) acceptable deletion proof, such as terminal `deleted` plus absence from active inventory. Fly has no provider-enforced invoice cap; reconcile the actual bill afterward. Earlier one-time grants are consumed. First reconcile the current `C:\Forge\CONTROL_PLANE.md` and its dated recovery receipts; do not replay completed staging recovery. Actual PostgreSQL backup restoration remains distinct from encrypted credential recovery | Remaining L10/P0-6 recovery evidence, if needed |
| O-02 | A | Reconcile the already completed original staging migration and held private runtime from the October 11 control-plane receipts. If a further hosted operation is necessary, confirm applicable authorization for its exact source, SQL, image, target and holds before it runs. Production migration/cutover authority is separate; this packet requires no repetition of staging work | Any further hosted operation; all hosted test environments |
| O-03 | A | For each test window, name: the exact test recipients (by role), the purpose, the maximum number of sends, the stop time, and the staging push/user allowlist | Every send case |

## B. Accounts and providers

| ID | Who | Exact ask | Unblocks |
| --- | --- | --- | --- |
| O-04 | A | **Gmail.** Create or confirm the *Staging* Google Cloud project (Testing audience, exact redirects). Provide **at least 2 Gmail test identities** for 2 organizations. Decide when to submit the *Production* project for verification (`GOOGLE-OAUTH-SETUP.md:25-80`) | E-01 to E-05, I-01 |
| O-05 | A | **Azure first sign-in** with Adam present. Inspect the existing directory and app registration; do not open a new account (`HOUSECALL-PRO-REPLACEMENT-GATE.md:143`). **Per company:** name the actual mailbox provider and the sending mailbox. Tracked replies also require separate approved delegated `Mail.Read` consent and GrowthOS mailbox-reading opt-in. Painless's Microsoft mailbox is unverified and its Yahoo inbox is unsupported | E-07 to E-09, L1 |
| O-06 | A | **Resend.** Provide a verified platform sender domain and staff test inboxes for invitation, verification and reset mail (`PAID-BETA-READINESS-P0.md:299-309`) | E-10, L2 |
| O-07 | A + each co. | **Twilio.** For each company: (1) the account model (platform subaccount or client-owned); (2) the number to use or buy; (3) A2P/TFV registration with that company's legal identity; (4) a one-time and a monthly spend cap; (5) allowed destinations; (6) the carrier forwarding plan and revert plan; (7) authorized test handsets (`TWILIO-CLIENT-READINESS.md:86-90`) | S-01 to S-08, V-01 to V-11 |
| O-08 | A | **ElevenLabs/CALLIE.** For each company: (1) the account and agent version; (2) the caller disclosure; (3) the retention period; (4) the budget; (5) the recording decision (currently off); (6) the fixed human-handoff targets; (7) the after-hours owner (`reports/callie-conversation-operator-2026-10-05.md:149-160`) | V-02 to V-09 |
| O-09 | A | **OpenAI.** Separate staging and production projects, a model allowlist, budget and alert thresholds, and a no-silent-mock rule in production (`PAID-BETA-READINESS-P0.md:328-339`) | AI invoice wording, CALLIE summaries |
| O-10 | A | **Stripe test mode** for the GrowthOS *subscription* (checkout, webhook, portal, cancel, enforcement on and off). This is not contractor collection (`PAID-BETA-READINESS-P0.md:341-352`) | L11 |
| O-11 | A | Approve push enablement in the test environment: securely installed VAPID keys and the exact allowlisted user IDs (`STAFF-PUSH-PILOT.md:37-50`) | P-01 to P-10 |

## C. Housecall Pro exports (one set per company)

**O-12 (Painless) and O-13 (CSS).** Provide approved exports, or authorized
read-only access, covering every item below. Supply counts and the export
date with each.

- [ ] Customers/contacts and **all service properties**.
- [ ] **Completed jobs with original job values** (CSS calls this essential, `C:\Forge\CSS_OWNER_INTAKE_2026-10-09.md:178-181`).
- [ ] Open work: estimates, jobs and appointments, including those scheduled after the cutoff.
- [ ] Equipment and installed components, with warranty evidence. Service agreements and plans, with cadence and anchor dates.
- [ ] Invoices, payments, refunds and **open balances** (exact cents, original numbers and dates).
- [ ] Media and documents (job photos, reports, signed estimates).
- [ ] Communications history and consent/opt-out state.
- [ ] **Samples:** 1 assessment report, 1 multi-repair invoice, 1 maintenance invoice, 1 estimate, 1 maintenance agreement. Redacted copies are acceptable.

**O-14 (each company).** Approve the reconciliation result, the cutoff date and
time, one writer per record domain, the rollback/export path and the parallel-run
period. Cancelling Housecall Pro stays a separate, later owner action.

## D. CSS decisions (from the October 9 open items)

| ID | Exact ask |
| --- | --- |
| O-15 | Formal business hours, confirmed as Mon–Fri, "seven to five" (07:00–17:00?), plus the **IANA time zone**. Do not copy Painless's. |
| O-16 | **Urgent escalation and booking safeguards:** (1) the urgency criteria; (2) whether **both** owners are alerted; (3) a claim rule or none; (4) the escalation timer; (5) which slot the fallback booking may use and its limits; (6) the confirmation-text wording; (7) what is never promised (arrival time, dispatch). |
| O-17 | **Customer messaging rules:** (1) the appointment yes/no confirmation wording, timing and no-response rule; (2) the fields on the details-correction form and its identity check; (3) quiet hours; (4) stop events for reminders and estimate follow-ups (reply, decline, accept, opt-out); (5) the owner and deadline for the estimate follow-up call task; (6) the after-hours automatic reply wording. |
| O-18 | **Warranty and maintenance:** (1) the warranty evidence standard (manufacturer or installer, parts versus labor); (2) the exact reminder lead time ("about a month"); (3) whether due dates follow fixed seasonal dates or the last completed visit; (4) what counts as major service that shifts a due date; (5) annual plan billing and renewal terms. |
| O-19 | **Invoice approval rule:** what makes an invoice "multi-repair" and need office review (count, amount or job type). Who may issue each type. The required invoice and report layout (from the O-13 samples). |
| O-20 | **Payments:** (1) preferred methods (reader, phone, link; Apple Pay or Google Pay); (2) the provider shortlist (Stripe, PayPal, other); (3) surcharge or fee policy; (4) payout destination type; (5) deposit, progress-payment and financing terms and provider. Provide a **redacted** current processing/payout statement. No account opening or charges until separately approved (`C:\Forge\CSS_OWNER_INTAKE_2026-10-09.md:117-156`). |

## E. Painless decisions

| ID | Exact ask |
| --- | --- |
| O-21 | (1) The response target and overdue escalation for office hours; (2) the after-hours on-call and escalation policy (the after-hours owner is already designated; confirm only the policy); (3) the manual logging path for direct phone or `mailto:` contacts (`...owner-contact-and-routing-2026-10-05.md:22-23`). |
| O-22 | (1) The verified sending mailbox (not the shared Yahoo inbox); (2) the main voice number and the forwarding approach; (3) the website/capture configuration and the accountable lead assignee. |
| O-23 | (1) The actual warranty and service promises, with their evidence; (2) whether customer e-signature is required on estimates; (3) whether **in-app payment collection** is required for Painless after the October 9 scope change; (4) whether warranty dates must appear on invoices; (5) the retention policy. |

## F. People, devices and testers

| ID | Who | Exact ask |
| --- | --- | --- |
| O-24 | Each co. | Who gets GrowthOS accounts, and their roles (owner/admin, office, field). Each person must accept their invitation. CSS: 2 accounts; no account for the helper unless requested. Painless: both owners, plus any office or field staff. |
| O-25 | Each co. + A | Each owner's **iPhone** (iOS 16.4 or later) and any Android phone. Test customer phones and inboxes with **written consent for the specific test**. Uncoached office and field testers. Agreed test dates. |

## G. Release, commercial and privacy decisions

| ID | Exact ask |
| --- | --- |
| O-26 | Approve the public Privacy Policy, Terms, Google data-use disclosure, retention and deletion, subprocessor list and security contact (`PAID-BETA-READINESS-P0.md:421-440`). |
| O-27 | Confirm the $500 beta scope and included allowances (SMS, calls, AI). Name the release go/no-go approver for each company and the support owner and coverage hours (`PILOT-OPERATOR-RUNBOOK.md:15-28`). |

## Priority order (highest leverage first)

1. **O-13 / O-12 — Housecall Pro exports and samples.** These unblock G-05, the
   migration line on both cards, and the layouts needed for G-03, G-12 and G-13.
2. **O-01 / O-02 — reconcile current recovery and hosted evidence.** Request
   an exact new paid-restore approval only if the remaining recovery plan needs
   it; do not repeat the completed staging migration/private runtime. Remaining
   release gates do not make this documentation a prerequisite for PR #35.
3. **O-20 — CSS payment decisions and a redacted statement.** These define G-01
   and G-02, the largest new engineering scope.
4. **O-15 + O-16 + O-17 — CSS hours, time zone, urgent safeguards and messaging
   rules.** These unblock G-07 to G-11 and every CSS after-hours case.
5. **O-25 + O-24 — named testers, accepted accounts, owner iPhones and consented
   test recipients.** Every device and provider case needs these.
6. **O-04 — the Gmail staging project and 2 test identities.** This is the
   fastest real-mail path (E-01 to E-05, I-01).
7. **O-05 — Azure first sign-in and the mailbox choice for each company.**
8. **O-07 + O-08 — Twilio account model, number, registration and caps, and
   the ElevenLabs agent.** These have the longest lead time because of A2P
   review.
9. **O-18 + O-19 + O-21/O-22/O-23 — warranty, invoice-approval and Painless
   routing/sender/agreement decisions.**
10. **O-06, O-09, O-10, O-26, O-27 — Resend, OpenAI projects, Stripe
    subscription test, privacy documents and commercial scope.**
