# Opaque non-ready cluster status

Two allowance copies rejected HTTP200 status fields during restore before Reader
or SQL. Exact rejected values were deliberately not retained. Both later returned
ready metadata, were deleted through their unused permit, and original data/app
configuration preservation passed. The pinned official V1 model declares Status
as string rather than an exhaustive enum. Reader failure cause remains unknown.

Ruling: separate readiness from identity. Map only bounded, nonempty primitive
unknown status strings to fixed not-ready, never persist the raw value. This
sentinel grants no readiness, deletion or ownership. Keep all immutable identity,
namespace/version/suitability/empty-attachment checks and recognized terminal
states. Poll GET within existing deadlines; keep onlyready before clone reads,
Reader and SQL, including ambiguous-create reconciliation. Owned DELETE still
requires the existing unused permit. No timeout/write retry or app-state changes.
Cost if wrong: bounded wait may consume the approved lifetime, followed by cleanup;
unknown status can never enable SQL. App8df/all19 SQL and financial caps stayfixed.

1. Prove string normalization, malformed rejection, unknown->ready, permanent
   unknown timeout/cleanup and ambiguous-create readiness with failing tests.
2. Implement shared readiness wait; run focused/full/types/native/hash/scans.
3. Independent whole-delta review and one fix pass; publish draft/exact-head CI.
4. Fresh preparation/review/child3 only after actual slot2 containment/completion.

Review focus: no raw status/secret retention, terminal state semantics, readiness
on every clone/Reader/SQL path, strict ownership/suitability and deadline cleanup.
