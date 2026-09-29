import { Link } from "wouter";
import {
  Sparkles,
  Workflow,
  Trello,
  BadgeDollarSign,
  Webhook,
  LayoutDashboard,
  ArrowRight,
  Command,
  ShieldCheck,
  Zap,
} from "lucide-react";
import { CLIENT } from "@/lib/client.config";

const brandInitial = (CLIENT.businessShortName || CLIENT.appName || "M")
  .trim()
  .charAt(0)
  .toUpperCase();

const FEATURES = [
  {
    icon: Sparkles,
    title: "Find the follow-up gaps",
    body: "Revenue Desk brings unowned inquiries, overdue follow-up, and estimates awaiting a decision into one place, with the evidence behind each next step.",
  },
  {
    icon: Workflow,
    title: "Give every opportunity an owner",
    body: "Assign the right person, set a next action, and use consent-aware playbooks to keep approved follow-up moving. Review uncertain results before trying again.",
  },
  {
    icon: Trello,
    title: "Connect the customer journey",
    body: "Keep inquiries, appointments, estimates, and project progress connected. Help your team see what is waiting and what needs attention today.",
  },
  {
    icon: BadgeDollarSign,
    title: "Make results inspectable",
    body: "Track responses, booked appointments, wins, and staff-recorded payments with their supporting records. Pipeline value and recorded payments remain clearly distinguished.",
  },
  {
    icon: Webhook,
    title: "Bring your existing leads",
    body: "Import a CRM CSV or connect approved website intake. Organize the opportunities you already have before adding another source of leads.",
  },
  {
    icon: LayoutDashboard,
    title: "One Business Intelligence Ecosystem",
    body: "CRM records, business knowledge, controlled automation, customer decisions, and revenue evidence work together in GrowthOS. CRM is one part of the system.",
  },
];

function Cta({
  href,
  children,
  primary,
}: {
  href: string;
  children: React.ReactNode;
  primary?: boolean;
}) {
  return (
    <Link
      href={href}
      className={
        primary
          ? "inline-flex items-center justify-center gap-2 h-12 px-6 rounded-lg bg-violet-600 hover:bg-violet-500 text-white font-semibold text-sm transition-colors shadow-lg shadow-violet-600/30"
          : "inline-flex items-center justify-center gap-2 h-12 px-6 rounded-lg border border-white/15 text-zinc-200 hover:bg-white/5 font-semibold text-sm transition-colors"
      }
    >
      {children}
    </Link>
  );
}

