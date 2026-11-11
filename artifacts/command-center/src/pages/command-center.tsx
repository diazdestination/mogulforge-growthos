import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useGetMe, type MemberProfile } from "@workspace/api-client-react";
import {
  ArrowRight,
  CalendarPlus,
  CheckCircle2,
  ChevronDown,
  FilePlus2,
  MessageCircleQuestion,
  ReceiptText,
  RefreshCw,
  Smartphone,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import { AGENT_TEAM } from "@/lib/agent-team";
import { contractorRequest } from "@/lib/contractor-api";
import { memberAuthorityScope } from "@/lib/member-authority-scope";
import { canManageInvoices, canReadInvoices, canWrite, isFieldRole } from "@/lib/permissions";
import {
  AGENT_PLAIN,
  agentStatuses,
  buildNeeds,
  greeting,
  summaryLine,
  type AgentId,
  type AgentStatus,
  type CallbackItem,
  type EstimateRow,
  type InvoiceRow,
  type NbaAction,
  type NeedItem,
  type WorkDay,
} from "@/lib/command-center";
import "./command-center.css";

const SHOW_FIRST = 6;
const MANAGER_ROLES = ["owner", "admin", "office", "sales_manager"];

function portrait(agent: AgentId) {
  return AGENT_TEAM.find((profile) => profile.id === agent)?.portrait ?? "";
}
function agentName(agent: AgentId) {
  return AGENT_TEAM.find((profile) => profile.id === agent)?.name ?? agent.toUpperCase();
}

export default function CommandCenter() {
  const profile = useGetMe();
  if (profile.isError)
    return (
      <div role="alert" className="p-4">
        We couldn't confirm your company access.{" "}
        <button className="min-h-11 underline" onClick={() => void profile.refetch()}>
          Try again
        </button>
      </div>
    );
  if (profile.isLoading) return <p role="status" className="p-4">Opening your command center…</p>;
  if (!profile.data?.isActive || !profile.data.organization)
    return <p role="alert" className="p-4">Active company access is required to open the command center.</p>;
  const scopeKey = memberAuthorityScope(profile.data);
  return <CommandCenterContent key={scopeKey} me={profile.data} scopeKey={scopeKey} />;
}

function listOf<T>(value: T[] | null | undefined): T[] | null {
  return Array.isArray(value) ? value : null;
}

function useSafeQuery<T>(key: unknown[], path: string | null) {
  return useQuery({
    queryKey: key,
    enabled: path !== null,
    queryFn: ({ signal }) => contractorRequest<T>(path!, { signal }),
    retry: false,
    staleTime: 30_000,
  });
}

function CommandCenterContent({ me, scopeKey }: { me: MemberProfile; scopeKey: string }) {
  const [showAll, setShowAll] = useState(false);
  const role = me.role;
  const companyId = me.organization!.id;
  const timeZone = me.organization!.timezone || "America/New_York";
  const scope = MANAGER_ROLES.includes(role) ? "company" : "mine";
  const seesMoney = canReadInvoices(role);
  const hidden = useMemo(
    () => new Set<AgentId>(seesMoney ? [] : ["bill", "invo"]),
    [seesMoney],
  );

  const day = useSafeQuery<WorkDay>(["command-center", scopeKey, "day", scope], `/contractor/today?scope=${scope}`);
  const nba = useSafeQuery<{ actions: NbaAction[] }>(["command-center", scopeKey, "nba"], "/next-best-action/today-actions?limit=8");
  const calls = useSafeQuery<{ items: CallbackItem[] }>(["command-center", scopeKey, "callie"], "/communications/callie?scope=attention&offset=0");
  const service = useSafeQuery<{ items: unknown[] }>(["command-center", scopeKey, "service"], "/service-watch?scope=attention&offset=0");
  const estimates = useSafeQuery<EstimateRow[]>(["command-center", scopeKey, "estimates"], "/estimates?status=sent&limit=50");
  const issued = useSafeQuery<{ items: InvoiceRow[] }>(["command-center", scopeKey, "invoices", "issued"], seesMoney ? "/invoices?page=0&status=issued" : null);
  const drafts = useSafeQuery<{ total: number }>(["command-center", scopeKey, "invoices", "draft"], seesMoney ? "/invoices?page=0&status=draft" : null);

  const dayData = day.data && day.data.organizationId === companyId && day.data.appointments ? day.data : null;
  const now = new Date();
  const inputs = {
    now,
    timeZone: dayData?.timeZone ?? timeZone,
    nba: listOf(nba.data?.actions),
    day: dayData,
    callbacks: listOf(calls.data?.items),
    invoices: listOf(issued.data?.items),
    draftInvoiceCount: typeof drafts.data?.total === "number" ? drafts.data.total : null,
    estimates: listOf(estimates.data),
    serviceAttention: listOf(service.data?.items)?.length ?? null,
    hidden,
  };
  const loading: Partial<Record<AgentId, boolean>> = {
    scout: nba.isPending,
    callie: calls.isPending,
    appt: day.isPending,
    sched: day.isPending,
    esti: estimates.isPending,
    bill: seesMoney && issued.isPending,
    invo: seesMoney && drafts.isPending,
    maintain: day.isPending && service.isPending,
  };
  const anyLoading = Object.values(loading).some(Boolean);
  const needs = buildNeeds(inputs);
  const statuses = agentStatuses(inputs, loading);
  const failed = [day, nba, calls, estimates, ...(seesMoney ? [issued, drafts] : [])].filter((q) => q.isError).length;
  const visible = showAll ? needs : needs.slice(0, SHOW_FIRST);
  const refreshAll = () => {
    for (const q of [day, nba, calls, service, estimates, issued, drafts]) void q.refetch();
  };

  const firstName = me.firstName?.trim() || null;
  const dateLine = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", month: "long", day: "numeric" }).format(now);
  const crewFaces = (["scout", "callie", "appt", "esti", "bill"] as AgentId[]).filter((a) => !hidden.has(a));

  return (
    <div className="cc">
      <section className="cc-hero" aria-labelledby="cc-greeting">
        <div className="cc-hero__copy">
          <p className="cc-hero__date">{dateLine}</p>
          <h1 id="cc-greeting">{greeting(now, timeZone, firstName)}</h1>
          <p className="cc-hero__summary" aria-live="polite">{summaryLine(needs, anyLoading)}</p>
          <div className="cc-hero__actions">
            {isFieldRole(role) && (
              <Link href="/tech" className="cc-btn cc-btn--primary">
                <Smartphone aria-hidden /> Open my day
              </Link>
            )}
            <Link href="/today" className="cc-btn cc-btn--ghost">
              <span className="cc-long">See the full work day</span>
              <span className="cc-short">Full work day</span>
              <ArrowRight aria-hidden />
            </Link>
          </div>
        </div>
        <div className="cc-hero__team" aria-hidden="true">
          {crewFaces.map((agent) => (
            <img key={agent} src={portrait(agent)} alt="" width={72} height={72} />
          ))}
        </div>
      </section>

      <div className="cc-body">
        <section className="cc-card cc-needs" aria-labelledby="cc-needs-title">
          <header className="cc-section-head">
            <div>
              <h2 id="cc-needs-title">What needs you today</h2>
              <p>Most important first. Tap a button to take care of it.</p>
            </div>
            <button
              type="button"
              className="cc-icon-btn"
              onClick={refreshAll}
              aria-label="Check again"
              disabled={anyLoading}
            >
              <RefreshCw aria-hidden className={anyLoading ? "cc-spin" : undefined} />
            </button>
          </header>
          {failed > 0 && (
            <p role="alert" className="cc-warning">
              Some of your team couldn't check in just now, so this list may be missing something.{" "}
              <button type="button" onClick={refreshAll}>Try again</button>
            </p>
          )}
          {anyLoading && needs.length === 0 ? (
            <ul className="cc-needs__list" aria-busy="true">
              {[0, 1, 2].map((i) => (
                <li key={i} className="cc-need cc-need--skeleton" />
              ))}
            </ul>
          ) : needs.length === 0 ? (
            <div className="cc-empty">
              <CheckCircle2 aria-hidden />
              <div>
                <p className="cc-empty__title">You're all caught up</p>
                <p>Nothing needs you right now. New calls, leads and payments will show up here.</p>
              </div>
            </div>
          ) : (
            <>
              <ul className="cc-needs__list">
                {visible.map((need) => (
                  <NeedRow key={need.key} need={need} />
                ))}
              </ul>
              {needs.length > SHOW_FIRST && (
                <button type="button" className="cc-more" onClick={() => setShowAll((v) => !v)} aria-expanded={showAll}>
                  {showAll ? "Show less" : `Show ${needs.length - SHOW_FIRST} more`}
                  <ChevronDown aria-hidden className={showAll ? "cc-rotate" : undefined} />
                </button>
              )}
            </>
          )}
        </section>

        <section className="cc-card cc-quick" aria-labelledby="cc-quick-title">
          <header className="cc-section-head">
            <div>
              <h2 id="cc-quick-title">Start something</h2>
              <p>The things you do most, one tap away.</p>
            </div>
          </header>
          <div className="cc-quick__grid">
            {canWrite(role) && <QuickAction href="/contacts" icon={UserPlus} label="Add a customer" />}
            {canWrite(role) && <QuickAction href="/estimates" icon={FilePlus2} label="New estimate" />}
            {canWrite(role) && <QuickAction href="/appointments" icon={CalendarPlus} label="Book a visit" />}
            {canManageInvoices(role) && <QuickAction href="/invoices" icon={ReceiptText} label="New invoice" />}
            <QuickAction href="/assistant" icon={MessageCircleQuestion} label="Ask the assistant" />
          </div>
        </section>
      </div>

      <section className="cc-team" aria-labelledby="cc-team-title">
        <header className="cc-section-head cc-section-head--team">
          <div>
            <h2 id="cc-team-title">Your team</h2>
            <p>Each specialist watches one part of your business. Tap one to open their desk.</p>
          </div>
          <Link href="/agent-team" className="cc-link">
            How they work <ArrowRight aria-hidden />
          </Link>
        </header>
        <ul className="cc-team__grid">
          {statuses
            .filter((status) => status.state !== "hidden")
            .map((status) => (
              <AgentCard key={status.agent} status={status} />
            ))}
        </ul>
      </section>
    </div>
  );
}

function NeedRow({ need }: { need: NeedItem }) {
  return (
    <li className={`cc-need cc-need--${need.tone}`}>
      <img className="cc-need__face" src={portrait(need.agent)} alt="" width={48} height={48} />
      <div className="cc-need__copy">
        <p className="cc-need__who">{agentName(need.agent)}</p>
        <p className="cc-need__title">{need.title}</p>
        <p className="cc-need__detail">{need.detail}</p>
      </div>
      <Link href={need.href} className="cc-btn cc-btn--action" aria-label={`${need.action}: ${need.title}`}>
        {need.action}
        <ArrowRight aria-hidden />
      </Link>
    </li>
  );
}

function AgentCard({ status }: { status: AgentStatus }) {
  const plain = AGENT_PLAIN[status.agent];
  const name = agentName(status.agent);
  return (
    <li>
      <Link
        href={plain.href}
        className={`cc-agent cc-agent--${status.state}`}
        aria-label={`${name}, ${plain.job}: ${status.line}. ${plain.cta}`}
      >
        <span className="cc-agent__face">
          <img src={portrait(status.agent)} alt="" width={64} height={64} />
          {status.state === "needs-you" && status.count > 0 && (
            <span className="cc-agent__badge" aria-hidden>
              {status.count > 99 ? "99+" : status.count}
            </span>
          )}
        </span>
        <span className="cc-agent__copy">
          <span className="cc-agent__name">{name}</span>
          <span className="cc-agent__job">{plain.job}</span>
          <span className="cc-agent__line">
            <span className={`cc-dot cc-dot--${status.state}`} aria-hidden />
            {status.line}
          </span>
          <span className="cc-agent__helps">{plain.helps}</span>
        </span>
      </Link>
    </li>
  );
}

function QuickAction({ href, icon: Icon, label }: { href: string; icon: LucideIcon; label: string }) {
  return (
    <Link href={href} className="cc-quick__btn">
      <Icon aria-hidden />
      <span>{label}</span>
    </Link>
  );
}
