# Provider and device acceptance cases

Every case starts as **Not run**. Use the status legend and evidence rules in
[README.md](README.md). The `O-nn` codes refer to
[owner-input-checklist.md](owner-input-checklist.md), and the `G-nn` codes to
[source-gap-map.md](source-gap-map.md).

**Shared preconditions for all cases (O-02, O-03)**

- The release and schema under test are recorded.
- The company tenant is isolated.
- The outbound hold and staging allowlist state are recorded.
- The test window, exact recipients, purpose, maximum sends and stop time have
  been approved before the first send.

The rehearsal controls are in `PILOT-OPERATOR-RUNBOOK.md:30-47`.

**What the evidence must show:** the GrowthOS screen or audit ID, plus the
provider receipt where one applies, plus what a person saw on the receiving
device or inbox. Keep provider acceptance and observed arrival as two separate
facts.

---

## Email

### E-01 Gmail connect, User A
- **Pre:** a staging Google Cloud project with the Testing audience. Test
  Gmail A is an allowlisted test user. The redirect matches the environment
  exactly (`GOOGLE-OAUTH-SETUP.md:56-80`).
- **Steps:**
  1. User A opens My Profile → My Connections → connect Gmail.
  2. User A grants consent.
  3. User A returns to GrowthOS.
- **Expect:** the settings page shows Gmail A. Only `openid`, `email`,
  `profile` and `gmail.send` are requested.
- **Evidence:**
  - a screenshot of the consent scopes
  - a screenshot of the connected status
  - the audit event ID
- **Blocking:** O-04, O-24.

### E-02 Per-user send isolation, two organizations
- **Pre:** E-01 for User A in Org 1. User B is connected to Gmail B in Org 2.
- **Steps:**
  1. User A executes one approved email to the test inbox.
  2. User B executes one approved email to the test inbox.
  3. Try to make User A send through User B's connection by tampering with the
     action or connection ID.
- **Expect:**
  - Each message arrives from its own sender.
  - The tampered request is refused.
  - Neither user can read the other's connection status.
- **Evidence:**
  - the provider message IDs
  - inbox screenshots showing the From address
  - the refusal response
  - Ref: `GOOGLE-OAUTH-SETUP.md:105-110`
- **Blocking:** O-03, O-04.

### E-03 Token refresh
- **Pre:** E-01 completed more than one hour earlier, so the access token has
  expired.
- **Steps:** send one approved email.
- **Expect:** the send succeeds without reconnecting. No token appears in logs
  or the database.
- **Evidence:**
  - the message ID
  - the inbox arrival
  - a log/database inspection note (`GOOGLE-OAUTH-SETUP.md:111-112`, `:119`)
- **Blocking:** O-04.

### E-04 Disconnect in GrowthOS
- **Steps:**
  1. User A selects Disconnect.
  2. Try a send as User A.
  3. Check Google Account → Third-party access.
- **Expect:**
  - The send is blocked visibly.
  - Google access is revoked.
  - User B is unaffected.
  - No fallback to any other mailbox.
- **Evidence:**
  - the blocked-send screen
  - a Google security page screenshot
  - Ref: `GOOGLE-OAUTH-SETUP.md:113-114`
- **Blocking:** O-04.

### E-05 Revoked from the Google side
- **Steps:**
  1. Revoke GrowthOS from Gmail B's Google Account.
  2. Try a send as User B.
- **Expect:** a visible failure and a provider-health record. No send from any
  other sender.
- **Evidence:** the failure screen and the health/audit ID (`GOOGLE-OAUTH-SETUP.md:115-116`).
- **Blocking:** O-04.

### E-06 Customer replies to a Gmail-sent message — KNOWN GAP G-17
- **Steps:** the test customer replies to the E-02 message.
- **Expect:** Gmail is send-only. GrowthOS will not see the reply
  (`GOOGLE-OAUTH-SETUP.md:22-23`). Record how staff found the reply and logged
  it manually.
- **Status:** cannot pass. Record **Failed** or **Not run — known gap G-17**.

### E-07 Microsoft 365 connect and send
- **Pre:** Azure first sign-in completed with the owner present. The existing
  app registration has been inspected; do not create a new account. Delegated
  `Mail.Send`, `User.Read` and `offline_access`, with the exact callback
  (`MOBILE-EMAIL-PILOT.md:74-96`).
- **Steps:**
  1. The owner connects the mailbox and selects Microsoft 365 / Outlook.
  2. Send one approved email.
- **Expect:** a `202 Accepted` is recorded as acceptance only. The message
  arrives in the test inbox.
- **Evidence:**
  - the acceptance record
  - an inbox screenshot
  - the request correlation ID
