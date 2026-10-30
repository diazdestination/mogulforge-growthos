/** Client for the ESTI price book API. Plain fetch, matching the integration cards. */

export type PriceBookItem = {
  id: string;
  trade: string;
  name: string;
  description: string | null;
  unit: string;
  unitCostCents: number;
  unitPriceCents: number;
  targetMarginBps: number | null;
  isActive: boolean;
  updatedAt: string;
};

export type PriceBookItemInput = {
  trade: string;
  name: string;
  description?: string | null;
  unit: string;
  unitCostCents: number;
  unitPriceCents: number;
  targetMarginBps?: number | null;
  isActive?: boolean;
};

export type MarginLine = {
  index: number;
  description: string;
  priceBookItemId: string | null;
  priceBookItemName: string | null;
  unit: string | null;
  revenueCents: number;
  costCents: number | null;
  marginCents: number | null;
  marginBps: number | null;
  targetMarginBps: number | null;
  suggestedUnitPriceCents: number | null;
  status: 'below_cost' | 'below_target' | 'on_target' | 'no_cost';
};

export type MarginGuidance = {
  lines: MarginLine[];
  pricedRevenueCents: number;
  pricedCostCents: number;
  pricedMarginCents: number;
  pricedMarginBps: number | null;
  unpricedLineCount: number;
  belowTargetLineCount: number;
  belowCostLineCount: number;
  defaultTargetMarginBps: number;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    credentials: 'include',
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body;
}

export async function fetchPriceBook(includeInactive = false): Promise<PriceBookItem[]> {
  const body = await request<{ items?: PriceBookItem[] }>(`/price-book/items${includeInactive ? '?includeInactive=true' : ''}`);
  return Array.isArray(body?.items) ? body.items : [];
}

export async function savePriceBookItem(input: PriceBookItemInput, id?: string): Promise<PriceBookItem> {
  const body = await request<{ item: PriceBookItem }>(id ? `/price-book/items/${id}` : '/price-book/items', {
    method: id ? 'PATCH' : 'POST',
    body: JSON.stringify(input),
  });
  return body.item;
}

export async function removePriceBookItem(id: string): Promise<void> {
  await request(`/price-book/items/${id}`, { method: 'DELETE' });
}

export async function previewMargin(
  lineItems: { description: string; quantity: number; unitPriceCents: number; priceBookItemId?: string | null }[],
): Promise<MarginGuidance> {
  return request<MarginGuidance>('/price-book/margin-preview', { method: 'POST', body: JSON.stringify({ lineItems }) });
}

export const dollars = (cents: number): string =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export const percent = (bps: number | null): string => (bps === null ? '—' : `${(bps / 100).toFixed(1)}%`);

/** Gross margin of a price over a cost, in basis points; null when price is zero. */
export const itemMarginBps = (priceCents: number, costCents: number): number | null =>
  priceCents > 0 ? Math.trunc(((priceCents - costCents) * 10000) / priceCents) : null;
