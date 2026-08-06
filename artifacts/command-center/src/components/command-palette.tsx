import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { useAuth } from '@workspace/replit-auth-web';
import {
  type LucideIcon,
  LayoutDashboard,
  Sparkles,
  Trello,
  TrendingUp,
  BadgeDollarSign,
  Users,
  Home,
  FileText,
  HardHat,
  CheckSquare,
  Calendar,
  RotateCcw,
  Webhook,
  ClipboardList,
  Shield,
  Settings2,
  CreditCard,
  Search,
  CornerDownLeft,
  LogOut,
  Command as CommandIcon,
  Bot,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface CmdItem {
  id: string;
  label: string;
  hint?: string;
  icon: LucideIcon;
  group: 'Navigate' | 'Actions';
  keywords?: string;
  run: (ctx: {
    navigate: (href: string) => void;
    logout: () => void;
  }) => void | Promise<void>;
}

const nav = (href: string, label: string, icon: LucideIcon, keywords = ''): CmdItem => ({
  id: `nav:${href}`,
  label,
  hint: href,
  icon,
  group: 'Navigate',
  keywords,
  run: ({ navigate }) => navigate(href),
});

const ITEMS: CmdItem[] = [
  nav('/', 'BIE Revenue Command', Bot, 'growthos revenue recovery agents autopilot home'),
  nav('/dashboard', 'Dashboard', LayoutDashboard, 'overview operations'),
  nav('/assistant', 'Assistant', Sparkles, 'ai chat'),
  nav('/pipeline', 'Pipeline', Trello, 'board kanban leads deals'),
  nav('/insights', 'Insights', TrendingUp, 'analytics metrics'),
  nav('/reports', 'ROI Report', BadgeDollarSign, 'revenue attribution money'),
  nav('/contacts', 'Contacts', Users, 'people customers'),
  nav('/properties', 'Properties', Home, 'addresses'),
  nav('/estimates', 'Estimates', FileText, 'quotes proposals'),
  nav('/projects', 'Projects', HardHat, 'jobs work'),
  nav('/tasks', 'Tasks', CheckSquare, 'todo'),
  nav('/appointments', 'Appointments', Calendar, 'schedule calendar'),
  nav('/reactivation', 'Win-back', RotateCcw, 'reactivation campaigns'),
  nav('/capture', 'Lead Capture', Webhook, 'widget forms'),
  nav('/forms', 'Forms', ClipboardList, 'form builder'),
  nav('/audit', 'Audit Log', Shield, 'history security'),
  nav('/settings', 'Settings', Settings2, 'config preferences'),
  nav('/billing', 'Billing', CreditCard, 'subscription payment stripe plan'),
  {
    id: 'action:demo',
    label: 'Load sample data',
    hint: 'Seed the pipeline',
    icon: Sparkles,
    group: 'Actions',
    keywords: 'demo seed example populate',
    run: async ({ navigate }) => {
      const r = await fetch('/api/v1/demo-data', {
        method: 'POST',
        credentials: 'include',
      });
      if (r.ok) {
        navigate('/');
        window.location.reload();
      }
    },
  },
  {
    id: 'action:signout',
    label: 'Sign out',
    icon: LogOut,
    group: 'Actions',
    keywords: 'logout leave exit',
    run: ({ logout }) => logout(),
  },
];

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [, setLocation] = useLocation();
  const { logout } = useAuth();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Global ⌘K / Ctrl+K to toggle.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Allow a click trigger (e.g. the sidebar search button) to open it.
  useEffect(() => {
    function openIt() {
      setOpen(true);
    }
    window.addEventListener('mogulforge:cmdk', openIt as EventListener);
    return () => window.removeEventListener('mogulforge:cmdk', openIt as EventListener);
  }, []);

  // Reset + focus when opening.
  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      // Focus after paint.
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [open]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ITEMS;
    return ITEMS.filter((it) =>
      (`${it.label} ${it.keywords ?? ''} ${it.hint ?? ''}`)
        .toLowerCase()
        .includes(q),
    );
  }, [query]);

  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, results.length - 1)));
  }, [results.length]);

  function close() {
    setOpen(false);
  }

  async function runItem(item: CmdItem | undefined) {
    if (!item) return;
    close();
    await item.run({
      navigate: (href) => setLocation(href),
      logout,
    });
  }

  function onInputKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      void runItem(results[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }

  // Keep the active row scrolled into view.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  let lastGroup = '';

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center px-4 pt-[12vh] bg-background/70 backdrop-blur-sm"
      onMouseDown={close}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <div
        className="w-full max-w-xl rounded-xl border border-border bg-card shadow-2xl overflow-hidden animate-in fade-in slide-in-from-top-2 duration-150"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 border-b border-border">
          <Search className="w-4 h-4 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onInputKey}
            placeholder="Search pages and actions…"
            className="flex-1 bg-transparent py-3.5 text-sm outline-none placeholder:text-muted-foreground"
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="hidden sm:inline-flex items-center gap-1 text-[10px] font-mono text-muted-foreground border border-border rounded px-1.5 py-0.5">
            ESC
          </kbd>
        </div>

        <div ref={listRef} className="max-h-[52vh] overflow-y-auto py-2">
          {results.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">
              No matches for “{query}”.
            </div>
          ) : (
            results.map((item, idx) => {
              const showHeader = item.group !== lastGroup;
              lastGroup = item.group;
              const isActive = idx === active;
              return (
                <div key={item.id}>
                  {showHeader && (
                    <div className="px-4 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                      {item.group}
                    </div>
                  )}
                  <button
                    data-idx={idx}
                    onMouseEnter={() => setActive(idx)}
                    onClick={() => void runItem(item)}
                    className={cn(
                      'w-full flex items-center gap-3 px-4 py-2.5 text-sm text-left transition-colors',
                      isActive
                        ? 'bg-primary/10 text-foreground'
                        : 'text-foreground/80 hover:bg-muted/60',
                    )}
                  >
                    <item.icon
                      className={cn(
                        'w-4 h-4 shrink-0',
                        isActive ? 'text-primary' : 'text-muted-foreground',
                      )}
                    />
                    <span className="flex-1 font-medium">{item.label}</span>
                    {item.hint && (
                      <span className="text-xs text-muted-foreground font-mono">
                        {item.hint}
                      </span>
                    )}
                    {isActive && (
                      <CornerDownLeft className="w-3.5 h-3.5 text-muted-foreground" />
                    )}
                  </button>
                </div>
              );
            })
          )}
        </div>

        <div className="flex items-center justify-between px-4 py-2 border-t border-border text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <CommandIcon className="w-3 h-3" /> MogulForge command palette
          </span>
          <span className="hidden sm:flex items-center gap-3 font-mono">
            <span>↑↓ navigate</span>
            <span>↵ open</span>
          </span>
        </div>
      </div>
    </div>
  );
}
