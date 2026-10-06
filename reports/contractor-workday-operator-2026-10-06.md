# Contractor Workday Completion — operator guide

October 6, 2026. This guide describes the bounded source implementation under
`contractor-workday-contract-2026-10-06.md`. It is not a declaration that the
feature is deployed, that a real visit was performed, or that either contractor
has accepted GrowthOS as a replacement for its current system. Use the final
integration/release report for exact tested source and evidence.

## What this adds

GrowthOS can keep structured equipment or roof-area records on a customer's
property, apply company-reviewed checklists to an existing appointment, save
technician observations and private photos, and record one reviewed completion.
One visit can have several separate work entries, such as two HVAC units or
multiple roof areas. The original appointment and customer remain the source of
truth; this does not create an acquisition lead just to service an existing customer.

The existing screens are used:

| Need | Where to go |
| --- | --- |
| Record equipment or roof areas | Customer → **Service & equipment** → **Open equipment & assets** |
| Create/review company instructions | **Service Desk** → **Open company checklists** |
| Prepare, record and complete work | Open the exact appointment → **Open visit work** |
| Continue a selected service occurrence | **Open this service**, **Open completed occurrence** or **Open next service occurrence** |
| Handle a recorded finding | **Open office follow-up** on the completion record |

The customer page is `/contacts/:id?organizationId=...`; an exact visit uses
`/appointments?appointmentId=...&organizationId=...`. Open links from the correct
signed-in company. Changing a URL is not permission to switch companies.

## Before using this for a real contractor

An owner/administrator must review the contractor's actual procedures and the
applicable release/activation gates. HVAC and roofing starters are suggestions,
not manufacturer instructions, warranty requirements, code/insurance decisions
or approved company procedures. Prepare and approve each company's own revision.

Use current accepted, verified and active staff accounts. Reading, managing
company checklists and recording work have different permissions:

- Owners/administrators with settings authority can approve company instructions.
- Field work requires the current assigned accepted performer and CRM write access,
  or authorized owner/admin/office staff explicitly recording on that performer's
  behalf. Enter the **Office acting-on-behalf note** when shown.
- An unassigned sales manager does not acquire office attestation authority.
  Read-only staff cannot change the work. API keys do not authorize these human
  work attestations.
- Entry cancellation has separate office authority. Permission to record field
  progress does not itself permit cancelling prepared evidence.

Do not enter a fictional technician to bypass an assignment hold. Resolve actual
membership/assignment in the native staff and schedule workflow first.

## 1. Record the property's equipment or roof areas

Open the customer's **Service & equipment** section, then **Open equipment & assets**.
Choose **Add equipment or asset** and explicitly select the correct property.
Even a customer with only one property requires a choice; use the property
selector's next page if the correct address is not initially visible.

Choose the category and a useful recorded label. Manufacturer, model, serial,
location, installation date, notes and custom attributes are optional facts.
Leave unknown information blank. If you record warranty dates, supply their
actual source reference and a valid date interval; GrowthOS does not verify
eligibility or turn those dates into a service agreement.

Use **Save recorded asset**. An asset belongs to its original customer/property;
editing facts does not move it or rewrite earlier visit snapshots. **Save edits
and retire this asset** removes it from new selection while preserving history.
Do not relabel an old service record merely to make it resemble the new asset:
historical free-text equipment labels remain separate until an explicit work
entry is prepared.

Asset pages load 25 records at a time. **Load more customer assets** means another
bounded page, not a whole-company total.

## 2. Save and approve company checklists

In **Service Desk**, open **Company checklists**, then **Create company checklist**.
Start blank or choose a **Suggested baseline** and select **Copy selected baseline
into editable draft**. Review the name, trade, description and every item.

Each item has a stable key, label and response kind:

- **Result:** a staff-recorded outcome.
- **Text:** an actual observation or finding.
- **Number:** an observation with an explicitly reviewed unit; no automatic
  pass/fail threshold is inferred.
- **Photo:** evidence attached to that exact item, not merely a selected outcome.

