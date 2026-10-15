# Private Reader rejection diagnostics

Fly returned HTTP 422 for the final approved Reader-create request. The previous
driver rejected unexpected status before reading the bounded response body, so
the validation reason was discarded. This correction cannot recover that body
or establish the historical rejection cause.

Only rejected create-reader requests now read the response under the existing
total 15-second request deadline and maximum 4,000,000-byte body bound. They still
throw production75_v1_status. The existing private, immutable five-field request
evidence records a fixed rejection hint in safeCode. Arbitrary body text, names,
credentials, URLs and other provider values are discarded.

Recognized structured field errors and short fixed phrases may yield username
invalid/conflict, role invalid, role-system disabled, cluster not ready or
permission-denied hints. Multiple distinct hints are marked multiple. Other
bounded objects remain unknown; absent, malformed and non-object bodies have
fixed format categories. Bounded-read failures have fixed bound/deadline/
unreadable categories. These are untrusted diagnostic hints, not proof of the
provider's root cause or permission to change a request.

The endpoint, user_name field, Reader role, accepted statuses, exact successful
identity/role validation, ownership, app guards, and permanent mutation permits
are unchanged. No automatic POST or DELETE replay is introduced. Other rejected
operations retain their prior immediate rejection and body-cancellation path.

Evidence:

- New tests first produced 22 expected failures and one passing success-validation
  guard; no implementation change preceded that reproduction.
- 142 focused tests and all 657 script tests passed. Type checks passed.
- The full suite initially exposed one Reader503 assertion expecting the old
  generic diagnostic. It now checks the intentional unknown hint, and a Reader422
  operator case verifies category preservation plus owned deletion and no upgrade.
- Independent review accepted with no Important/Critical findings, 145 independent
  tests and additional native-stream/success/no-replay assertions.
- Local real PostgreSQL rehearsal e06dab79-6eb3-480f-bcfe-316d0b5fab34 passed:
  99 clients/sockets and six owned containers closed; all 23 runtime hashes stayed
  unchanged. Provider/authentication and proxy ownership in that fixture are synthetic.
- Exact-head GitHub CI is required separately before another hosted rehearsal.

The pinned official CLI reads non-success bodies, but its raw-body error output
is unsuitable for this private driver:
https://raw.githubusercontent.com/superfly/flyctl/a1cf49a52b36fba66a2bf0907617bd5aadb8a727/internal/uiex/mpg/v1/managed_postgres.go

App source candidate PR44/8df64dc and all 19 SQL inputs/full 142-table target remain
fixed. Hosted Reader/profile, upgrade and rollback remain unverified. All three
approved paid copies are deleted and original preservation passed. All three
reservations are consumed; this source correction authorizes no fourth copy.
All 20 contractor gaps and both company replacement acceptance gates remain open.
No original database/app mutation, deployment or public launch occurred.
