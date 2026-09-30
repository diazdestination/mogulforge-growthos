# GrowthOS background-work operations

Updated: 2026-09-29. Status: implementation and isolated acceptance; **not a deployment or paid-beta approval**.

## What this release adds

GrowthOS's web process also runs the scheduler. It begins one cycle at startup, waits for that cycle to finish, then waits 60 seconds before the next cycle. A PostgreSQL session advisory lock prevents two healthy processes from running global cycles concurrently during a rolling release. Scheduled effects retain their tenant-scoped durable execution receipt; losing a process or database connection never authorizes replay of an uncertain effect.

Due actions are selected oldest-first. Live execution owners do not occupy the entire batch and starve other work. Preparation failures without a receipt persist their attempt count, wait 5 then 10 minutes, and stop after the third failure. Failure after ownership is recovered from the receipt or held for review. Cancellation wins over a failed preparation update. Error messages saved by this path and scheduler-stage logs use fixed, non-sensitive explanations.

The operator's **Client Launchpad → Follow-up reliability** shows the last progress and completed cycle, stale/stopped/degraded states, due actions, failed records and execution reviews. Only a current active platform administrator's session may read `/api/v1/platform/runtime`. API keys and ordinary tenant owners are rejected. The response contains aggregate operational metadata, not customer bodies, credentials, raw errors or job payloads. A failed refresh hides the old status; the interface never substitutes a green result.

## Smallest beta topology

- One continuously running `shared-cpu-1x`, 1 GB application machine in `iad` per active environment, plus that environment's PostgreSQL database.
- Prepared Fly configurations retain auto-stop for surplus capacity and set `min_machines_running = 1` in the primary region. They use SIGTERM and a 30-second platform shutdown allowance. The application drains HTTP and scheduler work for at most 25 seconds.
- Use a **direct PostgreSQL connection or session pooling**. Transaction-mode connection pooling is incompatible with the session ownership lock. Validate this before staging; do not silently rely on the lock through a transaction pooler.
- Apply the additive `scheduler_runtime` table through the normal release schema gate before serving the new application. The existing schema release process and backup/restore gates still apply.
- No Redis service, separate worker bill or additional provider subscription was introduced. A sleeping/stopped application cannot process follow-up on time; configuration on disk alone does not prove an always-on machine exists.

