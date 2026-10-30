export type AgentTaskStage = 'workspace' | 'setup' | 'planned';
export interface AgentTask { title: string; stage: AgentTaskStage; reality: string; }
export interface AgentProfile {
  id: string; name: string; role: string; promise: string; portrait: string;
  category: 'finance' | 'operations'; workspace: string; workspaceLabel: string;
  tasks: readonly AgentTask[];
}
/** Illustrated specialists identify workspaces; they do not imply autonomous execution. */
export const AGENT_TEAM: readonly AgentProfile[] = [
  {
    "id": "esti",
    "name": "ESTI",
    "role": "Estimates & proposals",
    "promise": "Build a clear estimate from the scope, then review the next step.",
    "category": "finance",
    "portrait": "/agent-profiles/esti.webp",
    "workspace": "/estimates",
    "workspaceLabel": "Open estimates",
    "tasks": [
      {
        "title": "Scope & line items",
        "stage": "workspace",
        "reality": "Prepare quantities, prices and line items in the estimate workspace. Your team reviews the scope and totals."
      },
      {
        "title": "Estimate status & follow-up",
        "stage": "workspace",
        "reality": "Track drafts, decisions and follow-up. Changing a status does not itself deliver a proposal or contact a customer."
      },
      {
        "title": "Returning-customer estimates",
        "stage": "workspace",
        "reality": "Prepare new work for an existing customer and property without creating a new acquisition lead."
      },
      {
        "title": "Price books & margin guidance",
        "stage": "workspace",
        "reality": "Keep your own costs and prices per trade in the Price Book. ESTI flags estimate lines below cost or below your target margin and offers a target-meeting price; your team decides."
      }
    ]
  },
  {
    "id": "bill",
    "name": "BILL",
    "role": "Balances & receipts",
    "promise": "Understand what is owed and what has been recorded against it.",
    "category": "finance",
    "portrait": "/agent-profiles/bill.webp",
    "workspace": "/invoices",
    "workspaceLabel": "Review invoice balances",
    "tasks": [
      {
        "title": "Invoice balances",
        "stage": "workspace",
        "reality": "Review issued totals, recorded receipts and the remaining balance in the customer invoice workspace."
      },
      {
        "title": "External receipts & corrections",
        "stage": "workspace",
        "reality": "Authorized staff can record evidenced external receipts and refund corrections. These records do not move money or verify bank settlement."
      },
      {
        "title": "Financial history",
        "stage": "workspace",
        "reality": "Keep issued documents, opening balances and later receipts distinguishable. The Billing page manages GrowthOS subscriptions separately."
      },
      {
        "title": "Card & bank collection",
        "stage": "setup",
        "reality": "Test invoice Checkout in a configured Stripe sandbox. Confirmed test payments are recorded on the invoice; live collection is unavailable and no real money moves."
      }
    ]
  },
  {
    "id": "invo",
    "name": "INVO",
    "role": "Invoice documents & delivery",
    "promise": "Prepare the document, check the details and review delivery.",
    "category": "finance",
    "portrait": "/agent-profiles/invo.webp",
    "workspace": "/invoices",
    "workspaceLabel": "Open invoices",
    "tasks": [
      {
        "title": "Draft & issue invoices",
        "stage": "workspace",
        "reality": "Authorized staff can prepare a draft, review its saved details and issue a customer invoice. Issued document history is retained."
      },
      {
        "title": "Document & customer review",
        "stage": "workspace",
        "reality": "Review the customer, job, line items and issued document before choosing the next action."
      },
      {
        "title": "Invoice email delivery",
        "stage": "setup",
        "reality": "The delivery worklist exposes pending and uncertain attempts. Sending requires an approved mailbox, recipient and company delivery setup; uncertain sends are not retried automatically."
      },
      {
        "title": "Exceptions & audit history",
        "stage": "workspace",
        "reality": "Inspect saved document changes, recorded financial events and delivery exceptions before resolving them."
      }
    ]
  },
  {
    "id": "sched",
    "name": "SCHED",
    "role": "Schedule & dispatch",
    "promise": "Keep visits, assignments and the day’s work in view.",
    "category": "operations",
    "portrait": "/agent-profiles/sched.webp",
    "workspace": "/appointments",
    "workspaceLabel": "Open schedule",
    "tasks": [
      {
        "title": "Visit scheduling",
        "stage": "workspace",
        "reality": "Create and update staff-booked appointments linked to the relevant customer, property and work."
      },
      {
        "title": "Workday coordination",
        "stage": "workspace",
        "reality": "Review scheduled visits and their saved status. Required structured work must be completed through its work record."
      },
      {
        "title": "Change review",
        "stage": "workspace",
        "reality": "Review the current appointment when a change is uncertain; no reschedule is repeated automatically."
      },
      {
        "title": "Route planning & optimization",
        "stage": "workspace",
        "reality": "Each crew member's day shows as a mapped route with estimated miles, a one-tap Maps link and a shorter stop order when one exists. Suggestions never move a booked time; your team decides."
      }
    ]
  },
  {
    "id": "appt",
    "name": "APPT",
    "role": "Bookings & visit details",
    "promise": "Keep the customer, property and next visit connected.",
    "category": "operations",
    "portrait": "/agent-profiles/appt.webp",
    "workspace": "/appointments",
    "workspaceLabel": "Open appointments",
    "tasks": [
      {
        "title": "Staff-confirmed booking",
        "stage": "workspace",
        "reality": "Book and update appointments in GrowthOS after your team confirms the visit."
      },
      {
        "title": "Customer & property details",
        "stage": "workspace",
        "reality": "Choose the property for new manual appointments and keep existing visit history connected to its saved work."
      },
      {
        "title": "Customer confirmations",
        "stage": "setup",
        "reality": "Customer-facing confirmations and reminders require approved delivery setup and consent. A draft or staff booking alone does not send a message."
      },
      {
        "title": "External calendar sync",
        "stage": "planned",
        "reality": "Full external calendar synchronization remains planned; the GrowthOS schedule is the available workspace."
      }
    ]
  },
  {
    "id": "callie",
    "name": "CALLIE",
    "role": "Calls & intake",
    "promise": "Turn a missed call into a clear callback and reviewed next step.",
    "category": "operations",
    "portrait": "/agent-profiles/callie.webp",
    "workspace": "/calls",
    "workspaceLabel": "Open calls",
    "tasks": [
      {
        "title": "Call & callback review",
        "stage": "workspace",
        "reality": "Review call records and callback outcomes, then assign the appropriate staff follow-up."
      },
      {
        "title": "Reviewed opportunity intake",
        "stage": "workspace",
        "reality": "Staff can connect reviewed call details to an opportunity when the customer’s need is confirmed."
      },
      {
        "title": "Keypad or voice intake",
        "stage": "setup",
        "reality": "Company-scoped keypad and voice-only intake need provider setup and real phone acceptance before activation. Neither pilot is live."
      },
      {
        "title": "Approved human handoff",
        "stage": "setup",
        "reality": "A reviewed conversation may attempt one fixed handoff after setup. A phone answer may be voicemail; neither a call nor a handoff confirms a visit or grants general messaging permission."
      }
    ]
  },
  {
    "id": "maintain",
    "name": "MAINTAIN",
    "role": "Warranties & service",
    "promise": "Keep equipment, service dates and required work from being missed.",
    "category": "operations",
    "portrait": "/agent-profiles/maintain.webp",
    "workspace": "/service",
    "workspaceLabel": "Open service desk",
    "tasks": [
      {
        "title": "Service obligations",
        "stage": "workspace",
        "reality": "Track warranty and service dates and create staff follow-up work. These records do not automatically book a technician."
      },
      {
        "title": "Equipment & checklists",
        "stage": "workspace",
        "reality": "Review company equipment and configurable checklists, and keep visit completion evidence with its work record."
      },
      {
        "title": "Standing service work",
        "stage": "workspace",
        "reality": "Manage saved recurring service work and review obligations and visit outcomes without inferring a manufacturer warranty."
      },
      {
        "title": "Customer service reminders",
        "stage": "setup",
        "reality": "Customer reminders require approved company delivery setup and contact consent. Staff follow-up tasks do not send customer reminders themselves."
      }
    ]
  },
  {
    "id": "scout",
    "name": "SCOUT",
    "role": "Pipeline & follow-up",
    "promise": "Find the opportunities that need an owner or a next action.",
    "category": "finance",
    "portrait": "/agent-profiles/scout.webp",
    "workspace": "/bie",
    "workspaceLabel": "Open Revenue Desk",
    "tasks": [
      {
        "title": "Revenue Desk priorities",
        "stage": "workspace",
        "reality": "Review unowned inquiries, overdue follow-up and estimates awaiting a decision, with supporting records."
      },
      {
        "title": "Existing lead recovery",
        "stage": "workspace",
        "reality": "Use reviewed imports, segments and source records to organize opportunities already in the business."
      },
      {
        "title": "Recorded activity & insights",
        "stage": "workspace",
        "reality": "Inspect pipeline and activity reports. Recommendations support a staff decision; they do not prove additional revenue by themselves."
      },
      {
        "title": "Consented outreach",
        "stage": "setup",
        "reality": "Campaign and delivery controls require approved providers, consent and company setup before customer contact. Your team reviews the action."
      }
    ]
  }
];
export const AGENT_STAGE_LABEL: Record<AgentTaskStage, string> = { workspace:'In workspace', setup:'Connection setup', planned:'Planned' };
export interface SpecialistContextInfo { workspace: string; summary: string; ids: readonly string[]; }
const contexts: readonly [string,SpecialistContextInfo][] = [
  [
    "/invoices",
    {
      "workspace": "Invoices",
      "summary": "Documents, balances and recorded receipts, with clear review steps.",
      "ids": [
        "invo",
        "bill"
      ]
    }
  ],
  [
    "/estimates",
    {
      "workspace": "Estimates",
      "summary": "Scope, line items and the next decision on the estimate.",
      "ids": [
        "esti"
      ]
    }
  ],
  [
    "/price-book",
    {
      "workspace": "Price Book",
      "summary": "Your costs, prices and target margins per trade.",
      "ids": [
        "esti"
      ]
    }
  ],
  [
    "/appointments",
    {
      "workspace": "Schedule",
      "summary": "The visit, the right property and the team’s confirmed plan.",
      "ids": [
        "sched",
        "appt"
      ]
    }
  ],
  [
    "/service",
    {
      "workspace": "Service",
      "summary": "Equipment, checklists and the service work that needs attention.",
      "ids": [
        "maintain"
      ]
    }
  ],
  [
    "/calls",
    {
      "workspace": "Calls",
      "summary": "Review the call, assign the callback and confirm the next step.",
      "ids": [
        "callie"
      ]
    }
  ],
  [
    "/projects",
    {
      "workspace": "Jobs",
      "summary": "Keep the job and its upcoming work connected.",
      "ids": [
        "sched",
        "esti"
      ]
    }
  ],
  [
    "/contacts",
    {
      "workspace": "Customers",
      "summary": "Keep customer history and new work connected to the right record.",
      "ids": [
        "appt",
        "esti"
      ]
    }
  ],
  [
    "/properties",
    {
      "workspace": "Properties",
      "summary": "Connect the right property to the next estimate or visit.",
      "ids": [
        "appt"
      ]
    }
  ],
  [
    "/pipeline",
    {
      "workspace": "Pipeline",
      "summary": "Keep an owner and a clear next action on each opportunity.",
      "ids": [
        "scout"
      ]
    }
  ],
  [
    "/leads",
    {
      "workspace": "Opportunities",
      "summary": "Review the opportunity and choose the next staff action.",
      "ids": [
        "scout"
      ]
    }
  ],
  [
    "/reactivation",
    {
      "workspace": "Win-back",
      "summary": "Review existing opportunities and consent before outreach.",
      "ids": [
        "scout"
      ]
    }
  ],
  [
    "/bie",
    {
      "workspace": "Revenue Desk",
      "summary": "Start with the opportunities that need attention today.",
      "ids": [
        "scout"
      ]
    }
  ],
  [
    "/tasks",
    {
      "workspace": "Tasks",
      "summary": "Keep follow-up owned and tied to the relevant customer work.",
      "ids": [
        "scout"
      ]
    }
  ],
  [
    "/today",
    {
      "workspace": "Today",
      "summary": "Review the next visit, follow-up and customer decision.",
      "ids": [
        "scout",
        "sched"
      ]
    }
  ],
  [
    "/",
    {
      "workspace": "Today",
      "summary": "Review the next visit, follow-up and customer decision.",
      "ids": [
        "scout",
        "sched"
      ]
    }
  ]
];
/** Exact segment matching; guides never interpret a query as a route or action. */
export function specialistContextFor(location: string): SpecialistContextInfo | null {
  const pathname=location.split(/[?#]/,1)[0];
  return contexts.find(([p])=>pathname===p || (p!=='/' && pathname.startsWith(p+'/')))?.[1] ?? null;
}
