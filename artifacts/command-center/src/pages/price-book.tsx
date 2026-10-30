import { useCallback, useEffect, useMemo, useState } from 'react';
import { Edit, Loader2, Plus, Trash2, X } from 'lucide-react';
import { useGetMe } from '@workspace/api-client-react';

import { useToast } from '@/hooks/use-toast';
import { canManageSettings } from '@/lib/permissions';
import {
  dollars,
  fetchPriceBook,
  itemMarginBps,
  percent,
  removePriceBookItem,
  savePriceBookItem,
  type PriceBookItem,
} from '@/lib/price-book';

type Draft = {
  trade: string;
  name: string;
  description: string;
  unit: string;
  unitCost: string;
  unitPrice: string;
  targetMargin: string;
  isActive: boolean;
};

const EMPTY: Draft = { trade: '', name: '', description: '', unit: 'ea', unitCost: '', unitPrice: '', targetMargin: '', isActive: true };

const toCents = (value: string): number => Math.round((parseFloat(value) || 0) * 100);

function draftFrom(item: PriceBookItem): Draft {
  return {
    trade: item.trade,
    name: item.name,
    description: item.description ?? '',
    unit: item.unit,
    unitCost: (item.unitCostCents / 100).toString(),
    unitPrice: (item.unitPriceCents / 100).toString(),
    targetMargin: item.targetMarginBps === null ? '' : (item.targetMarginBps / 100).toString(),
    isActive: item.isActive,
  };
}

