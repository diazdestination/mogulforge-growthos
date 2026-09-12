import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useGetSession } from "@workspace/api-client-react";
import {
  Building2,
  CheckCircle2,
  Circle,
  KeyRound,
  Loader2,
  LockKeyhole,
  Plus,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";

type Profile = { id: string; name: string; services: [string, string][] };
type Organization = {
  id: string;
  name: string;
  slug: string;
  timezone: string;
};
type Site = {
  id: string;
  name: string;
  profile: string;
  source: string;
  isActive: boolean;
  responseTargetMinutes: number;
  credentialVersion: number;
  credentialIssuedAt: string | null;
  credentialCheckedAt: string | null;
  lastSavedAt: string | null;
};
type Readiness = {
  organization: Organization;
  serverNow: string;
  staffing: { activeManagers: number; activeResponders: number };
  sites: Site[];
  releaseGates: string[];
  releaseStatus: "not_assessed";
};

async function request<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method,
    credentials: "include",
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const result = await res.json().catch(() => ({}));
    const messages: Record<string, string> = {
      identifier_taken:
        "That workspace identifier is already in use. Choose a different one.",
      request_changed:
        "This draft changed after submission. Edit a field to start a new request.",
      site_missing_or_credential_changed:
        "The connection changed. Refresh before issuing another key.",
      invalid_request:
        "Check the company name, identifier, profile, timezone and response target.",
    };
    throw new Error(
      messages[result.error] ??
        "The request could not be completed. Your entries are still here; try again.",
    );
  }
  return res.json() as Promise<T>;
}
const date = (v: string | null) =>
  v ? new Date(v).toLocaleString() : "Not recorded";
const control =
  "w-full min-w-0 rounded-md border border-border bg-background px-3 py-2 text-sm min-h-11";

export function ClientLaunchpad() {
  const session = useGetSession();
  if (session.isLoading) return <p role="status">Loading platform access…</p>;
  if (session.isError)
    return (
      <p role="alert">Could not verify platform access. Refresh to retry.</p>
    );
  if (!session.data?.isPlatformAdmin)
    return (
      <section className="rounded-xl border p-6">
        <LockKeyhole className="mb-3" />
        <h1 className="text-xl font-bold">Platform access required</h1>
        <p className="mt-2 text-muted-foreground">
          Client provisioning is restricted to platform administrators. An
          organization owner only manages their own business.
        </p>
      </section>
    );
  return (
    <Launchpad
      key={session.data.id}
      actorId={session.data.id}
      currentOrgId={session.data.organization?.id}
    />
  );
}

