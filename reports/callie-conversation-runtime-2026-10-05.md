# CALLIE conversational reception — runtime lane

Engineering checkpoint, October 5 Eastern / October 6 UTC. This report covers
the frozen `callie-conversation-contract-2026-10-05.md` on
`agent/growthos-callie-conversation-20261005`, based on accepted main `afcb72a`.
It is not provider activation, deployment, PostgreSQL acceptance, or contractor
cutover evidence. Root owns schema review/recovery, full checks, Git and CI.

## Implemented boundary

- Exactly three new tenant-bound tables: reception bindings, original-call
  sessions and immutable-key events. Composite intake identity includes the
  explicit conversation mode. SQL rejects partial capability/receipt groups,
  foreign/mismatched parents and invalid finite state/content/phone values.
  No provider TwiML or capability replay material is retained.
- Browser-safe closed Zod contracts and four session-only staff routes support
  non-secret binding, exact actor-bound ten-minute persisted policy review and
  approval. V1 and v2 share one immutable revision head. Disabled policies remain
  savable without provider credentials; explicit voice-only v2 does not weaken
  the old SMS/program/handset-grant rules. GETs are read-only.
- Only a newly inserted, signed, company-bound inbound call can acquire v2.
  The original staff Dial must actually be missed. The existing intake, original
  callback task, reviewed owner and deadline remain canonical. Existing calls,
  a public conversation ID or a later webhook cannot manufacture admission.
- Registration and cold handoff retain lifetime original revenue-execution keys
  `callie:<callId>:conversation:v1` and
  `callie:<callId>:human-transfer:v1`. Lifecycle, schedule and CALLIE locks precede
  original authority/session/task/receipt row locks. Provider I/O is outside SQL
  transactions, without retries or redirects. Only the original registration
  claimant can return one Connect response; duplicates do not replay a stream.
  Unknown effects and failed local completion writes never authorize another POST.
- Agent preflight checks the selected branch's actual agent version, full reviewed
  configuration fingerprint, three resolved permitted tools, 8kHz mu-law audio,
  no additional workflow/procedure/knowledge/custom-LLM/MCP capability, explicit
  no-recording/deletion/finite-retention settings, and allowed prompt/duration
  overrides. Org-derived credential slots cannot select arbitrary environment
  secrets. The supported `conversation.max_duration_seconds` override constrains
  provider conversation duration. GET/tool-resolution/POST share a 12-second
  absolute registration budget (individual fetch caps are 2/2/5 seconds); a late
  preparation cannot start a fresh POST. This does not promise a hard HTTP SLA
  when the database is unavailable or contended.
- Authenticated initialization corroborates actual provider conversation, agent,
  version/branch/environment and original Twilio caller/called/call SID before
  binding. Secret per-call capability is hashed, finite and header-only. Three
  bounded tools collect literal unverified facts or request one approved fixed
  handoff. They cannot create customer identity, leads, messaging consent,
  appointments, payments or arbitrary external actions.
- One controlled Twilio parent Call redirect uses a distinct signed Dial callback
  and child identity. REST acceptance is only `redirect_accepted`; ordinary Dial
  completion is `phone_answered`, not proof a human accepted. Known routing loops
  are refused. Interrupted registration/transfer claims recover to blocked or
  indeterminate without replay, including a claiming transfer after a completed
  conversation and expired capability.
- A fixed raw-byte HMAC/timestamp post-call endpoint resolves only already-bound
  conversations, verifies the original full provider/call tuple, and retains only
  bounded encrypted facts/summary plus hashes. Exact duplicate events are inert;
  changed duplicates fail. No raw transcript/audio is stored or exposed. Expiry
  clears content/capability, not receipts or office work. Provider parse failures
  return fixed safe errors rather than transcript snippets.
- Office lists/details distinguish conversation, transfer, SMS and actual saved
  work. Legacy monitoring excludes conversation rows. Caller/provider callbacks
  do not rewrite staff notes, assignment, progress, deadlines or disposition.
  Existing explicit identity review/native booking remains the only booking path.
  Exact office review additionally fingerprints the actual selected property
  address, not only a millisecond timestamp, after a stale-review regression
  exposed a timestamp-collision edge.

## Files and executable seams

Pure DTO/configuration preparation: `artifacts/api-server/src/services/callie-reception-contract.ts`.
Policy/credentials: `callie-reception-policy.ts`. Read-only provider proof and
bounded transport: `callie-reception-provider.ts`. Admission, original effects,
tools, callbacks, evidence, monitoring and retention: `callie-reception-runtime.ts`.
Schema: `lib/db/src/schema/callie-reception.ts`, additive mode/version changes in
`callie.ts`, and schema index export. Existing CALLIE intake/policy/runtime/office,
missed-call handoff, voice routes, staff routes and automation hooks are integrated.

