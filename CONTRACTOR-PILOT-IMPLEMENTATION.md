# Contractor pilot implementation and release boundary

> **Current context — October 29, 2026:** The technical contract and dated results below describe their recorded feature checkpoint. Current main includes later contractor, scheduling, service, mailbox and Twilio work; use the current inventory for implemented features and pending live acceptance. Older branch names, test totals and approvals do not become current by this documentation refresh.
> See [current build](CURRENT-BUILD.md) and [documentation map](docs/DOCUMENTATION-MAP.md).


September 30, 2026 — local code on the private GrowthOS beta-prep branch. **Not a production activation or claim that Painless and Climate Simulation Solutions are live.**

Communications update: the owner chose to continue with Twilio after evaluating
alternatives. The [provider review](COMMUNICATIONS-PROVIDER-REVIEW-2026-09-30.md)
is historical. Client-specific Twilio binding, voice acceptance and SMS sender
approval remain unfinished; this choice is not live activation.

## What the shared product can now do in code

- Existing Smart Site intake remains tenant/site-key scoped and creates an inquiry, consent receipt and staff follow-up task. Painless has a local encrypted retry journal; its hosted drain and public activation are still pending. The separate HVAC review site now has a disabled-by-default server adapter and form for the same GrowthOS contract. It appears only when an HVAC-specific site key, exact origin and approved contact disclosure are installed server-side.
- CSV lead import and throttled existing-lead campaigns remain separate from the new customer/service import. A Housecall Pro-style CSV can be mapped, previewed without writes, then explicitly committed into contacts plus warranty-check, maintenance or service-plan obligations. It does not manufacture sales leads or grant email/SMS permission. Service dates create staff tasks before the due date; staff can close or link an appointment. The new Service Desk exposes that flow.
- A signed missed inbound call now creates one callback task. The Calls screen lets staff link the matching existing contact or explicitly create an opportunity. Unknown callers are not auto-qualified; no missed-call text, campaign, recording or booking is initiated.
- Reactivation enrollment is transaction-atomic with its first scheduled step and campaign link. Webhook attempts are claimed before network I/O; ambiguous results are held for review. Local synthetic tests cover these boundaries. An exact production PostgreSQL crash/restart exercise remains outstanding.

## Pilot readiness by client

| Capability | Painless Roofing & Water Restoration | Climate Simulation Solutions (HVAC) |
| --- | --- | --- |
| Branded Smart Site | Local capture/outage recovery code exists; release gates remain | Local site/connector code exists; no real tenant or key installed |
| Lead desk and existing-lead campaigns | Shared GrowthOS code; needs approved tenant/staff/provider acceptance | Shared GrowthOS code; needs new isolated tenant/staff/provider acceptance |
| Missed-call task and staff review | Shared code, not live; single-org Twilio binding blocks rollout | Shared code, not live; dedicated HVAC binding/on-call routing absent |
| Existing customers/service dates | Can use the common service desk if applicable | CSV preview/import and staff task flow implemented locally; no real Housecall Pro export imported |
| Customer warranty/service notifications | Not activated | **Not implemented for live sending**. Current service desk creates staff tasks only; verified client sender, channel consent, templates, scheduler acceptance and appointment policies are required. |

## Do next, in dependency order

1. Finish paid-beta P0 reliability/release evidence: PostgreSQL restart/failure windows, always-on scheduler and alerting, exact-head staging, restore test, two-tenant isolation, privacy/retention, provider-verified acceptance. Code/test green is not this proof.
2. Keep the existing global Twilio voice binding disabled until it is replaced
   with one organization-specific Twilio account/number/secret binding per
   contractor, without cross-tenant or global fallback. Test two synthetic
   tenants, revocation, wrong signature/account/number, retries and status
   callback races before any client rollout.
3. Select and approve each client's Twilio account model, pilot number or
   conditional forwarding, staff/on-call recipients, budgets, contact policy,
   consent path and rollback. Verify real carrier routing, original caller ID
   and callback handoff on explicitly approved test phones. No automatic
   missed-call SMS until the client's sender/campaign approval,
   purpose-specific consent and full acceptance exist.
4. Obtain the actual Housecall Pro exports and map their fields to contacts, equipment and due dates. Review the preview with the HVAC owner before committing real customer records. Confirm their warranty/plan rules and service intervals; the generic import must not invent missing dates.
5. Build the customer-notification workflow on verified sending identities: due-date policy, approved copy, email/SMS preference, purpose-specific SMS consent, opt-outs, bounded retries, delivery receipts, staff escalation and appointment-booking handoff. Keep existing customers out of acquisition campaigns unless marketing permission is separately established.
6. Complete each Smart Site Launch Guard independently: real manager/responder, key handshake, owner-approved contact disclosure and HTTPS acceptance. Activate each site deliberately and verify a labeled end-to-end inquiry; do not substitute the synthetic HVAC fixture or Painless resources.

The product UX should stay centered on **Today’s priorities, Calls, Service Desk, Pipeline, and Win-back**. Agent names can be friendly labels over bounded, auditable actions; they are not a Codex desktop white-label runtime or blanket account access.
