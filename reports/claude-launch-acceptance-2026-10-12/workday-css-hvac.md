# Full-workday acceptance script: Climate Simulation Solutions (HVAC)

**October 27 scope correction:** The October 9 intake requires payment collection
preparation for the switch. Older payment-deferral labels in this packet must
not exempt collection, deposits, progress payments or financing from acceptance;
signed approval is a separate requirement. Current blockers and evidence:
[CSS readiness](../css-onboarding-readiness-2026-10-27.md). No live workflow was
executed or accepted by this correction.

**Card status: NOT ACCEPTED** (`HOUSECALL-PRO-REPLACEMENT-GATE.md:125-139`).
Running this script does not change that status. Only the company owner, the
office/field representatives and Adam can accept the card, and only after every
required row is Passed with evidence or explicitly accepted as a manual
substitute.

**Workflow source.** The workflows come from the October 9 owner interview,
`C:\Forge\CSS_OWNER_INTAKE_2026-10-09.md` (cited as `CSS:N`). That intake is
private. Do not copy its names or contact details here; use role labels only.

**Roles**

| Role | Who it is |
| --- | --- |
| **Owner-Tech** | The owner. Does the field work and runs service calls with a helper. |
| **Office Lead** | Handles scheduling, invoicing and customer communication. |
| **Helper** | Has no GrowthOS account (`CSS:15-17`). |
| **Test customer** | An authorized, consented test person. Never a real customer without separate approval. |

**Devices.** iPhones only. Waiting for connectivity is acceptable, so offline
work is not a blocker (`CSS:18-19`).

**Before starting**, all of the following must be complete. If any is missing,
record the row as **Blocked-on-owner**.

- O-13: the source export.
- O-15: hours and timezone.
- O-24: both accounts accepted.
- O-25: devices and test recipients.
- The provider cases each step depends on.

**Columns:** Actor · Screen in GrowthOS · Expected outcome · Evidence · Known
gap. Add a Status column (legend in [README.md](README.md)) when you print the
script.

## Card line 1: Migration reconciles customers, properties, equipment, history, open work, agreements and balances (`HOUSECALL-PRO-REPLACEMENT-GATE.md:133`)

| # | Actor | Screen | Expected outcome | Evidence | Known gap |
| --- | --- | --- | --- | --- | --- |
| C1.1 | Adam + Office Lead | Off-system: Housecall Pro export inventory | Every export listed in O-13 is received. Counts recorded per domain | Private export manifest with counts | — |
| C1.2 | Operator | Win-back (CSV), Service Desk (customer/service CSV), Financial migrations | Contacts, properties and service rows load with their provenance; normalized invoices and opening balances reconcile to the source to the cent | Import/exception reports, balance tie-out | **G-05**: no open-job, appointment, media, equipment or communications loader |
| C1.3 | Office Lead | Customer → Service & equipment | Spot-check 10 customers against Housecall Pro: completed jobs **and their original values** are present (`CSS:178-181`) | Side-by-side screenshots (redacted) | **G-05** |
| C1.4 | Adam + Owner-Tech | — | Cutoff date, one writer per domain, rollback/export rehearsed (O-14) | Signed cutoff record | — |

## Card line 5: Phone intake, website and after-hours (`HOUSECALL-PRO-REPLACEMENT-GATE.md:137`)

| # | Actor | Screen | Expected outcome | Evidence | Known gap |
| --- | --- | --- | --- | --- | --- |
| C5.1 | Test customer → Office Lead | Phone; Calls | The call is answered or, if missed, CALLIE takes intake and creates one office task with an owner and deadline (V-01 to V-03). Current practice is a callback in about 30 minutes; this is not a promise (`CSS:39-42`) | Task ID, call record | — |
| C5.2 | Office Lead | Calls → original task → link or create the customer | Name, service address, phone and email are entered once. No duplicate customer | Customer record | — |
| C5.3 | System | — | **Required:** a customer-details confirmation text with a link to a short correction form (`CSS:61-63`) | — | **G-09** |
| C5.4 | Test customer | Phone | **Required:** an urgent problem (leak; no heat or cooling in extreme weather) is triaged and alerts **both** owners; if neither responds, the customer is scheduled and a confirmation text follows (`CSS:43-54`) | V-12 | **G-10** |
| C5.5 | Test customer | Phone (outside Mon–Fri "seven to five"; timezone set in O-15) | **Required:** a text alert to both owners and an automatic reply to the customer (`CSS:55-60`) | A-05 | **G-11** |
| C5.6 | Owner-Tech, Office Lead | iPhone lock screen → lead | If CSS uses website capture, a new lead alerts both owners (P-02 to P-07). The claim rule for CSS is **not decided**; do not copy Painless's rules (`CSS:47-49`) | Coverage screen | Decision O-16 |

