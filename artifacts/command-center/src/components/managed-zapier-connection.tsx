import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Provisioning = "mogulforge" | "legacy" | "unassigned";
type Connection = {
  organizationId: string;
  status: {
    provisioning: Provisioning;
    connected: boolean;
    connectionFingerprint: string | null;
    monthlyActionLimit?: number | null;
  };
  serverReference: string | null;
  usage: {
    monthStartUtc: string;
    successfulActions: number;
    indeterminateActions: number;
    estimatedTasksFromRecordedActions: number;
    monthlyActionLimit?: number | null;
    monthlyActionsUsed?: number | null;
    monthlyActionsRemaining?: number | null;
  };
};

const REFERENCE = /^[A-Za-z0-9_-]{1,128}$/;
const DEFAULT_MONTHLY_LIMIT = 1000;
const MAX_MONTHLY_LIMIT = 100000;

function requestConnection(endpoint: string, scope: AbortSignal, method = "GET", body?: object) {
  return fetch(endpoint, {
    credentials: "include",
    cache: "no-store",
    method,
    signal: AbortSignal.any([scope, AbortSignal.timeout(15_000)]),
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
}

async function readConnection(response: Response, organizationId: string): Promise<Connection> {
  if (!response.ok) throw new Error();
  const value = (await response.json()) as Connection;
  const { status, serverReference, usage } = value;
  if (
    value.organizationId !== organizationId ||
    !status || !["mogulforge", "legacy", "unassigned"].includes(status.provisioning) ||
    typeof status.connected !== "boolean" ||
    !(status.connectionFingerprint === null || (typeof status.connectionFingerprint === "string" && status.connectionFingerprint.length > 0)) ||
    (status.connected && (status.connectionFingerprint === null || status.provisioning === "unassigned")) ||
    !(serverReference === null || (typeof serverReference === "string" && REFERENCE.test(serverReference))) ||
    !usage || !Number.isFinite(Date.parse(usage.monthStartUtc)) ||
    ![usage.successfulActions, usage.indeterminateActions, usage.estimatedTasksFromRecordedActions]
      .every((count) => Number.isSafeInteger(count) && count >= 0) ||
    ![usage.monthlyActionLimit, usage.monthlyActionsUsed, usage.monthlyActionsRemaining]
      .every((count) => count == null || (Number.isSafeInteger(count) && count >= 0)) ||
    (usage.monthlyActionLimit ?? 0) > MAX_MONTHLY_LIMIT
  ) throw new Error();
  if (status.provisioning === "mogulforge") {
    const { monthlyActionLimit, monthlyActionsUsed, monthlyActionsRemaining } = usage;
    if (
      monthlyActionLimit == null || monthlyActionsUsed == null || monthlyActionsRemaining == null ||
      status.monthlyActionLimit !== monthlyActionLimit ||
      monthlyActionsRemaining !== Math.max(0, monthlyActionLimit - monthlyActionsUsed)
    ) throw new Error();
  }
  return { organizationId, status, serverReference, usage };
}

export function ManagedZapierConnection({ actorId, organizationId, companyName }: {
  actorId: string;
  organizationId: string;
  companyName: string;
}) {
  return <ManagedConnectionForm key={JSON.stringify([actorId, organizationId])} organizationId={organizationId} companyName={companyName} />;
}

function ManagedConnectionForm({ organizationId, companyName }: {
  organizationId: string;
  companyName: string;
}) {
  const id = useId();
  const endpoint = "/api/v1/platform/clients/" + encodeURIComponent(organizationId) + "/integrations/zapier";
  const [connection, setConnection] = useState<Connection | null>(null);
  const [busy, setBusy] = useState(true);
  const [notice, setNotice] = useState("");
  const [serverReference, setServerReference] = useState("");
  const [monthlyLimit, setMonthlyLimit] = useState(String(DEFAULT_MONTHLY_LIMIT));
  const [ownershipConfirmed, setOwnershipConfirmed] = useState(false);
  const [dedicatedConnectionConfirmed, setDedicatedConnectionConfirmed] = useState(false);
  const tokenRef = useRef<HTMLInputElement | null>(null);
  const setTokenInput = useCallback((node: HTMLInputElement | null) => {
    if (tokenRef.current && !node) tokenRef.current.value = "";
    tokenRef.current = node;
  }, []);
  const scopeRef = useRef<AbortController | null>(null);
  const pending = useRef(false);

  useEffect(() => {
    const scope = new AbortController();
    scopeRef.current = scope;
    pending.current = true;
    void requestConnection(endpoint, scope.signal).then((response) => readConnection(response, organizationId)).then((next) => {
      if (scope.signal.aborted) return;
      setConnection(next);
      setServerReference(next.serverReference ?? "");
      setMonthlyLimit(String(next.usage.monthlyActionLimit ?? DEFAULT_MONTHLY_LIMIT));
    }).catch(() => {
      if (!scope.signal.aborted) setNotice("Could not verify the current connection. Refresh before making changes.");
    }).finally(() => {
      if (scope.signal.aborted) return;
      pending.current = false;
      setBusy(false);
    });
    return () => scope.abort();
  }, [endpoint, organizationId]);

  function resetForm(reference: string) {
    setServerReference(reference);
    setOwnershipConfirmed(false);
    setDedicatedConnectionConfirmed(false);
    if (tokenRef.current) tokenRef.current.value = "";
  }

  async function update(method: "GET" | "PUT" | "DELETE", body?: object) {
    const scope = scopeRef.current;
    if (!scope || scope.signal.aborted || pending.current) return;
    pending.current = true;
    setBusy(true);
    setNotice("");
    resetForm(connection?.serverReference ?? "");
    setConnection(null);

    const request = (verb: string, payload?: object) => requestConnection(endpoint, scope.signal, verb, payload);
    let message = "";
    try {
      let next: Connection;
      if (method === "GET") {
        next = await readConnection(await request("GET"), organizationId);
      } else {
        try {
          const result = await request(method, body);
          if (result.status === 409) message = "The connection changed or these details conflict with a saved assignment. Review the current connection.";
          if (result.status === 422) message = "Use a dedicated Zapier agentic server with the required read and write tools.";
          if (!result.ok) throw new Error();
          next = method === "DELETE"
            ? await readConnection(await request("GET"), organizationId)
            : await readConnection(result, organizationId);
          message = method === "DELETE" ? "Connection status refreshed after disconnect." : "Connection saved. Review each flow before enabling it.";
        } catch {
          if (scope.signal.aborted) return;
          message ||= "Could not confirm the update. Review the current connection before trying again.";
          next = await readConnection(await request("GET"), organizationId);
        }
      }
      if (scope.signal.aborted) return;
      setConnection(next);
      setServerReference(next.serverReference ?? "");
      setMonthlyLimit(String(next.usage.monthlyActionLimit ?? DEFAULT_MONTHLY_LIMIT));
      setNotice(message);
    } catch {
      if (!scope.signal.aborted) setNotice("Could not verify the current connection. Refresh before making changes.");
    } finally {
      if (!scope.signal.aborted) {
        pending.current = false;
        setBusy(false);
      }
    }
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!connection || pending.current || !ownershipConfirmed || !dedicatedConnectionConfirmed) return;
    const reference = serverReference.trim();
    const token = tokenRef.current?.value.trim();
    if (!REFERENCE.test(reference) || !token || !/^[!-~]{1,4096}$/.test(token) || token === reference) {
      setNotice("Enter the exact server reference and a valid private connection token.");
      return;
    }
    const monthlyActionLimit = Number(monthlyLimit);
    if (!monthlyLimit.trim() || !Number.isInteger(monthlyActionLimit) || monthlyActionLimit < 0 || monthlyActionLimit > MAX_MONTHLY_LIMIT) {
      setNotice("Enter a monthly action ceiling from 0 to 100,000.");
      return;
    }
    void update("PUT", {
      monthlyActionLimit,
      serverReference: reference,
      connectionToken: token,
      ownershipConfirmed: true,
      dedicatedConnectionConfirmed: true,
      expectedConnectionFingerprint: connection.status.connectionFingerprint,
    });
  }

  function disconnect() {
    if (!connection?.status.connected || pending.current) return;
    if (!window.confirm("Disconnect Zapier for " + companyName + "? Its connected flows will switch Off.")) return;
    void update("DELETE", { expectedConnectionFingerprint: connection.status.connectionFingerprint });
  }

  const status = connection?.status;
  const usage = connection?.usage;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Managed Zapier connection</CardTitle>
        <CardDescription className="break-words">{companyName} · {organizationId}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {busy && <p role="status">Checking connection…</p>}
        {notice && <p role="status">{notice}</p>}
        {status && (
          <p>
            {status.provisioning === "legacy" ? "Existing connection needs review" :
              status.connected ? "Managed by MogulForge" :
              status.connectionFingerprint ? "Disconnected" : "No connection assigned"}
          </p>
        )}
        {usage && (
          <div className="text-sm text-muted-foreground">
            <p>{new Date(usage.monthStartUtc).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" })} (UTC) · Recorded actions: {usage.successfulActions} successful, {usage.indeterminateActions} awaiting reconciliation.</p>
            {usage.monthlyActionLimit != null && usage.monthlyActionsUsed != null && usage.monthlyActionsRemaining != null && (
              <p>Monthly ceiling: {usage.monthlyActionLimit} action attempts. Used: {usage.monthlyActionsUsed}. Remaining: {usage.monthlyActionsRemaining}.</p>
            )}
            <p>Estimated tasks from successful actions: {usage.estimatedTasksFromRecordedActions}. Use the Zapier invoice for total provider billing.</p>
          </div>
        )}
        {connection ? (
          <form onSubmit={save} autoComplete="off" className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor={id + "-server"}>Server reference</Label>
              <Input id={id + "-server"} value={serverReference} onChange={(event) => {
                resetForm(event.target.value);
              }} required maxLength={128} autoComplete="off" />
            </div>
            <div className="space-y-1">
              <Label htmlFor={id + "-token"}>Private connection token</Label>
              <Input id={id + "-token"} ref={setTokenInput} type="password" autoComplete="new-password" required maxLength={4096} />
            </div>
            <div className="space-y-1">
              <Label htmlFor={id + "-limit"}>Monthly action ceiling</Label>
              <Input id={id + "-limit"} type="number" min={0} max={MAX_MONTHLY_LIMIT} step={1} required value={monthlyLimit}
                onChange={(event) => setMonthlyLimit(event.target.value)} />
              <p className="text-sm text-muted-foreground">Counts attempted flow actions each UTC month. Set to 0 to pause execution. Setup and app discovery are excluded from this counter. Check total usage in Zapier.</p>
            </div>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={ownershipConfirmed} onChange={(event) => setOwnershipConfirmed(event.target.checked)} />
              MogulForge owns this Zapier account.
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={dedicatedConnectionConfirmed} onChange={(event) => setDedicatedConnectionConfirmed(event.target.checked)} />
              This server and its connected apps are dedicated to {companyName}.
            </label>
            <p className="text-sm text-muted-foreground">Changing the connection switches its flows Off for review.</p>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={busy || !ownershipConfirmed || !dedicatedConnectionConfirmed}>Save connection</Button>
              {status?.connected && <Button type="button" variant="outline" disabled={busy} onClick={disconnect}>Disconnect</Button>}
              <Button type="button" variant="outline" disabled={busy} onClick={() => void update("GET")}>Refresh connection</Button>
            </div>
          </form>
        ) : !busy && (
          <Button variant="outline" onClick={() => void update("GET")}>Refresh connection</Button>
        )}
      </CardContent>
    </Card>
  );
}