function Launchpad({
  actorId,
  currentOrgId,
}: {
  actorId: string;
  currentOrgId?: string;
}) {
  const client = useQueryClient();
  const [selected, setSelected] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [createdNotice, setCreatedNotice] = useState(false);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const organizations = useQuery({
    queryKey: ["client-launchpad", actorId, "organizations"],
    queryFn: async () => {
      const value = await request<{ organizations: Organization[] }>(
        "/platform/orgs",
      );
      if (!Array.isArray(value.organizations))
        throw new Error("Workspace list unavailable.");
      return value.organizations;
    },
  });
  const profiles = useQuery({
    queryKey: ["client-launchpad", actorId, "profiles"],
    queryFn: async () => {
      const value = await request<Profile[]>("/platform/clients/profiles");
      if (
        !Array.isArray(value) ||
        !value.every((p) => Array.isArray(p.services))
      )
        throw new Error("Profiles unavailable.");
      return value;
    },
  });
  const activeId = selected || currentOrgId || organizations.data?.[0]?.id;
  return (
    <div className="space-y-6">
      <header className="relative overflow-hidden rounded-2xl border border-primary/25 bg-gradient-to-br from-primary/15 via-card to-card p-6 md:p-8">
        <div className="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-widest text-primary">
          <ShieldCheck className="h-4 w-4" /> MogulForge · Smart Sites{" "}
          <Badge variant="outline">Operator workspace</Badge>
        </div>
        <h1 className="mt-4 text-3xl font-bold tracking-tight md:text-4xl">
          One platform. Every client, separate.
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Bring the next business into GrowthOS with a repeatable, isolated
          setup. Configuration is a starting point. Evidence tells you what
          actually works.
        </p>
        <div className="mt-6 grid gap-3 sm:grid-cols-3">
          {[
            ["01", "Create a private workspace"],
            ["02", "Configure its connection"],
            ["03", "Verify before launch"],
          ].map(([n, title]) => (
            <div key={n} className="flex items-center gap-3 text-sm">
              <span className="font-mono text-primary">{n}</span>
              {title}
            </div>
          ))}
        </div>
      </header>
      <section
        className="rounded-xl border bg-card p-4 md:p-6"
        aria-label="Client workspaces"
      >
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1 space-y-2">
            <Label htmlFor="client-workspace">Review client setup</Label>
            <select
              id="client-workspace"
              className={control}
              value={activeId ?? ""}
              onChange={(e) => {
                setSelected(e.target.value);
                setCreatedNotice(false);
              }}
              disabled={!organizations.data}
            >
              {!organizations.data?.length && (
                <option value="">
                  {organizations.isError
                    ? "Workspace list unavailable"
                    : "Select a workspace"}
                </option>
              )}
              {organizations.data?.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name}
                </option>
              ))}
            </select>
          </div>
          <Button
            className="min-h-11"
            onClick={() => setShowCreate(!showCreate)}
            aria-expanded={showCreate}
          >
            <Plus className="mr-2 h-4 w-4" />
            {showCreate ? "Close new client form" : "New client workspace"}
          </Button>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          Setup view only. Selecting a client does not switch your CRM
          membership or expose its customer records.
        </p>
        {createdNotice && (
          <p
            ref={noticeRef}
            tabIndex={-1}
            role="status"
            className="mt-4 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm outline-none"
          >
            Isolated draft saved. Nothing was activated. Review its connection
            checklist below.
          </p>
        )}
        {organizations.isError && (
          <div role="alert" className="mt-3">
            <p>Could not load workspaces. No status is assumed.</p>
            <Button
              variant="outline"
              onClick={() => void organizations.refetch()}
            >
              Retry workspace list
            </Button>
          </div>
        )}
        {showCreate &&
          (profiles.isError ? (
            <p role="alert" className="mt-4">
              Profiles are unavailable.{" "}
              <button
                className="underline"
                onClick={() => void profiles.refetch()}
              >
                Retry profiles
              </button>
            </p>
          ) : profiles.data ? (
            <CreateClient
              profiles={profiles.data}
              onCreated={(orgId) => {
                setSelected(orgId);
                setShowCreate(false);
                setCreatedNotice(true);
                requestAnimationFrame(() => {
                  noticeRef.current?.focus({ preventScroll: true });
                  noticeRef.current?.scrollIntoView({ block: "center" });
                });
                void client.invalidateQueries({
                  queryKey: ["client-launchpad", actorId],
                });
              }}
            />
          ) : (
            <p role="status">Loading service profiles…</p>
          ))}
      </section>
      {activeId && (
        <ClientReadiness
          key={activeId}
          organizationId={activeId}
          actorId={actorId}
          currentOrgId={currentOrgId}
          profiles={profiles.data ?? []}
        />
      )}
    </div>
  );
}

