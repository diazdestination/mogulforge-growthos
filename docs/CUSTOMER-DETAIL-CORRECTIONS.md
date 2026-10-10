# Staff customer-detail corrections

The customer workspace lets active, accepted owner, admin and office staff correct a customer's name, email, phone and an explicitly selected property's address. Staff first load the current details. Contact-only editing is the default; changing an address requires selecting its property.

All three private routes require the signed-in session, trusted application origin and CRM permission. API-key headers are refused, including empty headers. Responses use no-store and no-referrer headers.

- `GET /api/v1/contacts/:id/detail-correction` loads a current snapshot, optionally with `propertyId`.
- `POST /api/v1/contacts/:id/detail-corrections` applies a strict request with its UUID, changed fields and expected snapshot version.
- `GET /api/v1/contacts/:id/detail-corrections/:requestId` checks that staff member's original receipt for this company and customer.

The service rereads accepted membership and locks the scoped contact before the selected property. A stale contact/property version or changed property parent refuses the save. Both row changes and their audit receipt share one transaction. The receipt stores the before/after allowed details and normalized request digest; the request UUID identifies its original audit event. Identical same-actor retries return that receipt. A reused UUID with another payload, actor or customer refuses without partial edits. Explicit no-op saves produce one unchanged receipt without changing row timestamps.

Consent, DNC, acquisition history, ownership, coordinates, appointment/dispatch state and outbound messaging are outside the editable contract. Phone formatting is preserved; editing it does not grant contact permission. Unchanged malformed legacy email/phone data does not prevent correcting another field, while supplied changes still undergo validation.

An unconfirmed save locks further writes and preserves its original request in the mounted panel. Staff can close and reopen the panel and check the original receipt through the read-only route. A missing receipt leaves the outcome unconfirmed. After confirmation, staff load the current details before another edit. Stale callbacks, context changes, cached pending membership and late responses cannot promote an old save into the current workspace. There is no automatic write retry or local-storage copy of customer details.

This is the private staff correction workflow. A public customer correction link requires a separate tenant/customer/version-bound token, lifetime and replay policy. A detail correction does not confirm an appointment or dispatch slot.

## Local validation

The October 9, 2026 continuation verified 60 API tests across seven files on disposable native PostgreSQL 16.15, including same-version concurrent saves and audit-primary-key rollback. There were no failures or skips. It also verified 41 UI tests, both typechecks and both production builds. The temporary database container, its loopback port and tracked workers were closed or removed and separately checked.

The Windows-only local helper is `artifacts/api-server/scripts/test-customer-detail-corrections-isolated.mjs`. It refuses existing `DATABASE_URL` and nearby environment files, requires the fixed already-cached PostgreSQL image, uses only a new nonce-labelled loopback/tmpfs container, and retains a bounded password-redacted Vitest log plus creation and cleanup receipts under `reports/`. It does not pull images or use hosted databases. A supervised interrupted or unknown CREATE needs explicit inspection of its retained intent and exact ownership; the helper does not adopt a container by name.

The earlier PGlite socket run failed around audit-collision rollback and subsequent result alignment. Those logs remain preserved; simpler protocol probes passed, so the exact in-memory transport cause remains unresolved. Native PostgreSQL verification passed without changing the application transaction logic. Passing local checks do not establish deployed behavior, real staff access, provider activation or client cutover acceptance.