Set required items deliberately. Enable N/A only where the company's procedure
allows it; N/A needs a reason. A checklist contains 1–50 items with unique keys.

1. Select **Save unreviewed revision**.
2. Select **Prepare exact company review**.
3. Read the saved revision displayed, then confirm the exact instructions.
4. Select **Approve reviewed revision** before its ten-minute review expires.

Unsaved edits cannot be approved. Editing after review, a different reviewer,
changed saved state or expiry requires a fresh review. A saved draft is not
approved just because it came from a researched starter.

Revisions are retained. New work uses the currently reviewed latest revision;
existing entries keep the revision they originally adopted. **Retire from new
work** requires a reason and confirmation and does not erase old instructions.
The catalog shows at most 100 templates and labels when that bound is reached.

## 3. Prepare the exact scheduled visit

Open the native appointment and **Open visit work**. Check the customer, property,
assigned performer and native status. Original scheduling notes are read-only
here; field observations do not overwrite them.

Under **Prepare another explicit work entry**:

1. Choose a **Company-reviewed checklist**.
2. Choose the exact **Equipment for this entry**, or explicitly choose **No
   equipment — non-equipment work**. A visit without a property cannot acquire
   equipment by guessing from a lead or label.
3. Optionally choose an **Already-linked service occurrence**. This must be a
   current service already attached to this appointment; it is not a new agreement.
4. Select **Prepare this visit entry**.

Prepare separate entries for separate units/areas; the limit is 20 retained
entries per visit. Preparation pins the recorded asset facts and reviewed
instructions. It does not complete the service or fill in answers.

## 4. Record progress and private photos

For each entry, record actual outcomes and observations. Required items must be
answered before completion. **Needs attention** requires a reason and an
accountable office follow-up at completion; permitted **Not applicable** requires
a reason. Do not mark a result solely to dismiss a warning.

Use **Save progress for [checklist name]**. The saved version is visible on the
entry. A draft is not proof of physical completion, and unsaved edits are not
stored offline. Save each entry before closing/navigating away or uploading photos.
Saving one entry preserves other units' unsaved drafts while the current scope
remains unchanged.

For photos:

1. Save outstanding field progress.
2. Choose the **Photo evidence item**, or general visit evidence.
3. Enter a caption and choose a JPEG, PNG or WebP file up to 10 MiB.
4. Select **Upload and attach private photo** and wait for the attached result.

The feature permits at most 50 photo reservations per visit. HEIC, SVG and video
are not supported by this work-photo flow. An upload reservation is not attached
evidence; **reserved**, **expired** or **unavailable** must not be presented as a
successful photo. Required photo items need an actual attached photo for that item.

These files use the exact authenticated visit-content route. They are not public
or customer-portal links and cannot be adopted through old lead-photo paths.
Uploading does not authorize marketing, AI analysis or video processing and does
not establish capture date, location, image truth or warranty compliance.

## 5. Review and complete once

Save every entry's progress, then use **Complete saved visit work**:

1. Record when the work was actually performed and a completion summary. Future
   performed times are refused. Check the timezone displayed beside the field.
2. Choose the outcome. If any saved observation needs attention, choose **Needs
   office follow-up**, an accepted owner, a future deadline and an explicit action.
3. Check only the **Service occurrences to complete** that were actually performed.
   Selection is optional; unchecked services are not marked performed by the visit.
4. Select **Review exact completion**. Review the saved entries, selected services,
   follow-up and warning. The native task state for every linked service is checked.
5. Confirm the saved work and choose **Record reviewed completion** before the
   ten-minute review expires.

Changing draft intent, answers, parent/asset facts, assignment, native task state
or selected services requires a fresh review. Do not use a generic appointment or
service **Completed** edit to bypass recorded work; use **Open visit work**.

A confirmed original completion seals the evidence and marks the native visit
completed in the same transaction. Only explicitly selected service occurrences
are completed. Their already-approved recurrence can create zero or one anchored
next occurrence. It does **not** create another appointment, infer a new recurrence,
enroll the new occurrence's asset, activate a reminder, send a message, issue an
invoice or collect payment. Existing uncertain sends remain owned and held.

