/**
 * The CRM assistant's single read-only retrieval tool. The organization and
 * the caller principal come from the authenticated chat (never from model
 * arguments). Visibility is the customer-workspace decision for that caller:
 * the stored user role AND the effective role (a capped API-key role) must
 * both allow crm.read, and invoice sources additionally need invoices.read.
 * Without a principal the tool fails closed.
 */
import { contactsTable, db, type UserRole } from "@workspace/db";
import { and, asc, eq, ilike, or, sql } from "drizzle-orm";
import { z } from "zod/v4";

import { resolveCustomerReadAccess } from "./customer-workspace";
import { retrieveCustomerContext } from "./retrieval";

export interface AssistantPrincipal {
  userId: string;
  role: UserRole;
}

const MAX_CANDIDATES = 5;

function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export async function searchCustomerHistory(
  organizationId: string,
  args: Record<string, unknown>,
  principal?: AssistantPrincipal,
) {
  if (!principal) return { error: "Customer history needs a signed-in staff member." };
  let access;
  try {
    access = await resolveCustomerReadAccess(organizationId, principal.userId, principal.role);
  } catch {
    return { error: "Customer history is not available for your current access." };
  }
  const query = typeof args.query === "string" ? args.query.trim().slice(0, 500) : "";
  if (!query) return { error: "Provide a query describing what to look for." };
  const limit = Math.min(Math.max(Math.floor(Number(args.limit) || 5), 1), 10);
  let contactId = typeof args.contactId === "string" ? args.contactId.trim() : "";
  if (contactId && !z.uuid().safeParse(contactId).success) return { error: "contactId is not a valid id." };

  if (!contactId) {
    const customer = typeof args.customer === "string" ? args.customer.trim().slice(0, 120) : "";
    if (customer.length < 2) return { error: "Provide contactId or a customer name, email or phone." };
    const pattern = likePattern(customer);
    const candidates = await db
      .select({
        id: contactsTable.id,
        firstName: contactsTable.firstName,
        lastName: contactsTable.lastName,
      })
      .from(contactsTable)
      .where(
        and(
          eq(contactsTable.organizationId, organizationId),
          or(
            ilike(sql`${contactsTable.firstName} || ' ' || coalesce(${contactsTable.lastName}, '')`, pattern),
            ilike(contactsTable.email, pattern),
            ilike(contactsTable.phone, pattern),
          ),
        ),
      )
      .orderBy(asc(contactsTable.firstName), asc(contactsTable.id))
      .limit(MAX_CANDIDATES + 1);
    if (candidates.length === 0) return { found: false, message: "No customer in this company matches that name, email or phone." };
    if (candidates.length > 1) {
      return {
        found: false,
        ambiguous: true,
        candidates: candidates.slice(0, MAX_CANDIDATES).map((c) => ({ contactId: c.id, name: [c.firstName, c.lastName].filter(Boolean).join(" ") })),
        message: "Several customers match. Ask which one, then call again with contactId.",
      };
    }
    contactId = candidates[0]!.id;
  }

  const result = await retrieveCustomerContext(organizationId, contactId, query, limit, access);
  if (!result) return { found: false, message: "That customer is not in this company." };
  return {
    found: true,
    contactId,
    retrievalMode: result.mode,
    invoiceDetailsIncluded: access.canReadInvoices,
    snippets: result.results.map((r) => ({ source: r.sourceType, sourceId: r.sourceId, text: r.content })),
  };
}
