import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCustomerLifecycleExporter } from "./customer-lifecycle-export";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const privateMarker = "FICTIONAL_RETURNING_INTERNAL_DO_NOT_EXPORT";
const document = {
  title: "Recorded issued work",
  currency: "USD",
  issuerName: "Fictional contractor",
  issuerAddress: null,
  customerName: "Fictional customer",
  customerAddress: null,
  dueDate: null,
  notes: null,
  lineItems: [
    {
      description: "Recorded scope",
      quantity: "1",
      unitPriceCents: 10000,
      totalCents: 10000,
      privateActor: privateMarker,
    },
  ],
  subtotalCents: 10000,
  taxCents: 0,
  totalCents: 10000,
  privateToken: privateMarker,
};
function fixture() {
  const records: Record<string, Record<string, unknown>[]> = {
    contacts: [{ id: id(2) }, { id: id(3) }],
    properties: [
      { id: id(4), contact_id: id(2) },
      { id: id(5), contact_id: id(3) },
    ],
    customer_work_roots: [
      {
        id: id(6),
        contact_id: id(2),
        property_id: id(4),
        created_by_user_id: privateMarker,
      },
      { id: id(7), contact_id: id(2), property_id: null },
      { id: id(8), contact_id: id(2), property_id: id(5) },
    ],
    estimates: [
      {
        id: id(9),
        lead_id: null,
        customer_work_id: id(6),
        work_version: 2,
        title: "Estimate",
        line_items: [
          {
            description: "Scope",
            quantity: 1,
            unitPriceCents: 10000,
            totalCents: 10000,
          },
        ],
      },
      {
        id: id(10),
        lead_id: null,
        customer_work_id: id(7),
        work_version: 1,
        title: "Other work",
        line_items: [],
      },
    ],
    projects: [
      {
        id: id(11),
        lead_id: null,
        customer_work_id: id(6),
        work_version: 1,
        estimate_id: id(9),
      },
      {
        id: id(12),
        lead_id: null,
        customer_work_id: id(7),
        work_version: 1,
        estimate_id: id(9),
      },
    ],
    value_entries: [
      {
        id: id(13),
        lead_id: null,
        customer_work_id: id(6),
        kind: "payment",
        amount_cents: 10000,
        refund_of_value_entry_id: null,
      },
      {
        id: id(14),
        lead_id: null,
        customer_work_id: id(6),
        kind: "refund",
        amount_cents: 1000,
        refund_of_value_entry_id: id(13),
      },
      {
        id: id(15),
        lead_id: null,
        customer_work_id: id(7),
        kind: "refund",
        amount_cents: 1000,
        refund_of_value_entry_id: id(13),
      },
      {
        id: id(16),
        lead_id: null,
        customer_work_id: null,
        kind: "payment",
        amount_cents: 1000,
        refund_of_value_entry_id: null,
      },
    ],
    invoices: [
      {
        id: id(17),
        lead_id: null,
        customer_work_id: id(6),
        project_id: id(11),
        estimate_id: id(9),
        draft_document: document,
        issued_document: document,
        issued_document_sha256: createHash("sha256")
          .update(JSON.stringify(document))
          .digest("hex"),
        issued_at: "2026-10-06T00:00:00Z",
        historical_source: null,
      },
      {
        id: id(18),
        lead_id: null,
        customer_work_id: id(7),
        project_id: id(11),
        estimate_id: id(9),
      },
    ],
    invoice_receipt_allocations: [
      {
        id: id(19),
        invoice_id: id(17),
        value_entry_id: id(13),
        kind: "payment",
        amount_cents: 10000,
        reverses_allocation_id: null,
      },
      {
        id: id(20),
        invoice_id: id(17),
        value_entry_id: id(14),
        kind: "refund",
        amount_cents: 1000,
        reverses_allocation_id: null,
      },
      {
        id: id(21),
        invoice_id: id(17),
        value_entry_id: id(15),
        kind: "refund",
        amount_cents: 1000,
        reverses_allocation_id: null,
      },
    ],
    customer_work_commands: [
      {
        id: id(22),
        actor_user_id: privateMarker,
        payload_sha256: privateMarker,
        request_id: privateMarker,
      },
    ],
  };
  const queries: string[] = [];
  const client = {
    connect: async () => {},
    end: async () => {},
    on: () => {},
    query: async (input: string | { text: string; values?: unknown[] }) => {
      const text = typeof input === "string" ? input : input.text;
      queries.push(text);
      if (text.includes("FROM public.users"))
        return { rows: [{ id: "fictional-owner" }] };
      if (text.startsWith("SELECT id, name, slug"))
        return {
          rows: [
            { id: id(1), name: "Fictional company", slug: "fictional-export" },
          ],
        };
      const match = text.match(
        /^SELECT (.+) FROM public\."([a-z_]+)" WHERE organization_id/,
      );
      if (match) {
        const columns = [...match[1].matchAll(/"([a-z_][a-z_0-9]*)"/g)].map(
          (row) => row[1],
        );
        return {
          rows: (records[match[2]] ?? []).map((row) =>
            Object.fromEntries(columns.map((key) => [key, row[key] ?? null])),
          ),
        };
      }
      return { rows: [] };
    },
  };
  return { records, queries, client };
}
describe("returning-work core export", () => {
  it("does not read or include staff alert admission and original effect identities", async () => {
    const { client, records, queries } = fixture();
    records.staff_lead_alert_coverage = [{
      lead_id: id(28),
      policy_fingerprint: privateMarker,
      recipients: [{ userId: privateMarker, outcome: "queued", deliveryIds: [id(29)] }],
    }];
    const result = await createCustomerLifecycleExporter({ createClient: () => client as never })(id(1), "fictional-owner");
    expect(result.data).not.toHaveProperty("staff_lead_alert_coverage");
    expect(result.manifest.tables.some(row => row.table === "staff_lead_alert_coverage")).toBe(false);
    expect(queries.some(text => text.includes("staff_lead_alert_coverage"))).toBe(false);
    expect(JSON.stringify(result)).not.toContain(privateMarker);
  });
  it("preserves original issued and usable native lineage while withholding cross-work links and replay authority", async () => {
    const { client, queries } = fixture();
    const result = await createCustomerLifecycleExporter({
      createClient: () => client as never,
    })(id(1), "fictional-owner");
    expect(result.manifest.tables).toHaveLength(28);
    expect(result.data.customer_work_roots.map((row) => row.id)).toEqual([
      id(6),
      id(7),
    ]);
    expect(result.data.customer_work_roots[1].property_id).toBeNull();
    expect(result.data.projects.map((row) => row.id)).toEqual([id(11)]);
    expect(result.data.value_entries.map((row) => row.id)).toEqual([
      id(13),
      id(14),
    ]);
    expect(result.data.value_entries[1].refund_of_value_entry_id).toBe(id(13));
    expect(result.data.invoices.map((row) => row.id)).toEqual([id(17)]);
    expect(
      result.data.invoice_receipt_allocations.map((row) => row.id),
    ).toEqual([id(19), id(20)]);
    expect(result.data.invoices[0].issued_document_sha256).toBe(
      createHash("sha256").update(JSON.stringify(document)).digest("hex"),
    );
    expect(result.data.invoices[0].exported_issued_document_sha256).not.toBe(
      result.data.invoices[0].issued_document_sha256,
    );
    expect(
      result.manifest.tables.find((row) => row.table === "customer_work_roots")
        ?.withheldInvalidLinks,
    ).toBe(1);
    expect(
      result.manifest.tables.find((row) => row.table === "projects")
        ?.withheldInvalidLinks,
    ).toBe(1);
    expect(
      result.manifest.tables.find((row) => row.table === "value_entries")
        ?.withheldInvalidLinks,
    ).toBe(2);
    expect(JSON.stringify(result.data)).not.toContain(privateMarker);
    expect(result.data).not.toHaveProperty("customer_work_commands");
    expect(
      queries.some((text) =>
        text.includes('FROM public."customer_work_commands"'),
      ),
    ).toBe(false);
  });
  it("withholds over-original cumulative refund corrections rather than exporting valid-looking cash twice", async () => {
    const { client, records } = fixture();
    records.value_entries.push({
      id: id(23),
      lead_id: null,
      customer_work_id: id(6),
      kind: "refund",
      amount_cents: 10000,
      refund_of_value_entry_id: id(13),
    });
    const result = await createCustomerLifecycleExporter({
      createClient: () => client as never,
    })(id(1), "fictional-owner");
    expect(result.data.value_entries.map((row) => row.id)).toEqual([id(13)]);
    expect(
      result.data.invoice_receipt_allocations.map((row) => row.id),
    ).toEqual([id(19)]);
    expect(
      result.manifest.tables.find((row) => row.table === "value_entries")
        ?.withheldInvalidLinks,
    ).toBe(4);
  });
});
