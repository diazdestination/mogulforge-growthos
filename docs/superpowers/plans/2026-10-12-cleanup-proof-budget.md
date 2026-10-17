# Cleanup proof timing follow-up

BasePR47/ae2e2eb stays published/fixed; application PR44 and all19 SQL stay fixed.
Observed original-only read53.138s exceeds existing30s cleanup callback bound.
This source-only follow-up changes only the post-deletion read-only proof budget
(up to4min, always clipped to the admitted absolute cleanup deadline). PaidAPI
requests/deletion retain their30s callback and15s HTTP bounds. No paid or hosted
execution; actual protected-app/price/Reader gates stay open. No app stop/start.

1. RED virtual53s source-proof callback must pass only after owned deletion;
   expiry beyond absolute cleanup deadline and slow delete must remain held.
2. GREEN explicit bounded read-only proof callback; full scripts/types/native
   regression, no schema/provider/request/cost/absolute-lifetime changes.
3. Prepare dependent private follow-up source with current native dependency
   binding. Source-only scope; no new priced grant or deployment.
