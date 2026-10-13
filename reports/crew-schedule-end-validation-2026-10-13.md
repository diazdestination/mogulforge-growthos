# Assigned crew schedule end validation

Source candidate based on PR44/8df64dc72009832f93b2b491031acd1bb2afb903.

An end-only PATCH with scheduledEnd:null could erase the end of an assigned
multi-day project. Conflict checks then treated that job as a one-day legacy
window and allowed an appointment inside the original later days.

The existing required-end guard now includes explicit scheduledEnd changes.
That request returns400 invalid_interval before project writes. The saved end,
crew and updatedAt remain unchanged, and the original overlap stays blocked.
Legacy null-end note edits, unassigned end clears, explicit crew unassignment,
and clearing both dates continue to work. Tenant/role checks, schedule locks,
schema and migration inputs are unchanged.

## Verification

- RED: real PostgreSQL16, 2 expected failures/30 passes. The old service saved
  a null end and the HTTP endpoint returned200 instead of400.
- GREEN: same two files, all32 tests passed with no skips, including independent
  PostgreSQL race tests and six added regression/compatibility cases.
- Full disposable local gate:4463 passed,15 existing API skips. API3005;
  Command Center1061; scripts355; React client13; email intake3; website adapter26.
- Workspace typechecks and both production builds passed.
- Independent code review: no Critical/Important/Minor findings.
- Owned local fixtures removed; no provider calls or live app/database changes.
- Redacted secret scan passed for the six candidate files (exit 0).
- Exact publication CI is recorded separately before source acceptance.
  A draft PR does not establish deployed/client acceptance.

Artifacts: C:\Forge\artifacts\growthos-crew-end-guard-20261013. RED and GREEN
logs are red.log/green.log; early launcher/connection setup failures are preserved
separately. Full-gate.log, types.log, api-build.log and ui-build.log retain checks.

This closes a scheduling correctness defect, not configurable travel/service
capacity or a contractor cutover gate. G-04 capacity configuration and G-06
estimate delivery remain open. PR43 is customer import, not capacity policy.
The Fly Reader/rehearsal work remains independent; all19SQL inputs and the
142-table target are preserved. No merge, deployment or public launch is implied.
