# GrowthOS launch acceptance packet — October 12, 2026

Prepared October 11–12, 2026 against PR #35 head `87adc3e`. This is documentation
only. **It closes no launch item.** Each launch item (L1–L11) and each contractor
card stays open until a dated, evidenced result is recorded and the named
approver accepts it. Status values come from `LAUNCH-COMPLETION.md:49-61` and
`HOUSECALL-PRO-REPLACEMENT-GATE.md:102-139`; this packet does not change them.

## Purpose

This packet gives Adam (the owner) and both contractor companies one set of
real-world tests to run:

- **Painless Roofing and Water Restoration** (roofing/restoration).
- **Climate Simulation Solutions (CSS)** (HVAC).

The tests prove whether GrowthOS can replace each company's actual Housecall Pro
work. They also mark the places where the source code does not yet do what a
company asked for. A tester who reaches one of those places records a **known
gap**. The tester does not improvise a workaround or skip the step without
recording it.

## Files

| File | Use it for |
| --- | --- |
| [provider-device-cases.md](provider-device-cases.md) | Numbered tests for each provider and device: email, SMS, voice/CALLIE, staff push, after-hours and invoice delivery. |
| [workday-css-hvac.md](workday-css-hvac.md) | The full-workday script for CSS, mapped to its acceptance card and the October 9 intake. |
| [workday-painless-roofing.md](workday-painless-roofing.md) | The full-workday script for Painless, mapped to its acceptance card and routing decisions. |
| [source-gap-map.md](source-gap-map.md) | Each requirement mapped to its implementation evidence or a known gap ID (`G-nn`). |
| [owner-input-checklist.md](owner-input-checklist.md) | The exact decisions, accounts, exports and devices only the owner or a company can supply. |

## How to use

1. **Start with the owner inputs.** Find the case in `owner-input-checklist.md`.
   If any blocking input for that case is missing, record the case as
   **Blocked-on-owner** and do not start it.
2. **Fix the release under test.** Record the exact commit, schema table count,
   environment (local preview, held staging or production) and tenant. A local
   or synthetic run is never evidence of hosted or provider acceptance
   (`HOUSECALL-PRO-REPLACEMENT-GATE.md:57-63`).
3. **Run the provider/device cases** that a workday step depends on, before
   running that step.
4. **Run each workday script** with the company's real office and field people,
   without coaching (`BETA-CONTRACTOR-SUCCESS.md:25-41`). Record time taken,
   wrong turns and requests for help.
5. **Record a result in every row.** Leave nothing blank. The approver signs
   each card section.

## Status legend

| Status | Meaning |
| --- | --- |
| **Not run** | The test has not been attempted. This is the default for every row. |
| **Passed with evidence** | The expected outcome was observed and the evidence below is stored. A result without evidence counts as Not run. |
| **Failed** | The test was attempted and the expected outcome was not observed, or an unexpected effect occurred (wrong company, wrong recipient, duplicate, contact after opt-out). |
| **Blocked-on-owner** | A required account, credential, decision, export, recipient or device is missing. Name the item from `owner-input-checklist.md`. |

**Known gaps.** A step marked **KNOWN GAP G-nn** depends on behavior that
`source-gap-map.md` shows is not implemented, or was not found during this
packet's source review. These steps can never be Passed:

- Record **Failed — known gap G-nn** if you attempted the step.
- Record **Not run — known gap G-nn** if you did not attempt it.

A manual substitute for a known gap counts only if the owner accepts it
explicitly and in writing (`LAUNCH-COMPLETION.md:42-46`). Do not rename a
missing feature as a "testing gate".

## Evidence rules

For every executed row, record the fields that
`HOUSECALL-PRO-REPLACEMENT-GATE.md:145` requires:

- the company
- the requirement
- the release/schema
- the authorized identities, by role
- the timestamp and timezone
- whether the evidence is synthetic or real
- the provider receipt, where one applies
- the independently observed outcome
- the exception and recovery result
- the named approver

**What counts as evidence**

- Screenshots or screen recordings of the GrowthOS screen and of the receiving
  device or inbox. Browser recordings and traces remain disabled unless Adam
  explicitly opts in for that test.
- A provider receipt or message ID, a GrowthOS audit event or record ID, and a
  short note from a person who saw the result.
- Provider **acceptance** (HTTP 2xx, `202 Accepted`, a push `accepted`) is not
  delivery, display or reading (`STAFF-PUSH-PILOT.md:120-122`,
  `MOBILE-EMAIL-PILOT.md:91-93`). Record acceptance and the observed arrival
  separately.

**Where evidence goes**

- Raw screenshots, recordings, exports and receipts go in a **private** location
  outside Git. Use the existing private artifact convention, for example
  `C:\Forge\artifacts\growthos-launch-acceptance-<date>\`.
- The repository may hold only redacted results tables: role names, a truncated
  or hashed record/provider ID, the status and the private evidence filename.

**What must never enter the repository, a screenshot or a chat log**

- Passwords, OAuth client secrets, API keys, tokens, VAPID private keys,
  Twilio auth tokens or webhook secrets.
- Customer or staff names, phone numbers, emails, street addresses, message
  bodies, photos of people or property, or invoice amounts tied to a real
  customer.
- Card, bank or payout data of any kind. GrowthOS must not collect these during
  testing.

Use role labels in all written records: "CSS Owner-Tech", "CSS Office Lead",
"Painless Owner A", "Painless Owner B", "Painless after-hours owner", "Test
customer 1". The private intakes hold the real identities and stay outside
this repository.

**Stop and preserve**

Stop a test immediately if any of these happens:

- data from the wrong company
- the wrong sender or recipient
- a duplicate or unexpected send
- contact after an opt-out
- an unknown provider result

Then hold sends, keep the record and receipt IDs, and escalate
(`PILOT-OPERATOR-RUNBOOK.md:89-93`). Never delete evidence, and never replay an
uncertain action to make a test pass.

## Authority boundaries

This packet authorizes nothing. Each of the following needs its own explicit
owner approval for that specific action:

- sending to a real customer
- activating a provider or a phone number
- changing forwarding
- applying a hosted schema
- creating a paid resource or a managed restore
- charging money or collecting a payment
- importing real data
- cancelling Housecall Pro

Contractor payment collection is back in engineering scope as of October 9
(see G-01). No processor is selected and no payment may be taken in testing.

## Review baseline and integration lane

The October 11 Forge control-plane record already reports the original staging
95-to-142 migration and held private runtime as passed. Production binding,
encrypted recovery custody and a read-only 75-table baseline are also recorded;
an actual PostgreSQL backup restoration and production migration/cutover remain
separate gates. These earlier results do not mark any case in this packet run.
Consult the current `C:\Forge\CONTROL_PLANE.md` and its dated receipts before
deciding which further recovery operation is necessary. Do not repeat a
completed migration, runtime attempt or consumed paid-resource grant.

This draft is launch-supporting documentation beside the #33 → #34 → #35
integration stack. It must not block or complicate PR #35 or production cutover.
Its gap register remains visible for the separately required contractor
acceptance decision; this packet neither changes that decision nor authorizes
a merge, deployment or hosted operation.
