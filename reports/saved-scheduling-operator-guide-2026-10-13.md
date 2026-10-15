# Saved scheduling operator guide

**Scope:** early Task 13 documentation of the accepted source through Task 11 and the independently accepted native Task 12 subset. Source checkpoint: `a19f34e1a4f2ee6f8f7b230008f29c3875ef2347`, tree `5f235af7899365a0e98eac408a769d1e0d08baad`. This guide was prepared on October 14, 2026; its filename follows the October 13 wave. Runtime browser acceptance, a new exact recovery pin, whole-branch release gates, final review, release packet and candidate CI remain pending. These are source instructions for the candidate, not evidence that a company is configured or a hosted release is accepted.

## Configure an explicit company policy

Use the scheduling settings editor with the existing accepted active staff and `settings.manage` authority. Read the authoritative saved policy and company zone first. A read error, invalid policy or unavailable authority holds editing/saving; an empty or failed read is not an unconfigured company. Do not guess a revision or create replacement defaults to clear an error.

Review each value before **Save scheduling settings**:

| Control | Accepted value and meaning |
|---|---|
| Enable scheduling policy | Explicit boolean; disabling retains the saved envelope and revision. |
| Minimum travel gap | Integer `0..1440` elapsed minutes. Zero is an explicit value. |
| Company concurrency ceiling | `null` for no general company ceiling, or integer `1..100` reservations. |
| Duration presets | `0..50` explicitly configured entries; each has a stable unique ID, nonblank label of `1..80` characters (uniqueness checked after trimming) and integer `1..1440` elapsed minutes. Retain IDs when editing; a new entry requests a server-assigned ID. |

A missing policy is legacy revision zero; the first explicit save creates revision one. Later supported policy changes advance the revision. Actor, digest, revision and matching company zone are server-owned. The policy editor displays saved state separately from the draft. A transport response alone does not make an unresolved draft authoritative: use the explicit refresh control and wait for refreshed saved settings. A stale result requires fresh authority and another deliberate review, not automatic resubmission.

No company duration, service category, helper account, crew pool, business hours, route or default ceiling is inferred. CSS's reported two-hour diagnostics, three-hour maintenance and approximately one-hour travel are requirements/examples awaiting actual company configuration and acceptance, not activated presets.

Source: `lib/scheduling-core/src/models.ts:33` (limits and closed policy), `artifacts/command-center/src/components/scheduling-policy-editor.tsx:44` (refresh custody), `:120` (saved revision), `:149` (preset editing), `:166` (save control). Named tests in `scheduling-policy-editor.test.tsx`: `allows explicit first save at revision zero without inventing company defaults`, `accepts inclusive upper bounds and submits disable without dropping the saved envelope`, and `releases a settled hold only after explicit refresh receives authoritative props`.

## Review the actual interval and resources

Choose the existing exact appointment/project and its real source, customer/property/lead/estimate lineage. Preserve the existing permission, participant, lifecycle and source-command rules. An unlinked manual appointment remains legitimately unlinked; native projects retain their existing lead requirement. Returning customer-work, service-care, CALLIE and inspection/concierge paths retain their own identities and authority. A schedule review does not grant a role, manufacture a parent or establish provider permission.

Enter service start/end and explicitly accepted staff resources, or deliberately select a current enabled duration preset. Press **Review interval**, examine the service interval, elapsed duration, assigned resources, travel requirement and separate capacity rules, then save the reviewed draft. A changed interval, preset, resource, appointment type, source or context invalidates that review. **Refresh scheduling review** obtains current context; review again before submitting a material change. A stale server result is a reason to refresh and review, not to retry the old admission.

The proposal's **Rechecked when saving** message means final transactional checks are still required. A displayed list or completed local review cannot prove capacity is available. Scheduled/confirmed appointments and scheduled/in-progress projects with usable starts consume capacity. Each distinct assigned user is an occupied resource; a job with several crew members counts once toward the general company ceiling and occupies every assigned member. Unassigned work may consume company/inspection capacity without proving technician availability.

Service intervals cannot overlap for shared staff. For immediately adjacent reservations A and B, the required gap is `max(A.savedGap, B.savedGap)`; exact equality is allowed, one minute short is refused. The general company ceiling uses the peak count of half-open service intervals, independently of the existing inspection ceiling. Travel is not added to company/inspection occupancy, and same-property work has no automatic travel exemption.

