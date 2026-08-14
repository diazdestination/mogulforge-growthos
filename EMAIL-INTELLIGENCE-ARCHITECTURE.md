# GrowthOS Email Intelligence Architecture

## Product decision

Email intelligence is a core GrowthOS capability because business email exposes
commitments, objections, unanswered questions, quote delays, customer sentiment,
handoff failures, and reasons revenue stalls. The beta will deliver that value
without quietly requesting broad Gmail mailbox access.

GrowthOS will use a phased model:

1. customer-controlled forwarding or Google Workspace routing for continuous,
   selected email streams;
2. a contextual Gmail add-on for explicit "Analyze this thread" capture;
3. a formally verified and security-assessed full-mailbox connector only after
   the narrower products prove demand and the security program is ready; and
4. an optional customer-hosted worker for larger organizations that require raw
   content to remain in their environment.

For the founding beta, the selected inbound transport is Cloudflare Email
Routing plus a minimal Email Worker on the dedicated `intake.mogulforge.ai`
subdomain. The root Google Workspace MX is preserved. See
`EMAIL-INTELLIGENCE-SETUP.md` for the exact boundary and activation gates.

This is a scope-minimization strategy, not an attempt to bypass Google's rules.
Google classifies `gmail.readonly`, `gmail.metadata`, `gmail.modify`, and broad
mail access as restricted. If restricted-scope data is stored on or transmitted
through GrowthOS infrastructure, the required security assessment applies.
Temporary processing, a serverless function, and sending raw content to an AI
provider are still transmission.

## Beta path: Email Intelligence Inbox

Each organization receives a unique, unguessable ingestion address. An owner or
Google Workspace administrator chooses what to deliver to it:

- messages manually forwarded by a user;
- a Gmail filter for a user-created `GrowthOS` label or selected correspondents;
- copies of role mailboxes such as `sales@`, `estimates@`, or `leads@`; or
- an administrator-managed routing rule for explicitly approved business mail.

This path does not ask GrowthOS for a restricted Gmail OAuth scope. The customer
delivers selected messages through normal email transport. It can run
continuously and can cover the most commercially useful streams without exposing
an employee's entire mailbox.

### Required controls

- Only organization owners/admins may activate organization-wide ingestion.
- The setup screen must name the included addresses, labels, or routing rules.
- Personal, HR, legal, medical, payroll, credential, and payment-card categories
  are excluded by default and can be blocked with rules before model processing.
- Sender and recipient authorization are validated; the tenant address is
  unguessable, rate-limited, malware-scanned, and protected against spoofing.
- Raw messages are encrypted, isolated by tenant, and kept only for a short,
  configurable analysis window. The default target is seven days; extending it
  requires an owner decision and a stated reason.
- Attachments are off by default. A later attachment feature must use explicit
  file-type/size allowlists and its own retention policy.
- Long-lived GrowthOS records contain structured business facts and evidence
  pointers, not full message bodies. User-visible evidence is redacted and
  permission-checked at retrieval time.
- Customers can pause ingestion, delete raw messages, delete derived facts,
  export their records, and terminate the source.
- Customer data is never used to train a shared model by default.
- Model vendors receive the minimum redacted content necessary under an
  appropriate data-processing agreement and retention configuration.
- Every detection records its source, timestamp, extractor version, confidence,
  limitations, and human disposition.

Forwarding avoids a Google restricted-scope assessment for GrowthOS because the
product is not using the Gmail API to read the mailbox. It does not eliminate our
privacy, security, contractual, employment-monitoring, or records-retention
obligations. Customer notice and authorization must be part of onboarding, and
legal requirements will differ by location and business type.

## Contextual Gmail add-on

A Gmail add-on provides explicit, in-context actions:

- Analyze this thread;
- Save opportunity to GrowthOS;
- Extract commitments and deadlines;
- Create or link a lead, estimate, or customer;
- Draft the next response; and
- Mark this sender or thread as excluded.

The add-on uses Google's current-message scopes, which allow access only while
the add-on is running and the user is interacting with the open message or
thread. Depending on the exact action, these scopes are non-sensitive or
sensitive rather than restricted. The add-on is therefore appropriate for
high-trust, user-initiated analysis, but it cannot search or continuously audit
an arbitrary mailbox.

