import { useEffect, useId, useRef, useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const statusSchema = z.object({
  state: z.enum(["active", "paused", "offboarding_requested"]), version: z.number().int().min(0),
  automationAllowed: z.boolean(), requestId: z.string().uuid().nullable(),
  requestedAt: z.string().nullable(), updatedAt: z.string().nullable(), reason: z.string().nullable(),
  deletionPerformed: z.literal(false), billingChanged: z.literal(false),
}).refine((status) => status.automationAllowed === (status.state === "active") &&
  (status.state !== "offboarding_requested" || Boolean(status.requestId && status.requestedAt)));
const exportSchema = z.object({
  format: z.literal("growthos-core-customer-export"), version: z.literal(1), exportId: z.string().uuid(),
  generatedAt: z.string(), organization: z.object({ id: z.string().uuid(), name: z.string(), slug: z.string(), created_at: z.string() }),
  manifest: z.object({ scope: z.literal("core_customer_records"), completeAccountExport: z.literal(false), deletionPerformed: z.literal(false),
    rowsPerTableLimit: z.literal(2000), byteLimit: z.literal(10 * 1024 * 1024),
    tables: z.array(z.object({ table: z.string(), fields: z.array(z.string()), count: z.number().int().min(0).max(2000), withheldInvalidLinks: z.number().int().min(0) })).length(14),
    exclusions: z.array(z.string()), dataSha256: z.string().regex(/^[a-f0-9]{64}$/), followUp: z.string(),
  }), data: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
}).refine(({ data, manifest }) => new Set(manifest.tables.map((table) => table.table)).size === 14 &&
  Object.keys(data).length === 14 && manifest.tables.every((table) => data[table.table]?.length === table.count &&
    data[table.table].every((row) => Object.keys(row).every((field) => table.fields.includes(field)))));
type Status = z.infer<typeof statusSchema>;
type Action = "pause" | "resume" | "request_offboarding" | "cancel_offboarding";
type Operation = "status" | "export" | "transition";
const stateLabels: Record<Status["state"], string> = { active: "Active", paused: "Paused", offboarding_requested: "Offboarding requested — work paused" };
const unavailable: Record<Operation, string> = {
  status: "Company status could not be checked. Review it again before making a change.",
  export: "The export could not be prepared. Try again or ask your GrowthOS operator for help.",
  transition: "The change could not be confirmed. It may have been recorded. Review company status before trying again.",
};
function safeMessage(operation: Operation, code: number) {
  if (code === 401) return "Please sign in again to manage this company's data and operating status.";
  if (code === 403) return "Only an active company owner or administrator can use these controls.";
  if (code === 409) return "Company status changed. Review it again before making a change.";
  if (code === 413 && operation === "export") return "This company exceeds the core export limit. Ask your GrowthOS operator for an expanded export. No partial file was produced.";
  if (code === 400 && operation === "transition") return "Review the action and enter a reason of 10–500 characters. Resuming also requires the queued-work confirmation.";
  return unavailable[operation];
}

/** Private results and pending requests are discarded whenever the account changes. */
export function CustomerLifecycle({ accountKey }: { accountKey: string }) {
  return <CompanyControls key={accountKey} />;
}

function CompanyControls() {
  const [status, setStatus] = useState<Status | null>(null);
  const [needsReview, setNeedsReview] = useState(false);
  const [pending, setPending] = useState<Operation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [resumeQueuedWork, setResumeQueuedWork] = useState(false);
  const request = useRef<AbortController | null>(null);
  const downloadUrl = useRef<string | null>(null);
  const reasonId = useId(), reasonHelpId = useId(), resumeId = useId();
  useEffect(() => () => {
    request.current?.abort(); request.current = null;
    if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current);
    downloadUrl.current = null;
  }, []);

  async function run(operation: Operation, action?: Action) {
    if (request.current || (operation === "transition" && (!status || needsReview))) return;
    const controller = new AbortController(); request.current = controller;
    const currentVersion = status?.version;
    setPending(operation); setError(null); setNotice(null);
    if (operation === "status") setStatus(null);
    if (operation === "transition") setNeedsReview(true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("deadline")); }, 25_000);
    });
    let errorMessage = unavailable[operation];
    try {
      const response = await Promise.race([fetch(`/api/v1/customer-lifecycle${operation === "status" ? "" : operation === "export" ? "/export" : "/transition"}`, {
        method: operation === "transition" ? "POST" : "GET", credentials: "include", cache: "no-store", signal: controller.signal,
        ...(operation === "transition" ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ action, expectedVersion: currentVersion, reason: reason.trim(), ...(action === "resume" ? { resumeQueuedWork } : {}) }) } : {}),
      }), deadline]);
      if (!response.ok) { errorMessage = safeMessage(operation, response.status); throw new Error("unavailable"); }
      const raw = await Promise.race([response.json(), deadline]);
      if (request.current !== controller || controller.signal.aborted) return;
      if (operation === "export") {
        const data = exportSchema.parse(raw);
        const encoded = JSON.stringify(data, null, 2);
        // The formatted file may be larger than the server's compact size limit.
        const blob = new Blob([encoded], { type: "application/json" });
        const url = URL.createObjectURL(blob); downloadUrl.current = url;
        const anchor = document.createElement("a"); anchor.href = url; anchor.download = `growthos-core-export-${data.exportId}.json`;
        document.body.appendChild(anchor);
        try { anchor.click(); } finally { anchor.remove(); }
        URL.revokeObjectURL(url); downloadUrl.current = null;
        const count = data.manifest.tables.reduce((sum, table) => sum + table.count, 0);
        const withheld = data.manifest.tables.reduce((sum, table) => sum + table.withheldInvalidLinks, 0);
        setNotice(`Download started: ${count.toLocaleString("en-US")} ${count === 1 ? "record" : "records"} across 14 datasets. The file includes its coverage and checksum.${withheld ? ` ${withheld} ${withheld === 1 ? "record was" : "records were"} withheld because related records could not be verified. Ask your operator to review them.` : ""}`);
      } else {
        const next = statusSchema.parse(raw); setStatus(next); setNeedsReview(false);
        if (operation === "transition") {
          setReason(""); setResumeQueuedWork(false);
          setNotice(action === "cancel_offboarding" ? "Offboarding request cancelled. Company work remains paused." : action === "resume" ? "Company work is active. Pending work may now resume under its existing safety checks." : action === "pause" ? "Company work is paused. Customer records and history are preserved." : "Your offboarding request is recorded. Share the reference below with your GrowthOS operator for review.");
        }
      }
    } catch {
      if (request.current === controller) setError(errorMessage);
    } finally {
      clearTimeout(timer);
      if (request.current === controller) { request.current = null; setPending(null); }
    }
  }

  const canChange = !pending && !needsReview && reason.trim().length >= 10 && reason.trim().length <= 500;
  return <Card>
    <CardHeader>
      <CardTitle>Company data & operating status</CardTitle>
      <CardDescription>Keep a copy of core customer records, pause company work, or request an offboarding review.</CardDescription>
    </CardHeader>
    <CardContent className="space-y-6">
      <section aria-labelledby={`${reasonId}-export`} className="space-y-3">
        <h3 id={`${reasonId}-export`} className="font-semibold">Export core customer records</h3>
        <p className="max-w-prose text-sm text-muted-foreground">Download a machine-readable JSON file for this company. It includes contacts, leads, job records and selected history. This is a core CRM export; other account data needs a separate review.</p>
        <details className="text-sm">
          <summary className="cursor-pointer font-medium underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm">Included records and limits</summary>
          <div className="max-w-prose space-y-2 pt-3 text-muted-foreground">
            <p>The 14 datasets cover contacts, properties, leads, estimates, projects, tasks, appointments, activity text, consent, suppressions, value entries, execution receipts and events, and stored-media metadata.</p>
            <p>Up to 2,000 records per dataset and 10 MB before formatting. Larger exports fail without producing a partial file. Records with unverified relationships are withheld and counted in the file.</p>
            <p>Passwords, tokens, API keys, opaque metadata and staff identities are excluded. Photo files, full email conversations, website submissions, automation queues, provider copies, backups and other account tables need operator review.</p>
            <p>Ask your GrowthOS operator for an expanded export covering any excluded data you need.</p>
          </div>
        </details>
        <Button className="dark:text-slate-950" onClick={() => void run("export")} disabled={Boolean(pending)} aria-busy={pending === "export"}>
          {pending === "export" ? "Preparing export…" : "Download core records"}
        </Button>
      </section>
      <section aria-labelledby={`${reasonId}-status`} className="space-y-4 border-t border-border pt-6">
        <div className="space-y-2">
          <h3 id={`${reasonId}-status`} className="font-semibold">Pause work or request offboarding</h3>
          <p className="max-w-prose text-sm text-muted-foreground">Pausing stops new covered lead capture, automation and outbound work. Work already handed off may complete or need reconciliation. Records and exports remain available.</p>
          <p className="max-w-prose text-sm text-muted-foreground">These controls do not cancel billing, revoke provider access or erase data. An offboarding request records your reason for an operator review.</p>
        </div>
        <Button variant="outline" onClick={() => void run("status")} disabled={Boolean(pending)} aria-busy={pending === "status"}>
          {pending === "status" ? "Checking status…" : "Review company status"}
        </Button>
        {status && <div className="space-y-4" role="region" aria-label="Company operating status">
          <div className="space-y-1 text-sm">
            <p className="font-semibold">{needsReview ? "Previously checked: " : ""}{stateLabels[status.state]}</p>
            {needsReview && !pending && <p>Review company status before another change. Your reason is kept below.</p>}
            {status.reason && <p className="max-w-prose break-words text-muted-foreground">Last recorded reason: {status.reason}</p>}
          </div>
          {status.state === "offboarding_requested" && <div className="space-y-2 text-sm">
            <p className="max-w-prose">Share this reference with your GrowthOS operator to review remaining exports, billing and access. No deletion has been performed.</p>
            <p className="break-all">Request reference: {status.requestId}</p>
            <p className="text-muted-foreground">Cancelling this request leaves work paused. Resuming is a separate action.</p>
          </div>}
          <div className="max-w-prose space-y-2">
            <Label htmlFor={reasonId}>Reason for this change</Label>
            <Textarea id={reasonId} aria-describedby={reasonHelpId} value={reason} onChange={(event) => setReason(event.target.value)} minLength={10} maxLength={500} rows={3} disabled={Boolean(pending)} />
            <p id={reasonHelpId} className="text-xs text-muted-foreground">10–500 characters. This reason is saved in the company audit history.</p>
          </div>
          {status.state === "paused" && <div className="flex max-w-prose items-start gap-3">
            <Checkbox id={resumeId} checked={resumeQueuedWork} onCheckedChange={(checked) => setResumeQueuedWork(checked === true)} disabled={Boolean(pending)} className="mt-0.5" />
            <Label htmlFor={resumeId} className="text-sm font-normal leading-5">I have reviewed pending work and confirm it may resume. Previously paused or uncertain actions still require their existing review.</Label>
          </div>}
          <div className="flex flex-wrap gap-3">
            {status.state === "active" && <Button variant="outline" disabled={!canChange} onClick={() => void run("transition", "pause")}>Pause company work</Button>}
            {status.state === "paused" && <Button className="dark:text-slate-950" disabled={!canChange || !resumeQueuedWork} onClick={() => void run("transition", "resume")}>Resume company work</Button>}
            {status.state !== "offboarding_requested"
              ? <Button variant="outline" disabled={!canChange} onClick={() => void run("transition", "request_offboarding")}>Request offboarding review</Button>
              : <Button variant="outline" disabled={!canChange} onClick={() => void run("transition", "cancel_offboarding")}>Cancel offboarding request</Button>}
          </div>
        </div>}
        {pending === "transition" && <p role="status" className="text-sm">Recording your change…</p>}
      </section>
      {error && <p role="alert" className="max-w-prose text-sm text-destructive">{error}</p>}
      {notice && <p role="status" className="max-w-prose text-sm">{notice}</p>}
    </CardContent>
  </Card>;
}
