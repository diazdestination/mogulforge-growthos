import { Link, useLocation } from "wouter";
import { useEffect, useState } from "react";
import { useAuth } from "@workspace/replit-auth-web";
import {
  useGetMe,
  useGetSession,
  useGetOnboarding,
  getGetOnboardingQueryKey,
  type UserRole,
} from "@workspace/api-client-react";
import { ChevronDown, LogOut, Menu, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { canManageSettings } from "@/lib/permissions";
import {
  contractorNavigation,
  navigationIsActive,
  type ContractorNavigationItem,
} from "@/lib/contractor-navigation";
import { CLIENT } from "@/lib/client.config";
import { CommandPalette } from "./command-palette";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetTrigger,
} from "./ui/sheet";

export function Shell({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { logout } = useAuth();
  const { data: session } = useGetSession();
  const { data: profile } = useGetMe();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  useEffect(() => {
    window.scrollTo(0, 0);
    setIsMobileMenuOpen(false);
  }, [location]);

  const role = profile?.role as UserRole | undefined;
  const brandName = profile?.organization?.name || CLIENT.businessShortName;
  const canSetup = canManageSettings(role);
  const { data: onboarding } = useGetOnboarding({
    query: {
      queryKey: getGetOnboardingQueryKey(),
      enabled: canSetup,
      staleTime: 60_000,
    },
  });
  const showSetup =
    canSetup &&
    !!onboarding?.state &&
    !onboarding.state.completedAt &&
    !onboarding.state.dismissedAt;
  const items = contractorNavigation({
    role,
    isPlatformAdmin: session?.isPlatformAdmin === true,
    showSetup,
  });
  const daily = items.filter((item) => item.group === "Daily work");
  const customerTabs = items.filter(
    (item) => item.group === "Customers & Jobs",
  );
  const customersActive = daily.some(
    (item) => item.href === "/contacts" && navigationIsActive(item, location),
  );
  const bottomItems = daily.slice(0, 4);
  const openSearch = () => window.dispatchEvent(new Event("mogulforge:cmdk"));

  function navLinks(links: ContractorNavigationItem[], mobile = false) {
    return links.map((item) => {
      const active = navigationIsActive(item, location);
      return (
        <Link
          key={`${item.group}:${item.href}`}
          href={item.href}
          aria-current={active ? "page" : undefined}
          onClick={() => setIsMobileMenuOpen(false)}
          className={cn(
            "flex min-h-11 items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            mobile
              ? active
                ? "bg-accent text-accent-foreground"
                : "text-foreground hover:bg-muted"
              : active
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-sidebar-foreground/85 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
          )}
        >
          <item.icon className="h-4 w-4 shrink-0" aria-hidden />
          <span>{item.title}</span>
        </Link>
      );
    });
  }

  function groupedNavigation(mobile = false) {
    return (
      <>
        <nav
          aria-label={mobile ? "Mobile daily work" : "Daily work"}
          className="space-y-1"
        >
          {navLinks(daily, mobile)}
        </nav>
        {(["More tools", "Administration"] as const).map((group) => {
          const links = items.filter((item) => item.group === group);
          if (!links.length) return null;
          return (
            <details
              key={group}
              open={
                links.some((item) => navigationIsActive(item, location)) ||
                undefined
              }
              className="group mt-5 border-t border-current/15 pt-3"
            >
              <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between rounded-lg px-3 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                {group}
                <ChevronDown
                  className="h-4 w-4 transition-transform group-open:rotate-180"
                  aria-hidden
                />
              </summary>
              <nav
                aria-label={`${mobile ? "Mobile " : ""}${group}`}
                className="mt-1 space-y-1"
              >
                {navLinks(links, mobile)}
              </nav>
            </details>
          );
        })}
      </>
    );
  }

  return (
    <Sheet open={isMobileMenuOpen} onOpenChange={setIsMobileMenuOpen}>
      <div className="flex min-h-[100dvh] w-full flex-col bg-background md:flex-row">
        <a
          href="#main-content"
          className="sr-only z-[100] rounded bg-background p-3 text-foreground focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
        >
          Skip to content
        </a>
        <CommandPalette items={items} />
        <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex">
          <div className="flex h-16 shrink-0 items-center gap-3 border-b border-sidebar-border px-5">
            <div
              aria-hidden
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-sidebar-primary font-bold text-sidebar-primary-foreground"
            >
              {brandName.charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-bold">{brandName}</div>
              <div className="text-xs text-sidebar-foreground/80">GrowthOS</div>
            </div>
          </div>
          <div className="px-3 pt-3">
            <button
              onClick={openSearch}
              className="flex min-h-11 w-full items-center gap-2 rounded-lg border border-sidebar-border px-3 text-sm text-sidebar-foreground/85 hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Search className="h-4 w-4" aria-hidden />
              <span>Find a page…</span>
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-3 py-4">
            {groupedNavigation()}
          </div>
          <div className="border-t border-sidebar-border p-3">
            {profile && (
              <Link
                href="/account"
                className="mb-2 block min-w-0 rounded-lg px-3 py-2 text-sm hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="block truncate font-medium">
                  {[profile.firstName, profile.lastName]
                    .filter(Boolean)
                    .join(" ") || profile.email}
                </span>
                <span className="block text-xs capitalize text-sidebar-foreground/80">
                  {profile.role.replaceAll("_", " ")}
                </span>
              </Link>
            )}
            <button
              onClick={logout}
              className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm text-sidebar-foreground/85 hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <LogOut className="h-4 w-4" aria-hidden />
              Sign Out
            </button>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="sticky top-0 z-30 flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border bg-card px-4 md:hidden">
            <div className="min-w-0 truncate text-sm font-bold">
              {brandName}
            </div>
            <button
              type="button"
              onClick={openSearch}
              aria-label="Find a page"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Search className="h-5 w-5" aria-hidden />
            </button>
          </div>
          {customersActive && (
            <nav
              aria-label="Customers and jobs sections"
              className="flex shrink-0 gap-1 overflow-x-auto border-b border-border bg-card px-4 py-2 md:px-6"
            >
              {customerTabs.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={
                    navigationIsActive(item, location) ? "page" : undefined
                  }
                  className={cn(
                    "min-h-11 shrink-0 rounded-lg px-3 py-2.5 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    navigationIsActive(item, location)
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  {item.title}
                </Link>
              ))}
            </nav>
          )}
          <main
            id="main-content"
            tabIndex={-1}
            className="relative z-0 flex min-w-0 flex-1 flex-col pb-16 focus:outline-none md:pb-0"
          >
            {children}
          </main>
        </div>

        <nav
          aria-label="Quick navigation"
          className="fixed inset-x-0 bottom-0 z-40 flex h-16 items-center justify-around border-t border-border bg-card px-1 pb-safe md:hidden"
        >
          {bottomItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-label={item.title}
              aria-current={
                navigationIsActive(item, location) ? "page" : undefined
              }
              className={cn(
                "flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-lg px-1 text-[11px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                navigationIsActive(item, location)
                  ? "text-primary dark:text-foreground"
                  : "text-muted-foreground",
              )}
            >
              <item.icon className="h-5 w-5" aria-hidden />
              <span>{item.shortTitle ?? item.title}</span>
            </Link>
          ))}
          <SheetTrigger asChild>
            <button
              type="button"
              className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-lg text-[11px] font-medium text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Menu className="h-5 w-5" aria-hidden />
              <span>Menu</span>
            </button>
          </SheetTrigger>
        </nav>
        <SheetContent
          side="right"
          closeLabel="Close menu"
          className="flex w-full max-w-full flex-col p-0 sm:max-w-sm"
        >
          <SheetHeader className="border-b border-border p-5 pr-12 text-left">
            <SheetTitle>{brandName}</SheetTitle>
            <SheetDescription>Daily work and workspace tools</SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto p-4">
            {groupedNavigation(true)}
          </div>
          <div className="border-t border-border p-4">
            <button
              onClick={logout}
              className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <LogOut className="h-4 w-4" aria-hidden />
              Sign Out
            </button>
          </div>
        </SheetContent>
      </div>
    </Sheet>
  );
}