export default function LandingPage() {
  return (
    <div className="min-h-screen w-full bg-[#0a0a0f] text-zinc-100 overflow-x-hidden">
      {/* subtle grid + violet glow */}
      <div
        className="pointer-events-none fixed inset-0 opacity-[0.06]"
        style={{
          backgroundImage:
            "linear-gradient(to right, #fff 1px, transparent 1px), linear-gradient(to bottom, #fff 1px, transparent 1px)",
          backgroundSize: "56px 56px",
        }}
      />
      <div
        className="pointer-events-none fixed -top-40 left-1/2 -translate-x-1/2 h-[520px] w-[820px] rounded-full blur-3xl opacity-25"
        style={{
          background: "radial-gradient(circle, #7c3aed 0%, transparent 70%)",
        }}
      />

      <div className="relative">
        {/* Nav */}
        <header className="max-w-6xl mx-auto px-5 md:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-violet-600 flex items-center justify-center font-bold text-white shadow-md shadow-violet-600/40">
              {brandInitial}
            </div>
            <span className="font-bold tracking-tight">
              {CLIENT.businessShortName}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/login"
              className="whitespace-nowrap text-sm text-zinc-300 hover:text-white px-3 py-2 transition-colors"
            >
              Sign in
            </Link>
            <Link
              href="/signup"
              className="whitespace-nowrap text-sm font-semibold bg-white text-zinc-900 hover:bg-zinc-200 px-4 py-2 rounded-lg transition-colors"
            >
              Explore
            </Link>
          </div>
        </header>

        {/* Hero */}
        <section className="max-w-3xl mx-auto px-5 md:px-8 pt-16 md:pt-24 pb-16 text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-violet-500/30 bg-violet-500/10 px-3 py-1 text-xs font-medium text-violet-300 mb-7">
            <Zap className="w-3.5 h-3.5" />
            {CLIENT.appName}
          </div>
          <h1 className="text-4xl md:text-6xl font-extrabold tracking-tight leading-[1.05] text-balance">
            Turn overlooked opportunities into{" "}
            <span className="text-violet-400">clear next actions.</span>
          </h1>
          <p className="mt-6 text-lg text-zinc-400 max-w-2xl mx-auto">
            A Business Intelligence Ecosystem (BIE) for home-service teams.
            Connect your leads, follow-up, estimates, and outcomes so your team
            knows what to do next — and why.
          </p>
          <div className="mt-9 flex flex-col sm:flex-row items-center justify-center gap-3">
            <Cta href="/signup" primary>
              Explore a workspace <ArrowRight className="w-4 h-4" />
            </Cta>
            <Cta href="/login">Sign in</Cta>
          </div>
          <p className="mt-5 text-xs text-zinc-500 flex items-center justify-center gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5 shrink-0" /> Start with sample
            data. Live outreach requires provider setup and launch verification.
          </p>
        </section>

        {/* Features */}
        <section className="max-w-6xl mx-auto px-5 md:px-8 py-8 md:py-14">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <div
                key={f.title}
                className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 hover:bg-white/[0.05] hover:border-violet-500/30 transition-colors"
              >
                <div className="w-10 h-10 rounded-lg bg-violet-500/15 text-violet-300 flex items-center justify-center mb-4">
                  <f.icon className="w-5 h-5" />
                </div>
                <h3 className="font-semibold text-[15px] mb-1.5">{f.title}</h3>
                <p className="text-sm text-zinc-400 leading-relaxed">
                  {f.body}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* Command-palette flex */}
        <section className="max-w-5xl mx-auto px-5 md:px-8 py-10 md:py-16">
          <div className="rounded-3xl border border-white/10 bg-gradient-to-b from-violet-600/10 to-transparent p-8 md:p-12 text-center">
            <div className="inline-flex items-center gap-2 text-violet-300 text-sm font-mono mb-4">
              <Command className="w-4 h-4" /> ⌘K
            </div>
            <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-balance">
              One place to decide what happens next.
            </h2>
            <p className="mt-4 text-zinc-400 max-w-xl mx-auto">
              Find the opportunity, inspect its history, and give the next step
              an owner. Use the command palette to move between your revenue
              workspace, contacts, pipeline, and appointments.
            </p>
          </div>
        </section>

        {/* Final CTA */}
        <section className="max-w-3xl mx-auto px-5 md:px-8 py-14 md:py-20 text-center">
          <h2 className="text-3xl md:text-4xl font-extrabold tracking-tight text-balance">
            Start with the opportunities already in your business.
          </h2>
          <p className="mt-4 text-zinc-400">
            Explore {CLIENT.appName} with sample data, then prepare one focused
            workflow with your team. Connect providers and verify the full
            customer journey before launching live follow-up.
          </p>
          <div className="mt-8 flex justify-center">
            <Cta href="/signup" primary>
              Create your workspace <ArrowRight className="w-4 h-4" />
            </Cta>
          </div>
        </section>

        {/* Footer */}
        <footer className="border-t border-white/10">
          <div className="max-w-6xl mx-auto px-5 md:px-8 h-16 flex items-center justify-between text-sm text-zinc-500">
            <span className="flex items-center gap-2">
              <div className="w-5 h-5 rounded bg-violet-600 flex items-center justify-center text-[10px] font-bold text-white">
                {brandInitial}
              </div>
              {CLIENT.appName}
            </span>
            <span>© {CLIENT.businessShortName}</span>
          </div>
        </footer>
      </div>
    </div>
  );
}