Public endpoints are the call-capability tool route
`/api/v1/public/callie/reception/:sessionId/tool`, fixed signed
`/api/v1/public/callie/reception/post-call`, and separate signed
`/api/v1/public/voice/reception-transfer`.
`buildReceptionAgentConfiguration(snapshot)` creates local preparation only; it
does not configure a provider account. No hosted/provider action was performed.

## Verification performed by this lane

Final focused command, using the existing disposable in-memory PGlite harness:

```text
node artifacts/api-server/scripts/test-scheduler-isolated.mjs src/services/callie-reception.test.ts src/services/callie-reception-races.test.ts src/routes/v1/callie-reception.test.ts src/services/callie-runtime.test.ts src/services/callie-office.test.ts src/routes/v1/callie.test.ts src/services/scheduler-stage-isolation.test.ts
```

Result: **103 passed, 9 PostgreSQL-only skipped; 6 files passed, 1 entirely skipped**.
Reception service: 29/29; reception HTTP: 6/6; legacy runtime: 34 plus 4 skips;
legacy office: 14 plus 1 skip; legacy HTTP: 6/6; scheduler isolation: 14/14.
The four new real-PG race cases are the entirely skipped file. These counts
overlap earlier 31/0 and 99/9 focused runs and must not be added together.

`pnpm --filter @workspace/api-server typecheck` passed before the final narrow
deadline/unused-column/property corrections. A final API-only no-emit check is
also **passed (exit 0)** after those corrections:
`pnpm --filter @workspace/api-server exec tsc -p tsconfig.json --noEmit`.
The focused backend/source `git diff --check` is clean. No duplicate full
workspace build, Docker or hosted schema check was run by this lane.

Two investigated non-acceptance runs are retained honestly: the first two-company
HTTP fixture reused a unique shop phone and was corrected to distinct fictional
numbers; an attempted backend-trigger fault injection hit PGlite's known socket
`parseComplete` limitation. The lost-final-write regression now injects exactly
the two completion-transaction failures after the real original claim and mock
provider boundary; it verifies retained processing ownership, later indeterminate
recovery and zero replay. None of the real PostgreSQL barrier tests was replaced
by a timing assertion or mocked lock. The existing stale-address assertion was
preserved and made deterministic with unchanged `updatedAt`.

## Mandatory PostgreSQL obligations still pending at this checkpoint

`artifacts/api-server/src/services/callie-reception-races.test.ts` uses actual
independent connections, actual production writer methods, test-owned trigger
barriers and `pg_blocking_pids` proof, with exact cleanup:

1. `one final registration claim serializes duplicate callbacks and the actual CRM task writer through physical dispatch ownership`
2. `an actual policy disable writer commits before a waiting original registration and prevents every provider POST`
3. `a final transfer claim serializes competing call tools and retains exactly one original redirect effect`
4. `signed late provider evidence waits for the actual office resolve writer and cannot undo its original task or disposition`

The five existing skipped tests (four CALLIE runtime, one office booking) also
remain required. PGlite passage is not PostgreSQL16 concurrency proof. Root must
verify execution in full candidate and exact-main PostgreSQL CI, plus reviewed
133-table offline schema/restore, full UI/types/builds and browser acceptance.

## Honest provider/live limitations

Register-call supports a mutable branch selector, not an immutable agent-version
selector. Preflight detects configured drift but cannot make GET and registration
atomic. Tools additionally corroborate the actual conversation version and call;
speech before that proof remains a real acceptance limitation. Missing/mismatched
provider metadata fails closed. The narrow allowed returned TwiML grammar has
synthetic proof only; a real approved response/audio capture is still required.
No ElevenLabs/Twilio configuration, credential operation, call, SMS, billing or
activation happened. Painless and HVAC each still need reviewed business facts,
disclosure/retention/budget, actual agent/tool setup, explicit day/after-hours
targets, carrier/voicemail/no-loop/audio acceptance and full contractor workday
proof. Native phone answer does not establish human acceptance. Azure/mailbox,
notification and other launch gates are unchanged.

Checkpoint scope is this report and source files only. Root retains shared
Jarvis STATE/project-state checkpointing, all Git/CI/release actions and the
unrelated `pnpm-workspace.yaml.bak`.