Fly documents that its minimum applies in the primary region when auto-stop is enabled, and that shutdown timeouts are best-effort: [configuration reference](https://docs.fly.io/reference/configuration/).

### Cost planning, not authorization

Fly's published base pricing shows shared-1x/256 MB at $1.94 per month, with extra RAM at $5 per GB-month. An illustrative 1 GB machine is therefore **$1.94 + 0.75 × $5 = $5.69/month**, or $11.38 for one production and one staging machine continuously running. Region-specific rates, machine count and the actual invoice must be checked before deployment. These are base-price examples, not a verified `iad` quote. Database, backups, storage, egress, IPs, taxes and email/SMS/AI usage are additional. Published Managed Postgres Basic starts at $38/month plus $0.28/GB storage; no database plan was selected or purchased here. [Fly pricing, checked September 29, 2026](https://fly.io/pricing/).

## Operator response

| State | Meaning | Next action |
| --- | --- | --- |
| No worker observed | No runtime row exists | Verify the schema and start the approved application. |
| Current / processing | Recent progress; cycle finished or is running | Inspect due work and reviews separately. This is not delivery proof. |
| Heartbeat overdue | No stage progress for over five minutes | Inspect machine, database connectivity, logs and the last stage. A long stage can also trigger this conservative warning. |
| Needs attention | A stage or cycle failed | Inspect the named stage and its records; resolve the underlying problem. |
| Worker stopped | Graceful shutdown was recorded | Confirm a replacement is running and produces fresh progress. |
| Execution review > 0 | An effect is uncertain or ownership expired | Open the owning client's Revenue Desk, inspect the receipt and downstream evidence, then reconcile. Never blindly resend. |

Failed-record counts include historical records; they are not all currently actionable incidents. Reconciliation records an observed outcome and does not enqueue a resend. If a new action is justified, it needs its own authorization and evidence after reconciliation. A pre-ownership failure has no execution receipt: inspect its safe scheduled record, repair the preparation problem, and prepare a new approved action only after confirming no effect occurred.

For an authorized operator, this read-only query identifies failed scheduled records without selecting customer content:

```sql
SELECT a.id, a.organization_id, a.action->>'type' AS kind,
       a.attempts, a.run_at, a.status,
       e.id AS execution_id, e.state AS execution_state
FROM scheduled_actions a
LEFT JOIN revenue_executions e
  ON e.organization_id = a.organization_id
 AND e.action_key = 'scheduled:' || a.id::text
WHERE a.status = 'failed'
ORDER BY a.run_at DESC
LIMIT 100;
```

## Verification and remaining gates

- `pnpm --filter @workspace/api-server run test:scheduler` creates a new in-memory database and excludes inherited database/provider credentials. It covers bounded retries, cancellation, queue fairness, stage isolation, heartbeat, access control and durable receipts.
- Its real child-process restart fixture stops a worker **after** a synthetic task is committed but **before** the receipt is completed. A replacement process leaves exactly one copy of that task, marks its interrupted receipt indeterminate and completes the other due task. The test advances the 15-minute ownership deadline rather than sleeping for it.
- Independent-session advisory lock exclusion is **skipped only in the explicit PGlite runner**. The normal CI suite uses PostgreSQL and must pass it without that skip. PGlite's multiplexed connection is not evidence of production PostgreSQL lock semantics.
- A stage heartbeat now requires an updated row still owned by that worker. A zero-row update stops progression at that stage boundary even if the advisory-lock connection has not emitted an error event. Work already in flight remains governed by durable receipts. The isolated regression deliberately replaces the owner mid-cycle; it proves fail-closed stage progression, not a real PostgreSQL failover.
- Interface tests cover authorization, fresh/stale/degraded status and failure to refresh. Desktop and phone evidence is in `design/runtime-health-desktop.png` and `design/runtime-health-mobile.png`.
- `pnpm --filter @workspace/api-server run preview:scheduler` serves the real routes/UI against fictional, disposable loopback data at port 4192. It uses a separate preview entrypoint to avoid the emulator's incompatible concurrent legacy startup seeding. It does not validate production bootstrap, Fly operation or provider delivery. Close the runner to discard its in-memory fixture; existing databases are never opened.
- **Still required:** exact-commit green CI, staging machine/connection-pool inspection, schema/backup/restore evidence, staged idle/restart acceptance, and real provider receipts under an approved test plan.
- **September 30 local contractor slice:** reactivation enrollment, its first scheduled step, lead-stage change and campaign linkage now commit in one transaction per lead. A failed transaction leaves the campaign row pending for a later bounded tick; cancellation stops only the campaign's linked enrollment. Outbound webhooks atomically claim an attempt before network I/O; interrupted/ambiguous network outcomes remain held as failed for operator review, not automatic replay. Confirmed HTTP failures retain the receiver-deduplicated delivery-ID retry protocol. Isolated synthetic tests cover the failure/retry, linkage, concurrent attempt and ambiguous network cases. This is code/test evidence only: PostgreSQL crash/restart acceptance, exact-SHA staging, provider receiver deduplication and operations review remain required before marking P0-2 passed.

## Staging acceptance checklist

1. Record the exact CI-green SHA, schema version and isolated staging identity. Take/verify the applicable backup before migration.
2. Verify an active machine in `iad`, the approved cost, direct/session-pooled database connectivity, and no production provider keys or customer records in staging.
3. Confirm a fresh heartbeat without opening client traffic for at least two cycles. Check that failed/uncertain records remain visible.
4. Queue synthetic internal tasks; repeat the controlled restart and concurrent-worker test using real PostgreSQL. Do not use real customer messages as crash fixtures.
5. Verify the owning client can inspect/reconcile uncertain receipts, another client cannot read them, and platform aggregates remain payload-free.
6. Exercise legacy reactivation and outbound-webhook failure windows separately; record remaining defects instead of marking the whole gate green.
7. Record observed shutdown timing, restart timing, heartbeat, receipt IDs and exact SHA in the release evidence. Only then assess P0-2; P0-3 through P0-9 remain independent release gates.
