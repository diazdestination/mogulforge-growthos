import { useEffect, useState } from 'react';
import { AlertTriangle, BookOpen, CheckCircle2, Loader2 } from 'lucide-react';

import { dollars, fetchPriceBook, percent, previewMargin, type MarginGuidance, type PriceBookItem } from '@/lib/price-book';

export type MarginDraftLine = { description: string; quantity: number; unitPriceCents: number; priceBookItemId?: string | null };

/** Adds a price-book line to the draft. Renders nothing when the book is empty. */
export function PriceBookPicker({ onPick, disabled }: { onPick: (item: PriceBookItem) => void; disabled?: boolean }) {
  const [items, setItems] = useState<PriceBookItem[]>([]);
  useEffect(() => {
    let alive = true;
    fetchPriceBook()
      .then((next) => { if (alive) setItems(next); })
      .catch(() => { if (alive) setItems([]); });
    return () => { alive = false; };
  }, []);
  if (items.length === 0) return null;
  return (
    <label className="flex items-center gap-1.5 text-xs font-bold text-primary bg-primary/10 px-2 py-1 rounded-lg">
      <BookOpen className="w-3 h-3" />
      <span className="sr-only">Add from price book</span>
      <select
        aria-label="Add from price book"
        className="bg-transparent text-xs font-bold focus:outline-none max-w-[11rem]"
        value=""
        disabled={disabled}
        onChange={(event) => {
          const item = items.find((entry) => entry.id === event.target.value);
          if (item) onPick(item);
        }}
      >
        <option value="">From price book…</option>
        {items.map((item) => (
          <option key={item.id} value={item.id}>
            {item.trade} · {item.name} ({dollars(item.unitPriceCents)}/{item.unit})
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * ESTI margin guidance for a draft estimate. Read-only: it reports margin from
 * the company's price book and offers a target-meeting price; the user decides.
 */
export function EstimateMarginPanel({
  lines,
  onUsePrice,
}: {
  lines: MarginDraftLine[];
  onUsePrice: (lineIndex: number, unitPriceCents: number) => void;
}) {
  const [guidance, setGuidance] = useState<MarginGuidance | null>(null);
  const [loading, setLoading] = useState(false);
  const key = JSON.stringify(lines);

  useEffect(() => {
    if (lines.length === 0) {
      setGuidance(null);
      return;
    }
    let alive = true;
    setLoading(true);
    const timer = window.setTimeout(() => {
      previewMargin(lines)
        .then((next) => { if (alive) setGuidance(next); })
        .catch(() => { if (alive) setGuidance(null); })
        .finally(() => { if (alive) setLoading(false); });
    }, 350);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
    // `key` captures the line contents; `lines` identity changes every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!guidance || guidance.lines.every((line) => line.status === 'no_cost')) return null;
  const flagged = guidance.lines.filter((line) => line.status === 'below_cost' || line.status === 'below_target');

  return (
    <div className="rounded-2xl border border-border bg-muted/10 p-3 md:p-4 space-y-2" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-[10px] md:text-xs font-bold text-muted-foreground uppercase tracking-widest">ESTI margin check</span>
        {loading && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />}
        <span className="ml-auto font-semibold">
          {percent(guidance.pricedMarginBps)} margin on priced lines ({dollars(guidance.pricedMarginCents)})
        </span>
      </div>
      {flagged.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground"><CheckCircle2 className="w-4 h-4 text-primary" /> Every priced line meets its target margin.</p>
      ) : (
        <ul className="space-y-1.5">
          {flagged.map((line) => (
            <li key={line.index} className="flex flex-wrap items-center gap-2 text-sm">
              <AlertTriangle className={`w-4 h-4 ${line.status === 'below_cost' ? 'text-destructive' : 'text-amber-500'}`} />
              <span className="font-medium">{line.description || line.priceBookItemName}</span>
              <span className="text-muted-foreground">
                {line.status === 'below_cost' ? 'is priced below your cost' : `is at ${percent(line.marginBps)} vs ${percent(line.targetMarginBps)} target`}
              </span>
              {line.suggestedUnitPriceCents !== null && (
                <button
                  type="button"
                  onClick={() => onUsePrice(line.index, line.suggestedUnitPriceCents!)}
                  className="ml-auto text-xs font-bold text-primary bg-primary/10 px-2 py-1 rounded-lg"
                >
                  Use {dollars(line.suggestedUnitPriceCents)}/{line.unit ?? 'ea'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {guidance.unpricedLineCount > 0 && (
        <p className="text-xs text-muted-foreground">
          {guidance.unpricedLineCount} line{guidance.unpricedLineCount === 1 ? '' : 's'} not in the price book (or without a cost) — not included in the margin.
        </p>
      )}
    </div>
  );
}
