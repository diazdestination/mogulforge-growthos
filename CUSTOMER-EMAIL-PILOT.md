# Customer email pilot configuration

Customer messages now require a specific active staff member's Gmail connection
within the same organization. Platform account email uses MogulForge's separate
transactional Resend sender. A global Replit Gmail connection and platform Resend
credentials do not enable contractor messages.

## Sender selection

- A lead-linked automation, appointment reminder, concierge confirmation, or
  customer-facing project-room notification uses that lead's assigned staff member.
- If the lead is unassigned, or the message has no lead (a customer portal sign-in
  code), the explicit **Settings → Automations → Customer email sender** is used.
- The admin selects an active company member with `crm.write` and a connected
  Gmail account containing `gmail.send`. The API validates the selection against
  the authenticated organization and rechecks it at send time.
- If an assigned sender becomes inactive, loses permission, disconnects Gmail,
  has insufficient scopes, or receives a provider error, the send fails visibly.
  Another member and the platform sender are never substituted. Reconnect or
  deliberately reassign the lead after reviewing any uncertain prior send.
- Clearing the company default leaves unassigned messages and portal email codes
  blocked. Assigned leads may still use their own authorized sender.
- Staff portal-message/photo alerts always use the explicit company default.
  The assigned person selects the notification recipient, with existing fallback
  inbox/admin rules. An inactive or revoked assignee therefore cannot silence
  staff alerts when the company default is healthy. Customer replies retain the
  strict assigned sender rule.

The new nullable `org_settings.customer_email_sender_user_id` field starts empty.
It references `users.id` with `ON DELETE SET NULL`; the API also enforces company
membership, role, and connection readiness. There is no automatic choice during
migration and no provider credential migration.

## Dispatch inventory

| Flow                                                                  | Identity                                                                                |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Lead automation email                                                 | Assigned lead member, otherwise explicit company default                                |
| Appointment reminder / concierge booking confirmation                 | Assigned lead member, otherwise explicit company default                                |
| Portal code                                                           | Explicit company default                                                                |
| Portal staff notification                                             | Explicit company default; assigned member or configured inbox/admins are the recipients |
| Customer reply notification                                           | Assigned lead member, otherwise explicit company default                                |
| Manual lead send / BIE / acquisition playbook                         | Existing explicit acting or assigned member's Gmail                                     |
| Account verification / password reset / staff invitation              | Platform transactional Resend                                                           |
| Platform API-key expiry / blocked-login security notice to org admins | Platform transactional Resend                                                           |

Accepted customer sends record `customer_email.provider_accepted` with company,
sender user, source of selection, and provider message ID. Content, OTPs, OAuth
credentials, and recipient mailboxes are absent from that audit event. Provider
acceptance is not proof of delivery. Existing automation/notification failure
surfaces and connection errors remain authoritative when a send is blocked.

## Controlled acceptance

1. Apply the reviewed additive schema to isolated staging with the outbound hold
   active. Connect two authorized test users in two distinct test companies using
   the intended staging OAuth client.
2. Save a default sender in each company. Verify the displayed Gmail address and
   connect any separately assigned lead staff. Use synthetic contacts initially.
3. Add only explicitly authorized email test inboxes to staging's recipient
   allowlist. Release the staging hold only for the approved acceptance window.
4. Prove a portal code, an assigned-lead reminder and an unassigned confirmation
   use the intended identity. Record Gmail message IDs and actual inbox receipts.
5. Revoke one assigned connection while another company/default remains healthy.
   Its send must fail without any alternate mailbox. Reconnect and verify token
   refresh; do not replay an uncertain provider effect until reconciled.
6. Independently test Resend verification, password-reset, invitation and signed
   delivery callbacks against the approved platform sender.

Local tests use synthetic DB rows and stub the Gmail network boundary. They do
not establish OAuth approval, domain verification, inbox delivery, production
activation, or permission to contact contractor customers.