function CreateClient({
  profiles,
  onCreated,
}: {
  profiles: Profile[];
  onCreated: (id: string) => void;
}) {
  const [form, setForm] = useState({
    name: "",
    slug: "",
    profile: profiles[0]?.id ?? "",
    timezone: "America/New_York",
    responseTargetMinutes: "60",
  });
  const [confirmed, setConfirmed] = useState(false);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const edit = (key: keyof typeof form, value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
    setRequestId(crypto.randomUUID());
    setConfirmed(false);
    create.reset();
  };
  const create = useMutation({
    mutationFn: () =>
      request<{ organizationId: string }>("/platform/clients", "POST", {
        ...form,
        name: form.name.trim(),
        responseTargetMinutes: Number(form.responseTargetMinutes),
        requestId,
        confirmed,
      }),
    onSuccess: (r) => onCreated(r.organizationId),
  });
  const profile = profiles.find((p) => p.id === form.profile);
  return (
    <form
      className="mt-6 space-y-5 border-t pt-6"
      aria-label="Create isolated client"
      onSubmit={(e) => {
        e.preventDefault();
        if (confirmed && !create.isPending) create.mutate();
      }}
    >
      <div>
        <h2 className="text-xl font-semibold">Start with a safe draft</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          No invitations, subscriptions, messages, agents or public changes.
          Nothing from Painless is copied.
        </p>
      </div>
      <fieldset
        disabled={create.isPending}
        className="grid min-w-0 gap-4 sm:grid-cols-2"
      >
        <div className="space-y-2">
          <Label htmlFor="client-name">Company name</Label>
          <Input
            id="client-name"
            maxLength={120}
            minLength={2}
            required
            value={form.name}
            onChange={(e) => edit("name", e.target.value)}
            placeholder="Your next client"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="client-slug">Workspace identifier</Label>
          <Input
            id="client-slug"
            required
            minLength={3}
            maxLength={50}
            pattern="[a-z0-9][a-z0-9-]{1,48}[a-z0-9]"
            value={form.slug}
            onChange={(e) => edit("slug", e.target.value)}
            placeholder="example-hvac"
          />
          <p className="text-xs text-muted-foreground">
            Unique, lowercase, hyphens allowed. This is not a domain.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="client-profile">Service profile</Label>
          <select
            id="client-profile"
            className={control}
            value={form.profile}
            onChange={(e) => edit("profile", e.target.value)}
          >
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="client-timezone">Business timezone</Label>
          <Input
            id="client-timezone"
            required
            value={form.timezone}
            onChange={(e) => edit("timezone", e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="client-target">First-attempt target · minutes</Label>
          <Input
            id="client-target"
            type="number"
            required
            min={5}
            max={10080}
            value={form.responseTargetMinutes}
            onChange={(e) => edit("responseTargetMinutes", e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Elapsed-time internal goal. Not business hours or a customer
            promise.
          </p>
        </div>
      </fieldset>
      <div className="rounded-lg bg-muted/50 p-4">
        <p className="text-sm font-medium">
          Starter services for {profile?.name}
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          {profile?.services.map(([, name]) => name).join(" · ")}
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          Intake configuration only—not a finished industry product. Confirm the
          actual business offerings before public use.
        </p>
      </div>
      <label className="flex items-start gap-3 text-sm leading-relaxed">
        <input
          type="checkbox"
          className="mt-1 h-4 w-4 shrink-0"
          checked={confirmed}
          disabled={create.isPending}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        I confirm this is a separate business workspace. Create its inactive
        draft only; do not move my account or activate services.
      </label>
      {create.isError && (
        <p role="alert" className="text-sm text-destructive">
          {create.error.message}
        </p>
      )}
      <Button
        type="submit"
        className="min-h-11"
        disabled={!confirmed || create.isPending}
      >
        {create.isPending ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <Building2 className="mr-2 h-4 w-4" />
        )}
        Create isolated draft
      </Button>
    </form>
  );
}

function ClientReadiness({
  organizationId,
  actorId,
  currentOrgId,
  profiles,
}: {
  organizationId: string;
  actorId: string;
  currentOrgId?: string;
  profiles: Profile[];
}) {
  const data = useQuery({
    queryKey: ["client-launchpad", actorId, organizationId, "readiness"],
    queryFn: async () => {
      const value = await request<Readiness>(
        `/platform/clients/${organizationId}/readiness`,
      );
      if (
        value.organization?.id !== organizationId ||
        !Array.isArray(value.sites) ||
        !value.staffing ||
        !Number.isInteger(value.staffing.activeManagers) ||
        !Number.isInteger(value.staffing.activeResponders) ||
        !Number.isFinite(Date.parse(value.serverNow)) ||
        !Array.isArray(value.releaseGates)
      )
        throw new Error("Readiness unavailable.");
      return value;
    },
    refetchInterval: 60_000,
  });
  const [siteId, setSiteId] = useState("");
  if (data.isLoading) return <p role="status">Checking this workspace…</p>;
  if (data.isError || !data.data)
    return (
      <section role="alert" className="rounded-xl border p-5">
        <p>
          Readiness is unavailable. No green checks or zero counts are assumed.
        </p>
        <Button
          onClick={() => void data.refetch()}
          variant="outline"
          className="mt-3"
        >
          Retry readiness
        </Button>
      </section>
    );
  const report = data.data;
  const site = report.sites.find((s) => s.id === siteId) ?? report.sites[0];
  return (
    <section
      className="space-y-4"
      aria-label={`${report.organization.name} readiness`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold break-words">
            {report.organization.name}
          </h2>
          <p className="text-xs text-muted-foreground">
            Checked {date(report.serverNow)}
          </p>
        </div>
        <Button
          variant="outline"
          disabled={data.isFetching}
          onClick={() => void data.refetch()}
        >
          <RefreshCw className="mr-2 h-4 w-4" />
          Refresh checks
        </Button>
      </div>
      {report.sites.length > 1 && (
        <div className="space-y-2">
          <Label htmlFor="readiness-site">Website connection</Label>
          <select
            id="readiness-site"
            className={control}
            value={site?.id}
            onChange={(e) => setSiteId(e.target.value)}
          >
            {report.sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="grid min-w-0 gap-4 lg:grid-cols-[1.3fr_1fr]">
        <div className="min-w-0 rounded-xl border bg-card p-5">
          <h3 className="font-semibold">Connection readiness</h3>
          <p className="mb-4 mt-1 text-xs text-muted-foreground">
            Configured ≠ verified ≠ approved to launch.
          </p>
          <CheckRow
            title="Isolated organization"
            status="Configured"
            detail={`Private workspace: ${report.organization.slug}`}
          />
          <CheckRow
            title="Service profile"
            status={site ? "Configured" : "Missing"}
            detail={
              profiles.find((p) => p.id === site?.profile)?.name ??
              site?.profile ??
              "Create a connection from this organization’s Lead Capture setup."
            }
          />
          <CheckRow
            title="Client staff access"
            status={
              report.staffing.activeManagers && report.staffing.activeResponders
                ? "Configured"
                : "Missing"
            }
            detail={`${report.staffing.activeManagers} active manager(s), ${report.staffing.activeResponders} responder(s). Owner approval and invitations are separate.`}
          />
          {site && (
            <>
              <CheckRow
                title="Server credential"
                status={site.credentialIssuedAt ? "Issued" : "Not recorded"}
                detail={
                  site.credentialIssuedAt
                    ? `Issued ${date(site.credentialIssuedAt)}. Installation is not inferred.`
                    : site.credentialCheckedAt ||
                        site.lastSavedAt ||
                        site.isActive
                      ? "Historical issuance date is unknown. Preserve the installed key; rotating it disables capture."
                      : "Issue a dedicated key when you are ready to install it securely."
                }
              />
              <CheckRow
                title="Credential handshake"
                status={
                  site.credentialCheckedAt
                    ? Date.parse(report.serverNow) -
                        Date.parse(site.credentialCheckedAt) <
                      86400_000
                      ? "Verified"
                      : "Recheck needed"
                    : "Not verified"
                }
                detail={
                  site.credentialCheckedAt
                    ? `${date(site.credentialCheckedAt)} · credential only, not website or outage acceptance.`
                    : "Run the server-side check. It creates no customer records and sends no messages."
                }
              />
              <CheckRow
                title="Intake save observed"
                status={site.lastSavedAt ? "Observed" : "Not observed"}
                detail={
                  site.lastSavedAt
                    ? `Last receipt ${date(site.lastSavedAt)}. May be a test; not proof of the current public form or current credential.`
                    : "After approved setup, submit a labeled end-to-end acceptance inquiry."
                }
              />
              <CheckRow
                title="Capture switch"
                status={site.isActive ? "Enabled" : "Disabled"}
                detail={
                  site.isActive
                    ? "API intake is enabled. This does not establish a public deployment."
                    : "Safe draft. Credentials can be checked while intake remains disabled."
                }
              />
            </>
          )}
        </div>
        <div className="min-w-0 space-y-4">
          <div className="rounded-xl border border-amber-400/25 bg-amber-400/5 p-5">
            <div className="flex gap-2 font-semibold text-amber-600 dark:text-amber-300">
              <LockKeyhole className="h-5 w-5 shrink-0" />
              Launch review still required
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              No automatic “all green.” These release gates are not assessed by
              this screen.
            </p>
            <ul className="mt-4 space-y-3 text-sm">
              {report.releaseGates.map((gate) => (
                <li key={gate} className="flex gap-2">
                  <Circle className="mt-1 h-3 w-3 shrink-0 text-muted-foreground" />
                  {gate}
                </li>
              ))}
            </ul>
          </div>
          {site && (
            <ServerSetup
              key={site.id}
              organizationId={organizationId}
              site={site}
              refresh={() => void data.refetch()}
            />
          )}
          {currentOrgId === organizationId && (
            <a
              className="block rounded-lg border p-4 text-sm font-medium text-primary"
              href="/capture"
            >
              Open this organization’s Lead Capture →
            </a>
          )}
        </div>
      </div>
    </section>
  );
}

function CheckRow({
  title,
  status,
  detail,
}: {
  title: string;
  status: string;
  detail: string;
}) {
  const verified = status === "Verified";
  return (
    <div className="border-t py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">{title}</span>
        <Badge
          variant="outline"
          className={
            verified
              ? "border-emerald-500/50 text-emerald-600 dark:text-emerald-300"
              : "text-muted-foreground"
          }
        >
          {verified && <CheckCircle2 className="mr-1 h-3 w-3" />}
          {status}
        </Badge>
      </div>
      <p className="mt-2 break-words text-xs leading-relaxed text-muted-foreground">
        {detail}
      </p>
    </div>
  );
}

function ServerSetup({
  organizationId,
  site,
  refresh,
}: {
  organizationId: string;
  site: Site;
  refresh: () => void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setNotice("Copied. Keep credentials in server-only settings.");
    } catch {
      setNotice("Clipboard unavailable. Select and copy the value manually.");
    }
  };
  const issue = async () => {
    setBusy(true);
    setSecret(null);
    setNotice("");
    try {
      const result = await request<{ secret: string }>(
        `/platform/clients/${organizationId}/sites/${site.id}/key`,
        "POST",
        { confirmed, expectedVersion: site.credentialVersion },
      );
      setSecret(result.secret);
      setConfirmed(false);
      refresh();
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const template = JSON.stringify(
    {
      schemaVersion: 1,
      organizationId,
      siteId: site.id,
      profile: site.profile,
      source: site.source,
      responseTargetMinutes: site.responseTargetMinutes,
      serverOnly: {
        GROWTHOS_API_ORIGIN: "<approved-api-origin>",
        GROWTHOS_SITE_ID: site.id,
        GROWTHOS_SITE_SECRET: "<install-secret-on-server-only>",
      },
      checkPath: `/api/v1/public/smart-sites/${site.id}/check`,
      intakePath: `/api/v1/public/smart-sites/${site.id}/intake`,
      note: "Never send organizationId in intake. The site credential fixes tenant identity. Never put keys in VITE variables.",
    },
    null,
    2,
  );
  return (
    <div
      className="rounded-xl border bg-card p-5 space-y-4"
      aria-label={`${site.name} server setup`}
    >
      <h3 className="flex items-center gap-2 font-semibold">
        <KeyRound className="h-4 w-4" />
        Server setup
      </h3>
      <p className="text-xs text-muted-foreground break-all">
        Connection {site.id}
      </p>
      <details>
        <summary className="cursor-pointer text-sm font-medium text-primary">
          Connection handoff · no secret
        </summary>
        <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">
          {template}
        </pre>
        <Button
          variant="outline"
          className="mt-3"
          onClick={() => void copy(template)}
        >
          Copy setup template
        </Button>
        <p className="mt-3 text-xs text-muted-foreground">
          Send JSON {`{"schemaVersion":1}`} with a Bearer key to the check path
          from your server. A handshake never activates capture.
        </p>
      </details>
      <label className="flex items-start gap-2 text-xs leading-relaxed">
        <input
          type="checkbox"
          className="mt-1 shrink-0"
          checked={confirmed}
          disabled={busy}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        I understand issuing a key revokes the old key, clears its check, and
        disables this connection. I will store it on the server only.
      </label>
      <Button
        variant="outline"
        className="w-full min-h-11 whitespace-normal"
        disabled={!confirmed || busy}
        onClick={() => void issue()}
      >
        {busy ? "Issuing…" : "Issue one-time server key"}
      </Button>
      {secret && (
        <div className="space-y-3 rounded border border-amber-400/40 p-3">
          <p className="text-xs font-semibold">
            Shown once. Do not screenshot or put it in client code.
          </p>
          <code className="block select-all break-all text-xs">{secret}</code>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void copy(secret)}>
              Copy key
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setSecret(null);
                setNotice("Key hidden. It cannot be retrieved again.");
              }}
            >
              Hide key
            </Button>
          </div>
        </div>
      )}
      {notice && (
        <p role="status" className="text-xs leading-relaxed">
          {notice}
        </p>
      )}
    </div>
  );
}
