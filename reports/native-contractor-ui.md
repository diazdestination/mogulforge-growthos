# Native contractor navigation, Today and customer invoices

October 1, 2026. Local implementation and synthetic verification on
`agent/growthos-native-contractor-day`, based on `48c3491`. No provider calls,
production changes, commits or pushes were performed by this lane.

## Delivered

- One role-filtered navigation description powers desktop, mobile and page
  search. The daily destinations are Today, Customers & Jobs, Schedule,
  Invoices, and Warranties & Service. Customer tabs keep the existing contacts,
  projects, leads, estimates and properties URLs. Advanced tools and
  administration remain reachable; SaaS Subscription is distinct from customer
  Invoices. The former root BIE workspace remains at `/bie`.
- Today reads the parent-owned `/contractor/today` snapshot with explicit date,
  scope and company timezone. It reports each queue's exact total and visible
  cap, names the UTC fallback, and preserves failures rather than substituting
  empty queues. Midnight-spanning appointments show their start date; recurring
  service due dates remain calendar dates. No estimated financial metrics are
  added.
- Every ordinary Today task links to its exact record through
  `/tasks?taskId=...`. The parent-owned `GET /tasks/:id` resolves old overdue
  records outside the recent 200-row list. The dialog rejects mismatched
  company/ID responses, supports read-only viewers, and shows unavailable state
  without substituting a different task. Task editing uses the existing
  authenticated mutations inside an accessible dialog.
- The invoice workspace supports drafts, reviewed issuance/voiding, saved
  document viewing/printing, staff-recorded receipts, existing receipt/refund
  allocation and allocation reversal. Issue does not imply delivery; recording
  a receipt does not charge money; reversal does not return cash. An unissued
  voided draft is never labeled issued. Refund reconciliation withholds paid
  and balance claims.
- Invoice read roles are owner/admin/office/sales manager. Only
  owner/admin/office receive invoice mutation controls. Existing route access
  remains enforced by the backend.
- Explicit invoice submissions retain their exact payload and request ID in
  tab session storage, scoped to the user, company and invoice. An uncertain
  result freezes further changes until an explicit retry. Mounting the page
  does not replay a request. Stale versions require refresh and review while
  retaining form contents. A later 401/403/404 during reconciliation retains
  the earlier uncertain request. Read-only roles cannot trigger its retry.

## Source ownership

New frontend modules:

- `src/lib/contractor-navigation.ts`, `contractor-api.ts`, `invoice-ui.ts`
- `src/hooks/use-invoice-command.ts`
- `src/pages/today.tsx`, `invoices.tsx`
- `src/components/invoice-editor.tsx`, `invoice-actions.tsx`, `task-deep-link.tsx`
- Matching UI tests and `src/test/invoice-fixtures.ts`

Integrated existing files: `src/App.tsx`, `components/shell.tsx`,
`components/command-palette.tsx`, `pages/tasks.tsx`. Narrow shared changes add
accessible LeadSelect names and an optional SheetContent close label, retaining
the shell's explicit **Close menu** name. The existing task save-error test now
selects the task dialog by its accessible role while retaining its failure and
retry assertions. All paths above are relative to `artifacts/command-center`.

## Verification

### Local UI checks

Final focused run: **85 passed in 11 suites**:

```text
pnpm exec vitest run src/components/contractor-navigation.test.tsx src/components/shell-nav-gating.test.tsx src/pages/today.test.tsx src/pages/invoices.test.tsx src/pages/task-deep-link.test.tsx src/pages/task-lead-label.test.tsx src/pages/tasks-retry-toast.test.tsx src/lib/invoice-ui.test.ts src/pages/save-failure-toasts.test.tsx src/components/lead-select.test.tsx src/accessible-names.test.tsx --config vitest.config.ts
```

`pnpm exec tsc -p tsconfig.json --noEmit` and the scoped tracked-file
`git diff --check` also passed after the final integration changes.

Coverage includes role denials before invoice GET, read-only finance actions,
exact lost-acknowledgement replay across remount, no automatic replay,
stale-version recovery, decimal amounts, refund reconciliation, reviewed
void/reversal, unissued void truthfulness, access-loss evidence retention,
exact old-task lookup, foreign/missing response rejection, task save-error
retention, prior-day appointment labels and calendar service dates.

The print helper test verifies escaped saved-document-only markup, repeating
table headers, normal multi-page flow CSS and temporary frame removal. The
native print dialog and generated PDF bytes were not exercised.

### Browser confirmation

**32/32 states passed** across 1440px desktop, 390px mobile, 320px mobile and
390px dark mode. Surfaces: Today, exact task detail/edit, invoice list/editor,
saved invoice, uncertain-payment recovery, page search/mobile navigation.
Final results: zero WCAG 2 A/AA and 2.1 AA axe violations, page overflow,
page errors, unhandled API requests, or external requests. Payment recovery
preserved the exact request across reload and required an explicit retry.

Initial inspection identified low-contrast Today status text and a horizontally
scrolling invoice table that lacked keyboard focus. Those were corrected.
Dialog measurements now wait for finite opening animations to finish. The
first development load also encountered a Vite dependency optimization reload;
the completed confirmation batch had no page errors.

Evidence directory:
`C:\Forge\workspace\growthos-native-contractor-ui-2026-10-01`

- `browser-qa.cjs`, `results.json`, `results-initial.json`
- 32 confirmation screenshots
- Copies of the temporary synthetic preview entries for reproduction

The fixture uses the actual components, CSS and branding tokens with synthetic
API intercepts. It blocks all external requests and therefore exercises the
app's font fallback rather than downloading its CDN fonts. No video recordings
or traces were enabled. Temporary repository preview entries were removed and
the lane-owned listener on port 5217 was stopped.

## Independent source review

Read the current parent-owned Today service/tests, customer export delta/tests,
and native recovery fixture/probe/drill. No additional blocking defect was
found in that bounded review:

- Today intersects current membership and effective role, scopes indirect
  customer/project joins, uses a read-only repeatable-read snapshot, and tests
  date boundaries, DST, limits, normal HTTP auth and exact task access.
- Export uses fixed columns, closed JSON field lists, tenant-filtered parent
  sets, transitive self-reference pruning, original issued snapshot hash
  validation and a separate exported-document hash. Reversals reference
  canonical value entries rather than adding cash. Canary, cross-company and
  tampered snapshot cases are present.
- The synthetic restore fixture keeps invoice numbering, immutable snapshot,
  receipt/reversal references and recurring-service ancestry. Its one allowed
  active successor requires the exact reviewed ID and restored company pause;
  negative controls reject unpaused companies and additional active services.
  The application probe is read-only and does not activate outbound work.

This review did not independently rerun the parent-owned backend/recovery
suites. Their recorded results and full CI remain the integration evidence.

## Remaining acceptance boundaries

This is local source/UI proof, not a deployed release, provider delivery,
payment processor integration, bank reconciliation, production backup restore
or real contractor onboarding acceptance. Uncertain request storage lasts for
the current tab; clearing browser storage requires office review of retained
server history before creating another entry. Actual issued invoice terms,
tax amounts, customer consent and live financial/provider actions remain
operator-approved inputs and separate integration work.
