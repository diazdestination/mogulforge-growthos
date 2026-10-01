# Isolated staging schema preview — September 30, 2026

Status: **generated preview only; not applied or approved for release**.

The owner-approved Fly MPG cluster `zp2wjrejd2zodn4q` contains a separate
`growthos_staging` database. A read-only connection through `fly mpg proxy`
confirmed `current_database()=growthos_staging`, `session_user=fly-user`,
`default_transaction_read_only=on`, and zero application tables in `public`.
No schema command was run against the database.

The checked-in SQL and snapshot were generated from
`lib/db/src/schema/index.ts` using the repository's installed Drizzle Kit:

```text
pnpm exec drizzle-kit generate --dialect postgresql --schema ./src/schema/index.ts --out ../../reports/staging-schema-preview-2026-09-30 --name isolated-staging-initial
```

Run from `lib/db`. This command does not connect to Fly. The preview contains
15 enum types, 90 tables, 207 `ALTER TABLE ... ADD CONSTRAINT` statements,
61 unique indexes and 87 other indexes. Its top-level SQL statements contain
no `DROP`, `TRUNCATE`, `DELETE FROM` or `UPDATE`. SHA-256 of
`0000_isolated-staging-initial.sql` is
`B27D33A59A8A0F083FEFE3271936D197309DB5D683BD4254BBD28D7BC7315A10`.

This is a source-schema preview for human review, **not** a verified delta from
the actual Fly database and not an executable migration plan. The installed
Drizzle Kit does not recognize `push --explain`; its current push path uses
`--force` and remains gated by `STAGING_SCHEMA_PUSH_APPROVED=false`. Before any
staging release, review compatibility of the generated SQL with the actual
empty cluster, confirm required extensions/defaults, establish meaningful
backup/restore evidence, and authorize the exact schema operation separately.
The staging app remains stopped; customer and provider sends remain off.
