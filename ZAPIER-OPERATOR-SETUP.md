# MogulForge-managed app connection setup

MogulForge pays for Zapier centrally. Contractors authorize the business-app access and business actions they need; they do not buy a Zapier subscription or receive the operator's Zapier credentials. This runbook describes the operator-managed path, not a White Label enrollment or a provider acceptance receipt.

## Verify the provider setup first

1. Verify the exact MogulForge Zapier account, current plan/task allowance and permitted client-management use. Do not infer them from an Embed ID, a browser profile label or a successful app authentication. Account-wide usage includes activity outside GrowthOS.
2. Under that verified account, prepare a dedicated server for ONE client with only that client's authorized app connections/actions. Verify the actual sender, calendar, accounting company and phone account where applicable. Do not assign a broad personal/default server or a server already used for another tenant. Client app authorization, token creation, paid tasks and upgrades retain their applicable owner approval boundaries.
3. The initial GrowthOS provisioner requires the supported agentic meta-tool contract used by the curated capability registry. A direct-tools-only server is refused; a tool name or heuristic direction is insufficient to admit it as a reviewed flow.
4. Obtain that server's exact stable dashboard reference and server-specific connection token through the approved owner process. Zapier's current connection documentation supports Streamable HTTP to `https://mcp.zapier.com/api/v1/connect` with the token in an Authorization Bearer header. Treat it as a password. Never put it in a URL, ticket, source file, browser recording or ordinary storage. Do not rotate/regenerate another live integration's token as a shortcut.
5. Verify the application has its existing valid `OAUTH_TOKEN_ENCRYPTION_KEY` and recovery plan. Do not blindly replace it: other records may depend on it. Existing Embed settings are neither required for the new token path nor evidence of central account ownership.

## Configure the correct client in GrowthOS

1. Sign into GrowthOS as a human platform administrator. Open Platform → Client Launchpad, explicitly choose the intended company and review its identity.
2. Open the company's Zapier setup and refresh its current connection. Review legacy/disconnected status and monthly recorded usage. A changed target/actor requires a fresh read; never transplant a form or version between companies.
3. Enter the dedicated server reference, private token and reviewed monthly action ceiling. Default is1,000 action attempts;0 pauses new dispatch. Confirm both MogulForge ownership and client-only app configuration, then save once. The browser clears its token field on submission and target changes; the server returns only sanitized status/version.
4. On conflict or uncertain outcome, refresh/read the original company state before another write. Do not blindly replay. Replacing credentials pauses policies and invalidates stale bindings. The operator version precondition rejects stale assignment/revoke.
5. Bind only reviewed actions to company flows and re-enable approved policies deliberately. Confirm exact account/settings/destination before the first authorized external test. New setup does not itself send a message, import data or grant business-send approval.
6. Verify company Settings shows managed status without a Zapier signup/login, raw token or connection URL. Company members retain scoped approvals/policies and voluntary disconnect. Credential reassignment and provider-action enablement stay with the operator.

## Isolation and cost controls

Assignment and revoke are serialized in database transactions. Known server references and token hashes cannot be assigned to another company, including after revocation. The stable reference is operator-entered, and the token is opaque: these controls prevent known accidental reuse; they do not independently prove Zapier account ownership or provider-side app isolation. Retain the provider setup evidence and perform actual two-client acceptance before broader use. A newly labeled server is not proof that its app accounts are separate.

The operator monthly ceiling is a conservative count of started GrowthOS action attempts in the UTC month, across capabilities. Failed and indeterminate attempts can consume the ceiling, completed idempotent replays do not create another attempt, and company policy changes cannot raise it. It excludes setup/discovery and is not a dollar limit or full invoice counter. Successful-action task estimates use ordinary MCP's current two-task rate; verify provider usage independently, and do not apply this rate to a different White Label contract.

## Hosted acceptance and recovery

Use the approved image/config/target and existing scheduler/outbound holds. Test real role/tenant boundaries, supported discovery/parameters, one explicitly approved labeled destination operation, its durable receipt, actual destination outcome, limit refusal and revoke. A mock, connection probe or provider acceptance alone does not prove delivery. Never retry an uncertain write or use a fallback sender before reconciling the original.

Both operator and authorized company revocation stop the company's connection, clear the current encrypted credential, pause policies and retain history/identity reservations. A revoked credential does not erase an earlier uncertain provider effect; investigate it. Reconnect only the intended company after fresh provider review, without reassigning another company's server.

Provider references: [connection tokens and transport](https://docs.zapier.com/mcp/overview/how-connections-work), [ordinary MCP usage](https://docs.zapier.com/mcp/overview/usage), [White Label as a separate selfservice option](https://zapier.com/developer-platform/white-label). Provider plan/terms, actual app authorization and live client acceptance remain separate from source implementation.
