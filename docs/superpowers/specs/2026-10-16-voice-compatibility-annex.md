# Voice compatibility annex proposal

Status: DOCS-ONLY PROPOSAL FOR ROOT'S INTEGRATED SPEC REVIEW. Not an approved
implementation contract, provider configuration or execution instruction.

Purpose: support the retained Telnyx transport / ElevenLabs Agents / GrowthOS
business-logic direction for missed calls and after-hours reception, preserving
staff-first admission, company isolation, three guarded tools and one original
human-transfer attempt. ROOT owns shared dispatch, ingress, history, quotas,
schema and integration. This annex owns no product file or account setting.

Source binding: b95cb5fa1e1da1c0349427dbb20d5adc1088007e,
tree 910e15638af9c8988594570ea2dc6b79d83bc552,
parent a237e83771e15f95be1b7a87e823fcaa454a18e3. Use the existing exact source
map and cached official research; selected input hashes accompany this annex.
No new fetch, import, test, installation, provider/account call or source edit.

## Existing behavior that the design must preserve

Paths below are relative to artifacts/api-server/src unless lib/db is shown.

| Seam | Exact baseline and consequence |
| --- | --- |
| Admission | routes/v1/twilio-voice.ts:347 records a fresh signed inbound call and dials staff. Its :577 completion path retains the first signed staff-leg outcome. services/callie-reception-runtime.ts:36,55 admits/rechecks only the original eligible missed call, current policy, owner and open office task. Direct SIP routing to an agent must not silently replace this with AI-first answering. |
| Registration | services/callie-reception-provider.ts:104 uses ElevenLabs' Twilio register-call endpoint and validates a narrow TwiML media response. runtime:104 reserves the original call-scoped effect before dispatch; only that invocation may emit the connection. This protocol cannot be reused by renaming the carrier. |
| Conversation identity | provider:121,127 requires exact agent/version/branch/environment and Twilio inbound call SID/from/to metadata. runtime:188 corroborates the first initialize through the provider before binding the conversation. A SIP value must not be accepted by relaxing or deleting the Twilio predicate. |
| Configuration/tools | provider:40,69 checks the reviewed configuration fingerprint, privacy, duration, codec and override allowlist, resolves exactly three webhook tools and rejects built-ins, workflow/procedure/MCP/knowledge-base/custom-LLM additions. contract:121 prepares configuration locally, not an upload. |
| Tool authority | contract:143 and routes/v1/callie.ts:37 require the strict initialize/save_facts/request_handoff shapes and a header capability. runtime:166,188 verifies its hash/expiry, actual conversation, current policy/task and finite allowance. Events retain request identity and payload hashes; changed replays refuse. |
| Transfer | runtime:232 reserves the original human-transfer key, rechecks authority/target/claim before dispatch, then updates the Twilio parent call. Signed child-leg evidence remains separate from the original staff Dial. API acceptance, phone answer and human acceptance are distinct. |
| Late evidence/history | runtime post-call handling authenticates raw bytes for an already bound conversation and stores bounded encrypted content without completing staff work. Cleanup never releases an original effect. lib/db/src/schema/callie.ts:117,119 links intakes to Twilio call/binding parents; callie-reception.ts:73 constrains transferChildCallSid to CA-prefixed values. New carrier identities require an explicit compatible persistence design, not fake SIDs or renamed old data. |

## Documented options and recommended scope

The cached public pages establish possible connection surfaces, not account
readiness or the complete GrowthOS protocol:

