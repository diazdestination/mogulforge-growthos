# Contractor acceptance: the 33 cases as an executable checklist (October 16, 2026)

Package C of the GrowthOS launch division (`C:\Forge\CODEX_REQUEST_GROWTHOS_LAUNCH_DIVISION_2026-10-16.md`).
Owner authority: Adam's October 16 decision, item 5. Run the 33 contractor cases
on **staging** with `TEST` company and site records only. Never use production,
and never send to a real customer.

## Where the 33 cases come from

The 33 cases are the 24 original company cards plus 9 G-04/G-06 supplements.
They come from GEEKOM's ledger, which ROOT reviewed:
`C:\Forge\artifacts\growthos-contractor-acceptance-20261015\geekom-20261016T022212Z\`.

| Source | File | Cases |
| --- | --- | --- |
| Painless card | `CASE-LEDGER.json` (original `CONTRACTOR-CARDS.md:49-60`) | P-A … P-L (12) |
| CSS (HVAC) card | `CASE-LEDGER.json` (original `CONTRACTOR-CARDS.md:111-122`) | H-A … H-L (12) |
| G-04 / G-06 supplements | `G04-G06-ACCEPTANCE.md`, `G04-G06-LEDGER.json` | G04-01 … G04-05, G06-01 … G06-04 (9) |

Gap IDs G-01 … G-20 come from
`C:\Forge\artifacts\growthos-production-readiness-20261012\acceptance-register.json`
(`contractorGaps`) and `GAP-DEFINITIONS.json`. They match the October 12 packet's
`source-gap-map.md`.

Older sub-case IDs are cross-references only. These include E-/S-/V-/P-nn/A-/I-
from `provider-device-cases.md`, C/R rows from the workday scripts, and N-01 … N-07
from `new-feature-cases.md`. They do not add to the 33.

## Columns

- **Auto:** `local` means it runs fully in the disposable local runtime.
  `staging` means the same script runs against staging with TEST records.
  `device` means it needs real phones, inboxes, carriers or people.
  Most cases are mixed.
- **Local 10-16:** the result of the automated slice in the local run on October 16
  (`scripts/acceptance/run-workday-acceptance.mjs`). Values are PASS, FAIL,
  BLOCKED or NOT-RUN. **A PASS here proves only the automated, synthetic slice.**
  No case is company-accepted. Each case still needs the real staff, provider,
  device and owner evidence listed in it (`RESULT-TEMPLATE.md`).
- **Staging 10-16:** the result of the read-only staging smoke
  (`scripts/acceptance/staging-smoke.mjs`) at the original ef52778 handoff, before
  the separately owned schema repair. That recorded smoke returned 500 for
  the settings, onboarding, Today, appointments and projects reads. The cause is
  that schema migration 0019 is missing. Every workday case is therefore BLOCKED
  in that historical smoke (see GAPS.md, GAP-01). It is not current stage status.
- **Evidence:** screenshots and JSON are in the private folder
  `C:\Forge\artifacts\growthos-launch-claude-20261016\acceptance\`, not in Git.

Shared preconditions for every case:
- Record the release commit and image, schema table count, environment and tenant.
- `GROWTHOS_OUTBOUND_HOLD` is on. Staging has `STAGING_OUTBOUND_APPROVED=false` and an empty allowlist.
- All records are labeled TEST.
- Stop and preserve on: wrong company, wrong recipient, duplicate or unexpected send, contact after opt-out, or unknown provider result.

---

## Painless Roofing and Water Restoration (P-A … P-L)

| ID | Scenario / preconditions | Steps (automated part in **bold**) | Expected | Auto | Gaps | Blocking owner input | Local 10-16 | Staging 10-16 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P-A | Reconcile approved source sample before cutover. Needs an approved HCP export and a reconciliation owner. | **Onboarding → "Bring your customers from Housecall Pro": upload a synthetic CSV, check columns, Preview, tick reviewed, Import. Re-preview the same file. Preview a copy with one changed email (N-04…N-07).** Then reconcile real counts, documents, open work and balances. | Preview counts add up to the file rows and nothing is saved. Import creates customers, not leads, and contacts nobody. Re-import gives 0 new. A changed email shows as "needs review". Unmapped data is recorded, not dropped. | local+staging (synthetic); device/owner (real export) | G-05 (jobs/estimates/invoices/media/equipment not importable) | O-12 export, O-14 cutoff, Adam's approval to import real data | **PASS** (5 rows: 4 new, 1 skipped; lead count unchanged; re-import 0 new / 4 duplicates; changed email 1 conflict) | BLOCKED (`/api/v1/onboarding` 500) |
| P-B | New website inquiry during normal hours. Needs the TEST site activated and both owners accepted. | **Credential check → activate TEST site → owner alert policy → server-to-server inquiry → identical resubmission → alert coverage → Owner A claims → Owner B takeover attempt.** Then real phones lock-screen (P-02…P-04). | One lead, one receipt, one task. Both owners are in coverage. Resubmission is a duplicate. Exactly one owner can claim. | local+staging; device for phone display | — | O-11 push allowlist, O-21 routing, O-25 devices | **PASS** (coverage `evaluated`, both owners `no_eligible_device`; replay `duplicate:true`; B gets 409 `owner_changed_refresh_first`) | BLOCKED (settings/onboarding 500; selected cross-org setup needs platform admin; owners manage own-site keys) |
| P-C | After-hours inquiry and missed call. | **Make the TEST policy "closed today", capture an inquiry, check coverage, restore the policy.** CALLIE missed, busy, voicemail and handoff paths (V-02…V-08). | Only the after-hours owner is selected. A missed call creates one office task with an owner. A requested visit is not a booking. | local+staging (routing); device/provider (CALLIE) | G-20 (phone/mailto clicks create no lead) | O-07/O-08 voice binding, O-21 after-hours owner | **PASS** (routing slice; CALLIE NOT-RUN) | BLOCKED |
| P-D | Owner mobile action. | **The other company's owner opens the lead link and is refused. "Reply from your phone" drafts for the inquiry.** iPhone tap-through, locked, Focus, offline, logout (P-01…P-09) and handset send (S-09). | The correct lead opens with no company switch. Three SMS drafts address the consented number and need a human Send. | local (isolation, drafts); device (rest) | G-18 | O-11, O-25 | **FAIL**: cross-tenant read 404 is PASS, but drafts are refused (`no_sms_consent`) even though the inquiry consented to SMS (GAP-02) | BLOCKED |
| P-E | New roofing/restoration opportunity. | **Customer and property linked from the inquiry → line-item estimate → native inspection → overlapping visit refused → reschedule.** Multi-day project with crew windows, crew conflict and cancellation (R3.7, R3.8). | No duplicate customer. Estimate totals are exact. The conflict is refused with a reason. A reschedule leaves one visit. | local+staging; project/crew is manual | G-04 (durations/helpers), G-06 | O-23 | **PASS** (project/crew windows not automated) | BLOCKED (`/appointments`, `/projects` 500) |
| P-F | Returning customer, with no invented lead. | **For the imported HCP TEST customer: add a property → customer-work estimate (`existing_customer`) → check the lead count.** Then job/invoice and receipts isolation. | `leadId` is null and the lead count is unchanged. Receipts stay on their own work. | local+staging | — | — | **PASS** | BLOCKED |
| P-G | Field completion and evidence. | **Record a roof asset with warranty dates and source → company checklist from starter: preview → approve → prepare entry for the exact asset → save answers → completion preview → complete.** Photos from a real phone. | The reviewed checklist is pinned. Only performed work is completed. Needs-attention creates an office follow-up. | local+staging; device (photos) | — | O-23 checklist content | **PASS API slice** (preview/complete/correction 200 retained; completion UI **NOT_RUN/unverified**, original image showed invalid link; photo N/A, needs-attention not automated) | BLOCKED |
| P-H | Held or corrected work. | **Note-only correction on the completed visit.** Asset/address change holds a draft, then cancel and reprepare. | Completed evidence is immutable; a note-only correction is accepted. A held draft is visible. | local+staging (partial) | — | — | **PASS** (note-only correction only; hold/reprepare NOT-RUN) | BLOCKED |
| P-I | Invoice and external receipt. | **Draft invoice for the exact customer, property and equipment → issue → relabel the asset and confirm the issued copy is unchanged (N-02) → email delivery PREVIEW (never sent) → staff-recorded partial receipt.** Real inbox receipt (I-01…I-04). | The issued document is stable. The email reaches the approved test inbox. Balance = issued − receipts. | local+staging; inbox needs approval | G-19 (Yahoo sender unsupported); G-01 collection owner-DEFERRED | O-03 window, O-04/O-05 sender mailbox, O-25 inbox | **BLOCKED**: issue, N-01/N-02 snapshot and receipt PASS (balance $230.00 of $330.00); email preview 409, no company sender connected | BLOCKED |
| P-J | Service/warranty follow-up. | **Service date with a 6-month recurrence → standing email reminder preview/approve.** Reply, then book, complete, next date. | The reminder is approved (dispatch is held). The reply is linked or held. | local+staging; provider for dispatch/reply | G-03 if dates are required on invoice, G-17 | O-23 actual promises, O-04/O-05 | **BLOCKED**: obligation and recurrence PASS; reminder preview 409 `sender_identity_required` | BLOCKED |
| P-K | Approved lead growth. | Source adoption / finite nurture with exact recipients, copy and timing. | Only permitted outreach; STOP/reply holds. | device/provider + owner decision | G-07 style cadence n/a | Owner decision on growth scope | NOT-RUN | NOT-RUN |
| P-L | Unassisted office/field handover. | Real Painless staff complete the day without coaching. | Time, help and wrong turns recorded; sign-off. | device/people only | — | O-24 accounts, company time | NOT-RUN | NOT-RUN |

## Climate Simulation Solutions — HVAC (H-A … H-L)

| ID | Scenario / preconditions | Steps (automated part in **bold**) | Expected | Auto | Gaps | Blocking owner input | Local 10-16 | Staging 10-16 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| H-A | Reconcile the actual service database. | **Same HCP synthetic import / re-import / conflict as P-A.** Then multiple properties, units, agreements, balances. | As P-A. Never infer model, serial, warranty or consent. | local+staging (synthetic); owner (real) | G-05 | O-13 export | **PASS** (synthetic) | BLOCKED |
| H-B | Enroll an agreed service series. | **Maintenance obligation for the exact customer, property and unit with a 6-month recurrence and agreement note.** | Finite agreement evidence and owner. Standing review is off by default. | local+staging | G-15 (due-date shift, plan billing), G-14 | O-18 notice days | **PASS** | BLOCKED |
| H-C | Due reminder and staff visibility. | **Standing email reminder preview → approve.** The dispatch is observed in the test inbox. | Approval does not mean sent. Hold-gated dispatch with recorded evidence. | local+staging; inbox | G-14 (SMS+email both) | O-04/O-05 sender, O-18 | **BLOCKED** (`sender_identity_required`) | BLOCKED |
| H-D | Reply and no-response exceptions. | Microsoft-parent / signed-SMS replies; no-response, STOP, expiry. | Exact replies are linked; ambiguous replies held; exceptions owned. | provider/device | G-17 | O-05, O-07 | NOT-RUN | NOT-RUN |
| H-E | Agree and schedule service. | **Inquiry customer and property linked; native visit for the accepted technician; conflict refused; reschedule.** | Deliberate property and technician; conflicts visible. | local+staging | G-04, G-08 | O-15 hours/timezone (TEST placeholder `America/New_York`) | **PASS** | BLOCKED |
| H-F | Technician visits the right unit. | **HVAC asset with warranty dates and source; HVAC starter checklist approved; entry for that exact unit; answers saved.** | Pinned revision; draft is distinct from performed; no warranty certification. | local+staging; device (photos) | — | — | **PASS** | BLOCKED |
| H-G | Complete selected service only. | **Completion preview → complete (one completion).** Month-end, partial selection, needs-attention. | At most one successor; unperformed service untouched. | local+staging | — | — | **PASS API slice** (completion/correction 200 retained; completion UI **NOT_RUN/unverified**, original image showed invalid link; boundary cases NOT-RUN) | BLOCKED |
| H-H | Retained-history recovery. | **Note-only correction.** Changed-equipment hold, then cancel and reprepare without duplication. | Prior history preserved. | local+staging (partial) | — | — | **PASS** (partial) | BLOCKED |
| H-I | Repeat repair/install billing. | **Lead estimate; returning-customer estimate with no new lead; invoice with equipment and warranty snapshot (N-01); issue; partial receipt.** | No fake lead; issued document linked to the right work. | local+staging | G-12 (office review), G-13, G-02 signed scope; G-01/deposit collection owner-DEFERRED | O-17 | **PASS** (email delivery tracked under P-I/N-03) | BLOCKED |
| H-J | New inquiry and CALLIE. | **Site activation, inquiry, duplicate, coverage, claim, after-hours routing (as P-B/P-C).** Missed-call CALLIE paths. | Inquiry arrives in the HVAC org with its own policy. | local+staging; provider (CALLIE) | G-10, G-11, G-09 | O-15, O-16 claim rule, O-07/O-08 | **PASS** (website/routing slice) | BLOCKED |
| H-K | Growth, email and phones. | **Cross-tenant isolation; manual SMS drafts.** Mailbox receipt, reply, revocation; phone notifications. | Per-phone notification, deep link, logout and manual SMS pass. | device/provider | G-17, G-16 | O-04/O-05, O-11, O-25 | **FAIL** (same `no_sms_consent` finding as P-D) | BLOCKED |
| H-L | Unassisted handover and continuity. | Office and technician complete the day uncoached. | Sign-off. | people only | — | O-24 | NOT-RUN | NOT-RUN |

## G-04 / G-06 supplements

| ID | Observation | Automated step | Auto | Blocking | Local 10-16 | Staging 10-16 |
| --- | --- | --- | --- | --- | --- | --- |
| G04-01 | Confirm exact company scheduling policy | — (needs company values; never install the 2h/3h/1h guesses) | owner | O-15, CSS durations/helper | **BLOCKED** (owner input) | BLOCKED (`org_settings.scheduling_policy` column missing) |
| G04-02 | Create and reschedule a native visit/project | **Create visit, reschedule, count active visits** (both TEST companies) | local+staging | — | **PASS** (visit; project NOT-RUN) | BLOCKED |
| G04-03 | Saved travel/capacity conflict | **Overlapping same-technician visit → 409 `resource_conflict`** | local+staging | approved buffer/capacity values | **PASS** (overlap only; travel buffer not configured) | BLOCKED |
| G04-04 | Reconcile uncertainty / preserve saved history | — | staging w/ approved scenario | bounded reconciliation authority | NOT-RUN | NOT-RUN |
| G04-05 | Install, major-repair and helper work | — | owner + capability | CSS install/helper requirements | **BLOCKED** (helper has no account; resource model unconfirmed) | BLOCKED |
| G06-01 | Deliver exact estimate by email | **Estimate delivery PREVIEW (send never called)** | staging + approved inbox | O-03, O-04/O-05 | **BLOCKED** (409 `estimate_sender_unavailable`) | BLOCKED |
| G06-02 | Text/SMS estimate delivery | — (capability absent) | — | G-06/G-13 capability | **BLOCKED** (capability) | BLOCKED |
| G06-03 | Documents, photos and report with estimate | — (capability absent) | — | G-13 | **BLOCKED** (capability) | BLOCKED |
| G06-04 | Revision, resend, failure, unknown effect | — | staging | supported resend semantics | NOT-RUN | NOT-RUN |

## Totals (case level, 33 cases)

| | PASS | FAIL | BLOCKED | NOT-RUN |
| --- | --- | --- | --- | --- |
| Local automated slice, Oct 16 | 17 | 2 | 8 | 6 |
| Staging, Oct 16 (read-only smoke) | 0 | 0 | 27 | 6 |

The local check-level results are in `workday-local-results.json`: 62 checks,
54 PASS, 2 FAIL and 6 BLOCKED. The FAILs are the GAP-02 manual-SMS consent
finding. The BLOCKEDs are the sender-dependent previews.

Local PASS cases: P-A, P-B, P-C, P-E, P-F, P-G, P-H, H-A, H-B, H-E, H-F, H-G,
H-H, H-I, H-J, G04-02 and G04-03.

These historical API-slice totals stay 17/2/8/6. P-G/H-G UI completion is a separate
NOT_RUN subclaim, not an invented product failure. Cross-tenant API 404 is retained;
the spinner image is not independent settled UI-refusal proof. Original P-E/H-E,
G04-02 and N-02/balance entries remain author-recorded observations: the old
predicates checked identifiers/count upper bounds/label survival/2xx, with the
observed one visit and $230 balance. They did not establish the stronger exact
lineage, whole-document and required-cents invariants now enforced for future runs.

Contractor card/bank collection (G-01 and deposit collection) is explicitly
owner-DEFERRED for initial launch under AGENTS.md. It is not required for the
permitted P-I/H-I accounting slice. Signed-scope approval (G-02), invoices, delivery,
exact balances and truthful external receipts remain separate requirements; P2
engineering classification cannot waive either company's actual required workflow.

## Re-running locally

```powershell
cd C:\Forge\worktrees\growthos-claude-acceptance-20261016
node scripts/local-dev.mjs setup
# From committed clean reviewed harness source; builds both API and frontend.
# Credentials/site keys remain in the owning runtime process, never in evidence.
node scripts/acceptance/acceptance-runtime.mjs --run
```

Each run needs a fresh runtime because the HCP import expects an empty TEST org.
For staging, see `STAGING-RUN.md`.

**No case is company-accepted.** Every row still needs its real-world evidence
and its named approver.
