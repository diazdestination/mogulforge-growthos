import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const categories = {
  account_access: "Accounts & access", crm: "Customer work", communications: "Communications",
  acquisition: "Lead capture", automation: "Automations", intelligence: "Intelligence",
  audit: "Audit records", configuration: "Configuration", media: "Media records",
  shared_runtime: "Shared system records",
} as const;
const tableSchema = z.object({
  table: z.string().regex(/^[a-z][a-z0-9_]{0,100}$/),
  category: z.enum(Object.keys(categories) as [keyof typeof categories, ...(keyof typeof categories)[]]),
  ownership: z.enum(["direct_org", "indirect_org", "shared_exception"]),
  selector: z.enum(["organization_id", "organization_primary_key", "user_organization", "excluded"]),
  rowCount: z.number().int().min(0).max(10_000).nullable(),
  countStatus: z.enum(["exact_in_snapshot", "at_least_limit", "excluded"]),
}).refine((row) => row.countStatus === "excluded"
  ? row.rowCount === null && row.selector === "excluded" && row.ownership === "shared_exception"
  : row.rowCount !== null && row.selector !== "excluded" && row.ownership !== "shared_exception" &&
    (row.countStatus !== "at_least_limit" || row.rowCount === 10_000));
const previewSchema = z.object({
  catalogVersion: z.string().min(1).max(100),
  status: z.literal("bounded_preview"),
  complete: z.literal(false), exportReady: z.literal(false), deletionReady: z.literal(false),
  coverage: z.object({
    classifiedTables: z.number().int().min(1).max(256),
    sourceSchemaHash: z.string().regex(/^[0-9a-f]{64}$/),
    deployedSchema: z.literal("matched"), reasons: z.array(z.string()).max(0),
    countedTables: z.number().int().min(0).max(256),
    excludedTables: z.number().int().min(0).max(256),
    providerMetadataExclusions: z.array(z.enum(["docker_parity_provider_monitor_v1", "fly_mpg_pg_stat_monitor_2_3_v1"])).max(1),
  }),
  limits: z.object({ rowsPerTable: z.literal(10_000), countQueryMs: z.literal(5_000), totalMs: z.literal(12_000) }),
  tables: z.array(tableSchema).min(1).max(256),
}).refine((data) => data.coverage.classifiedTables === data.tables.length &&
  new Set(data.tables.map((row) => row.table)).size === data.tables.length &&
  data.coverage.excludedTables === data.tables.filter((row) => row.countStatus === "excluded").length &&
  data.coverage.countedTables + data.coverage.excludedTables === data.tables.length);
type Preview = z.infer<typeof previewSchema>;

const unavailable = "The inventory could not be checked. No data was changed. Try again later.";
const statusMessages: Record<number, string> = {
  401: "Please sign in again to check this company's inventory.",
  403: "Only a signed-in company owner or administrator can check this inventory.",
  409: "The database does not match the reviewed inventory catalog. Counts are hidden until the mismatch is reviewed.",
};

/** No query cache or automatic request. Changing account always discards the preview. */
export function DataLifecycleInventory({ accountKey }: { accountKey: string }) {
  return <InventoryPreview key={accountKey} />;
}

function InventoryPreview() {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => {
    request.current?.abort();
    request.current = null;
  }, []);

  async function checkInventory() {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setPreview(null);
    setError(null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("deadline")); }, 20_000);
    });
    let safeError = unavailable;
    try {
      const response = await Promise.race([fetch("/api/v1/data-lifecycle/inventory", {
        method: "GET", credentials: "include", cache: "no-store", signal: controller.signal,
      }), deadline]);
      if (!response.ok) {
        safeError = statusMessages[response.status] ?? unavailable;
        throw new Error("unavailable");
      }
      const data = previewSchema.parse(await Promise.race([response.json(), deadline]));
      if (request.current === controller && !controller.signal.aborted) setPreview(data);
    } catch {
      if (request.current === controller) setError(safeError);
    } finally {
      clearTimeout(timer);
      if (request.current === controller) {
        request.current = null;
        setPending(false);
      }
    }
  }

  return <Card>
    <CardHeader>
      <CardTitle>Data & privacy</CardTitle>
      <CardDescription>A read-only count preview for this company. Nothing is exported, deleted, or sent.</CardDescription>
    </CardHeader>
    <CardContent className="space-y-5">
      <p className="text-sm text-muted-foreground">
        This checks reviewed database tables only. It is not a complete account inventory or an export or deletion tool.
        Counts describe records in separate tables, not a total number of customers.
      </p>
      <Button onClick={() => void checkInventory()} disabled={pending} aria-busy={pending}>
        {pending ? "Checking inventory…" : "Check data inventory"}
      </Button>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {preview && <section aria-label="Inventory preview" className="space-y-4">
        <p role="status" className="text-sm">
          Schema matched the reviewed catalog. {preview.coverage.countedTables} tables counted; {preview.coverage.excludedTables} shared or unscoped tables excluded.
          {" "}Counts stop at 10,000 per table. This is a snapshot, not live tracking.
        </p>
        {preview.coverage.providerMetadataExclusions.length > 0 && <p className="text-sm text-muted-foreground">
          One reviewed provider-monitoring view was excluded. Only its metadata was checked; its records were not read.
        </p>}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="text-left pb-2 font-medium">Database record counts</caption>
            <thead><tr className="border-b text-left">
              <th scope="col" className="py-2 pr-4">Table</th><th scope="col" className="py-2 pr-4">Area</th><th scope="col" className="py-2">Records</th>
            </tr></thead>
            <tbody>{preview.tables.map((row) => <tr key={row.table} className="border-b">
              <th scope="row" className="py-2 pr-4 text-left font-normal break-all">{row.table}</th>
              <td className="py-2 pr-4">{categories[row.category]}</td>
              <td className="py-2 whitespace-nowrap">{row.countStatus === "excluded" ? "Not counted" :
                row.countStatus === "at_least_limit" ? "At least 10,000" : row.rowCount!.toLocaleString("en-US")}</td>
            </tr>)}</tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground">Catalog: {preview.catalogVersion}</p>
      </section>}
      <div className="rounded-lg border border-border p-4 text-sm space-y-2">
        <h3 className="font-medium">What still needs a separate review</h3>
        <p>Shared identities and sessions, links inside stored content, media ownership, external provider copies, and backups are outside these counts.</p>
        <p>Retention, access revocation, complete exports, and deletion workflows are not available through this preview.</p>
      </div>
    </CardContent>
  </Card>;
}
