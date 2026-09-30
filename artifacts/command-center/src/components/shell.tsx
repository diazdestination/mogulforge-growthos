import { type LucideIcon } from 'lucide-react';
import { Link, useLocation } from 'wouter';
import { cn } from '@/lib/utils';
import { useAuth } from '@workspace/replit-auth-web';
import { useGetMe, useGetSession, useGetOnboarding, getGetOnboardingQueryKey, UserRole } from '@workspace/api-client-react';
import {
  LayoutDashboard,
  Trello,
  Users,
  Home,
  CheckSquare,
  Calendar,
  ClipboardList,
  Shield,
  FileText,
  HardHat,
  LogOut,
  Building,
  Settings2,
  Menu,
  X,
  Sparkles,
  TrendingUp,
  BadgeDollarSign,
  RotateCcw,
  Webhook,
  CreditCard,
  Search,
  Bot,
  FileSearch2,
  UserRound,
  Wrench,
  PhoneCall,
} from 'lucide-react';
import { canManageSettings, canViewAuditLog } from '@/lib/permissions';
import { CLIENT } from '@/lib/client.config';
import { CommandPalette } from './command-palette';
import { useEffect, useState } from 'react';

interface NavItem {
  title: string;
  href: string;
  icon: LucideIcon;
  requireAudit?: boolean;
  requireSettings?: boolean;
  requirePlatform?: boolean;
}