Source: `lib/scheduling-core/src/reservations.ts:5`, `:45`, `:77`; `artifacts/api-server/src/services/scheduling-admission.ts:241`; `artifacts/command-center/src/components/scheduling-interval-fields.tsx:164`. Named UI tests in `appointments-scheduling.test.tsx`: `requires fresh review after resources or appointment type change` and `preserves saved travel protection and actual target binding`.

## Keep instants, elapsed duration and zones distinct

The company's `organizations.timezone` controls current input, display and company-day navigation. UTC endpoints remain the same instants when the display zone changes. A snapshot's approved zone is historical provenance, not a replacement for the current company zone. An invalid or unavailable current zone holds review/display rather than falling back to the browser's zone.

Inspection windows, weekdays and blackout dates retain their recorded rule-source zone. When it differs from the company zone, review both named zones; the difference is valid. Changing either applicable zone or inspection configuration invalidates affected context, including legacy policy revision zero. A company-zone change does not reinterpret existing inspection rules.

Preset duration and travel gap are elapsed minutes. Preset selection resolves once into endpoints; renaming, changing or deleting a preset does not reinterpret a saved interval. Manual multi-day ranges remain exact instants, and a supported start-only edit preserves elapsed duration and milliseconds. A nonexistent DST wall time is refused. For a repeated wall time choose the explicit **First** or **Second occurrence**, including its UTC offset; review stays held until that occurrence is chosen. Do not assume a two-hour preset means a calendar span or includes travel.

Source: `lib/scheduling-core/src/time.ts`; `artifacts/command-center/src/components/scheduling-interval-fields.tsx:137`, `:147`; `artifacts/command-center/src/components/appointment-linked-card-scheduling.test.tsx:31`, `:79`. Named UI tests: `requires explicit DST occurrence and rejects nonexistent wall time` and `preserves multi-day elapsed duration and milliseconds on a start-only edit without a preset` in `appointments-scheduling.test.tsx`.

## Preserve saved protection when defaults or assignments change

Reducing or disabling current defaults affects new admissions, not old saved gaps. Disabled policy offers no retained preset for a new preset admission; new admissions receive zero new travel and no general company ceiling, while existing resource/inspection gates and configured-context review still apply. Earlier preset provenance, endpoints and larger saved travel gaps remain history and protection. A disabled configured policy is distinct from a never-configured legacy policy.

A true pure resource removal keeps unchanged effective endpoints, type, source and consuming state, removes only a subset of resources, and advances a valid reservation's release revision. It preserves the remaining resources' saved gap, duration/preset, original policy and zone provenance. It requires existing target/version authority without adopting new policy defaults. An addition, replacement, reactivation or combined release/material edit requires current admission review. Notes-only, confirmation-only and terminal closure retain their existing historical authority; terminal release keeps snapshot/history. Those paths still obey ordinary parent, actor and lifecycle checks. Do not combine a historical edit with an intentional interval change and assume the historical exemption covers it.

Actual legacy SQL NULL snapshots use the established compatibility end only when an end is missing: appointment `120` elapsed minutes, project one elapsed day (`24` hours), and zero legacy travel. This does not fabricate a recorded end or prior approved buffer. Do not send a fabricated two-hour end on an unrelated legacy note edit. Existing assigned-crew end-clear restrictions remain effective; an allowed full date release preserves its last snapshot/history.

The selected appointment card independently checks fetched detail against the supplied closed scheduling projection, including exact ID/version/endpoints, actual NULL semantics and snapshot target. Missing, mismatched or unavailable evidence is visibly held, never relabelled legacy zero. A legacy NULL end stays **No end recorded**; the card shows a compatibility window only when positively supplied and validated as the exact legacy window. Refreshing to a newer detail version holds an older projection until fresh matching evidence arrives. Existing links, private-note boundaries and visit completion authority remain intact.

Source: `lib/scheduling-core/src/reservations.ts:11`, `:26`; `artifacts/api-server/src/services/scheduling-admission.ts:267`, `:330`; `artifacts/command-center/src/components/appointment-linked-card-scheduling.test.tsx:120`, `:136`, `:184`. Named tests in `appointments-scheduling.test.tsx`: `permits valid pure release without current context and holds invalid active release`, `requires current review for an intentional material edit and preserves a legacy empty end on unrelated notes`, and `requires fresh review when a terminal action also deliberately edits the interval`.

