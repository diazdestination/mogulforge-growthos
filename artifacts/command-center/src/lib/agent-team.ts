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
        "title": "Customer approval & signature",
        "stage": "workspace",
        "reality": "Share a secure approval link for an estimate, or include it in the reviewed estimate email. The customer reviews it, signs and approves or declines; the signed record and estimate status update together. Creating a link or changing a status does not contact the customer; your team shares the link, emails it with the estimate, or requests a text that waits for approval. A draft can also be emailed, without the approval link, from your own Gmail or Outlook connected through Zapier, after your approval."
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
        "reality": "Invoice Checkout on your own Stripe account (test mode by default; live once your deployment is switched and Stripe setup is finished in Settings). On the job, a tech can create the pay link for an invoice linked to their own assigned job, show it as a QR code, or text it from your own business number through Zapier to a customer who agreed to texts (sent on the tech's tap, or after office approval if you choose Approve each). Confirmed payments are recorded on the invoice; refunds and disputes are flagged for office review. In test mode no real money moves."
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
        "reality": "Authorized staff can prepare a draft, review the customer, job and line items, and issue a customer invoice. Issued document history is retained."
      },
      {
        "title": "Accounting export",
        "stage": "setup",
        "reality": "Send an issued invoice, and each payment recorded against it, to QuickBooks Online or Xero through your own Zapier connection. Drafts are never exported. The connection starts switched off; with approval on, an authorized staff member approves each export."
      },
      {
        "title": "Invoice email delivery",
        "stage": "setup",
        "reality": "Each invoice keeps its delivery history, and the delivery worklist shows failed, pending and uncertain attempts. Sending requires an approved mailbox, a previewed recipient and company delivery setup; uncertain sends are not retried automatically. You can instead email an issued invoice from your own Gmail or Outlook through Zapier; each invoice uses one path, not both."
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
        "reality": "Review each day's visits with their working windows, assigned crew and saved status. Required structured work is completed through its work record, and an uncertain change is never repeated automatically."
      },
      {
        "title": "Crew day sheets",
        "stage": "setup",
        "reality": "Text a crew member their day's stops from your own business number through Zapier. Each crew member's number is saved on the connection, and the text waits for staff approval unless an owner switches the connection to automatic."
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
        "reality": "Appointment reminders go by email, or by text to customers who agreed to texts: through GrowthOS texting, or from your own business number once your phone app is connected through Zapier. From My day, a tech can also request one On My Way text per job per day with an ETA; Settings recommends sending it on the tech's tap (Automatic); choose Approve each to have the office approve it first. A draft or staff booking alone does not send a message, and other business-number texts wait for staff approval unless an owner switches that connection to automatic."
      },
      {
        "title": "Add bookings to your calendar",
        "stage": "setup",
        "reality": "From Settings → Connections, request a calendar event for a booked appointment through your own Google or Outlook account connected with Zapier. This flow supports event creation only; reschedules, cancellations and changes made in the outside calendar do not sync, so the GrowthOS schedule stays the source of truth."
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
        "reality": "Review call records and callback outcomes, assign staff follow-up, and connect reviewed call details to an opportunity once the customer’s need is confirmed. With your phone app connected through Zapier, customer text replies are logged for follow-up and STOP replies stop GrowthOS texts to that number."
      },
      {
        "title": "Missed-call callbacks",
        "stage": "setup",
        "reality": "With your phone system (Quo or CallRail) connected through Zapier, each missed call becomes a high-priority callback task with the caller’s name and number. An optional text-back from your business number waits for staff review; without that connection no text is sent."
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
        "reality": "Record installed equipment at each customer property with its install date and warranty terms, use configurable checklists, and keep visit completion evidence with its work record."
      },
      {
        "title": "Standing service work",
        "stage": "workspace",
        "reality": "Manage saved recurring service work and review obligations and visit outcomes without inferring a manufacturer warranty."
      },
      {
        "title": "Customer service reminders",
        "stage": "setup",
        "reality": "A due service can get one reminder by email or text to customers who agreed to it, including a text from your own business number through Zapier. Staff follow-up tasks do not send customer reminders themselves. Replies and STOP messages to GrowthOS texting are recorded automatically; replies to a text from your own number arrive in your phone app, so record an opt-out on the customer and later reminders are refused."
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
        "title": "Today & Revenue Desk priorities",
        "stage": "workspace",
        "reality": "Today ranks one next action per opportunity, such as following up an estimate awaiting the customer’s answer or checking in on a quiet lead, and records what your team did with it. The Revenue Desk groups unowned inquiries, overdue follow-up and stalled estimates. Recommendations support a staff decision and send nothing."
      },
      {
        "title": "Existing lead recovery",
        "stage": "workspace",
        "reality": "Use reviewed imports, segments and source records to organize opportunities already in the business."
      },
      {
        "title": "Marketplace leads & reviews",
        "stage": "setup",
        "reality": "Through Zapier, new leads from Facebook Lead Ads, Housecall Pro or Jobber become opportunities once each, and new Google or Facebook reviews become follow-up tasks, with one- and two-star reviews marked high priority. Customer email replies from a mailbox connected through Zapier are logged on the customer record with a follow-up task; mail from unknown senders is ignored. SCOUT only reads these connections; it never posts a review reply."
      },
      {
        "title": "Consented outreach",
        "stage": "setup",
        "reality": "Campaign and delivery controls require approved providers, consent and company setup before customer contact. Your team reviews the action. A review request can be texted from your own number once per finished visit or job, only to customers who agreed to texts."
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
