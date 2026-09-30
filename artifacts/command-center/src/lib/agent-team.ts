export type AgentTaskStage = 'workspace' | 'setup' | 'planned';

export interface AgentTask {
  title: string;
  stage: AgentTaskStage;
  reality: string;
}

export interface AgentProfile {
  id: string;
  name: string;
  role: string;
  promise: string;
  portrait: string;
  workspace?: string;
  workspaceLabel?: string;
  tasks: readonly AgentTask[];
}

/**
 * The illustrated agent team is a product map, not a claim that eight autonomous
 * workers are deployed. Keep every task tied to an inspectable current state.
 */
export const AGENT_TEAM: readonly AgentProfile[] = [
  {
    id: 'esti', name: 'ESTI', role: 'The Estimate Architect',
    promise: 'Turn a scoped opportunity into an estimate your team can review.',
    portrait: '/agent-profiles/esti.webp', workspace: '/estimates', workspaceLabel: 'Open estimates',
    tasks: [
      { title: 'Job measurements & scope building', stage: 'workspace', reality: 'Staff can create estimate line items and connect them to a lead. Automated measurement and scope extraction are not live.' },
      { title: 'Pricing intelligence & templates', stage: 'planned', reality: 'Trade-specific price books and margin guidance still need governed source data and approval rules.' },
      { title: 'Proposal generation & delivery', stage: 'planned', reality: 'A customer-ready proposal workflow and tracked delivery are not yet released.' },
      { title: 'Estimate follow-up & nurturing', stage: 'setup', reality: 'Revenue Desk can surface follow-up work. Customer outreach needs approved provider setup, consent, and release acceptance.' },
    ],
  },
  {
    id: 'bill', name: 'BILL', role: 'The Billing Guardian',
    promise: 'Keep the financial handoff visible without guessing at money.',
    portrait: '/agent-profiles/bill.webp',
    tasks: [
      { title: 'Invoices & progress billing', stage: 'planned', reality: 'Customer invoicing is not built. The existing Billing page manages GrowthOS subscriptions, not contractor invoices.' },
      { title: 'Payment tracking & reminders', stage: 'planned', reality: 'Recorded payments are not a connected accounting ledger; payment-provider reconciliation and consented reminders are still needed.' },
      { title: 'Late payment recovery', stage: 'planned', reality: 'Collections workflows require approved policies, provider integration, and human review.' },
      { title: 'Lien & notice management', stage: 'planned', reality: 'Legal deadlines and notices require jurisdiction-specific professional review. GrowthOS will not auto-file or send them.' },
    ],
  },
  {
    id: 'invo', name: 'INVO', role: 'The Invoice Intelligence Agent',
    promise: 'Catch invoice exceptions and make receivables easier to manage.',
    portrait: '/agent-profiles/invo.webp',
    tasks: [
      { title: 'Invoice creation & automation', stage: 'planned', reality: 'No contractor invoice generator is live; the canonical invoice model and accounting connector come first.' },
      { title: 'Exception detection & flagging', stage: 'planned', reality: 'Invoice accuracy checks need trusted line items, payment state, and an auditable exception queue.' },
      { title: 'Client payment portal management', stage: 'planned', reality: 'No customer payment portal is live. Payment collection remains outside the beta scope.' },
      { title: 'A/R aging & collections workflow', stage: 'planned', reality: 'A/R aging requires an authoritative invoice and payment source before it can be shown responsibly.' },
    ],
  },
  {
    id: 'sched', name: 'SCHED', role: 'The Schedule Optimizer',
    promise: 'Give dispatch a clear picture of appointments and capacity.',
    portrait: '/agent-profiles/sched.webp', workspace: '/appointments', workspaceLabel: 'Open appointments',
    tasks: [
      { title: 'Job scheduling & routing', stage: 'workspace', reality: 'Staff can create and update appointments. Job routing and route optimization are not built.' },
      { title: 'Crew & resource allocation', stage: 'planned', reality: 'A crew/skills/capacity model is needed before assignments can be optimized.' },
      { title: 'Schedule adjustments & alerts', stage: 'planned', reality: 'Automated change alerts require a verified calendar and notification connector.' },
      { title: 'Conflict detection & resolution', stage: 'planned', reality: 'There is not yet a cross-crew conflict engine or safe automatic rescheduler.' },
    ],
  },
  {
    id: 'appt', name: 'APPT', role: 'The Appointment Ally',
    promise: 'Make the next visit clear for both the customer and the office.',
    portrait: '/agent-profiles/appt.webp', workspace: '/appointments', workspaceLabel: 'Open appointments',
    tasks: [
      { title: 'Appointment booking & confirmations', stage: 'workspace', reality: 'Staff can book and update appointments in GrowthOS; automated customer confirmations need provider launch approval.' },
      { title: 'Calendar synchronization', stage: 'planned', reality: 'A full external calendar adapter is explicitly deferred until the paid-beta core is proven.' },
      { title: 'Email, SMS & voice reminders', stage: 'setup', reality: 'Reminder controls exist, but customer-facing delivery is not enabled for Painless or HVAC and must pass consent/provider acceptance.' },
      { title: 'No-show recovery & rescheduling', stage: 'planned', reality: 'A no-show trigger, recovery policy, and rescheduling workflow still need to be built.' },
    ],
  },
  {
    id: 'callie', name: 'CALLIE', role: 'The Missed Call Responder',
    promise: 'Turn a missed call into an owned callback, then a real opportunity.',
    portrait: '/agent-profiles/callie.webp', workspace: '/calls', workspaceLabel: 'Open calls',
    tasks: [
      { title: 'Missed call detection & response', stage: 'setup', reality: 'Tenant-scoped Twilio intake creates a staff callback task in local code. It is not live for either pilot client.' },
      { title: 'SMS & voicemail follow-up', stage: 'planned', reality: 'Automatic missed-call texts and AI voice answering are not implemented or activated in GrowthOS.' },
      { title: 'Lead qualification & routing', stage: 'workspace', reality: 'Staff can review a call and create an opportunity when confirmed. Autonomous qualification is not live.' },
      { title: 'Call analytics & reporting', stage: 'workspace', reality: 'The Calls workspace records calls and callback outcomes; provider-connected analytics need live acceptance.' },
    ],
  },
  {
    id: 'maintain', name: 'MAINTAIN', role: 'The Maintenance Watchdog',
    promise: 'Keep warranty and service dates from disappearing into a spreadsheet.',
    portrait: '/agent-profiles/maintain.webp', workspace: '/service', workspaceLabel: 'Open service desk',
    tasks: [
      { title: 'Maintenance reminders & scheduling', stage: 'workspace', reality: 'Service dates create staff follow-up tasks. They do not yet send customer reminders or book a technician automatically.' },
      { title: 'Inspection checklists & tracking', stage: 'planned', reality: 'Equipment-specific service checklists and completion evidence are not built.' },
      { title: 'Warranty & service alerts', stage: 'setup', reality: 'Warranty and plan obligations can be imported and tracked; customer alerts still require approved message automation.' },
      { title: 'Preventative maintenance programs', stage: 'planned', reality: 'Recurring program rules, entitlements, and visit reconciliation still need a product workflow.' },
    ],
  },
  {
    id: 'scout', name: 'SCOUT', role: 'The Opportunity Scout',
    promise: 'Find the revenue already hiding in your existing pipeline.',
    portrait: '/agent-profiles/scout.webp', workspace: '/reactivation', workspaceLabel: 'Open win-back',
    tasks: [
      { title: 'Dead-lead resurrection campaigns', stage: 'setup', reality: 'CSV import, segments, preview, and campaign controls exist in code. Live outreach requires consent, provider readiness, and release approval.' },
      { title: 'Missed opportunity detection', stage: 'workspace', reality: 'Revenue Desk can surface unowned inquiries, stalled follow-up, and estimates awaiting a decision.' },
      { title: 'Process & efficiency analysis', stage: 'workspace', reality: 'Current insights and reports expose recorded activity; they do not prove causal improvement by themselves.' },
      { title: 'Revenue growth recommendations', stage: 'workspace', reality: 'Next-best actions are operator-reviewed suggestions with supporting records, not autonomous business decisions.' },
    ],
  },
];

export const AGENT_STAGE_LABEL: Record<AgentTaskStage, string> = {
  workspace: 'In workspace',
  setup: 'Setup required',
  planned: 'Planned',
};