- **Blocking:** O-05, O-03.

### E-08 Microsoft tracked reply
- **Pre:** E-07. A test lead or service reminder was sent from that mailbox.
- **Steps:** the test customer replies.
- **Expect:**
  - The reply attaches to the correct lead or service item, with a hold or
    task for the responsible staff member.
  - An unrelated reply is held for review and not auto-linked.
- **Evidence:** the reply evidence screen and the task ID (L1, `LAUNCH-COMPLETION.md:51`).
- **Blocking:** O-05.

### E-09 Microsoft local disconnect
- **Steps:**
  1. Disconnect in GrowthOS.
  2. Try a send.
- **Expect:**
  - The send is blocked.
  - Pending flows are cancelled.
  - Remote Microsoft consent **remains**; a local disconnect does not revoke it
    (`MOBILE-EMAIL-PILOT.md:86-88`).
- **Blocking:** O-05.

### E-10 Platform mail: invitation, verification and reset (L2)
- **Pre:** a verified Resend sender. Test staff inboxes.
- **Steps:**
  1. Invite a staff member.
  2. Verify the email address.
  3. Request a password reset.
- **Expect:**
  - Each message arrives from the platform sender, never a customer mailbox.
  - The delivery ledger shows each attempt.
  - An uncertain attempt is not auto-retried.
- **Evidence:**
  - inbox screenshots
  - the ledger entries
  - Ref: `PAID-BETA-READINESS-P0.md:299-309`, `LAUNCH-COMPLETION.md:52`
- **Blocking:** O-06, O-25.

---

## SMS (Twilio)

**Shared preconditions for S-01 to S-08 (O-07)**

- The company's own Twilio binding, approved A2P/TFV registration, Messaging
  Service, Advanced Opt-Out and geographic permissions are in place.
- Each test recipient has given written consent for the specific test.
- See `TWILIO-CLIENT-READINESS.md:67-74` and `TWILIO-IMPLEMENTATION.md:102-109`.

### S-01 Consented outbound service SMS
- **Steps:** send one approved service SMS to a consented test handset.
- **Expect:**
  - The message comes from the company's number.
  - The provider SID is linked to the touch.
  - The delivery callback updates the status.
- **Evidence:**
  - a handset screenshot
  - the SID (truncated)
  - the GrowthOS status
- **Blocking:** O-07, O-25.

### S-02 Non-consented recipient
- **Steps:** try the same send to a test number with no recorded consent.
- **Expect:** blocked before dispatch. No provider call.
- **Evidence:** the block reason (`PAID-BETA-READINESS-P0.md:316`).

### S-03 Inbound reply
- **Steps:**
  1. The handset replies to S-01, including its service reference.
  2. The handset sends a second, natural reply without a reference.
- **Expect:**
  - The referenced reply links to the original reminder.
  - The unreferenced reply is held for office review.
  - Neither reply grants consent or books a visit.
- **Evidence:** the Service SMS evidence screen (`reports/standing-service-operator-guide-2026-10-03.md`, "Handle replies without guessing").

### S-04 STOP
- **Steps:**
  1. The handset sends STOP.
  2. Try a later send.
- **Expect:**
  - A suppression is recorded for this company only.
  - The later send is blocked.
  - The other company's tenant is unaffected.
- **Evidence:** the suppression record and the blocked send (`TWILIO-CLIENT-READINESS.md:73`).

### S-05 HELP
- **Steps:** the handset sends HELP.
- **Expect:** exactly one provider HELP reply (Advanced Opt-Out). The app does
  not send a duplicate.
- **Evidence:** a handset screenshot (`TWILIO-IMPLEMENTATION.md:58`).

### S-06 START
- **Steps:** after S-04, the handset sends START.
- **Expect:** only the STOP transport suppression is removed. Purpose consent is
  **not** restored, so a held service send stays held until fresh consent.
- **Evidence:** the consent/suppression state before and after.

### S-07 Quiet hours
- **Steps:** queue an approved customer SMS inside the company's quiet hours.
- **Expect:** the message is deferred with a resume time, not dropped and not
  sent (`api/services/send-gate.ts:351`). Staff alert hours are not customer
  hours (`MOBILE-EMAIL-PILOT.md:44-46`).
- **Blocking:** O-17 (CSS quiet hours), O-21 (Painless).

### S-08 Permanent versus transient failure
- **Steps:**
  1. Send to a known-invalid test destination.
  2. Simulate a transient failure where the provider allows it.
- **Expect:** a permanent error creates a suppression. A transient error does
  not, and is not auto-retried after an ambiguous acceptance.
- **Evidence:** the statuses (`PAID-BETA-READINESS-P0.md:322-324`).

