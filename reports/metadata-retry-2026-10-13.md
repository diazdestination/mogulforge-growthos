# Bounded retries for transient cluster metadata

The separately approved one-copy test created9g6y30wd11xrv5ml. A list-clusters
GET returned HTTP500 after ownership was established, before clone verification,
Reader creation or SQL. The operator safely deleted the copy and verified all
184 original records against source5fbb. Both independent checks confirmed
deletion, active-inventory absence, original readiness and matching app metadata,
but their full-data comparisons held on connection deadlines. Those held receipts
remain intact; no independent full-source PASS is claimed.

The driver now retries only GET list-clusters/get-cluster on500/502/503/504,
at most three total attempts. It cancels the failed body before1s/2s backoff.
Authentication, backoff, dispatch and final reading share the existing total
15-second deadline. The4,000,000-byte cap and all success/ownership validation
remain. Terminal status, malformed success, redirect/foreign URL and failed
cancellation do not become accepted metadata.

POST/DELETE, credential, user and backup operations are not retried. Mutation
permits remain permanent. A failed read never grants readiness, ownership or
deletion; those still require fresh validated responses. This does not fix or
establish the earlier Reader422 cause.

Validation:6 genuine RED failures/5 existing guards passed before implementation;
135 focused and668 scripts tests passed; types passed. One old concurrent503
test deferred every retry forever; its fixture now gates only the first response
while retaining concurrent diagnostic-isolation checks. Independent review
accepted with0 Important/Critical findings and156 tests plus cancellation,
backoff, deadline/no-late-dispatch and excluded-operation probes.

Real local PostgreSQL nativea0ce40b0-f960-40db-a7ac-fedeb1296f98 PASS:99 clients/
sockets and6 owned containers closed;23 runtime hashes stayed stable. Provider
calls/admission/proxy ownership there are synthetic. Exact-head CI is required.

The new15c grant is consumed by the deleted copy; actual metering is unverified.
No further copy, original database/app mutation or deployment is authorized here.
App8df/all19SQL/full142-table target and all20 contractor gaps remain unchanged.
Hosted Reader/profile/upgrade/rollback remain open.