## Card line 4: Scheduling, confirmation, conflict and reschedule (`HOUSECALL-PRO-REPLACEMENT-GATE.md:136`)

| # | Actor | Screen | Expected outcome | Evidence | Known gap |
| --- | --- | --- | --- | --- | --- |
| C4.1 | Office Lead | Appointments → new visit → choose the property explicitly | A 2-hour diagnostic is booked for Owner-Tech at a time that suits the customer. The end time is entered manually | Appointment ID | **G-04**: no duration defaults |
| C4.2 | Office Lead | Appointments | A 3-hour maintenance visit is booked the same day with about 1 hour of travel between visits. An overlapping booking is refused with an explanation | Conflict message | **G-04**: no travel capacity; leave the 1-hour gap by hand |
| C4.3 | System → Test customer | — | **Required:** an appointment confirmation text asking yes/no (`CSS:36-38`). A booked-appointment reminder exists; a reply is not captured as a confirmation | Handset | **G-08** |
| C4.4 | Office Lead | Appointments | No response: staff calls, puts the visit on hold and reschedules. Rescheduling makes the old reminders obsolete; no duplicate visit | Appointment history | **G-08** (hold state) |
| C4.5 | System | — | **Required:** an "on the way" text (`CSS:84-85`) | — | **G-16** |

## Card line 3: Technician completes the visit; one next service (`HOUSECALL-PRO-REPLACEMENT-GATE.md:135`)

| # | Actor | Screen | Expected outcome | Evidence | Known gap |
| --- | --- | --- | --- | --- | --- |
| C3.1 | Owner-Tech (owner/admin) | Service Desk → Company checklists | The CSS diagnostic and maintenance checklists are saved, reviewed and approved (starter text is a suggestion only) | Approved revision | — |
| C3.2 | Owner-Tech (iPhone) | Appointment → Open visit work | A work entry is prepared for each unit (for example, two systems) with the reviewed checklist and the exact equipment | Entry IDs | — |
| C3.3 | Owner-Tech | Open visit work | Diagnostic notes, findings, problems and solutions are recorded; progress is saved. JPEG/PNG/WebP photos up to 10 MiB attach to items. Photos must show "attached", not "reserved" | Screenshots | Note: no HEIC. Check the iPhone camera format |
| C3.4 | Owner-Tech | Customer → Service & equipment → Open equipment & assets | Newly installed equipment and major components are recorded with **warranty start/end dates and their source reference** (`CSS:110-112`). GrowthOS does not derive entitlement | Asset record | — |
| C3.5 | Owner-Tech | Open visit work → Complete saved visit work → Review → Record | One reviewed completion. Only the service occurrences actually performed are completed. Exactly one next occurrence is created from the approved recurrence. No new appointment, message or invoice is created automatically | Completion record, next-occurrence link | — |
| C3.6 | Office Lead | Completion record | A "needs attention" finding creates an accountable office follow-up with a deadline | Task | — |
| C3.7 | Office Lead | Appointments / Service Desk | Cancellation, no-show and a month-end due date (for example, Aug 31 + 6 months) behave correctly | Records | — |

## Card line 4 (continued): Invoice, delivery and receipts

| # | Actor | Screen | Expected outcome | Evidence | Known gap |
| --- | --- | --- | --- | --- | --- |
| C4.6 | Owner-Tech | Invoices (customer work) → draft → issue | A simple maintenance invoice is issued by the tech. The number is stable and the issued content is preserved | Invoice ID | — |
| C4.7 | Office Lead | Invoices | A multi-repair invoice is written up and reviewed by the office **before** it is issued (`CSS:68-70`). The system does not enforce this; anyone with `invoices.manage` can issue | Process note | **G-12** (manual substitute needs explicit acceptance) |
| C4.8 | Office Lead | Invoices | The description is in clear wording. If AI drafting is used, it must contain only the actual part and the quoted price; no invented work or prices (`CSS:71-73`) | Reviewed text | — |
| C4.9 | Office Lead | Invoices → delivery | The issued invoice is emailed from the selected sender and arrives (I-01) | Inbox | — |
| C4.10 | Office Lead | — | **Required:** warranty-validity dates on the invoice (`CSS:77`) | — | **G-03** |
| C4.11 | Office Lead | — | **Required:** photos plus an assessment report with the invoice; invoices or estimates by text (`CSS:75-77`, `CSS:84-86`) | — | **G-13** |
| C4.12 | Office Lead | Invoices → payments/refunds | A partial cash/check receipt, a refund and a correction give exact balances (I-05) | Balance screenshots | — |
| C4.13 | Test customer | — | **Required:** card, phone or payment-link collection (October 9 scope change, `CSS:117-139`). **No real payment may be taken** | — | **G-01** |
| C4.14 | System | — | **Required:** invoice payment follow-ups (`CSS:84-85`) | — | **G-16** |

