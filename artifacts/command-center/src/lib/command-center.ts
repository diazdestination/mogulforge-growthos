/**
 * Pure helpers for the home command center. Everything here turns API
 * responses into plain-language items a contractor can act on in one tap.
 * No function here sends, books, charges or changes anything.
 */

export type AgentId =
  | "scout"
  | "callie"
  | "appt"
  | "sched"
  | "esti"
  | "bill"
  | "invo"
  | "maintain";

/** Plain words for each specialist, for people who never read the guide. */
export const AGENT_PLAIN: Record<
  AgentId,
  { job: string; helps: string; href: string; cta: string }
> = {
  scout: { job: "Leads", helps: "Finds your next job and tells you who to call.", href: "/pipeline", cta: "Open leads" },
  callie: { job: "Calls", helps: "Catches missed calls so nobody slips away.", href: "/calls", cta: "Open calls" },
  appt: { job: "Appointments", helps: "Books visits and keeps customers in the loop.", href: "/appointments", cta: "Open appointments" },
  sched: { job: "Crew schedule", helps: "Plans the crew's day and the best route.", href: "/today", cta: "Open the work day" },
  esti: { job: "Estimates", helps: "Builds quotes and chases signatures.", href: "/estimates", cta: "Open estimates" },
  bill: { job: "Payments", helps: "Tracks who owes you and what's been paid.", href: "/invoices", cta: "Open payments" },
  invo: { job: "Invoices", helps: "Gets invoices out the door and delivered.", href: "/invoices", cta: "Open invoices" },
  maintain: { job: "Service & warranties", helps: "Remembers tune-ups, warranties and service dates.", href: "/service", cta: "Open service" },
};

export const AGENT_ORDER: readonly AgentId[] = [
  "scout",
  "callie",
  "appt",
  "sched",
  "esti",
  "bill",
  "invo",
  "maintain",
];

export type NeedTone = "urgent" | "money" | "today" | "follow";

export interface NeedItem {
  key: string;
  agent: AgentId;
  title: string;
  detail: string;
  action: string;
  href: string;
  tone: NeedTone;
  /** Lower comes first. */
  rank: number;
}

export interface AgentStatus {
  agent: AgentId;
  /** One short line, e.g. "2 callbacks waiting". */
  line: string;
  count: number;
  state: "needs-you" | "clear" | "unknown" | "hidden";
}

/* ── API shapes this page reads (subset) ─────────────────────────────── */

export interface NbaAction {
  leadId: string;
  actionType: string;
  title: string;
  reasons: string[];
  priority: number;
  contactName?: string | null;
  leadStatus?: string;
  score?: number;
}

export interface DayQueue<T> {
  items: T[];
  total: number;
  truncated: boolean;
}

export interface DayAppointment {
  id: string;
  type: string;
  status: string;
  scheduledStart: string;
  scheduledEnd: string | null;
  customerLabel: string | null;
  assigneeName: string | null;
}
export interface DayTask {
  id: string;
  title: string;
  status: string;
  dueAt: string | null;
  customerLabel: string | null;
  actionPath: string;
  leadId: string | null;
}
export interface DayProject {
  id: string;
  title: string;
  status: string;
  customerLabel: string | null;
  crewNames: string[];
}
export interface DayService {
  id: string;
  title: string;
  kind: string;
  status: string;
  dueAt: string | null;
  customerLabel: string | null;
}
export interface WorkDay {
  organizationId: string;
  date: string;
  timeZone: string;
  startAt: string;
  endAt: string;
  scope: "mine" | "company";
  appointments: DayQueue<DayAppointment>;
  tasks: DayQueue<DayTask>;
  projects: DayQueue<DayProject>;
  services: DayQueue<DayService>;
}

export interface CallbackItem {
  id: string;
  phone: string | null;
  state: string;
  overdue: boolean;
  dueAt: string | null;
  createdAt: string;
}

export interface InvoiceRow {
  id: string;
  status: "draft" | "issued" | "void";
  title: string;
  customerName: string;
  totalCents: number;
  dueDate: string | null;
  balanceDueCents: number | null;
  paymentState: "unpaid" | "partial" | "paid" | "reconciliation_required";
}