Check the resulting **Recorded work completion**, **Native service outcomes**,
next-occurrence link and office follow-up. A visit can be complete while an
unperformed service remains active; the office can explicitly rebook that service
and prepare new work without changing the original visit evidence.

## 6. Correct or recover without rewriting history

**After completion:** use **Correction note** → **Append correction note** for
an attributed clarification. It cannot change original answers, performer, service
dates or replay completion. Earlier notes remain retained; the screen shows the
latest 25 corrections when there are more.

**Changed asset or parent while still a draft:** leave editing, photos and
completion held. Authorized office staff must review the change and explicitly
open **Cancel this entry**, enter the **Entry cancellation reason** and any
required office acting-on-behalf note, then select **Cancel this work entry**.
After the saved result, explicitly choose the reviewed checklist and equipment
again to prepare fresh work against the correct current facts. The old answers
are not copied. Cancellation preserves the old entry and does not cancel the
appointment or service. It is a distinct office permission, not automatic
replacement or permission to claim that old work was performed.

Cancelling an entry does not permit moving its visit history to another customer,
property or lead. Correct facts on the original record and prepare anew only when
the original lineage is still correct; use a separate visit for different parent
links. Completed evidence cannot be cancelled; use an append-only correction.

**Unknown or failed response:** the command may already have committed. Use the
screen's refresh/review action and inspect the original saved record before any
new action. Do not repeatedly click, clone the visit, create another request/key,
change equipment or delete evidence to force a retry. A successful byte upload
with no confirmed attachment is still not attached evidence. Escalate an unclear
result to the operator with the exact company/visit and displayed status, never
upload tokens or secrets.

**Refresh choices intentionally:** **Refresh visit work and discard unsaved
drafts** clears local unsaved work; **Refresh entry choices and clear selection**
clears the equipment/checklist choices. Unchanged background membership checks
do not intentionally reset drafts. Real logout, permission/company/member changes
or profile errors fail closed; sign back into the correct company and read the
saved record again.

## Export and retention limits

The bounded core business export includes recorded asset facts, checklist
definitions, work-entry answers/notes, projected completion/correction records and
photo metadata. It omits photo bytes, raw internal snapshots, staff/security data,
acting notes, request/retry identities and upload/preview capabilities. The
original checklist digest is checked before projection; a separate exported
definition digest describes the exported fields. This is not a complete-account
backup or a re-import/activation workflow.

Historical entries, revisions and completions are retained. Orphan cleanup must
not delete attached evidence; expired unused reservations may be cleaned up.
Retirement and note corrections are not deletion. Retention/expanded export,
hosted backup/restore and any data-erasure request require their separate reviewed
operator process.

## Acceptance checklist before contractor cutover

Use the final source/release report plus each contractor's separate replacement
card. This guide alone closes none of these gates:

- Exact-source PostgreSQL writer tests, full candidate/main CI and required
  image/build/parity checks; local PGlite skips are not concurrency proof.
- Reviewed hosted schema application and current backup/restore evidence.
- Built desktop/narrow-phone walkthrough: correct later-page property, multiple
  units/roof area, saved observations, exact private photo, held draft recovery,
  explicit service selection, attention follow-up, completion and correction.
- Real company procedure and service-agreement review, authentic customer/property/
  equipment data and authorized staff assignment.
- Separate mailbox, phone, Twilio/CALLIE, notification/device and customer-contact
  acceptance. Field-work completion does not activate those providers.
- Each contractor's complete real workday acceptance before replacing its current
  system. Payment collection remains deferred; no warranty, revenue or replacement
  guarantee follows from a checklist, test count or source release.

Source references: frozen contract, research report, runtime lane report and
current integration/release evidence in this reports directory. This guide was
written from the actual native UI and DTO/services, with GrowthOS Revenue Desk
authority/original-effect boundaries; it is not an independent execution receipt.
