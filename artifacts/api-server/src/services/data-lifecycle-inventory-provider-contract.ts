import type { InventoryTableShape } from "./data-lifecycle-inventory";

/**
 * Pinned from a read-only staging catalog inspection at 2026-10-01T18:02:16.729Z.
 * Only relation/extension metadata was inspected. No monitoring rows were read.
 * Evidence reported zero primary/foreign-key constraints for this view.
 * This contract is distinct from the simplified Docker parity fixture and does
 * not allow other versions, owners, definitions or monitoring objects.
 */
export const REVIEWED_FLY_PROVIDER_METADATA = {
  contract: "fly_mpg_pg_stat_monitor_2_3_v1",
  table: {
    "schema": "public",
    "name": "pg_stat_monitor",
    "kind": "v",
    "rls": false,
    "owner": "postgres",
    "columns": [
      {
        "name": "application_name",
        "type": "text",
        "notNull": false
      },
      {
        "name": "blk_read_time",
        "type": "double precision",
        "notNull": false
      },
      {
        "name": "blk_write_time",
        "type": "double precision",
        "notNull": false
      },
      {
        "name": "bucket",
        "type": "bigint",
        "notNull": false
      },
      {
        "name": "bucket_done",
        "type": "boolean",
        "notNull": false
      },
      {
        "name": "bucket_start_time",
        "type": "timestamp with time zone",
        "notNull": false
      },
      {
        "name": "calls",
        "type": "bigint",
        "notNull": false
      },
      {
        "name": "client_ip",
        "type": "inet",
        "notNull": false
      },
      {
        "name": "cmd_type",
        "type": "integer",
        "notNull": false
      },
      {
        "name": "cmd_type_text",
        "type": "text",
        "notNull": false
      },
      {
        "name": "comments",
        "type": "text",
        "notNull": false
      },
      {
        "name": "cpu_sys_time",
        "type": "double precision",
        "notNull": false
      },
      {
        "name": "cpu_user_time",
        "type": "double precision",
        "notNull": false
      },
      {
        "name": "datname",
        "type": "text",
        "notNull": false
      },
      {
        "name": "dbid",
        "type": "oid",
        "notNull": false
      },
      {
        "name": "elevel",
        "type": "integer",
        "notNull": false
      },
      {
        "name": "jit_emission_count",
        "type": "bigint",
        "notNull": false
      },
      {
        "name": "jit_emission_time",
        "type": "double precision",
        "notNull": false
      },
      {
        "name": "jit_functions",
        "type": "bigint",
        "notNull": false
      },
      {
        "name": "jit_generation_time",
        "type": "double precision",
        "notNull": false
      },
      {
        "name": "jit_inlining_count",
        "type": "bigint",
        "notNull": false
      },
      {
        "name": "jit_inlining_time",
        "type": "double precision",
        "notNull": false
      },
      {
        "name": "jit_optimization_count",
        "type": "bigint",
        "notNull": false
      },
      {
        "name": "jit_optimization_time",
        "type": "double precision",
        "notNull": false
      },
      {
        "name": "local_blks_dirtied",
        "type": "bigint",
        "notNull": false
      },
      {
        "name": "local_blks_hit",
        "type": "bigint",
        "notNull": false
      },
      {
        "name": "local_blks_read",
        "type": "bigint",
        "notNull": false
      },
      {
        "name": "local_blks_written",
        "type": "bigint",
        "notNull": false
      },
      {
        "name": "max_exec_time",
        "type": "double precision",
        "notNull": false
      },
      {
        "name": "max_plan_time",
        "type": "double precision",
        "notNull": false
      },
      {
        "name": "mean_exec_time",
        "type": "double precision",
        "notNull": false
      },
      {
        "name": "mean_plan_time",
        "type": "double precision",
        "notNull": false
      },
      {
        "name": "message",
        "type": "text",
        "notNull": false
      },
      {
        "name": "min_exec_time",
        "type": "double precision",
        "notNull": false
      },
      {
        "name": "min_plan_time",
        "type": "double precision",
        "notNull": false
      },
      {
        "name": "pgsm_query_id",
        "type": "bigint",
        "notNull": false
      },
      {
        "name": "planid",
        "type": "bigint",
        "notNull": false
      },
      {
        "name": "plans",
        "type": "bigint",
        "notNull": false
      },
      {
        "name": "query",
        "type": "text",
        "notNull": false
      },
      {
        "name": "query_plan",
        "type": "text",
        "notNull": false
      },
      {
        "name": "queryid",
        "type": "bigint",
        "notNull": false
      },
      {
        "name": "relations",
        "type": "text[]",
        "notNull": false
      },
      {
        "name": "resp_calls",
        "type": "text[]",
        "notNull": false
      },
      {
        "name": "rows",
        "type": "bigint",
        "notNull": false
      },
      {
        "name": "shared_blks_dirtied",
        "type": "bigint",
        "notNull": false
      },
      {
        "name": "shared_blks_hit",
        "type": "bigint",
        "notNull": false
      },
      {
        "name": "shared_blks_read",
        "type": "bigint",
        "notNull": false
      },
      {
        "name": "shared_blks_written",
        "type": "bigint",
        "notNull": false
      },
      {
        "name": "sqlcode",
        "type": "text",
        "notNull": false
      },
      {
        "name": "stddev_exec_time",
        "type": "double precision",
        "notNull": false
      },
      {
        "name": "stddev_plan_time",
        "type": "double precision",
        "notNull": false
      },
      {
        "name": "temp_blk_read_time",
        "type": "double precision",
        "notNull": false
      },
      {
        "name": "temp_blk_write_time",
        "type": "double precision",
        "notNull": false
      },
      {
        "name": "temp_blks_read",
        "type": "bigint",
        "notNull": false
      },
      {
        "name": "temp_blks_written",
        "type": "bigint",
        "notNull": false
      },
      {
        "name": "top_query",
        "type": "text",
        "notNull": false
      },
      {
        "name": "top_queryid",
        "type": "bigint",
        "notNull": false
      },
      {
        "name": "toplevel",
        "type": "boolean",
        "notNull": false
      },
      {
        "name": "total_exec_time",
        "type": "double precision",
        "notNull": false
      },
      {
        "name": "total_plan_time",
        "type": "double precision",
        "notNull": false
      },
      {
        "name": "userid",
        "type": "oid",
        "notNull": false
      },
      {
        "name": "username",
        "type": "text",
        "notNull": false
      },
      {
        "name": "wal_bytes",
        "type": "numeric",
        "notNull": false
      },
      {
        "name": "wal_fpi",
        "type": "bigint",
        "notNull": false
      },
      {
        "name": "wal_records",
        "type": "bigint",
        "notNull": false
      }
    ],
    "primaryKey": [],
    "foreignKeys": [],
    "viewDefinition": " SELECT bucket,\n    bucket_start_time,\n    userid,\n    username,\n    dbid,\n    datname,\n    ('0.0.0.0'::inet + client_ip) AS client_ip,\n    pgsm_query_id,\n    queryid,\n    toplevel,\n    top_queryid,\n    query,\n    comments,\n    planid,\n    query_plan,\n    top_query,\n    application_name,\n    string_to_array(relations, ','::text) AS relations,\n    cmd_type,\n    get_cmd_type(cmd_type) AS cmd_type_text,\n    elevel,\n    sqlcode,\n    message,\n    calls,\n    total_exec_time,\n    min_exec_time,\n    max_exec_time,\n    mean_exec_time,\n    stddev_exec_time,\n    rows,\n    shared_blks_hit,\n    shared_blks_read,\n    shared_blks_dirtied,\n    shared_blks_written,\n    local_blks_hit,\n    local_blks_read,\n    local_blks_dirtied,\n    local_blks_written,\n    temp_blks_read,\n    temp_blks_written,\n    shared_blk_read_time AS blk_read_time,\n    shared_blk_write_time AS blk_write_time,\n    temp_blk_read_time,\n    temp_blk_write_time,\n    string_to_array(resp_calls, ','::text) AS resp_calls,\n    cpu_user_time,\n    cpu_sys_time,\n    wal_records,\n    wal_fpi,\n    wal_bytes,\n    bucket_done,\n    plans,\n    total_plan_time,\n    min_plan_time,\n    max_plan_time,\n    mean_plan_time,\n    stddev_plan_time,\n    jit_functions,\n    jit_generation_time,\n    jit_inlining_count,\n    jit_inlining_time,\n    jit_optimization_count,\n    jit_optimization_time,\n    jit_emission_count,\n    jit_emission_time\n   FROM pg_stat_monitor_internal(true) pg_stat_monitor_internal(bucket, userid, username, dbid, datname, client_ip, queryid, planid, query, query_plan, pgsm_query_id, top_queryid, top_query, application_name, relations, cmd_type, elevel, sqlcode, message, bucket_start_time, calls, total_exec_time, min_exec_time, max_exec_time, mean_exec_time, stddev_exec_time, rows, plans, total_plan_time, min_plan_time, max_plan_time, mean_plan_time, stddev_plan_time, shared_blks_hit, shared_blks_read, shared_blks_dirtied, shared_blks_written, local_blks_hit, local_blks_read, local_blks_dirtied, local_blks_written, temp_blks_read, temp_blks_written, shared_blk_read_time, shared_blk_write_time, local_blk_read_time, local_blk_write_time, temp_blk_read_time, temp_blk_write_time, resp_calls, cpu_user_time, cpu_sys_time, wal_records, wal_fpi, wal_bytes, wal_buffers_full, comments, jit_functions, jit_generation_time, jit_inlining_count, jit_inlining_time, jit_optimization_count, jit_optimization_time, jit_emission_count, jit_emission_time, jit_deform_count, jit_deform_time, parallel_workers_to_launch, parallel_workers_launched, stats_since, minmax_stats_since, toplevel, bucket_done)\n  ORDER BY bucket_start_time;",
    "extensions": [
      {
        "name": "pg_stat_monitor",
        "version": "2.3"
      }
    ]
  } satisfies InventoryTableShape,
};
