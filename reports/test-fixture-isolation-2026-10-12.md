# Test fixture isolation for global Twilio unique columns (2026-10-12)

Branch `agent/growthos-test-fixture-isolation-20261012`, based on `87adc3e`
(PR #35 head). Scope is test fixtures and test helpers only. No production
source, schema, migration or CI configuration changed.

## Problem

Vitest runs api-server files in parallel workers against one disposable
Postgres. Several files inserted `twilio_client_bindings` rows with the same
hard-coded `phone_number`. The index `twilio_client_binding_phone_uq` is unique
across all organizations, so two files holding a binding at the same time
collided. Per-org cleanup (`deleteTestOrgs`) is deterministic but cannot
prevent that overlap.

Shared fixed binding numbers found by grep:

| Number / pattern | Files |
| --- | --- |
| `+15005550009` | service-care, missed-call-care, twilio-dispatch-guard, sms-delivery (file-lifetime binding), callie-runtime |
| `+15005550006` / `+15005550007` | routes/v1/twilio, routes/v1/customer-lifecycle-voice |
| `+15005550008` | routes/v1/unsubscribe-flow |
| `+1500555` + serial from 0101 / 1001 | service-sms, callie-intake (overlapped the 0006–0009 numbers) |
| `+1202555` + serial from 1001 | callie-office-fixture (used by both callie-office.test and callie.test, so both started at the same number) |
| `+1500` + random 7 digits | callie-reception-fixture (could land on a literal magic number) |

The same class of collision also applied to fixed provider SIDs in globally
unique columns:
- `SM${"a".repeat(32)}` was a dispatch `provider_sid` (`twilio_dispatch_sid`)
  in service-care, sms-delivery and callie-runtime. sms-delivery also used
  `SM${"b"…}`.
- `"SM" + counter.padStart(32)` was an inbound `message_sid` (primary key)
  in both twilio.test and unsubscribe-flow.

No production code special-cases `+15005550009` or any other Twilio magic
number. A grep of non-test source found none. Every provider call in these
suites is mocked. The only format rule is `phoneE164`
(`^1[2-9]\d{9}$`), so a random `+1500XXXXXXX` value behaves the same way.

## Change

- New `artifacts/api-server/src/test-helpers/synthetic-twilio.ts`:
  - `syntheticTwilioNumber()` returns a random `+1500XXXXXXX` number. It is
    de-duplicated within a worker and never falls in `555-0000..0099`, so it
    cannot equal a literal magic number that a test still uses as a
    deliberately wrong identity (for example, `+15005550000` in callie-intake).
  - `syntheticTwilioSid(prefix)` returns a random SID.
  - `syntheticTwilioSidSequence(prefix)` returns ordered SIDs with a random
    base per file.
- The 10 test files and 2 fixtures listed above now use the helper. All
  assertions use the same variables, so test semantics are unchanged.
- Remaining fixed SIDs, such as twilio.test `CA…` values and
  twilio-dispatch-guard `SM4…`, are each confined to one file. They were left
  unchanged.

## Evidence

Before the change, at base `87adc3e`, the 10 colliding files ran together
once:
`Test Files 3 failed | 7 passed (10)`, `Tests 26 failed | 175 passed (201)`.
All 26 failures were caused by
`duplicate key value violates unique constraint "twilio_client_binding_phone_uq"`
(service-care 1, missed-call-care 14, callie-runtime 11).

After the change, 15 files ran together: the 10 above plus callie-office,
routes/callie, services and routes callie-reception, and
callie-reception-races. Results for 3 consecutive runs:
`Test Files 15 passed (15)`, `Tests 262 passed (262)` each time.

`pnpm run typecheck` passed (libs, api-server, command-center, scripts).

Full suite (`node scripts/local-dev.mjs test`), run twice:

| Package | Run 1 | Run 2 |
| --- | --- | --- |
| cloudflare-email-intake | 3/3 | 3/3 |
| api-client-react | 13/13 | 13/13 |
| scripts | 351/351 (28 files) | 351/351 |
| command-center | 1035/1035 (116 files) | 1035/1035 |
| api-server | 1 failed, 2973 passed, 15 skipped (2989); files 1 failed, 273 passed, 3 skipped | 2974 passed, 15 skipped (2989); files 274 passed, 3 skipped |
| website-connection node tests | not reached | 26/26 |

Run 1 had one failure, unrelated to this change:
`src/routes/v1/delivery-status.test.ts > authenticated Resend delivery
callbacks > supports signature rotation but rejects malformed base64 and extra
delimiters` failed with `expected 403 to be 200` at line 214. The test signs
`signature` with a timestamp taken at line 200. The later `send()` call
rebuilds `svix-timestamp` from a fresh `Date.now()`, so the request fails if a
wall-clock second boundary passes between the two. This is a timing flake in
the test. Neither that file nor `delivery-status.ts` differs from `87adc3e`,
and it does not touch Twilio fixtures. It passed in 3 isolated reruns
(32/32) and in full-suite run 2. Follow-up commit `bb24ffe` then fixed this
test-only timing issue by reusing the signed timestamp and headers for every
request in the signature-rotation case. Its focused rerun passed 32/32.

## Limitations

- Uniqueness across workers is random (about 9 million values for numbers,
  UUID-based for SIDs), not coordinated. Given how few bindings exist at any
  moment, the chance of a collision is negligible.
- The delivery-status timestamp correction changes only test request headers;
  it does not change production signature verification or freshness checks.