const navItems: NavItem[] = [
  { title: 'BIE Command', href: '/', icon: Bot },
  { title: 'Agent team', href: '/agent-team', icon: Users },
  { title: 'Evidence Intelligence', href: '/evidence', icon: FileSearch2 },
  { title: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { title: 'Assistant', href: '/assistant', icon: Sparkles },
  { title: 'Pipeline', href: '/pipeline', icon: Trello },
  { title: 'Insights', href: '/insights', icon: TrendingUp },
  { title: 'ROI Report', href: '/reports', icon: BadgeDollarSign },
  { title: 'Contacts', href: '/contacts', icon: Users },
  { title: 'Properties', href: '/properties', icon: Home },
  { title: 'Estimates', href: '/estimates', icon: FileText },
  { title: 'Projects', href: '/projects', icon: HardHat },
  { title: 'Tasks', href: '/tasks', icon: CheckSquare },
  { title: 'Appointments', href: '/appointments', icon: Calendar },
  { title: 'Service Desk', href: '/service', icon: Wrench },
  { title: 'Calls', href: '/calls', icon: PhoneCall },
  { title: 'Win-back', href: '/reactivation', icon: RotateCcw },
  { title: 'Lead Capture', href: '/capture', icon: Webhook },
  { title: 'Client Launchpad', href: '/platform', icon: Building, requirePlatform: true },
  { title: 'Forms', href: '/forms', icon: ClipboardList, requireSettings: true },
  { title: 'Audit Log', href: '/audit', icon: Shield, requireAudit: true },
  { title: 'My Profile', href: '/account', icon: UserRound },
  { title: 'Settings', href: '/settings', icon: Settings2, requireSettings: true },
  { title: 'Billing', href: '/billing', icon: CreditCard, requireSettings: true },
];

/** Org display name from live org config, with build-time fallback. */
function useBrandName(): string {
  const { data: profile } = useGetMe();
  return profile?.organization?.name || CLIENT.businessShortName;
}

export function Shell({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { logout } = useAuth();
  const { data: session } = useGetSession();
  const { data: profile } = useGetMe();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  // Scroll to the top of the page on every navigation.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location]);

  const role = profile?.role as UserRole | undefined;
  const brandName = useBrandName();
  const brandInitial = brandName.charAt(0).toUpperCase();

  // Surface the guided setup wizard until the org launches or dismisses it.
  const canSetup = canManageSettings(role);
  const { data: onboarding } = useGetOnboarding({
    query: { queryKey: getGetOnboardingQueryKey(), enabled: canSetup, staleTime: 60_000 },
  });
  const showSetup =
    canSetup &&
    !!onboarding?.state &&
    !onboarding.state.completedAt &&
    !onboarding.state.dismissedAt;

  const visibleItems = [
    ...(showSetup
      ? [{ title: 'Setup', href: '/onboarding', icon: Sparkles } as NavItem]
      : []),
    ...navItems,
  ].filter((item) => {
    if (item.requirePlatform && session?.isPlatformAdmin !== true) return false;
    if (item.requireAudit && !canViewAuditLog(role)) {
      return false;
    }
    if (item.requireSettings && !canManageSettings(role)) {
      return false;
    }
    return true;
  });

  // Mobile Bottom Nav items
  const bottomNavItems = [
    visibleItems.find(i => i.href === '/') || visibleItems[0],
    visibleItems.find(i => i.href === '/pipeline'),
    visibleItems.find(i => i.href === '/appointments'),
    visibleItems.find(i => i.href === '/tasks')
  ].filter(Boolean) as NavItem[];

  return (
    <div className="flex min-h-[100dvh] w-full bg-background flex-col md:flex-row">
      <CommandPalette />
      {/* Desktop Sidebar */}
      <aside className="hidden md:flex w-64 bg-sidebar border-r border-sidebar-border flex-col shrink-0">
        <div className="h-16 flex items-center px-6 border-b border-sidebar-border shrink-0">
          <div className="flex items-center gap-3 text-sidebar-foreground">
            <div className="w-8 h-8 rounded bg-sidebar-primary flex items-center justify-center font-bold text-sidebar-primary-foreground shadow-sm shadow-sidebar-primary/20">
              {brandInitial}
            </div>
            <div>
              <div className="font-bold text-sm tracking-tight leading-none">{brandName}</div>
              <div className="text-[10px] text-sidebar-foreground/70 uppercase tracking-widest font-mono mt-1">
                Command Center
              </div>
            </div>
          </div>
        </div>
        
        <div className="px-3 pt-3">
          <button
            onClick={() => window.dispatchEvent(new Event('mogulforge:cmdk'))}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg border border-sidebar-border text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent/40 transition-colors text-sm"
          >
            <Search className="w-4 h-4" />
            <span className="flex-1 text-left">Search…</span>
            <kbd className="text-[10px] font-mono border border-sidebar-border rounded px-1.5 py-0.5">⌘K</kbd>
          </button>
        </div>

        <div className="flex-1 py-4 overflow-y-auto">
          <nav className="px-3 space-y-1.5">
            {visibleItems.map((item) => {
              const isActive = location === item.href || (item.href !== '/' && location.startsWith(item.href));
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2.5 text-sm rounded-lg transition-all font-medium",
                    isActive 
                      ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-sm" 
                      : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                  )}
                >
                  <item.icon className={cn("w-4 h-4", isActive ? "text-sidebar-primary" : "")} />
                  {item.title}
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="p-4 border-t border-sidebar-border mt-auto">
          {profile && (
            <Link
              href="/account"
              className="mb-4 block rounded-lg px-2 py-1.5 hover:bg-sidebar-accent/50 transition-colors"
              title="Edit your profile"
            >
              <div className="flex items-center gap-2 mb-1 text-sidebar-foreground">
                <Building className="w-3 h-3 opacity-70" />
                <span className="text-xs font-semibold truncate">{profile.organization?.name || 'Loading Org...'}</span>
              </div>
              <div className="text-[11px] font-mono text-sidebar-foreground/50 truncate">
                {[profile.firstName, profile.lastName].filter(Boolean).join(' ') || profile.email} • {profile.role}
              </div>
            </Link>
          )}
          <button
            onClick={logout}
            className="w-full flex items-center gap-3 px-3 py-2 text-sm rounded-lg text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground transition-all font-medium text-left"
          >
            <LogOut className="w-4 h-4" />
            Sign Out
          </button>
        </div>
      </aside>

      {/* Mobile Top Bar */}
      <div className="md:hidden h-14 flex items-center justify-between px-4 border-b border-border bg-card shrink-0 sticky top-0 z-30">
        <div className="flex items-center gap-2 text-foreground">
          <div className="w-7 h-7 rounded bg-primary flex items-center justify-center font-bold text-primary-foreground shadow-sm shadow-primary/20 text-xs">
            {brandInitial}
          </div>
          <div className="font-bold text-sm tracking-tight leading-none">{brandName}</div>
        </div>
        {profile && (
           <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest bg-muted px-2 py-1 rounded-md">
             {profile.role.replace('_', ' ')}
           </div>
        )}
      </div>

      <main className="flex-1 flex flex-col min-w-0 overflow-hidden pb-16 md:pb-0 relative z-0">
        {children}
      </main>

      {/* Mobile Bottom Nav */}
      <div className="md:hidden fixed bottom-0 left-0 right-0 h-16 bg-card border-t border-border flex items-center justify-around px-2 pb-safe z-40">
        {bottomNavItems.map((item) => {
          const isActive = location === item.href || (item.href !== '/' && location.startsWith(item.href));
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex flex-col items-center justify-center w-16 h-full gap-1 rounded-lg transition-colors active:scale-95",
                isActive ? "text-primary" : "text-muted-foreground"
              )}
            >
              <item.icon className={cn("w-5 h-5", isActive ? "fill-primary/10" : "")} />
              <span className="text-[10px] font-medium tracking-tight">{item.title}</span>
            </Link>
          );
        })}
        <button
          onClick={() => setIsMobileMenuOpen(true)}
          className={cn(
            "flex flex-col items-center justify-center w-16 h-full gap-1 rounded-lg transition-colors active:scale-95",
            isMobileMenuOpen ? "text-primary" : "text-muted-foreground"
          )}
        >
          <Menu className="w-5 h-5" />
          <span className="text-[10px] font-medium tracking-tight">Menu</span>
        </button>
      </div>

      {/* Mobile Full Menu Drawer */}
      {isMobileMenuOpen && (
        <div className="md:hidden fixed inset-0 z-50 flex flex-col bg-background/95 backdrop-blur-sm animate-in fade-in slide-in-from-bottom-4">
          <div className="flex items-center justify-between p-4 border-b border-border bg-card">
            <div className="flex items-center gap-3">
               <div className="w-8 h-8 rounded bg-primary flex items-center justify-center font-bold text-primary-foreground shadow-sm shadow-primary/20 text-sm">
                {brandInitial}
              </div>
              <div>
                <div className="font-bold text-sm tracking-tight leading-none text-foreground">{brandName}</div>
                {profile && <div className="text-[10px] text-muted-foreground font-mono mt-1">{profile.organization?.name}</div>}
              </div>
            </div>
            <button 
              onClick={() => setIsMobileMenuOpen(false)}
              aria-label="Close menu"
              className="w-10 h-10 flex items-center justify-center rounded-full bg-muted text-muted-foreground hover:bg-muted/80 active:scale-95"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-2">
            {visibleItems.map((item) => {
              const isActive = location === item.href || (item.href !== '/' && location.startsWith(item.href));
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setIsMobileMenuOpen(false)}
                  className={cn(
                    "flex items-center gap-4 p-4 rounded-xl transition-colors font-medium text-base",
                    isActive 
                      ? "bg-primary/10 text-primary border border-primary/20" 
                      : "bg-card text-foreground border border-border active:bg-muted"
                  )}
                >
                  <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center", isActive ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>
                    <item.icon className="w-4 h-4" />
                  </div>
                  {item.title}
                </Link>
              );
            })}
          </div>
          <div className="p-4 border-t border-border bg-card pb-safe">
            <button
              onClick={logout}
              className="w-full flex items-center justify-center gap-3 p-4 rounded-xl bg-muted text-muted-foreground font-medium border border-border active:bg-muted/80"
            >
              <LogOut className="w-5 h-5" />
              Sign Out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
