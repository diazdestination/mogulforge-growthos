import { z } from "zod/v4";

export type CustomerWorkPage = "estimates" | "projects" | "invoices";
const uuid = (value: string | null): value is string =>
  !!value && z.uuid().safeParse(value).success;
export function customerWorkPath(
  page: "estimates" | "projects",
  id: string,
  organizationId: string,
) {
  return uuid(id) && uuid(organizationId)
    ? `/${page}?${page === "estimates" ? "estimateId" : "projectId"}=${id}&organizationId=${organizationId}`
    : null;
}
export function newCustomerWorkPath(
  page: CustomerWorkPage,
  contactId: string,
  organizationId: string,
) {
  return uuid(contactId) && uuid(organizationId)
    ? `/${page}?new=customer&contactId=${contactId}&organizationId=${organizationId}`
    : null;
}
export function customerInvoicePath(id: string, organizationId: string) {
  return uuid(id) && uuid(organizationId)
    ? `/invoices/${id}?organizationId=${organizationId}`
    : null;
}
export type CustomerWorkLocation =
  | { kind: "none" }
  | { kind: "invalid" | "different-company" }
  | { kind: "new"; contactId: string }
  | { kind: "record"; id: string };
/** Only fixed identity links. Legacy lead/highlight links are handled by their original pages. */
export function customerWorkLocation(
  page: CustomerWorkPage,
  search: string,
  organizationId: string,
): CustomerWorkLocation {
  const params = new URLSearchParams(search),
    keys = [...params.keys()];
  const exactKey = page === "estimates" ? "estimateId" : "projectId";
  const governed =
    params.has("new") ||
    params.has("contactId") ||
    params.has("organizationId") ||
    (page === "estimates" && params.has("estimateId"));
  if (!governed) return { kind: "none" };
  if (new Set(keys).size !== keys.length || !uuid(params.get("organizationId")))
    return { kind: "invalid" };
  if (params.get("organizationId") !== organizationId)
    return { kind: "different-company" };
  if (
    params.get("new") === "customer" &&
    keys.length === 3 &&
    keys.every((key) => ["new", "contactId", "organizationId"].includes(key)) &&
    uuid(params.get("contactId"))
  )
    return { kind: "new", contactId: params.get("contactId")! };
  if (
    keys.length === 2 &&
    keys.every((key) => [exactKey, "organizationId"].includes(key)) &&
    uuid(params.get(exactKey))
  )
    return { kind: "record", id: params.get(exactKey)! };
  return { kind: "invalid" };
}
export function customerWorkLoginPath(
  input: string,
  origin: string,
): string | null {
  if (!input.startsWith("/") || input.startsWith("//") || input.includes("\\"))
    return null;
  try {
    const url = new URL(input, origin),
      organizationId = url.searchParams.get("organizationId");
    if (url.origin !== origin || url.hash || !uuid(organizationId)) return null;
    const invoice = /^\/invoices\/([^/]+)$/.exec(url.pathname);
    if (
      invoice &&
      uuid(invoice[1]) &&
      [...url.searchParams.keys()].length === 1
    )
      return customerInvoicePath(invoice[1], organizationId);
    const page = url.pathname.slice(1) as CustomerWorkPage;
    if (!["estimates", "projects", "invoices"].includes(page)) return null;
    const target = customerWorkLocation(page, url.search, organizationId);
    return target.kind === "new"
      ? newCustomerWorkPath(page, target.contactId, organizationId)
      : target.kind === "record"
        ? page === "invoices"
          ? `/invoices?projectId=${target.id}&organizationId=${organizationId}`
          : customerWorkPath(page, target.id, organizationId)
        : null;
  } catch {
    return null;
  }
}