/** ESTI price book: the company's own priced work and materials, grouped by trade. */
export default function PriceBook() {
  const { data: me } = useGetMe();
  const canEdit = canManageSettings(me?.role);
  const { toast } = useToast();
  const [items, setItems] = useState<PriceBookItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft } | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await fetchPriceBook(true));
    } catch (error) {
      toast({ variant: 'destructive', title: error instanceof Error ? error.message : 'Could not load the price book' });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const trades = useMemo(() => {
    const groups = new Map<string, PriceBookItem[]>();
    for (const item of items) groups.set(item.trade, [...(groups.get(item.trade) ?? []), item]);
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [items]);

  const save = async () => {
    if (!editing) return;
    const { draft, id } = editing;
    setSaving(true);
    try {
      await savePriceBookItem(
        {
          trade: draft.trade.trim(),
          name: draft.name.trim(),
          description: draft.description.trim() || null,
          unit: draft.unit.trim() || 'ea',
          unitCostCents: toCents(draft.unitCost),
          unitPriceCents: toCents(draft.unitPrice),
          targetMarginBps: draft.targetMargin.trim() === '' ? null : Math.round(parseFloat(draft.targetMargin) * 100),
          isActive: draft.isActive,
        },
        id ?? undefined,
      );
      setEditing(null);
      await load();
    } catch (error) {
      toast({ variant: 'destructive', title: error instanceof Error ? error.message : 'Could not save the item' });
    } finally {
      setSaving(false);
    }
  };

  const remove = async (item: PriceBookItem) => {
    if (!window.confirm(`Delete "${item.name}" from the price book? Existing estimates are not changed.`)) return;
    try {
      await removePriceBookItem(item.id);
      await load();
    } catch (error) {
      toast({ variant: 'destructive', title: error instanceof Error ? error.message : 'Could not delete the item' });
    }
  };

  const set = (patch: Partial<Draft>) => setEditing((current) => (current ? { ...current, draft: { ...current.draft, ...patch } } : current));
  const draftMargin = editing ? itemMarginBps(toCents(editing.draft.unitPrice), toCents(editing.draft.unitCost)) : null;

  return (
    <div className="flex flex-col h-full bg-background overflow-hidden">
      <header className="px-4 py-3 md:px-6 md:py-4 border-b border-border flex items-center justify-between bg-card shrink-0 gap-4 sticky top-0 z-10">
        <div>
          <h1 className="text-xl md:text-2xl font-bold tracking-tight text-foreground">Price Book</h1>
          <p className="hidden md:block text-sm text-muted-foreground">ESTI uses your costs and prices to check margin on every estimate.</p>
        </div>
        {canEdit && (
          <button onClick={() => setEditing({ id: null, draft: { ...EMPTY, trade: trades[0]?.[0] ?? '' } })} className="bg-primary text-primary-foreground hover:bg-primary/90 px-4 py-2.5 md:px-3 md:py-2 rounded-xl text-sm font-semibold flex items-center gap-2 transition-transform active:scale-95 shadow-sm shadow-primary/20">
            <Plus className="w-4 h-4" /> <span className="hidden md:inline">Add Item</span>
          </button>
        )}
      </header>

      <div className="flex-1 overflow-auto p-4 md:p-6 pb-20 md:pb-6 space-y-6">
        {loading ? (
          <div className="flex items-center justify-center h-full"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>
        ) : trades.length === 0 ? (
          <div className="max-w-xl mx-auto text-center space-y-2 py-16">
            <p className="font-semibold">No price book items yet.</p>
            <p className="text-sm text-muted-foreground">
              Add the materials and labor you sell, with what they cost you and what you charge. ESTI will flag estimate lines that fall below your target margin.
            </p>
          </div>
        ) : (
          trades.map(([trade, group]) => (
            <section key={trade} className="space-y-2">
              <h2 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">{trade}</h2>
              <div className="bg-card border border-border rounded-2xl divide-y divide-border overflow-hidden">
                {group.map((item) => {
                  const margin = itemMarginBps(item.unitPriceCents, item.unitCostCents);
                  const target = item.targetMarginBps;
                  const low = margin !== null && target !== null && margin < target;
                  return (
                    <div key={item.id} className={`flex flex-wrap items-center gap-3 p-3 md:p-4 ${item.isActive ? '' : 'opacity-50'}`}>
                      <div className="min-w-0 flex-1">
                        <div className="font-semibold truncate">{item.name}{item.isActive ? '' : ' (inactive)'}</div>
                        {item.description && <div className="text-xs text-muted-foreground truncate">{item.description}</div>}
                      </div>
                      <div className="text-sm text-muted-foreground w-24 text-right">cost {dollars(item.unitCostCents)}/{item.unit}</div>
                      <div className="text-sm font-semibold w-24 text-right">{dollars(item.unitPriceCents)}/{item.unit}</div>
                      <div className={`text-sm w-28 text-right ${low ? 'text-destructive font-semibold' : 'text-muted-foreground'}`}>
                        {percent(margin)}{target !== null ? ` / ${percent(target)}` : ''}
                      </div>
                      {canEdit && (
                        <div className="flex gap-1">
                          <button aria-label={`Edit ${item.name}`} onClick={() => setEditing({ id: item.id, draft: draftFrom(item) })} className="w-9 h-9 flex items-center justify-center rounded-lg bg-muted/50 hover:bg-muted"><Edit className="w-4 h-4" /></button>
                          <button aria-label={`Delete ${item.name}`} onClick={() => void remove(item)} className="w-9 h-9 flex items-center justify-center rounded-lg bg-muted/50 hover:bg-destructive/10 hover:text-destructive"><Trash2 className="w-4 h-4" /></button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          ))
        )}
      </div>

      {editing && (
        <div className="fixed inset-0 bg-background/90 backdrop-blur-sm z-50 flex items-end md:items-center justify-center p-0 md:p-4">
          <div className="bg-card border-t md:border border-border shadow-2xl md:rounded-2xl rounded-t-2xl w-full max-w-lg overflow-hidden">
            <div className="p-4 md:p-6 border-b border-border flex justify-between items-center bg-muted/20">
              <h2 className="text-lg font-bold">{editing.id ? 'Edit Item' : 'New Item'}</h2>
              <button onClick={() => setEditing(null)} aria-label="Close" className="w-8 h-8 flex items-center justify-center rounded-full bg-muted"><X className="w-4 h-4" /></button>
            </div>
            <form className="p-4 md:p-6 space-y-4" onSubmit={(event) => { event.preventDefault(); void save(); }}>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Trade *"><input required value={editing.draft.trade} onChange={(e) => set({ trade: e.target.value })} placeholder="Roofing" className={inputClass} /></Field>
                <Field label="Unit"><input value={editing.draft.unit} onChange={(e) => set({ unit: e.target.value })} placeholder="sq, ea, lf, hr" className={inputClass} /></Field>
              </div>
              <Field label="Name *"><input required value={editing.draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="Architectural shingles" className={inputClass} /></Field>
              <Field label="Description"><input value={editing.draft.description} onChange={(e) => set({ description: e.target.value })} className={inputClass} /></Field>
              <div className="grid grid-cols-3 gap-3">
                <Field label="Your cost ($)"><input type="number" min="0" step="0.01" value={editing.draft.unitCost} onChange={(e) => set({ unitCost: e.target.value })} className={inputClass} /></Field>
                <Field label="Price ($) *"><input required type="number" min="0" step="0.01" value={editing.draft.unitPrice} onChange={(e) => set({ unitPrice: e.target.value })} className={inputClass} /></Field>
                <Field label="Target margin %"><input type="number" min="0" max="99.99" step="0.1" value={editing.draft.targetMargin} onChange={(e) => set({ targetMargin: e.target.value })} placeholder="30" className={inputClass} /></Field>
              </div>
              <p className="text-sm text-muted-foreground">Margin at this price: <span className="font-semibold text-foreground">{percent(draftMargin)}</span>. Leave target blank to use the 30% default.</p>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={editing.draft.isActive} onChange={(e) => set({ isActive: e.target.checked })} /> Active (available on estimates)</label>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setEditing(null)} className="px-4 py-2 rounded-xl border border-border text-sm">Cancel</button>
                <button type="submit" disabled={saving} className="px-4 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-semibold flex items-center gap-2">{saving && <Loader2 className="w-4 h-4 animate-spin" />}Save</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

const inputClass = 'w-full bg-background border border-border rounded-xl px-3 py-2.5 text-sm focus:ring-2 focus:ring-primary focus:outline-none';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-[10px] md:text-xs font-bold text-muted-foreground uppercase tracking-widest">{label}</span>
      {children}
    </label>
  );
}
