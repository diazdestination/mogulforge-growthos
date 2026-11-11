import type { UserRole } from "@workspace/api-client-react";
import {
  BadgeDollarSign,
  BookOpen,
  Bot,
  Building,
  CalendarDays,
  CheckSquare,
  ClipboardList,
  CreditCard,
  FileSearch2,
  FileText,
  HardHat,
  Home,
  LayoutDashboard,
  PhoneCall,
  ReceiptText,
  RotateCcw,
  Settings2,
  Shield,
  Smartphone,
  Sparkles,
  TrendingUp,
  Trello,
  UserRound,
  Users,
  Webhook,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import {
  canManageSettings,
  canReadInvoices,
  canViewAuditLog,
  isFieldRole,
} from "./permissions";

export type NavigationGroup =
  "Daily work" | "Customers & Jobs" | "More tools" | "Administration";
export interface ContractorNavigationItem {
  title: string;
  shortTitle?: string;
  href: string;
  icon: LucideIcon;
  group: NavigationGroup;
  keywords: string;
  matches?: string[];
  access?: "settings" | "audit" | "platform" | "invoices" | "field";
}

const items: ContractorNavigationItem[] = [
  {
    title: "Today",
    href: "/",
    icon: CalendarDays,
    group: "Daily work",
    keywords: "home daily assigned due appointments",
    matches: ["/", "/today"],
  },
  {
    title: "My day",
    href: "/tech",
    icon: Smartphone,
    group: "Daily work",
    keywords: "tech field my jobs on my way directions collect payment phone",
    access: "field",
  },
  {
    title: "Customers & Jobs",
    shortTitle: "Customers",
    href: "/contacts",
    icon: Users,
    group: "Daily work",
    keywords:
      "clients contacts customers jobs projects properties estimates leads",
    matches: [
      "/contacts",
      "/projects",
      "/properties",
      "/estimates",
      "/price-book",
      "/pipeline",
      "/leads",
    ],
  },
  {
    title: "Schedule",
    href: "/appointments",
    icon: CalendarDays,
    group: "Daily work",
    keywords: "appointments calendar inspections meetings booking",
  },
  {
    title: "Invoices",
    href: "/invoices",
    icon: ReceiptText,
    group: "Daily work",
    keywords: "customer invoice balance payment receipts",
    access: "invoices",
  },
  {
    title: "Warranties & Service",
    shortTitle: "Service",
    href: "/service",
    icon: Wrench,
    group: "Daily work",
    keywords: "warranty maintenance service plans equipment",
  },
  {
    title: "Customers",
    href: "/contacts",
    icon: Users,
    group: "Customers & Jobs",
    keywords: "people contacts clients directory",
  },
  {
    title: "Jobs",
    href: "/projects",
    icon: HardHat,
    group: "Customers & Jobs",
    keywords: "projects production crew work",
  },
  {
    title: "Leads",
    href: "/pipeline",
    icon: Trello,
    group: "Customers & Jobs",
    keywords: "pipeline opportunities kanban",
  },
  {
    title: "Estimates",
    href: "/estimates",
    icon: FileText,
    group: "Customers & Jobs",
    keywords: "quotes proposals",
  },
  {
    title: "Price Book",
    href: "/price-book",
    icon: BookOpen,
    group: "Customers & Jobs",
    keywords: "pricing catalog materials labor cost margin",
  },
  {
    title: "Properties",
    href: "/properties",
    icon: Home,
    group: "Customers & Jobs",
    keywords: "addresses buildings",
  },
  {
    title: "Tasks",
    href: "/tasks",
    icon: CheckSquare,
    group: "More tools",
    keywords: "todo follow up assigned",
  },
  {
    title: "Calls",
    href: "/calls",
    icon: PhoneCall,
    group: "More tools",
    keywords: "phone missed calls",
  },
  {
    title: "Follow-up center",
    href: "/bie",
    icon: Bot,
    group: "More tools",
    keywords: "bie command revenue recovery agents autopilot intelligence",
  },
  {
    title: "Specialists",
    href: "/agent-team",
    icon: Users,
    group: "More tools",
    keywords: "agents roles specialists guides esti bill invo sched appt callie maintain scout",
  },
  {
    title: "Photos & documents",
    href: "/evidence",
    icon: FileSearch2,
    group: "More tools",
    keywords: "evidence intelligence claims proof photos documents",
  },
  {
    title: "Assistant",
    href: "/assistant",
    icon: Sparkles,
    group: "More tools",
    keywords: "ai chat help",
  },
  {
    title: "Reconnect with customers",
    href: "/reactivation",
    icon: RotateCcw,
    group: "More tools",
    keywords: "win-back reactivation campaigns",
  },
  {
    title: "Business trends",
    href: "/insights",
    icon: TrendingUp,
    group: "More tools",
    keywords: "insights analytics metrics",
  },
  {
    title: "Revenue report",
    href: "/reports",
    icon: BadgeDollarSign,
    group: "More tools",
    keywords: "roi revenue attribution reporting money",
  },
  {
    title: "Business overview",
    href: "/dashboard",
    icon: LayoutDashboard,
    group: "More tools",
    keywords: "dashboard overview summary operations",
  },
  {
    title: "Lead Capture",
    href: "/capture",
    icon: Webhook,
    group: "Administration",
    keywords: "website forms widget",
  },
  {
    title: "Client Launchpad",
    href: "/platform",
    icon: Building,
    group: "Administration",
    keywords: "client onboarding setup",
    access: "platform",
  },
  {
    title: "Forms",
    href: "/forms",
    icon: ClipboardList,
    group: "Administration",
    keywords: "form builder",
    access: "settings",
  },
  {
    title: "Audit Log",
    href: "/audit",
    icon: Shield,
    group: "Administration",
    keywords: "history security",
    access: "audit",
  },
  {
    title: "Settings",
    href: "/settings",
    icon: Settings2,
    group: "Administration",
    keywords: "configuration preferences",
    access: "settings",
  },
  {
    title: "Subscription",
    href: "/billing",
    icon: CreditCard,
    group: "Administration",
    keywords: "growthos plan subscription billing",
    access: "settings",
  },
  {
    title: "My Profile",
    href: "/account",
    icon: UserRound,
    group: "Administration",
    keywords: "account profile connections",
  },
];

export function contractorNavigation({
  role,
  isPlatformAdmin = false,
  showSetup = false,
}: {
  role?: UserRole | null;
  isPlatformAdmin?: boolean;
  showSetup?: boolean;
}): ContractorNavigationItem[] {
  const visible = items.filter((item) => {
    if (item.access === "platform") return isPlatformAdmin;
    if (item.access === "settings") return canManageSettings(role);
    if (item.access === "audit") return canViewAuditLog(role);
    if (item.access === "invoices") return canReadInvoices(role);
    if (item.access === "field") return isFieldRole(role);
    return true;
  });
  if (showSetup && canManageSettings(role))
    visible.push({
      title: "Setup",
      href: "/onboarding",
      icon: Sparkles,
      group: "Administration",
      keywords: "onboarding launch setup",
    });
  return visible;
}

export function navigationIsActive(
  item: ContractorNavigationItem,
  location: string,
): boolean {
  const path = location.split("?")[0].replace(/\/$/, "") || "/";
  return (item.matches ?? [item.href]).some(
    (prefix) =>
      path === prefix || (prefix !== "/" && path.startsWith(`${prefix}/`)),
  );
}
