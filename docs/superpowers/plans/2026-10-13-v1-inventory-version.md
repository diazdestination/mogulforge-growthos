# Bind omitted V1 detail version to inventory

> Execute inline; one fresh whole-branch reviewer, no implementation agents.

Goal: handle the observed legacy detail/restore response without weakening owned
copy admission. Real V1 inventory carries version1, but detail data omits version
and attached_apps, with separate top-level credentials/password that must never
be retained or logged. The previous paid restore was created; ownership parsing
held before Reader/SQL. Observed owned copy was deleted under existing authority.

Design: only detail and restore DTOs may keep omitted version as explicit null.
Inventory remains strict. Merge confirms id/name/org/region/plan, then obtains
version solely from the matching independently fetched inventory. Explicit
invalid versions or conflicts still hold. Existing attachment and suitability
checks remain. Do not guess version1, reuse a paid grant or run new hosted copies.
ApplicationPR44/8df64dc and19SQL remain fixed; all20contractor gaps stay.

- [ ] RED real omitted-version fixture, strict inventory omission, invalid and
      conflicting versions, restore/get detail+inventory composition.
- [ ] GREEN minimal parser/merge change; native mock emits observed omission
      for detail/restore and complete inventory for authoritative binding.
- [ ] Focused/full scripts/types/scans/current native/runtime hashes.
- [ ] One fresh review; private dependent draft/exact CI.
- [ ] Prepare reviewed replacement packet; ask priced one-copy approval only
      when ready. Previous one-copy grant is consumed; no new purchase here.
