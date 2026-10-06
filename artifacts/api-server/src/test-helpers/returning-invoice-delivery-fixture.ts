import { randomUUID } from "node:crypto";
import {
  contactsTable,
  db,
  emailSenderPreferencesTable,
  gmailConnectionsTable,
  microsoftConnectionsTable,
  organizationsTable,
  orgSettingsTable,
  propertiesTable,
  usersTable,
} from "@workspace/db";
import { createInvoice, issueInvoice } from "../services/invoices";

/** Fictional canonical records only. No provider, account or credential flow. */
export async function returningInvoiceDeliveryFixture(
  provider: "gmail" | "microsoft" = "gmail",
  withProperty = true,
) {
  const [org] = await db
    .insert(organizationsTable)
    .values({
      name: "Synthetic returning invoice",
      slug: `returning-mail-${randomUUID()}`,
    })
    .returning();
  const [actor, sender] = await db
    .insert(usersTable)
    .values([
      {
        organizationId: org.id,
        role: "owner",
        isActive: true,
        emailVerifiedAt: new Date(),
      },
      {
        organizationId: org.id,
        role: "office",
        isActive: true,
        emailVerifiedAt: new Date(),
      },
    ])
    .returning();
  const [contact] = await db
    .insert(contactsTable)
    .values({
      organizationId: org.id,
      firstName: "Returning",
      lastName: "Customer",
      email: `customer-${randomUUID()}@example.invalid`,
    })
    .returning();
  const [property] = withProperty
    ? await db
        .insert(propertiesTable)
        .values({
          organizationId: org.id,
          contactId: contact.id,
          addressLine1: "1 Fictional Work Lane",
          city: "Atlanta",
          state: "GA",
          postalCode: "30301",
        })
        .returning()
    : [];
  await db
    .insert(orgSettingsTable)
    .values({ organizationId: org.id, customerEmailSenderUserId: sender.id });
  const mailbox = `office-${randomUUID()}@example.invalid`;
  if (provider === "gmail")
    await db
      .insert(gmailConnectionsTable)
      .values({
        organizationId: org.id,
        userId: sender.id,
        email: mailbox,
        encryptedRefreshToken: "synthetic-never-decrypted",
        grantedScopes: ["https://www.googleapis.com/auth/gmail.send"],
      });
  else
    await db
      .insert(microsoftConnectionsTable)
      .values({
        organizationId: org.id,
        userId: sender.id,
        accountId: "synthetic-microsoft-account",
        email: mailbox,
        encryptedRefreshToken: "synthetic-never-decrypted",
        grantedScopes: ["mail.send", "user.read"],
      });
  await db
    .insert(emailSenderPreferencesTable)
    .values({ organizationId: org.id, userId: sender.id, provider });
  const draft = (
    await createInvoice(org.id, actor.id, {
      requestId: randomUUID(),
      source: {
        kind: "existing_customer",
        contactId: contact.id,
        propertyId: property?.id ?? null,
      },
      document: {
        title: "Returning service invoice",
        currency: "USD",
        issuerName: "Synthetic contractor",
        customerName: "Returning Customer",
        customerAddress: property?.addressLine1 ?? null,
        lineItems: [
          {
            description: "Agreed returning work",
            quantity: "1",
            unitPriceCents: 10000,
          },
        ],
        taxCents: 0,
      },
    })
  ).invoice;
  const invoice = (
    await issueInvoice(org.id, actor.id, draft.id, {
      requestId: randomUUID(),
      expectedVersion: draft.version,
      confirmed: true,
    })
  ).invoice;
  return {
    org: org.id,
    actor: actor.id,
    sender: sender.id,
    contact,
    property: property ?? null,
    mailbox,
    provider,
    invoice,
  };
}
export type ReturningInvoiceDeliveryFixture = Awaited<
  ReturnType<typeof returningInvoiceDeliveryFixture>
>;
