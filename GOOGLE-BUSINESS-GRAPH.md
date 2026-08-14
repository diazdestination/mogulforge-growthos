# GrowthOS Google Business Graph

## Decision

GrowthOS will offer one Google connection experience with independently
authorized intelligence modules. This is the useful part of the “super Google
connector” pattern: a unified product surface over standard Google OAuth and
APIs. It is not blanket access and it is not an exemption from Google's scope,
verification, security-assessment, or product-approval requirements.

Users may connect nothing, one module, or several modules. CRM and deterministic
BIE remain useful without Google access.

## Module policy

| Module | Initial scope | BIE value | Release posture |
| --- | --- | --- | --- |
| Gmail sending | `gmail.send` | Approved follow-up from the user's identity | Implemented foundation |
| Calendar availability | `calendar.freebusy` | Capacity gaps and scheduling conflicts without event content | Next adapter |
| Calendar intelligence | `calendar.events.readonly` | Upcoming jobs, missed follow-ups, and workload risks | Optional sensitive module |
| Selected Drive files | `drive.file` + Google Picker | User-chosen operating documents and folders | Preferred Drive model |
| Selected Sheets | `drive.file` + Sheets API | User-chosen sales, estimating, operations, and finance facts | Preferred Sheets model |
| Analytics | `analytics.readonly` | Demand, conversion, and lead-quality signals | Read-only adapter |
| Search Console | `webmasters.readonly` | Search demand, visibility losses, and content opportunities | Read-only adapter |
| Google Ads | `adwords` | Spend-to-lead-to-estimate-to-win accountability | Adapter enforces reads first |
| Business Profile | `business.manage` | Reviews, locations, visibility, and demand | Google project approval required; adapter reads first |
| Gmail inbox intelligence | `gmail.readonly` | Commitments, intent, and missed opportunities | Deferred: restricted scope/security assessment |

Do not request broad `drive.readonly` for beta. It is restricted. Use
`drive.file` and Google Picker so the user selects the exact files GrowthOS may
access. `drive.file` also supports selected Google Sheets through the Sheets
API. Do not request `gmail.readonly` until the business case, restricted-scope
verification, security assessment, retention policy, deletion flow, and
customer trust materials are ready.

## Experience

1. The Connections page explains the outcome and exact access for each module.
2. A user presses Connect on a specific module; only then does GrowthOS request
   that module's scopes through incremental authorization.
3. GrowthOS checks what Google actually granted. A denied module remains off;
   all other product areas continue to work.
4. Drive/Sheets users select individual business assets. Selection is separate
   from OAuth permission.
5. The user chooses whether each connected source is personal or contributes
   organization intelligence. Only an owner/admin may designate an
   organization-wide source.
6. The source page shows account, assets, scopes, last successful sync, next
   sync, cursor/event health, last error, facts produced, and BIE uses.
7. Disabling a module stops sync and BIE use. Disconnecting Google revokes and
   removes the token. Reducing granted Google scopes requires full revocation
   and reauthorization with the smaller set.

## Continuous scouting architecture

```text
Google APIs / selected assets
  -> event notification or cursor-based sync
  -> immutable source observation + retrieval metadata
  -> normalized Business Graph fact
  -> deterministic opportunity detectors
  -> BIE explanation with citations and limitations
  -> approval queue
  -> separately authorized action adapter
  -> outcome / Recovered Revenue Ledger
```

Continuous does not mean unrestricted model access. Sync workers fetch only
enabled sources, preserve provider/resource/time provenance, and create bounded
facts. Opportunity rules run over those facts. AI may prioritize or explain a
candidate but may not manufacture a fact, silently expand source access, or
execute an action.

## Business Graph entities

- people, companies, properties, leads, estimates, projects, appointments;
- campaigns, search queries, landing pages, calls, forms, and lead sources;
- calendars, capacity windows, events, crews, and commitments;
- selected files, spreadsheets, tables, documents, and revisions;
- locations, reviews, ratings, responses, and local-search signals;
- spend, clicks, conversions, appointments, wins, revenue, and gross profit;
- source observations, evidence hashes, detector versions, opportunities,
  decisions, actions, and outcomes.

Every derived fact must retain organization ID, source connection, provider
resource ID, retrieval/event time, source revision/cursor, transformation rule,
and confidence/limitations. Raw Google content is not copied into ordinary
audit logs.

## Agent safety boundary

Email, calendar descriptions, documents, spreadsheets, comments, and filenames
are untrusted external content. They can contain malicious or accidental
instructions. GrowthOS must:

- treat connected content only as data, never as system/tool instructions;
- keep credentials and tool authority outside model context;
- use allowlisted read adapters and structured extraction;
- separate retrieval from action credentials;
- require explicit authorization and policy checks for every write;
- cite the exact source behind an opportunity;
- redact secrets and unnecessary personal data before any approved AI use;
- prevent one tenant or user's selected assets from being queried by another.

## Implementation state

Implemented locally:

- encrypted per-user Google token and state/PKCE foundation;
- incremental module catalog and requested-scope transaction record;
- local enable/disable state per organization, user, and module;
- module catalog/status API with maturity and scope disclosures;
- Gmail send adapter tied to the executing user.

Still required before claims:

- adapter and normalized-fact implementation for each non-Gmail module;
- Drive Picker asset registry;
- cursor/event worker and durable scheduler;
- two-account and two-tenant acceptance tests for every module;
- Google OAuth verification, Business Profile project approval, and any
  restricted-scope security assessment;
- retention, export, deletion, incident response, and production monitoring.