export interface EstimateRow {
  id: string;
  title: string;
  status: string;
  totalCents: number;
  leadLabel?: string | null;
  sentAt?: string | null;
  updatedAt: string;
}

export interface CommandInputs {
  now: Date;
  timeZone: string;
  nba?: NbaAction[] | null;
  day?: WorkDay | null;
  callbacks?: CallbackItem[] | null;
  invoices?: InvoiceRow[] | null;
  invoiceTotal?: number | null;
  draftInvoiceCount?: number | null;
  estimates?: EstimateRow[] | null;
  serviceAttention?: number | null;
  /** Agents the member may not see (role gating). */
  hidden?: ReadonlySet<AgentId>;
}

/* ── formatting ─────────────────────────────────────────────────────── */

export const money = (cents: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);

export function clock(iso: string, timeZone: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "time not set";
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function phoneLabel(phone: string | null) {
  if (!phone) return "an unknown number";
  const digits = phone.replace(/\D/g, "");
  const local = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return local.length === 10
    ? `(${local.slice(0, 3)}) ${local.slice(3, 6)}-${local.slice(6)}`
    : phone;
}

export function greeting(now: Date, timeZone: string, firstName?: string | null) {
  let hour = now.getUTCHours();
  try {
    hour = Number(
      new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(now),
    );
  } catch {
    /* fall back to UTC */
  }
  const part = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  return firstName ? `${part}, ${firstName}` : part;
}

const human = (value: string) => value.replaceAll("_", " ");
const dayStart = (date: string) => new Date(`${date}T00:00:00Z`).getTime();
const DAY = 86_400_000;

const NBA_ACTION: Record<string, string> = {
  call_now: "Call now",
  follow_up_estimate: "Follow up",
  reply_portal_message: "Reply",
  review_customer_reply: "Read reply",
  schedule_follow_up: "Plan follow-up",
  send_message: "Send message",
};

export function nbaHeadline(action: NbaAction) {
  const who = action.contactName?.trim() || "this lead";
  switch (action.actionType) {
    case "call_now":
      return `Call ${who}`;
    case "follow_up_estimate":
      return `Follow up with ${who} on their estimate`;
    case "reply_portal_message":
    case "review_customer_reply":
      return `${who} is waiting on a reply`;
    case "schedule_follow_up":
      return `Plan a follow-up with ${who}`;
    case "send_message":
      return `Send ${who} a message`;
    default:
      return `${action.title} · ${who}`;
  }
}

/* ── what needs you today ───────────────────────────────────────────── */

export function buildNeeds(input: CommandInputs): NeedItem[] {
  const hidden = input.hidden ?? new Set<AgentId>();
  const needs: NeedItem[] = [];
  const today = input.day?.date ?? input.now.toISOString().slice(0, 10);
  const todayMs = dayStart(today);

  if (!hidden.has("callie"))
    for (const call of input.callbacks ?? [])
      needs.push({
        key: `callie:${call.id}`,
        agent: "callie",
        title: `Call back ${phoneLabel(call.phone)}`,
        detail: call.overdue ? "Missed call, the callback is overdue." : "Missed call waiting for a callback.",
        action: "Call back",
        href: "/calls",
        tone: "urgent",
        rank: call.overdue ? 0 : 5,
      });

  if (!hidden.has("bill"))
    for (const invoice of input.invoices ?? []) {
      if (invoice.status !== "issued") continue;
      if (invoice.paymentState !== "unpaid" && invoice.paymentState !== "partial") continue;
      const balance = invoice.balanceDueCents ?? invoice.totalCents;
      if (balance <= 0 || !invoice.dueDate) continue;
      const late = Math.floor((todayMs - dayStart(invoice.dueDate.slice(0, 10))) / DAY);
      if (late < 0) continue;
      needs.push({
        key: `bill:${invoice.id}`,
        agent: "bill",
        title: `Collect ${money(balance)} from ${invoice.customerName}`,
        detail: late === 0 ? `${invoice.title} is due today.` : `${invoice.title} is ${late} day${late === 1 ? "" : "s"} past due.`,
        action: "Get paid",
        href: `/invoices/${encodeURIComponent(invoice.id)}`,
        tone: "money",
        rank: late > 0 ? 10 : 20,
      });
    }

  if (!hidden.has("scout"))
    (input.nba ?? []).slice(0, 5).forEach((action, index) =>
      needs.push({
        key: `scout:${action.leadId}`,
        agent: "scout",
        title: nbaHeadline(action),
        detail: action.reasons[0] ?? action.title,
        action: NBA_ACTION[action.actionType] ?? "Open",
        href: `/leads/${encodeURIComponent(action.leadId)}`,
        tone: action.actionType === "call_now" ? "urgent" : "follow",
        rank: (action.actionType === "call_now" ? 15 : 40) + index,
      }),
    );

  if (!hidden.has("appt") && input.day) {
    const day = input.day;
    for (const visit of day.appointments.items) {
      if (["completed", "cancelled", "canceled", "no_show"].includes(visit.status)) continue;
      if (new Date(visit.scheduledStart).getTime() < input.now.getTime() - 2 * 3_600_000 && visit.scheduledEnd && new Date(visit.scheduledEnd).getTime() < input.now.getTime()) continue;
      needs.push({
        key: `appt:${visit.id}`,
        agent: "appt",
        title: `${clock(visit.scheduledStart, day.timeZone)} · ${capitalize(human(visit.type))}${visit.customerLabel ? ` with ${visit.customerLabel}` : ""}`,
        detail: visit.assigneeName ? `${visit.assigneeName} is going.` : "Nobody is assigned yet.",
        action: visit.assigneeName ? "View visit" : "Assign someone",
        href: `/appointments?appointmentId=${encodeURIComponent(visit.id)}&organizationId=${encodeURIComponent(day.organizationId)}`,
        tone: visit.assigneeName ? "today" : "urgent",
        rank: visit.assigneeName ? 30 : 12,
      });
    }
  }

  if (!hidden.has("esti"))
    for (const estimate of input.estimates ?? []) {
      if (estimate.status !== "sent") continue;
      const sent = new Date(estimate.sentAt ?? estimate.updatedAt).getTime();
      const waited = Math.floor((input.now.getTime() - sent) / DAY);
      if (waited < 3) continue;
      needs.push({
        key: `esti:${estimate.id}`,
        agent: "esti",
        title: `Nudge ${estimate.leadLabel?.trim() || "the customer"} about a ${money(estimate.totalCents)} estimate`,
        detail: `Sent ${waited} days ago with no answer yet.`,
        action: "Follow up",
        href: "/estimates",
        tone: "follow",
        rank: 45,
      });
    }

  if (input.day)
    for (const task of input.day.tasks.items) {
      if (task.status === "done" || task.status === "completed") continue;
      const overdue = task.dueAt ? new Date(task.dueAt).getTime() < input.now.getTime() : false;
      needs.push({
        key: `task:${task.id}`,
        agent: "scout",
        title: task.title,
        detail: `${overdue ? "Overdue" : task.dueAt ? `Due ${clock(task.dueAt, input.day.timeZone)}` : "No due time"}${task.customerLabel ? ` · ${task.customerLabel}` : ""}`,
        action: "Do it",
        href: `/tasks?taskId=${encodeURIComponent(task.id)}`,
        tone: overdue ? "urgent" : "follow",
        rank: overdue ? 25 : 50,
      });
    }

  if (!hidden.has("maintain") && input.day)
    for (const service of input.day.services.items)
      needs.push({
        key: `maintain:${service.id}`,
        agent: "maintain",
        title: `${service.title}${service.customerLabel ? ` · ${service.customerLabel}` : ""}`,
        detail: `${capitalize(human(service.kind))} is due.`,
        action: "Plan it",
        href: `/service?serviceObligationId=${encodeURIComponent(service.id)}&organizationId=${encodeURIComponent(input.day.organizationId)}`,
        tone: "follow",
        rank: 55,
      });

  return needs.sort((a, b) => a.rank - b.rank);
}

function capitalize(value: string) {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

/* ── one line per specialist ────────────────────────────────────────── */

export function agentStatuses(input: CommandInputs, loading: Partial<Record<AgentId, boolean>> = {}): AgentStatus[] {
  const hidden = input.hidden ?? new Set<AgentId>();
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const today = input.day?.date ?? input.now.toISOString().slice(0, 10);
  return AGENT_ORDER.map((agent): AgentStatus => {
    if (hidden.has(agent)) return { agent, line: "", count: 0, state: "hidden" };
    if (loading[agent]) return { agent, line: "Checking…", count: 0, state: "unknown" };
    const unknown: AgentStatus = { agent, line: "Tap to check in", count: 0, state: "unknown" };
    switch (agent) {
      case "scout": {
        if (!input.nba) return unknown;
        const n = input.nba.length;
        return n ? { agent, line: `${plural(n, "lead")} to work today`, count: n, state: "needs-you" } : { agent, line: "Every lead has a next step", count: 0, state: "clear" };
      }
      case "callie": {
        if (!input.callbacks) return unknown;
        const n = input.callbacks.length;
        return n ? { agent, line: `${plural(n, "missed call")} to call back`, count: n, state: "needs-you" } : { agent, line: "No missed calls waiting", count: 0, state: "clear" };
      }
      case "appt": {
        if (!input.day) return unknown;
        const n = input.day.appointments.total;
        const next = input.day.appointments.items.find((v) => new Date(v.scheduledStart).getTime() >= input.now.getTime());
        if (!n) return { agent, line: "No visits booked today", count: 0, state: "clear" };
        return { agent, line: next ? `${plural(n, "visit")} today · next at ${clock(next.scheduledStart, input.day.timeZone)}` : `${plural(n, "visit")} today`, count: n, state: "needs-you" };
      }
      case "sched": {
        if (!input.day) return unknown;
        const n = input.day.projects.total;
        return n ? { agent, line: `${plural(n, "job")} on the board today`, count: n, state: "needs-you" } : { agent, line: "No crew jobs on the board today", count: 0, state: "clear" };
      }
      case "esti": {
        if (!input.estimates) return unknown;
        const n = input.estimates.filter((e) => e.status === "sent").length;
        return n ? { agent, line: `${plural(n, "estimate")} waiting on customers`, count: n, state: "needs-you" } : { agent, line: "No estimates waiting on customers", count: 0, state: "clear" };
      }
      case "bill": {
        if (!input.invoices) return unknown;
        const open = input.invoices.filter((i) => i.status === "issued" && (i.paymentState === "unpaid" || i.paymentState === "partial"));
        const incomplete = typeof input.invoiceTotal === 'number' && input.invoiceTotal > input.invoices.length;
        const owed = open.reduce((sum, i) => sum + Math.max(0, i.balanceDueCents ?? i.totalCents), 0);
        const late = open.filter((i) => i.dueDate && dayStart(i.dueDate.slice(0, 10)) < dayStart(today)).length;
        if (!open.length) return incomplete ? { agent, line: 'More invoices to review', count: 0, state: 'unknown' } : { agent, line: "Nobody owes you right now", count: 0, state: "clear" };
        return { agent, line: `${incomplete ? 'At least ' : ''}${money(owed)} owed${late ? ` · ${late} late` : ""}`, count: open.length, state: late ? "needs-you" : incomplete ? 'unknown' : "clear" };
      }
      case "invo": {
        if (input.draftInvoiceCount == null) return unknown;
        const n = input.draftInvoiceCount;
        return n ? { agent, line: `${plural(n, "draft invoice")} ready to send`, count: n, state: "needs-you" } : { agent, line: "No drafts waiting to go out", count: 0, state: "clear" };
      }
      case "maintain": {
        const due = input.day?.services.total;
        const attention = input.serviceAttention;
        if (due == null && attention == null) return unknown;
        const n = Math.max(due ?? 0, attention ?? 0);
        return n ? { agent, line: `${plural(n, "service visit")} coming due`, count: n, state: "needs-you" } : { agent, line: "No service coming due", count: 0, state: "clear" };
      }
    }
  });
}

/** One plain sentence under the greeting. */
export function summaryLine(needs: NeedItem[], anyLoading: boolean) {
  if (anyLoading && needs.length === 0) return "Your team is checking on everything…";
  if (needs.length === 0) return "You're all caught up. Nothing needs you right now.";
  const urgent = needs.filter((n) => n.tone === "urgent").length;
  const head = `${needs.length} thing${needs.length === 1 ? "" : "s"} need${needs.length === 1 ? "s" : ""} you today`;
  return urgent ? `${head}, ${urgent} of them right away.` : `${head}.`;
}
