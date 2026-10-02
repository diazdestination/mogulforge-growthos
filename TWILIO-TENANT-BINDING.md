# GrowthOS Twilio client binding — local engineering state

One `twilio_client_bindings` row maps one GrowthOS organization to one dedicated
Twilio account SID and one number. That account may be a platform-managed
subaccount or an approved client-owned account; the ownership/billing model is
still a client-specific decision, not something the schema selects. The database
has unique constraints on organization, account SID and number. Nothing is
created by default and every launch flag defaults to false. The old global
`TWILIO_ORGANIZATION_ID`, `TWILIO_ACCOUNT_SID`, `TWILIO_PHONE_NUMBER` and shared
auth token are no longer used to select a client.

## Safe binding contract

- The account SID and called number select exactly one candidate for a new
  inbound call or SMS. GrowthOS then checks Twilio's signature against that
  candidate's auth token and the configured exact external URL/full form body.
- Operation callbacks look up the existing call/SMS operation first, then
  require its organization, account, sender, recipient and provider SID to
  match the signed request. No callback organization parameter or credential
  search is accepted.
- Auth token and API-key secret values stay only in the approved server secret
  store. Binding fields hold names matching `TWILIO_CLIENT_*_AUTH_TOKEN` and
  `TWILIO_CLIENT_*_API_KEY_SECRET`. Blank/missing references disable traffic.
- Voice and SMS switches, approval flags, daily limits, staff route, business
  display name, SMS disclosure version and optional public enrollment selector
  are per client. `revoked_at` immediately blocks new sends/bridges; signed
  callbacks for already-created operations can still be recorded.
- Public SMS enrollment requires a client-specific `program` token. The old
  unscoped `/sms-preferences.html` is **not** a contractor opt-in link. Use
  `/sms-preferences.html?program=<client-token>`; missing, invalid or unknown
  selectors keep the form closed with no fallback to another business.
  The page displays the selected contractor's binding name and number.
  Enrollment additionally requires explicit HTTPS policy links configured
  on the server as `TWILIO_CLIENT_<CLIENT>_SMS_PRIVACY_URL` and
  `TWILIO_CLIENT_<CLIENT>_SMS_TERMS_URL`, using the same `<CLIENT>` prefix as
  that binding's auth-token secret reference. No URL is inferred from a
  website or replaced with MogulForge's own draft policies. Missing or invalid
  links close **new opt-in only**; signed inbound STOP/HELP and the sender
  number for existing recipients remain available. A URL passing this format
  gate is not proof that its content or the client campaign is approved.
  Before opening any contractor program, review the actual linked privacy,
  terms and purpose copy, sender registration, phone-confirmation path and
  required release/provider acceptance for that specific contractor.
- Unknown missed callers produce one staff callback/review task. They do not
  create SMS consent, trigger an automatic text, or create an AI call assistant.

## Local acceptance and release boundary

`pnpm --filter @workspace/api-server test:twilio` creates a disposable PGlite
database and intercepts all Twilio HTTP. Its two synthetic tenants cover
valid/invalid signatures, account/number/service/operation mismatch, duplicate
callbacks, STOP isolation, voice handoff, and per-client revocation. These are
code tests only; they do not prove PostgreSQL concurrency, carrier behavior,
registration, provider receipt, client disclosures, or production traffic.

Before any live activation, an operator must inspect the actual account and
number ownership, obtain the client's legal/registration and contact-policy
approval, put each secret in its separately scoped store, apply the reviewed
schema change at an exact green release SHA, and run client-specific signed
webhook and real-handset acceptance in isolated staging. Account rotation
while operations are pending needs an explicit reconciliation plan because the
current one-binding-per-organization model deliberately fails closed for old
callbacks after a binding replacement. The release gates in
`PAID-BETA-READINESS-P0.md` remain authoritative. No provider resource,
forwarding, real customer contact or deployment is authorized by this file.