### S-09 Manual phone drafts, no Twilio needed
- **Pre:** a staff iPhone and, if used, an Android phone. One consented test
  customer number.
- **Steps:**
  1. Open the lead.
  2. Select Reply from your phone.
  3. Open each of First response, Arrange a visit and Service follow-up.
  4. Select Open phone messages.
  5. Check the recipient and body, and test Copy message.
  6. Send only if the send is approved.
- **Expect:**
  - The recipient and body are prefilled, or Copy works.
  - Only `lead.manual_sms_prepared` is audited.
  - There is no "sent" claim and no change of stage.
- **Evidence:**
  - handset screenshots
  - the audit ID
  - Ref: `MOBILE-EMAIL-PILOT.md:48-72`
- **Note:** a reply or STOP sent to the staff phone is **not** synced. Record
  the manual logging step (G-18).
- **Blocking:** O-25.

---

## Voice and CALLIE

**Shared preconditions for V-01 to V-10 (O-07, O-08)**

- An approved voice binding for the company.
- The CALLIE policy has been reviewed and approved (Calls → How CALLIE handles a
  missed call).
- The ElevenLabs agent version and disclosure are recorded.
- The original staff route and fixed handoff targets are set, with no forwarding
  loop.
- The existing carrier forwarding has been saved and a revert plan is ready
  (`TWILIO-CLIENT-READINESS.md:76`, `:84`).
- Recording is off unless a separate approval says otherwise.

The full call matrix is in `reports/callie-conversation-operator-2026-10-05.md:149-160`.

| Case | Steps | Expected outcome | Evidence |
| --- | --- | --- | --- |
| V-01 Answered | Call the company number from an authorized test handset; staff answers | Rings the staff route; a signed call record is in Calls | Calls entry, call SID (truncated) |
| V-02 Missed → intake | Call; staff does not answer; the caller gives a name, location, problem, urgency and callback preference | One original office task with an accountable owner and deadline. Caller statements are labeled unverified. No customer or lead is created automatically | Task ID, CALLIE queue screenshot |
| V-03 Busy / failed / unreachable | Repeat with the staff line busy, then unreachable | Each produces one callback task. No SMS is sent unless the keypad mode's one-call conditions are met | Task IDs |
| V-04 Staff voicemail | Let the staff leg go to voicemail | A completed Dial is recorded only as a "phone answer", **not** human acceptance; the office task stays open | Evidence table, `reports/callie-conversation-operator-2026-10-05.md:109-118` |
| V-05 Handoff success | Ask for a human during the conversation | One redirect attempt to the reviewed fixed target. Accepted ≠ answered | Handoff evidence row |
| V-06 Handoff failure | Make the handoff target unavailable | No second attempt. The office task remains with its owner | Task, attempt record |
| V-07 Interrupted intake | Hang up mid-conversation | Partial facts are retained, the task still exists, no replay | Task |
| V-08 After-hours call | Call outside approved hours | Routes to the after-hours owner per the policy. No promised arrival time | Policy screenshot, task owner |
| V-09 Returning customer | Staff handles the V-02 task for an existing test customer | Staff links the existing customer explicitly. A visit is booked only through the native booking action; an agent-suggested time is not a booking | Linked customer, appointment ID |
| V-10 Rollback | Apply the pre-approved carrier revert | Normal business calls are restored and the client voice is disabled. Uncertain operations are preserved | Revert time, test call |
| V-11 Keypad one-call text (only if keypad mode is chosen) | Missed call; the caller presses the option | At most one acknowledgment text, caller-originated. This is not general consent | Message SID, `reports/callie-intake-operator-guide-2026-10-03.md` |
| V-12 CSS urgent call — **KNOWN GAP G-10** | Caller reports an urgent example (water leak; no cooling in heat) | Required: alert both owners; if neither responds, schedule and send a confirmation text. Not implemented. Record what actually happened | Failed or Not run — G-10 |

**Blocking:** O-07, O-08, O-25 (authorized test handsets); for CSS also O-15 and O-16.

---

## Staff push alerts (iPhone)

**Shared preconditions for P-01 to P-10**

- Push is enabled for the approved environment, with exact allowlisted user IDs
  (O-11).
- The tenant policy is saved under Settings → Scheduling → New-lead phone
  alerts.
- Each owner has an iPhone on iOS/iPadOS 16.4 or later.

References: `STAFF-PUSH-PILOT.md:31-55`, `:149-155`; `MOBILE-EMAIL-PILOT.md:20-46`.

