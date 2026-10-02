import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@workspace/replit-auth-web";
import { CornerDownLeft, LogOut, Search, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ContractorNavigationItem } from "@/lib/contractor-navigation";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./ui/dialog";

interface CommandItem {
  id: string;
  label: string;
  keywords: string;
  icon: LucideIcon;
  href?: string;
}

export function CommandPalette({
  items,
}: {
  items: ContractorNavigationItem[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [, navigate] = useLocation();
  const { logout } = useAuth();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((current) => !current);
      }
    };
    const openSearch = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("mogulforge:cmdk", openSearch);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mogulforge:cmdk", openSearch);
    };
  }, []);
  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
    }
  }, [open]);

  const commands = useMemo(() => {
    const seen = new Set<string>();
    const result: CommandItem[] = [];
    for (const item of items) {
      if (seen.has(item.href)) continue;
      seen.add(item.href);
      result.push({
        id: item.href,
        label: item.title,
        keywords: item.keywords,
        icon: item.icon,
        href: item.href,
      });
    }
    result.push({
      id: "sign-out",
      label: "Sign out",
      keywords: "logout leave exit",
      icon: LogOut,
    });
    return result;
  }, [items]);
  const results = useMemo(() => {
    const term = query.trim().toLowerCase();
    return term
      ? commands.filter((item) =>
          `${item.label} ${item.keywords}`.toLowerCase().includes(term),
        )
      : commands;
  }, [commands, query]);
  useEffect(
    () =>
      setActive((current) =>
        Math.min(current, Math.max(0, results.length - 1)),
      ),
    [results.length],
  );
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function run(item?: CommandItem) {
    if (!item) return;
    setOpen(false);
    if (item.href) navigate(item.href);
    else logout();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="w-[calc(100%-2rem)] max-w-xl gap-0 overflow-hidden bg-popover p-0 text-popover-foreground"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <DialogTitle className="sr-only">Find a page</DialogTitle>
        <DialogDescription className="sr-only">
          Search the pages available for your role. Use the arrow keys to choose
          and Enter to open.
        </DialogDescription>
        <div className="flex items-center gap-3 border-b border-border px-4 pr-12">
          <Search
            className="h-4 w-4 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive((current) =>
                  Math.min(current + 1, results.length - 1),
                );
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((current) => Math.max(current - 1, 0));
              }
              if (event.key === "Enter") {
                event.preventDefault();
                run(results[active]);
              }
            }}
            role="combobox"
            aria-label="Search pages"
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls="page-search-results"
            aria-activedescendant={
              results[active] ? `page-search-${active}` : undefined
            }
            placeholder="Search pages…"
            className="min-w-0 flex-1 bg-transparent py-4 text-sm outline-none placeholder:text-muted-foreground"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div
          ref={listRef}
          id="page-search-results"
          role="listbox"
          aria-label="Available pages"
          className="max-h-[60dvh] overflow-y-auto py-2"
        >
          {results.length === 0 ? (
            <p
              role="status"
              className="px-4 py-8 text-center text-sm text-muted-foreground"
            >
              No pages match “{query}”.
            </p>
          ) : (
            results.map((item, index) => (
              <button
                key={item.id}
                id={`page-search-${index}`}
                data-index={index}
                role="option"
                aria-selected={active === index}
                onMouseEnter={() => setActive(index)}
                onClick={() => run(item)}
                className={cn(
                  "flex min-h-11 w-full items-center gap-3 px-4 py-3 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  active === index
                    ? "bg-accent text-accent-foreground"
                    : "text-foreground hover:bg-muted",
                )}
              >
                <item.icon className="h-4 w-4 shrink-0" aria-hidden />
                <span className="flex-1 font-medium">{item.label}</span>
                {active === index && (
                  <CornerDownLeft
                    className="h-4 w-4 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                )}
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