- D01: ElevenLabs documents Telnyx-compatible SIP trunking and agent assignment.
  SIP call/caller headers can supply context; custom inbound header values are
  conversation-visible. This supports investigating native SIP, not trusting
  arbitrary caller headers. [SIP trunking](https://elevenlabs.io/docs/eleven-agents/phone-numbers/sip-trunking).
- D02: inbound SIP initiation can call a configured webhook with header secrets
  and receive variables/approved overrides; failed initiation can prevent
  startup. This does not establish the exact veto timing, retries, durable
  identity corroboration or safe per-call secret handling required below.
  [Personalization](https://elevenlabs.io/docs/eleven-agents/customization/personalization).
- D03: SIP REFER is a separate transfer mode requiring SIP/trunk support; the
  documented blind mode is specific to native Twilio. A built-in transfer tool
  would not preserve the current three-tool server-claim protocol by itself.
  [Transfer to number](https://elevenlabs.io/docs/eleven-agents/customization/tools/system-tools/transfer-to-number).
- D06: Telnyx custom-header propagation varies by route; account/PSTN boundaries
  can strip it and reserved headers need special treatment. Exact-route proof
  is required. [Header propagation](https://support.telnyx.com/en/articles/16666680-custom-sip-x-header-propagation-on-telnyx).

Recommended target: native SIP with authenticated GrowthOS admission/context
and a server-controlled transfer adapter, conditional on V01-V07 below. It
uses the documented voice transport while keeping business authority in
GrowthOS. No exact provider transfer endpoint is established by this packet.

Alternative: retain existing Twilio voice while a separately approved Telnyx
SMS delta proceeds. This preserves the known voice protocol but only partially
meets the retained provider direction; it requires an explicit staged decision.
A custom audio/media bridge would create a larger subsystem and is outside
this proposal. Do not introduce it as an automatic workaround.

## Proposed authority and identity contract

These are required semantic bindings, not invented provider JSON fields or
generated APIs. ROOT's integrated spec must map each role to verified provider
evidence and a reviewed typed persistence representation.

1. A trusted carrier front door identifies tenant + approved route binding and
   revision + original GrowthOS call operation + original carrier call/leg
   identities + normalized caller/called numbers + original staff outcome and
   admission time. Carrier identity must be authenticated independently of
   caller/model input. Trunk authentication is distinct from HTTP callback
   authentication and from the capability used by GrowthOS tools.
2. Only an original call created after the current policy approval, with the
   accepted missed-call staff outcome, may enter this reception mode. Preserve
   office owner/task/deadline, company hold, approver role and forward-only
   selection. Answered calls, old calls, blocked companies and duplicated or
   conflicting staff outcomes cannot be newly enrolled. After-hours policy
   selects the approved owner/target; it does not silently waive staff-first
   admission. If a different no-ring after-hours policy is desired, ROOT must
   expose it as a separate decision rather than infer it from hours fields.
3. Before emitting any new route/connection/initiation effect, durably reserve
   the existing logical registration ownership for the original GrowthOS call.
   Preserve callie:<callId>:conversation:v1 and
   callie:<callId>:human-transfer:v1 semantics and historical reservations.
   A carrier, policy or mode change must not mint a second effect namespace for
   that same operation. ROOT decides the compatible schema representation.
4. Authenticate initiation using reviewed server-held credentials and exact
   route/tenant binding. Resolve any nonsecret correlation handle to the
   original admitted call; a handle, phone number, SIP header or conversation ID
   is never sufficient authority. Verify agent/version/branch/environment,
   provider conversation and original call/leg mapping before binding once.
   Missing fields, identity conflicts or unavailable corroboration refuse.
5. Serialize concurrent initiation and initialize events against original
   ownership. Only the invocation that owns the new effect may issue a new
   connection/capability response. A lost response remains unknown and owned;
   retries do not create a fresh session, emit cached connection instructions,
   reissue authority or switch carrier. Evidence-only reconciliation may later
   explain the outcome without granting another attempt.

Native SIP may start a conversation without the old register-call/TwiML round
trip. ROOT must name the real effect boundary and prove reservation precedes
it. An authenticated initiation webhook does not alone prove this ordering or
that the original staff leg has finished. Until V01/V02 are closed, SIP remains
disabled and the present office-review fallback is retained.

## Dynamic context, capability and configuration

Return only approved business facts/disclosure, time/duration limits and an
honest transfer-availability indicator as conversational context. Caller facts
remain unverified; no identity, SMS permission, appointment, price, warranty,
arrival or emergency dispatch is confirmed. Agent speech cannot change policy,
tool destinations, staff targets or data permissions.

The existing code injects secret__callie_capability through the native Twilio
registration flow and maps it to X-Callie-Capability on server tools. That is a
code fact, not proof the same secret channel is safe or available on SIP. For
SIP, require a documented provider-supported per-call secret mechanism, exact
server-tool mapping and evidence that the capability is excluded from model
context, SIP/REFER/BYE headers, prompts, transcripts, conversation-visible
metadata, URLs, returned tool bodies and diagnostics. Use only a hash/expiry
in GrowthOS persistence as today. A shared initiation header secret cannot
replace the call-scoped tool capability. Do not put a bearer capability into a
custom SIP header, rename it to a normal dynamic variable, or weaken tool auth
to make a connection appear successful. If V03 cannot be satisfied, stop.

Retain exactly callie_initialize, callie_save_facts and callie_request_handoff,
strict schemas, reviewed fixed HTTPS tool origin/path and no redirects or
model-selected destinations. System agent/conversation IDs are evidence inputs
to corroborate, not proof by themselves. Preserve initialize-first, finite
tools/duration, expiry/revocation, event idempotency/payload matching and current
authority checks under original transaction locks. Saved facts do not overwrite
staff-reviewed booking context or close office work. Post-call evidence cannot
create contacts/leads, send SMS or book an appointment.

Freeze and independently review the exact SIP agent/configuration version,
branch/environment behavior, route binding, resolved three tools, permitted
overrides, codecs and privacy retention before any future activation. Preserve
the closed configuration check and redacted error handling. Do not auto-enable
built-in transfer, workflows, procedures, MCP or unrelated agent capabilities.
No provider config upload or new environment flag is defined by this annex.

## One controlled transfer and truthful results

The caller's request_handoff invokes GrowthOS; it does not grant a model the
ability to run a provider transfer directly. GrowthOS selects only the reviewed
day/night target, rejects caller/company/all managed inbound numbers and known
routing loops, and reserves the original transfer key once. Immediately before
dispatch, recheck session/conversation/capability expiry, current policy/owner/
task/route binding, target fingerprint and original claim under the existing
locking discipline. No model-supplied number or arbitrary SIP URI is allowed.

A verified server-side carrier operation or an equivalently enforceable gated
transfer mechanism is required. The cached REFER documentation supplies no
proof that its system tool can be restricted to one already committed GrowthOS
claim while keeping only the three allowed tools. Leave that tool disabled.
Do not implement 'return a permit then trust the model to REFER' or reuse the
Twilio Calls endpoint for Telnyx. V04 must identify the exact supported command,
parent/child identities, authenticated events and race behavior before coding
its physical dispatch adapter.

Persist dispatch-start before I/O. Definite refusal before dispatch is blocked;
timeout, malformed identity, lost acknowledgment or crash after dispatch-start
is indeterminate and permanently owned. No automatic retry, alternate target,
cross-carrier replay, new transfer key or lease-based rearm. Reconciliation is
read-only with respect to sending another effect. Monotonic signed outcomes
must not be overwritten by a slower REST response. Original staff and transfer
leg callbacks stay distinct. Preserve truthful evidence: command accepted,
ringing, phone answered, failed/not answered, unknown; none proves that a named
person accepted the case. Changing to SIP must not strengthen existing claims.

## Explicit unresolved dependencies

| ID | Exact dependency and required disposition |
| --- | --- |
| V01 | Choose and substantiate the Telnyx staff-first front door, authenticated original/child call identities, missed outcome and once-only route-to-agent boundary. Direct agent import alone is insufficient. No endpoint/HTTP signature scheme is inferred from the SMS webhook docs. |
| V02 | Supply the actual native SIP initiation, conversation-read and signed post-call identity schemas, version/branch/environment guarantees, event/retry ordering and rejection timing. Demonstrate correlation to the original call even if optional headers are stripped or spoofed. Missing proof keeps admission/tools disabled. |
| V03 | Prove protected per-call secret injection and server-tool header mapping on SIP, including redaction/visibility and no SIP/BYE/REFER propagation. The six cached pages do not establish this guarantee. |
| V04 | Select and independently substantiate one server-controlled transfer command or equivalently enforceable gated mechanism, finite request deadline, authenticated final leg evidence and original-claim ownership. The native REFER system tool is not selected. |
| V05 | Pin the exact SIP configuration/codec/privacy/tool snapshot and actual account/number/trunk/agent binding. Account readiness is NOT_CHECKED. No guessed phone.type, generic metadata pass or provider-default override is acceptable. |
| V06 | Authoritative CSS hours/timezone/on-call and approved company transfer targets, disclosure, finite targets and forwarding/revert procedure. Reuse dated Painless inputs but do not present them as new company acceptance. |
| V07 | ROOT must review typed carrier identities and compatible schema evolution for Twilio-linked intakes and CA-only transfer children, preserving all original foreign keys/history/once-only ownership. No DDL, schema mutation or fake Twilio identity is authorized here. |

V01-V05/V07 are engineering contract blockers for the corresponding live voice
path, not placeholders that may be filled with assumptions. Closure requires
exact documented/source facts and separately authorized real evidence where
documentation is insufficient. D02/D03 runtime-control dependencies from the
runtime-preparation packet are separate from V02/V03 above and remain held.

## Focused verification and acceptance criteria

No suite ran for this proposal. Reuse the existing callie-reception service,
race, route and UI suites at the eventual changed source; add behavioral
coverage only for the new boundary. A test fixture is not provider acceptance.

| Cases | Required observable result |
| --- | --- |
| VT01-VT03 | Fresh authenticated missed staff leg admits once; answered/old/conflicting or repeated leg never enrolls; concurrent initiation emits at most one effect and preserves office task/owner/deadline. |
| VT04-VT06 | Wrong trunk/tenant/number, forged/stripped correlation header and wrong call/leg/conversation/version/environment refuse without operational mutation or secret leakage; a redacted refusal audit may remain. Service authentication alone cannot select another tenant. |
| VT07-VT09 | Absent/expired/foreign capability refuses; secret never appears in agent-visible/transport diagnostic surfaces; changed request payload refuses while exact replay remains inert. |
| VT10-VT12 | initialize must precede facts/handoff; duration/tool cap and policy/owner/task revocation still apply; agent config drift or extra built-in tool refuses before a new physical effect. |
| VT13-VT15 | Two simultaneous handoff requests reserve one transfer; caller/company/managed-number loops refuse; target/policy/expiry change before dispatch blocks without a provider call. |
| VT16-VT18 | Lost initiation/transfer acknowledgment or failed final DB write stays owned without alternate provider/target retry; signed final outcome racing API response stays monotonic; original staff leg cannot settle transfer and foreign/duplicate/conflicting transfer legs refuse. |
| VT19-VT20 | Signed raw post-call evidence binds only the original known conversation; late/expired/purged content cannot expose secrets, rewrite staff-reviewed work, release an effect, book or send SMS. |
| VT21-VT22 | Forward-only provider change leaves Twilio rows, original receipts and unknown reservations intact; parent/child IDs remain typed without fabricated AC/CA values or provider-agnostic regex weakening. |

Future separately authorized finite real-call proof must cover staff answered,
missed and after-hours routes; safe initiation failure; actual agent/version/
call mapping; normal/failed/uncertain transfer; handset audio and hangup;
recording/transcript/secret visibility; callback authentication and forwarding
revert. Retain failures and exact source/config/event attribution. A forced
second physical attempt is not required to prove no-replay. Full CSS/Painless
workdays, G04/G06 and all original24+nine supplement cases remain NOT_RUN.

This proposal introduces no customer messaging permission, SMS dispatch,
number purchase, activation, contact, public/private publication, CI dispatch,
hosted/runtime/schema mutation, spending, merge, deployment or cutover. ROOT
will integrate and independently review the written spec for human design
approval before implementation planning or product code. canExecute=false,
implementationAuthorized=false, publicationAuthorized=false, releaseEligible=false.
