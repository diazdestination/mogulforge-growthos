# Local normal-mode tenant acceptance — October 1, 2026

## Result

**15 tests passed; one file; exit 0.** Reproduction of a cross-tenant photo read
failed before the repair in both tenant directions and now passes. This is local,
synthetic acceptance against normal Express routes and a disposable PGlite
database. It is not hosted P0-8 acceptance, actual email delivery, or paid-beta
approval. Full exact-head PostgreSQL CI remains required.

Command from the repository root:

```powershell
node artifacts/api-server/scripts/test-tenant-acceptance-isolated.mjs
```

The fixed wrapper accepts no arguments or external target. It delegates to the
existing isolated runner, which creates an in-memory loopback database, strips
inherited database/provider credentials, applies only that disposable schema,
and selects the named test. The fixture rejects restore mode, uses real normal
session/API-key/member/role guards, and performs actual HTTP requests to its own
listener. The selected email effect is mocked at the provider boundary; requests
outside that exact local listener through `fetch` are rejected and counted.
No public endpoint, live provider, customer data or billing action was exercised.

Final fixed-wrapper Vitest result: **15/15, 7.28 seconds total**, with test
execution 1.83 seconds. An earlier pre-fix run had **10 passed / 2 failed**;
the two failing cases exposed the actual foreign fixture bytes.

## Reproduced defect and repair

An authenticated company member with `crm.write` and knowledge of another
company's object UUID/path could submit `photos_attached` through the generic
lead-activity endpoint. That endpoint did not perform the dedicated photo
attachment validation. The gallery checked only that a local activity referred
to the object, then fetched it without the authenticated organization.

Observed before repair, in both A-to-B and B-to-A directions:

| Step | Observed result |
| --- | --- |
| Own company's photo GET | 200 and exact own fixture bytes |
| Foreign photo GET before forged reference | 404 |
| Generic activity POST referencing foreign object | 201 |
| Foreign photo GET after forged reference | 200 and exact foreign fixture bytes |

This was not blind UUID discovery; the adversarial fixture supplied the known
foreign ID. The test used fictional bytes and local synthetic identities only.

Repair:

- `routes/v1/leads.ts`: generic activity creation rejects the reserved
  `photos_attached` type with 400; clients must use the ownership-validating
  dedicated photo endpoint. Normal staff notes remain supported.
- `routes/v1/storage.ts` and `routes/v1/portal.ts`: both stream lookups supply
  the authenticated tenant ID. A preexisting malformed activity does not grant
  access to another tenant's or an unowned Postgres object.
- `lib/objectStorage.ts`: tenant-scoped GCS/Replit reads and attachment checks
  fail closed because this legacy adapter has no authoritative server-owned
  tenant association. No activity reference or arbitrary metadata is accepted
  as a substitute for that association.

Source paths above are relative to `artifacts/api-server/src/`. There was no
database migration or cleanup of historical references. No object was deleted
outside the disposable test fixture.

## Compatibility boundary

The tested working path is tenant-owned **Postgres object storage**. Legitimate
staff attachments, staff downloads and contact-scoped portal downloads still
return the exact own-company bytes. Unknown/null ownership remains denied.

Legacy external GCS/Replit private photo operations now require an explicit
trusted ownership registry, reviewed migration and provider acceptance before
they can be enabled for tenant operations. This is an intentional privacy
boundary, not evidence that the external adapter has passed acceptance. Do not
deploy this candidate to a customer relying on that legacy path without resolving
and reviewing its compatibility requirement. No production provider inventory
was performed by this test milestone.

## Reusable invariant manifest

The case IDs below are also test names. Cases NM-01 through NM-07 run in both
tenant directions; NM-08 is a single provider-boundary case. This manifest can
guide a later approved exact-SHA staging run; the local runner deliberately
cannot be pointed at hosted staging.

| Case | Identity and positive control | Negative attempt | Required evidence |
| --- | --- | --- | --- |
| NM-01 | Actual owner session; own contact direct/list read succeeds | Anonymous read, foreign direct ID, foreign search, forged org query/headers | 401/404/empty results as appropriate; foreign versus nonexistent direct errors match; no foreign rows or provider effect |
| NM-02 | Own contact create/update/delete succeeds in normal mode | Foreign contact/estimate/task edit/delete and foreign contact/lead relationship grafting | 404 or scoped invalid-reference 400; own mutation really happens; foreign business/effect rows unchanged |
| NM-03 | Own CSV source marker and Revenue evidence visible; own recorded payment succeeds | Foreign org selector in CSV, foreign direct evidence ID and foreign-lead payment | CSV excludes foreign source; evidence/payment deny; no foreign change |
| NM-04 | Own approved one-to-one compose reaches a synthetic provider exactly once with own org/user/recipient | Foreign or nonexistent lead send | Both denied before provider; no foreign touch/audit; acceptance explicitly not delivery |
| NM-05 | Real office API key reads its own contact; viewer session reads own contact | Foreign key read/write, office-key delete, viewer write | Correct 404/403; no restore-mode 405 substitutes; foreign state unchanged |
| NM-06 | Staff own photo returns exact own bytes | Generic photos_attached activity grafts foreign object path | Write400; subsequent read404; zero foreign bytes |
| NM-07 | Dedicated own photo attachment, staff and portal own bytes, ordinary note all succeed | Preseeded legacy foreign/null-owned links and dedicated foreign attachment | Both staff and portal deny legacy links; unknown ownership denied independently of write fix; foreign state unchanged |
| NM-08 | Explicitly selected external adapter | Tenant-scoped read with no trusted ownership registry | ObjectNotFound before storage bucket/provider contact; GCS/Replit compatibility remains unaccepted |

Snapshot checks cover contacts, leads, estimates, tasks, activities, audit rows,
value entries, execution receipts and stored objects belonging to the foreign
tenant. They are not a complete account inventory or all-table fingerprint.

## Related regression checks and limitations

An expanded isolated selection reported **58 tests passed across eight files**:

- Normal-mode matrix — 15
- Portal add photos — 12
- Staff photo upload — 13
- Storage serving/stream failure — 3
- Portal photo access — 5
- Assessment photo service — 7
- Portal stream failure — 1
- Storage authentication — 2

That combined selection exited 1 because the existing
`assessment-photo-flow.test.ts` timed out on all five tests plus teardown.
It resolves the legacy default organization before public request validation;
that path seeds default automations. The isolated emulator has known limitations
around this seeding/concurrent transaction path. No runtime regression cause was
established by those timeouts, and they are not counted as a pass. The production
concurrency tests and legacy test were not weakened or altered. The parent is
using full real-PostgreSQL CI to arbitrate the remaining release gate.

API typecheck initially reported the unrelated cross-worker historical-import
fixture missing `mappedFields`; the parent repaired it and reported the workspace
typecheck green. This report does not substitute that parent evidence for fresh
exact-head hosted CI.

Remaining P0-8 acceptance includes the complete normal-mode matrix across all
enabled modules, scheduler/provider identities, Smart Site credentials, portal
actions, integrations, automations, webhooks and billing on one staging SHA.
These fifteen cases close one concrete hole and add a reusable local gate;
they do not certify every feature or workflow.
