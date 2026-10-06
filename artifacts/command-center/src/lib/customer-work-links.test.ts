import { describe, expect, it } from "vitest";
import {
  customerInvoicePath,
  customerWorkLocation,
  customerWorkLoginPath,
  customerWorkPath,
  newCustomerWorkPath,
} from "./customer-work-links";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
describe("closed native customer-work links", () => {
  it.each(["estimates", "projects", "invoices"] as const)(
    "pins new %s to one current customer and company",
    (page) => {
      const path = newCustomerWorkPath(page, id(2), id(1))!;
      expect(customerWorkLocation(page, path.split("?")[1], id(1))).toEqual({
        kind: "new",
        contactId: id(2),
      });
      expect(customerWorkLoginPath(path, "https://app.example.test")).toBe(
        path,
      );
      expect(customerWorkLocation(page, path.split("?")[1], id(9)).kind).toBe(
        "different-company",
      );
    },
  );
  it.each(["estimates", "projects"] as const)(
    "keeps %s exact native reads separate from legacy list highlights",
    (page) => {
      const path = customerWorkPath(page, id(3), id(1))!;
      expect(customerWorkLocation(page, path.split("?")[1], id(1))).toEqual({
        kind: "record",
        id: id(3),
      });
      expect(customerWorkLoginPath(path, "https://app.example.test")).toBe(
        path,
      );
      expect(
        customerWorkLocation(page, "highlight=legacy&leadId=old", id(1)),
      ).toEqual({ kind: "none" });
    },
  );
  it.each([
    `new=customer&contactId=${id(2)}&organizationId=${id(1)}&contactId=${id(3)}`,
    `new=customer&contactId=${id(2)}&organizationId=${id(1)}&leadId=${id(3)}`,
    `new=customer&contactId=${id(2)}`,
    `estimateId=${id(3)}&organizationId=${id(1)}&edit=1`,
    `estimateId=null&organizationId=${id(1)}`,
  ])("rejects mixed or invalid source query %s", (search) =>
    expect(customerWorkLocation("estimates", search, id(1)).kind).toBe(
      "invalid",
    ),
  );
  it("allows only pinned invoice details or a pinned project invoice list, never arbitrary redirects", () => {
    const detail = customerInvoicePath(id(3), id(1))!;
    const list = `/invoices?projectId=${id(3)}&organizationId=${id(1)}`;
    expect(customerWorkLoginPath(detail, "https://app.example.test")).toBe(
      detail,
    );
    expect(customerWorkLoginPath(list, "https://app.example.test")).toBe(list);
    for (const value of [
      `//evil.test${detail}`,
      `https://evil.test${detail}`,
      `${detail}&next=https://evil.test`,
      `${detail}#arbitrary`,
      "/invoices/null",
      "/projects?highlight=old",
    ])
      expect(
        customerWorkLoginPath(value, "https://app.example.test"),
      ).toBeNull();
    expect(customerWorkPath("projects", "null", id(1))).toBeNull();
  });
});
