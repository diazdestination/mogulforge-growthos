import { useState, type ReactNode } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useGetMe, type MemberProfile, type ContractorToday } from "@workspace/api-client-react";
import { addElapsedMinutes, isoSchema, timeZoneSchema } from "@workspace/scheduling-core";
import { ArrowRight, ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { contractorRequest } from "@/lib/contractor-api";
import { canManageSettings } from "@/lib/permissions";
import { memberAuthorityScope } from "@/lib/member-authority-scope";
import { customerWorkLocation, customerWorkPath } from "@/lib/customer-work-links";
import { SchedulingReservationSummary } from "@/components/scheduling-reservation-summary";
import type { IntervalInput } from "@/lib/scheduling-ui-contract";

type Queue<T> = { items: T[]; total: number; truncated: boolean };
export type ContractorDay = ContractorToday;

function serviceInterval(item: ContractorDay["appointments"]["items"][number] | ContractorDay["projects"]["items"][number], kind: "appointment" | "project"): IntervalInput {
  const reservation = item.schedulingReservation ?? null;
  const evidence = item.schedulingEvidence ?? "invalid";
  const wrongTarget = reservation && (reservation.target.kind !== kind || reservation.target.id !== item.id);
  return {
    startAt: item.scheduledStart,
    endAt: item.scheduledEnd,
    legacyEffectiveEnd: evidence === "legacy" && item.scheduledEnd === null && isoSchema.safeParse(item.scheduledStart).success ? addElapsedMinutes(item.scheduledStart!, kind === "appointment" ? 120 : 1440) : null,
    reservation,
    evidence: wrongTarget ? "invalid" : evidence,
  };
}

const control =
  "min-h-11 rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
const human = (value: string) => value.replaceAll("_", " ");
const shiftDay = (day: string, delta: number) => {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
};
function time(value: string | null, timeZone: string, withDate = false) {
  if (!value) return "Date not set";
  if (!isoSchema.safeParse(value).success) return "Invalid date — review required";
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    ...(withDate ? ({ month: "short", day: "numeric" } as const) : {}),
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}
function serviceDate(value: string | null) {
  return value
    ? new Intl.DateTimeFormat("en-US", {
        timeZone: "UTC",
        dateStyle: "medium",
      }).format(new Date(value))
    : "Date not set";
}

function WorkQueue<T>({
  title,
  data,
  empty,
  destination,
  children,
}: {
  title: string;
  data: Queue<T>;
  empty: string;
  destination: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className="overflow-hidden rounded-xl border border-border bg-card"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border p-4">
        <div>
          <h2 className="font-semibold">{title}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {data.total === 0
              ? "No work in this view"
              : `Showing ${data.items.length} of ${data.total}`}
          </p>
        </div>
        <Link
          href={destination}
          className="flex min-h-11 items-center gap-1 rounded px-1 text-sm font-medium underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Open workspace
          <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
      </div>
      {data.total === 0 ? (
        <p className="p-5 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="divide-y divide-border">{children}</ul>
      )}
      {data.truncated && (
        <p className="border-t border-border px-4 py-3 text-sm text-muted-foreground">
          More work is available. Today shows at most 50 items per queue. Open
          the workspace to search or filter further.
        </p>
      )}
    </section>
  );
}
function WorkRow({
  href,
  title,
  customer,
  customerHref,
  detail,
  status,
  children,
}: {
  href: string;
  title: string;
  customer: string | null;
  customerHref?: string;
  detail: string;
  status: string;
  children?: ReactNode;
}) {
  return (
    <li className="px-4 py-3">
      <Link
        href={href}
        className="block rounded py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="flex items-start justify-between gap-3">
          <span className="min-w-0 break-words text-sm font-semibold">
            {title}
          </span>
          <span className="shrink-0 rounded bg-muted px-2 py-1 text-xs capitalize text-foreground">
            {human(status)}
          </span>
        </div>
        {customer && <p className="mt-1 break-words text-sm">{customer}</p>}
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {detail}
        </p>
      </Link>
      {customerHref && <Link href={customerHref} aria-label={`Open customer record for ${customer || "this work"}`} className="inline-flex min-h-11 items-center rounded text-sm underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Customer record</Link>}
      {children}
    </li>
  );
}

export default function Today() {
  const profile = useGetMe();
  if (profile.isError) return <div role="alert" className="p-4">Company access could not be verified. <button className="min-h-11 underline" onClick={() => void profile.refetch()}>Check work-day access</button></div>;
  if (profile.isLoading) return <p role="status" className="p-4">Confirming company access before opening the work day…</p>;
  if (!profile.data?.isActive || !profile.data.organization) return <p role="alert" className="p-4">Active company access is required to open the work day.</p>;
  const scopeKey = memberAuthorityScope(profile.data);
  return <TodayContent key={scopeKey} me={profile.data} scopeKey={scopeKey} />;
}
function TodayContent({ me, scopeKey }: { me: MemberProfile; scopeKey: string }) {
  const [date, setDate] = useState("");
  const [selectedScope, setScope] = useState<"mine" | "company" | null>(null);
  const scope =
    selectedScope ??
    (["owner", "admin", "office", "sales_manager"].includes(me?.role ?? "")
      ? "company"
      : "mine");
  const companyId = me?.organization?.id;
  const day = useQuery({
    queryKey: ["contractor-day", scopeKey, scope, date],
    enabled: !!companyId,
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({ scope });
      if (date) params.set("date", date);
      const result = await contractorRequest<ContractorDay>(
        `/contractor/today?${params}`,
        { signal },
      );
      if (
        result.organizationId !== companyId ||
        result.scope !== scope ||
        (date && result.date !== date) ||
        result.timeZoneSource !== "configured" ||
        !timeZoneSchema.safeParse(result.timeZone).success
      )
        throw new Error("Workspace response mismatch");
      return result;
    },
    retry: false,
  });
  const data = day.data;
  return (
    <div className="flex-1 bg-background p-4 text-foreground md:p-6">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Today</h1>
            <p className="mt-1 max-w-prose text-sm text-muted-foreground">
              Appointments, due work, and the next handoff.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link className={control} href="/contacts">
              Customers & Jobs
            </Link>
            <Link className={control} href="/tasks">
              All tasks
            </Link>
          </div>
        </header>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label
              htmlFor="work-day"
              className="mb-1 block text-sm font-medium"
            >
              Work day
            </label>
            <div className="flex gap-1">
              <button
                type="button"
                aria-label="Previous day"
                className={control}
                disabled={!data || day.isFetching}
                onClick={() => data && setDate(shiftDay(data.date, -1))}
              >
                <ChevronLeft className="h-4 w-4" aria-hidden />
              </button>
              <input
                id="work-day"
                type="date"
                value={date || data?.date || ""}
                onChange={(event) => setDate(event.target.value)}
                className={`${control} min-w-0`}
              />
              <button
                type="button"
                aria-label="Next day"
                className={control}
                disabled={!data || day.isFetching}
                onClick={() => data && setDate(shiftDay(data.date, 1))}
              >
                <ChevronRight className="h-4 w-4" aria-hidden />
              </button>
            </div>
          </div>
          <div>
            <label
              htmlFor="work-scope"
              className="mb-1 block text-sm font-medium"
            >
              Show
            </label>
            <select
              id="work-scope"
              className={control}
              value={scope}
              onChange={(event) =>
                setScope(event.target.value as "mine" | "company")
              }
            >
              <option value="mine">My work</option>
              <option value="company">Company work</option>
            </select>
          </div>
          <button
            type="button"
            className={control}
            onClick={() => setDate("")}
            disabled={!date}
          >
            Today
          </button>
          <button
            type="button"
            className={`${control} flex items-center gap-2`}
            disabled={day.isFetching || !companyId}
            onClick={() => void day.refetch()}
          >
            <RefreshCw className="h-4 w-4" aria-hidden />
            Refresh
          </button>
        </div>
        {companyId && day.isPending ? (
          <div role="status" className="space-y-3">
            <span className="text-sm text-muted-foreground">
              Loading the work day…
            </span>
            <div className="h-32 animate-pulse rounded-xl bg-muted motion-reduce:animate-none" />
            <div className="h-32 animate-pulse rounded-xl bg-muted motion-reduce:animate-none" />
          </div>
        ) : !companyId || day.isError ? (
          <div
            role="alert"
            className="rounded-xl border border-destructive/40 bg-card p-5"
          >
            <h2 className="font-semibold">The work day could not load</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              No empty-day or zero-work result is being assumed. Refresh to try
              again.
            </p>
          </div>
        ) : data ? (
          <>
            <div className="text-sm text-muted-foreground">
              <p>
                {new Intl.DateTimeFormat("en-US", {
                  dateStyle: "full",
                  timeZone: "UTC",
                }).format(new Date(`${data.date}T12:00:00Z`))}{" "}
                · {data.timeZone} ·{" "}
                {data.scope === "mine" ? "My assignments" : "Company work"}
              </p>
              {data.schedulingPolicyState === "invalid" && (
                <p role="alert" className="mt-1">
                  The current scheduling policy is invalid. Scheduling changes are held; historical work remains visible.
                  {canManageSettings(me?.role) && (
                    <>
                      {" "}
                      <Link
                        href="/settings"
                        className="underline underline-offset-4"
                      >
                        Review settings
                      </Link>
                    </>
                  )}
                </p>
              )}
            </div>
            <div className="grid items-start gap-5 lg:grid-cols-2">
              <WorkQueue
                title="Appointments"
                data={data.appointments}
                empty="No appointments overlap this work day."
                destination="/appointments"
              >
                {data.appointments.items.map((item) => (
                  <WorkRow
                    key={item.id}
                    href={`/appointments?appointmentId=${encodeURIComponent(item.id)}&organizationId=${encodeURIComponent(data.organizationId)}`}
                    title={human(item.type)}
                    customer={item.customerLabel}
                    customerHref={item.contactId ? `/contacts/${encodeURIComponent(item.contactId)}?organizationId=${encodeURIComponent(data.organizationId)}` : undefined}
                    status={item.status}
                    detail={`${time(item.scheduledStart, data.timeZone, new Date(item.scheduledStart) < new Date(data.startAt))}${item.scheduledEnd ? ` – ${time(item.scheduledEnd, data.timeZone, new Date(item.scheduledEnd) >= new Date(data.endAt))}` : ""} · ${item.assigneeName || "Unassigned"}`}
                  >
                    <SchedulingReservationSummary companyTimeZone={data.timeZone} interval={serviceInterval(item, "appointment")} proposal={null} resources={item.assignedUserId ? [{ id: item.assignedUserId, label: item.assigneeName || "Assigned staff (name unavailable)" }] : []} conflict={null} />
                  </WorkRow>
                ))}
              </WorkQueue>
              <WorkQueue
                title="Due and unplanned tasks"
                data={data.tasks}
                empty="No overdue, due, or unplanned tasks are in this view."
                destination="/tasks"
              >
                {data.tasks.items.map((item) => (
                  <WorkRow
                    key={item.id}
                    href={
                      /^\/invoices\?projectId=[0-9a-f-]+$/i.test(item.actionPath) ||
                      (item.actionPath.startsWith('/invoices?') && customerWorkLocation('invoices', item.actionPath.slice('/invoices?'.length), data.organizationId).kind === 'record') ||
                      (item.actionPath.startsWith('/projects?') && customerWorkLocation('projects', item.actionPath.slice('/projects?'.length), data.organizationId).kind === 'record') ||
                      (item.leadId !== null &&
                        /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(item.leadId) &&
                        item.actionPath === `/leads/${item.leadId}?tab=messages`)
                        ? item.actionPath
                        : `/tasks?taskId=${encodeURIComponent(item.id)}`
                    }
                    title={item.title}
                    customer={item.customerLabel}
                    customerHref={item.contactId ? `/contacts/${encodeURIComponent(item.contactId)}?organizationId=${encodeURIComponent(data.organizationId)}` : undefined}
                    status={item.status}
                    detail={`${time(item.dueAt, data.timeZone, true)} · ${item.assigneeName || "Unassigned"}`}
                  />
                ))}
              </WorkQueue>
              <WorkQueue
                title="Jobs"
                data={data.projects}
                empty="No scheduled jobs overlap this work day."
                destination="/projects"
              >
                {data.projects.items.map((item) => (
                  <WorkRow
                    key={item.id}
                    href={customerWorkPath('projects', item.id, data.organizationId) || `/projects?highlight=${encodeURIComponent(item.id)}`}
                    title={item.title}
                    customer={item.customerLabel}
                    customerHref={item.contactId ? `/contacts/${encodeURIComponent(item.contactId)}?organizationId=${encodeURIComponent(data.organizationId)}` : undefined}
                    status={item.status}
                    detail={`Crew: ${item.crewNames.length ? item.crewNames.join(", ") : "Unassigned"}`}
                  >
                    <SchedulingReservationSummary companyTimeZone={data.timeZone} interval={serviceInterval(item, "project")} proposal={null} resources={[]} conflict={null} />
                  </WorkRow>
                ))}
              </WorkQueue>
              <WorkQueue
                title="Warranties & Service"
                data={data.services}
                empty="No service follow-ups are due through this work day."
                destination="/service"
              >
                {data.services.items.map((item) => (
                  <WorkRow
                    key={item.id}
                    href={`/service?serviceObligationId=${encodeURIComponent(item.id)}&organizationId=${encodeURIComponent(data.organizationId)}`}
                    title={item.title}
                    customer={item.customerLabel}
                    customerHref={item.contactId ? `/contacts/${encodeURIComponent(item.contactId)}?organizationId=${encodeURIComponent(data.organizationId)}` : undefined}
                    status={item.status}
                    detail={`${human(item.kind)} · Due ${serviceDate(item.dueAt)} · ${item.assigneeName || "Unassigned"}`}
                  />
                ))}
              </WorkQueue>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