## Card line 4 (continued): Repair or installation estimate

| # | Actor | Screen | Expected outcome | Evidence | Known gap |
| --- | --- | --- | --- | --- | --- |
| C4.15 | Owner-Tech | Customer → estimate (customer work) | A line-item estimate is created for a repeat customer without creating a fake lead | Estimate ID | — |
| C4.16 | Office Lead | — | **Required:** the estimate is delivered to the customer by email and text | — | **G-06** |
| C4.17 | Test customer | — | **Required:** signed approval; deposit; progress payments; financing (`CSS:123-127`) | — | **G-02** |
| C4.18 | System | — | **Required:** if the estimate is unanswered, 3 reminders 24 hours apart starting 24 hours after sending, by text **and** email; then a staff phone-call task (`CSS:88-94`). Stop rules are still to be defined | — | **G-07**; decision O-17 |

## Card line 2: Maintenance and warranty due date → reminder → reply → appointment (`HOUSECALL-PRO-REPLACEMENT-GATE.md:134`)

| # | Actor | Screen | Expected outcome | Evidence | Known gap |
| --- | --- | --- | --- | --- | --- |
| C2.1 | Office Lead | Service Desk → service → approve recurrence | Residential: every 6 months. Commercial: every 3 months. A real agreement note is recorded; no invented agreement | Recurrence record | — |
| C2.2 | Owner-Tech (owner/admin) | Service Desk → Customer care & booking → Review automatic series reminders | The standing reminder is approved with a notice lead time of about 1 month (exact days per O-18), within finite agreement dates. Approval ≠ sent | Approved review | — |
| C2.3 | System → Test customer | — | The reminder is sent on the approved channel after the notice date (S-01 or E-02); quiet hours apply | Receipt + arrival | — |
| C2.4 | Owner-Tech (owner/admin) | — | **Required:** the reminder by **both** text and email (`CSS:102`) | — | **G-14** |
| C2.5 | Test customer → Office Lead | Review service SMS / mailbox reply evidence → Record customer response → Book confirmed visit | The reply is linked or held. Staff talk to the customer, then book a conflict-checked visit. An ambiguous reply is never a booking | Appointment ID | — |
| C2.6 | Office Lead | Service Desk | No response, opt-out, expired agreement and a missed office deadline each show a visible exception with an owner (MAINTAIN watch) | Watch cases | — |
| C2.7 | Office Lead | — | **Required:** shift a residential due date after major service; annual plan billing (`CSS:105-109`) | — | **G-15** |
| C2.8 | Office Lead | Service Desk (warranty check) | A warranty follow-up uses only the recorded dates and evidence. No coverage decision is made by GrowthOS | Record | — |

## Card lines 6–7: Mailbox, phones and cutover sign-off (`HOUSECALL-PRO-REPLACEMENT-GATE.md:138-139`)

| # | Actor | Screen | Expected outcome | Evidence | Known gap |
| --- | --- | --- | --- | --- | --- |
| C6.1 | Office Lead | My Profile → My Connections | The selected mailbox passes E-01 to E-05 (Gmail) or E-07 to E-09 (Microsoft) | Case results | **G-17** for Gmail replies |
| C6.2 | Owner-Tech, Office Lead | iPhones | P-01 to P-09 pass on both phones | Case results | — |
| C7.1 | All + Adam | Today, Invoices, Service Desk | An uncoached end-of-day review: overdue work, failed or uncertain sends and open exceptions are all visible with an owner | Time, wrong turns, help requests | — |
| C7.2 | Owner-Tech, Office Lead, Adam | — | Written acceptance of each required workflow, or an explicit acceptance of each manual substitute. Housecall Pro cancellation is a separate later owner action | Signed record | — |