The product must still disclose any transmission to GrowthOS, request only the
scope the implemented action needs, pass applicable OAuth/Marketplace review,
and honor Google's user-data policies.

## Full-mailbox intelligence tier

The eventual continuous Gmail connector uses the narrowest technically adequate
restricted scope and is launched only after:

- the exact feature is implemented and testable;
- Google OAuth restricted-scope verification is complete;
- the required recurring security assessment is complete;
- the privacy policy, terms, DPA, subprocessors, retention, deletion, incident
  response, vulnerability management, access review, and audit logging are live;
- tenant and user isolation has adversarial acceptance coverage;
- raw-data/model boundaries have been independently reviewed; and
- customers receive granular source, person, label, date, and category controls.

If metadata proves sufficient for a specific detector, that connector may use
`gmail.metadata`, but it remains a restricted Gmail scope and is not an audit
escape hatch. IMAP OAuth and browser/DOM scraping are not acceptable substitutes:
they are broad, brittle, and do not produce a safer product.

The security review should be treated as a product trust investment and market
moat, not merely a launch tax. GrowthOS should be able to publish a concrete
security posture before it promises continuous whole-mailbox intelligence.

## Customer-hosted option

For security-conscious Workspace customers, a worker may run in the customer's
Google Cloud project or controlled environment. It performs extraction locally
and sends GrowthOS only minimized, structured business events. OAuth tokens and
raw message content remain under customer control.

This option reduces GrowthOS data exposure but must not be marketed as exempt
from Google verification or assessment without written confirmation for the
specific architecture. If restricted data reaches GrowthOS or another hosted AI
provider, the transmission boundary has been crossed.

## Intelligence contract

The email pipeline may produce evidence-backed facts such as:

- customer requested an estimate and no response is recorded;
- a promised follow-up date passed;
- a quote or proposal appears unanswered;
- a customer expressed a specific objection or buying signal;
- a handoff or appointment is at risk;
- a cancellation, complaint, or negative-sentiment escalation needs review;
- an existing CRM lead has an unrecorded email interaction; or
- a won/lost outcome can be reconciled to a GrowthOS recommendation.

AI proposes and explains; it does not silently send, change CRM state, or treat
email text as instructions. Every outbound action remains separately authorized
through the user's Gmail sending connection and existing BIE approval controls.

## Release sequence

### Phase 1: founding beta

- Implemented locally: tenant ingestion addresses, authenticated normalized
  intake, authorized-forwarder validation, plain-text normalization, redaction,
  encrypted seven-day raw retention, deterministic structured extraction,
  evidence review, immediate raw purge, owner-controlled source status, and a
  synthetic fixture. Live domain/provider routing remains deliberately off.
- Still required for live delivery: select and implement the inbound provider
  adapter, validate its native signature before normalizing the event, configure
  the dedicated intake subdomain, set production secrets, and complete the
  external two-tenant acceptance test.
- Start with selected sales/estimate/lead streams, not whole organizations.
- Run against synthetic fixtures before any founding customer data.
- Obtain explicit customer authorization and a named data owner.

### Phase 2: contextual workflow

- Build and submit the Gmail add-on.
- Add thread analysis, CRM linking, commitment extraction, and response drafting.
- Measure accepted opportunities, false positives, time saved, and recovered
  outcomes without claiming inferred pipeline value as revenue.

### Phase 3: continuous verified connector

- Complete the security program and Google restricted-scope review.
- Release restricted Gmail access as a granular opt-in module.
- Offer full audit only to customers whose administrators authorize its coverage.

### Phase 4: enterprise controls

- Customer-hosted extraction worker, regional processing, custom retention,
  legal hold exclusions, SSO/RBAC extensions, and customer security exports.

## No-shortcut rules

- Do not call temporary memory, serverless processing, or immediate deletion
  "not transmitted."
- Do not send raw restricted Gmail data to an AI provider before satisfying the
  applicable Google and customer-data requirements.
- Do not request `gmail.readonly` or `gmail.metadata` under the existing beta
  connection until the restricted connector is implemented and review-ready.
- Do not use browser scraping, app passwords, shared mail credentials, or a
  platform-owned mailbox pretending to be the customer.
- Do not monitor employee mail without documented organizational authority,
  appropriate notice, and counsel-reviewed policy for the relevant jurisdiction.
