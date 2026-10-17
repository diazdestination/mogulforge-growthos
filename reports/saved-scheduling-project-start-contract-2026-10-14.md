# Saved scheduling project start-only fields addendum — October 14, 2026

This is the root-adjudicated fields prerequisite for full Task9. It is separate
from accepted Task10 and Task11. The existing consumer contract, original plan,
specification and literal/compiled fixture remain immutable. BASE is
`cb0102514edb662e27cd650e2bafe205922b42c4`.

`SchedulingIntervalFieldsProps` exports the optional field
`startOnlyBehavior?: 'preserve_elapsed' | 'preserve_absolute_end'`.
Omitting the field and passing `preserve_elapsed` have identical semantics and
do not reset equivalent local or pending state. The default retains appointment
elapsed duration, precision, arbitrary multiday and DST occurrence behavior.
No API, wire or database field is introduced.

Prospective project hosts may pass `preserve_absolute_end` after root accepts
this addendum. A start edit in that mode retains the current controlled non-null
end byte-for-byte, including its RFC3339 offset and seconds/milliseconds spelling.
It does not substitute a historical saved end. Any selected duration preset is
cleared to an explicit duration/review choice. Staff can explicitly select a
preset again; that choice computes elapsed duration normally. Review is always
explicit and the copy states the effective start-only behavior.

In BOTH modes, an original legacy SQL-NULL end whose start has changed holds
review until staff selects a valid duration preset or enters a valid explicit end.
The supplied compatibility effective end is evidence only and is never fabricated
or persisted as the end. An untouched legacy NULL remains NULL, including a
reversible return to the original start instant or equivalent RFC3339 spelling.
This narrow root ruling supersedes the two earlier fields-test expectations that
approved changed legacy NULL starts with compatibility duration; their scenarios
remain covered with the required hold. NULL presentation itself is not a
historical mutation-permission gate. Notes, closure and eligible release authority
remain host-owned.

An effective mode change invalidates obsolete review before publishing the exact
current controlled draft and remounts local field, preset and pending acknowledgment
state. Hosts retain custody of draft/context/mode closures and reject obsolete
callbacks. Exact controlled acknowledgment remains required before the fields can
emit a requested review. Endpoint wire spelling and resource-array order/contents
remain unchanged; equivalent object-key order does not reset state. Hosts must echo
the callback draft exactly rather than rewrite its end after the callback.

This source-only lane changes the exported contract, reusable fields and their
bounded tests. It does not change a host or its mutation/release authority. Project
host consumption and full Task9 acceptance remain prospective root-owned work.
It grants no provider, customer, paid, DB, hosted, merge, deployment, public launch
or push authority.
