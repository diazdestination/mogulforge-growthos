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
          ? "inline-flex items-center justify-center gap-2 h-12 px-6 rounded-lg bg-[#e9ad40] hover:bg-[#ffd57a] text-[#05111e] font-semibold text-sm transition-colors shadow-lg shadow-[#e9ad40]/20"
          : "inline-flex items-center justify-center gap-2 h-12 px-6 rounded-lg border border-white/15 text-zinc-200 hover:bg-white/5 font-semibold text-sm transition-colors"
      }
    >
      {children}
    </Link>
  );
}

export default function LandingPage() {
  return (
    <div className="min-h-screen w-full bg-[#05111e] text-zinc-100 overflow-x-hidden">
      <div className="relative">
        {/* Nav */}
        <header className="max-w-6xl mx-auto px-5 md:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <img src="/brand/mogulforge-mark.svg" alt="" className="w-11 h-11 object-contain" />
            <span className="font-bold uppercase tracking-[0.13em]">
              {CLIENT.businessShortName}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/agent-team" className="whitespace-nowrap text-sm text-[#ffd57a] hover:text-white px-3 py-2 transition-colors">Meet the team</Link>
            <Link
              href="/login"
              className="whitespace-nowrap text-sm text-zinc-300 hover:text-white px-3 py-2 transition-colors"
            >
              Sign in
            </Link>
            <Link
              href="/signup"
              className="whitespace-nowrap text-sm font-semibold bg-[#e9ad40] text-[#05111e] hover:bg-[#ffd57a] px-4 py-2 rounded-lg transition-colors"
            >
              Explore
            </Link>
          </div>
        </header>

        {/* Hero */}
        <section className="max-w-3xl mx-auto px-5 md:px-8 pt-16 md:pt-24 pb-16 text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-[#e9ad40]/30 bg-[#e9ad40]/10 px-3 py-1 text-xs font-medium text-[#ffd57a] mb-7">
            <Zap className="w-3.5 h-3.5" />
            {CLIENT.appName}
          </div>
          <h1 className="text-4xl md:text-6xl font-extrabold tracking-tight leading-[1.05] text-balance">
            Turn overlooked opportunities into{" "}
            <span className="text-[#e9ad40]">clear next actions.</span>
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
                className="rounded-2xl border border-white/10 bg-[#0b1b2b] p-6 hover:bg-[#102336] hover:border-[#e9ad40]/30 transition-colors"
              >
                <div className="w-10 h-10 rounded-lg bg-[#e9ad40]/15 text-[#ffd57a] flex items-center justify-center mb-4">
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

        <section className="max-w-6xl mx-auto px-5 md:px-8 py-8" aria-labelledby="team-teaser-heading">
          <div className="rounded-2xl border border-[#e9ad40]/30 bg-[#0b1b2b] p-6 md:p-8 flex flex-col md:flex-row gap-5 md:items-center md:justify-between">
            <div>
              <p className="text-[#e9ad40] text-xs font-bold tracking-widest">THE GROWTHOS TEAM</p>
              <h2 id="team-teaser-heading" className="text-2xl md:text-3xl font-bold mt-2">Eight familiar specialists. One honest view of what is ready.</h2>
              <p className="text-zinc-400 text-sm mt-3 max-w-2xl">Meet Esti, Callie, Maintain, Scout and the rest of the team. See the workspaces available now, the setup still required, and what we are building next.</p>
            </div>
            <Link href="/agent-team" className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-[#e9ad40] px-5 py-3 font-semibold text-sm text-[#ffd57a] hover:bg-[#e9ad40]/10">Meet the agent team <ArrowRight className="h-4 w-4" /></Link>
          </div>
        </section>

        {/* Command-palette flex */}
        <section className="max-w-5xl mx-auto px-5 md:px-8 py-10 md:py-16">
          <div className="rounded-3xl border border-white/10 bg-[#0b1b2b] p-8 md:p-12 text-center">
            <div className="inline-flex items-center gap-2 text-[#ffd57a] text-sm font-mono mb-4">
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
              <img src="/brand/mogulforge-mark.svg" alt="" className="w-5 h-5 object-contain" />
              {CLIENT.appName}
            </span>
            <span>© {CLIENT.businessShortName}</span>
          </div>
        </footer>
      </div>
    </div>
  );
}
