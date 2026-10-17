# Staging permission policy acceptance, October 10

The observed staging permissions support the separately reviewed migration
without broadening database grants. This is policy acceptance of the recorded
95-table baseline; actual 142-table privileges remain an execution-time check.

Reader has SELECT on all 95 application tables and their 1,068 columns, with no
application DML, schema/database CREATE, TEMP, ownership or elevated role flags.
The application Writer has SELECT/INSERT/UPDATE/DELETE, with no
TRUNCATE/REFERENCES/TRIGGER or schema/database CREATE/TEMP. Reachable role paths
were reviewed: no additional SET-only, admin-option, `schema_admin`, `postgres`
or `pg_database_owner` path was found for either application identity.

The administrative preflight used `fly-user` in READ ONLY REPEATABLE READ, then
`SET LOCAL ROLE schema_admin`. All 95 tables and 15 application enums belong to
`schema_admin`, which has public-schema USAGE/CREATE. The raw `pg_default_acl`
result is empty; this is direct evidence rather than an inference from an
exploded ACL query. Connections, sockets, proxy and owned agent were cleaned up.

Reader/Writer access to newly created tables derives from the existing
`pg_read_all_data` / `pg_write_all_data` memberships. PostgreSQL documents those
roles' current and future object access in its
[PostgreSQL 16 predefined-role reference](https://www.postgresql.org/docs/16/predefined-roles.html).
The executor additionally checks every resulting table and column, unchanged
original ACLs and default ACLs on all 47 new tables before commit and again
through a separate Reader. No speculative GRANT/REVOKE is part of this change.

## Provider extension functions

The two event triggers and their function metadata match the stock `pgaudit` 16.1 C functions
`pgaudit_ddl_command_end` and `pgaudit_sql_drop`: public schema, postgres owner,
security-definer, event_trigger return type, `$libdir/pgaudit` library, matching
symbol and extension ownership. The expected configuration is exactly
`search_path="pg_catalog, pg_temp"`, matching
[the upstream 16.1 declaration](https://raw.githubusercontent.com/pgaudit/pgaudit/16.1/pgaudit--16.1.sql).
No provider function was changed or invoked directly by the observation. This
metadata check does not attest the provider's binary files.

The second administrative receipt retains its original failed status because
the first validator expected a different serialization of this known setting.
Its content-free comparison booleans and configuration digest establish that
the actual value matches the quoted upstream value. Independent review accepted
that interpretation; the historical receipt was not rewritten as a successful
run. The validator now requires the actual exact representation. A further
hosted query was unnecessary.

Evidence remains private under
`C:\Forge\artifacts\growthos-db-recovery-20261010`:

- `admin-preflight-2026-10-10T17-28-14-054Z.json`, SHA256
  `bfb9068a131d25c02012e6c1d517bb0ae5af21991ec86221fb2088dea265a739`.
- Exact known configuration JSON SHA256
  `abacc35ef28582bda06d292529e1d16762aaaf22b87940151e7f1f767ab04ee6`.
- The accepted metadata hashes are in the private
  `growthos-upgrade-rehearsal-20261010/admin-policy.json` packet. A temporary
  copy must match roles, schema, ownership, triggers and raw default ACLs before
  its migration begins.

The `pg_stat_monitor` extension view remains outside application fingerprints
and was not queried. This acceptance does not establish full-cluster backup
coverage, production permissions, hosted application journeys or launch readiness.