| Case | Steps | Expected outcome | Evidence |
| --- | --- | --- | --- |
| P-01 Install and opt in | Each owner opens Safari → Share → Add to Home Screen, opens the tile, then My Profile → Enable lead notifications | The permission prompt appears only after the tap. The device appears in that owner's status | Screenshots for each owner |
| P-02 Daytime lead, both owners | Submit one approved labeled test inquiry during business hours | The coverage record lists **both** owners as `queued`. Both phones show a generic notice with no customer details | Coverage screen, both lock screens |
| P-03 Locked phone | Repeat P-02 with both phones locked | The notice appears on the lock screen | Photo of each lock screen, with the time |
| P-04 Background / Focus | One owner with the app backgrounded, the other in Focus mode | Record what was observed. Focus may suppress display; provider `accepted` ≠ seen | Screenshots, delivery receipts |
| P-05 Offline | Phone in airplane mode → lead → reconnect after 5 minutes; then repeat with more than 15 minutes offline | The 5-minute alert arrives late or not at all (record which). After 15 minutes the alert has expired, with no flood | Receipt state (`STAFF-PUSH-PILOT.md:116-118`) |
| P-06 Tap-through | Tap the notice; repeat with an expired session; repeat while signed into another company | Opens the exact lead in the correct company. After login it returns to the same lead. A different company is blocked, with no tenant switch | Screenshots |
| P-07 One claim | Both owners open the lead; A claims; B tries to claim | A owns the lead. B sees it as claimed and cannot take it. A concurrent claim produces a conflict, not a takeover | Lead ownership panel, audit ID |
| P-08 Missing device | Remove one owner's device, then create a lead | Coverage shows `no_eligible_device` for that owner; the owner is not silently omitted | Coverage screen (`reports/lead-alert-coverage-contract-2026-10-09.md:21-37`) |
| P-09 Logout / switch | Log out on one phone; create a lead | No alert to that device. The opt-in marker is erased | Status, coverage |
| P-10 Replay | Resubmit the identical Smart Site inquiry | No second lead and no second alert | Lead count, coverage |

**Blocking:** O-11, O-21 or O-16 (routing), O-24, O-25.

---

## After-hours

| Case | Steps | Expected outcome | Evidence |
| --- | --- | --- | --- |
| A-01 Painless after-hours lead | Approved test inquiry outside Monday–Saturday 09:00–18:00 America/New_York | Only the designated after-hours owner (named in the private intake) is alerted | Coverage, lock screen (`HOUSECALL-PRO-REPLACEMENT-GATE.md:108-110`) |
| A-02 Boundaries | Leads at exactly 09:00, at 17:59, at 18:00, on Sunday, and on a DST-change date if one falls in the test window | Opening time is inclusive, closing time exclusive; Sunday uses the after-hours set | Coverage for each (`STAFF-PUSH-PILOT.md:72-77`) |
| A-03 After-hours call | Covered by V-08 | — | — |
| A-04 Customer contact after hours | Queue an approved customer message after hours | Deferred by quiet hours. 24-hour service ≠ permission to message customers at any hour | Deferral record |
| A-05 CSS after-hours text alert + auto-reply — **KNOWN GAP G-11** | Test call or inquiry outside CSS hours | Required: text both CSS owners and auto-reply to the customer. Alerts are Web Push only, and there is no conversational auto-reply text | Failed or Not run — G-11 |

**Blocking:** O-15 (CSS hours/timezone), O-21 (Painless), O-25.

---

## Invoice delivery

| Case | Steps | Expected outcome | Evidence |
| --- | --- | --- | --- |
| I-01 Email an issued invoice | Issue a test invoice, then send it via the selected company sender to the test inbox | Plain text matching the issued document; acceptance recorded; arrival observed | Inbox, attempt record |
| I-02 No sender connected | Disconnect the selected sender, then try the send | Refused with "No alternate mailbox will be used" (`api/services/invoice-delivery.ts:113`) | Screen |
| I-03 Uncertain dispatch | Simulate a timeout where safe (staging only) | Shown as unknown; no automatic resend; reviewed recovery only | Delivery worklist |
| I-04 Additional copy | Request another copy after an accepted send | Needs fresh explicit review; recorded as an additional copy | Attempt history |
| I-05 External receipts | Record a partial cash/check receipt, a refund and an allocation reversal | Correct balance; history kept; no new cash created by a reversal | Invoice screen (`BETA-CONTRACTOR-SUCCESS.md:38-39`) |
| I-06 Warranty dates, photos, report, text delivery — **KNOWN GAPS G-03, G-13** | Try to include equipment warranty dates and photos, or send by text | Not supported | Failed or Not run — G-03/G-13 |
| I-07 Card or payment-link collection — **KNOWN GAP G-01** | — | No collection exists; do not take any payment | Not run — G-01 |

**Blocking:** O-03, O-04 or O-05 (sender), O-25 (test inbox).