## Recover an unknown original manual save

A missing acknowledgement, timeout, generic HTTP error, failed GET, missing list entry or missing target leaves the original result unknown. Do not submit another equivalent booking, replace its UUID, refresh its reviewed payload or infer no commit from absence. The same-tab custody retains the exact validated submitted command, wire spelling, operation ID, actor/company/source binding and payload hash across refresh/form remount. It retains omitted-versus-null values and original review context rather than hashing refreshed defaults into the old command.

Use **Reconcile original appointment** or the corresponding original project reconciliation control explicitly. This sends the retained original command to the non-creating reconciliation endpoint. It performs no new booking. Only a complete matching acknowledgement resolves custody: operation/company/actor/kind/source/hash and a valid committed target or terminal `no_commit_refused` outcome must match. A target can be committed but now unavailable; its disappearance does not release the original identity or justify replay. Open the original target only when acknowledged available. The schedule refresh follows exact committed proof, not an optimistic list match.

If exact original proof reports `no_commit_refused`, retain that permanent refusal. Use the explicit **Acknowledge refusal and review a new appointment** control (or corresponding project control), then review a new intentional operation with a new ID. Acknowledgement neither changes the original proof nor rearms its ID; retired IDs remain barred. A shaped/counterfeit refusal, unrelated 409 or failed reconciliation leaves the fence held. If storage/readback or current authority fails, dispatch is held; do not clear browser custody to bypass the hold.

This is same-tab session custody, not a guarantee across closed-tab, browser-loss, device-loss or another computer. Command storage is not a credential store: never add passwords, tokens, keys or provider secrets to payloads, notes or browser storage. Protect private business payloads under the existing authorized session; no encrypted-storage guarantee is made here. Cross-company/actor state is neither shown nor reused.

Source: `artifacts/command-center/src/lib/scheduling-command.ts:45`, `:106`; `artifacts/command-center/src/hooks/use-manual-scheduling-command.ts:238`, `:330`, `:360`; `artifacts/api-server/src/services/manual-scheduling-receipt.ts:278`. Named hook tests: `retains exact wire on loss, blocks replacements, restores without POST, then explicitly reconciles original`, `persists permanent refusal, requires explicit acknowledgement, and never rearms its ID`, and `uses the real generated reconcile parser with original body and no automatic retries`. These are source/test anchors, not new browser acceptance from this document.

## Update a known record deliberately

Manual updates use the actual record's optimistic `expectedUpdatedAt`, and the `expectedTargetFingerprint` where supplied for protected/versioned authority, together with the exact edited body and current scheduling review for material changes. The fingerprint supplements the date token so a same-millisecond competing change cannot authorize an old review. Preserve the original record/end NULL semantics; compare the intended body with the saved authoritative record after an unconfirmed update. A failed update is held as unconfirmed, with no automatic retry. Read the original record, resolve what actually saved, then make any next change deliberately. CREATE receipt reconciliation is not a generic PATCH replay mechanism.

Source: `artifacts/command-center/src/pages/appointments.tsx:1066` (submitted body/tokens and unknown-update hold); `artifacts/api-server/src/services/crm.ts:1486`, `:2168` (locked version/fingerprint checks). Named backend test in `scheduling-admission.test.ts`: `rejects old fingerprints after a same-millisecond crew change`.

## Keep the release and company acceptance gates open

See [release boundaries](saved-scheduling-release-boundaries-2026-10-13.md), `PAID-BETA-READINESS-P0.md`, `LAUNCH-COMPLETION.md` and `HOUSECALL-PRO-REPLACEMENT-GATE.md`. Full G-04 acceptance still requires actual company values and required workday behavior; this source wave does not establish helper capacity or every install/major-repair requirement. Full G-06 estimate delivery remains open, including required text/SMS, document/photos and revision/resend behavior. Email-only source approval does not close SMS.

Both companies retain separate actual provider/inbox/SMS/phone/physical-device and Housecall Pro replacement acceptance. Do not reduce the agreed launch vision to an assisted pilot, invent business facts/configuration/imports/payment setup, or treat local tests/recovery as replacement or deployment permission. Contractor card/bank collection is a future add-on, not an initial replacement blocker; GrowthOS subscription billing remains separate. This documentation adds no provider, migration, paid, deployment, customer-contact or public-launch authority.
