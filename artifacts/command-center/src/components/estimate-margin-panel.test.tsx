import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { EstimateMarginPanel, PriceBookPicker } from './estimate-margin-panel';

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const guidance = {
  lines: [
    { index: 0, description: 'Architectural shingles', priceBookItemId: 'a', priceBookItemName: 'Architectural shingles', unit: 'sq', revenueCents: 160000, costCents: 120000, marginCents: 40000, marginBps: 2500, targetMarginBps: 3500, suggestedUnitPriceCents: 18462, status: 'below_target' },
    { index: 1, description: 'Dumpster', priceBookItemId: null, priceBookItemName: null, unit: null, revenueCents: 45000, costCents: null, marginCents: null, marginBps: null, targetMarginBps: null, suggestedUnitPriceCents: null, status: 'no_cost' },
  ],
  pricedRevenueCents: 160000,
  pricedCostCents: 120000,
  pricedMarginCents: 40000,
  pricedMarginBps: 2500,
  unpricedLineCount: 1,
  belowTargetLineCount: 1,
  belowCostLineCount: 0,
  defaultTargetMarginBps: 3000,
};

it('flags a below-target line and applies the suggested price only when asked', async () => {
  const fetchMock = vi.fn(async () => json(guidance));
  vi.stubGlobal('fetch', fetchMock);
  const onUsePrice = vi.fn();
  render(
    <EstimateMarginPanel
      lines={[
        { description: 'Architectural shingles', quantity: 10, unitPriceCents: 16000 },
        { description: 'Dumpster', quantity: 1, unitPriceCents: 45000 },
      ]}
      onUsePrice={onUsePrice}
    />,
  );
  expect(await screen.findByText(/is at 25.0% vs 35.0% target/)).toBeTruthy();
  expect(screen.getByText(/1 line not in the price book/)).toBeTruthy();
  expect(onUsePrice).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: /Use \$184\.62\/sq/ }));
  expect(onUsePrice).toHaveBeenCalledWith(0, 18462);
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('/api/v1/price-book/margin-preview');
  expect(JSON.parse(String(init.body)).lineItems).toHaveLength(2);
});

it('renders nothing when no line has a known cost', async () => {
  const fetchMock = vi.fn(async () => json({ ...guidance, lines: [guidance.lines[1]], pricedMarginBps: null }));
  vi.stubGlobal('fetch', fetchMock);
  const { container } = render(<EstimateMarginPanel lines={[{ description: 'Dumpster', quantity: 1, unitPriceCents: 45000 }]} onUsePrice={() => {}} />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  expect(container.textContent).toBe('');
});

it('adds a price-book item through the picker', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ items: [{ id: 'a', trade: 'Roofing', name: 'Architectural shingles', description: null, unit: 'sq', unitCostCents: 12000, unitPriceCents: 20000, targetMarginBps: 3500, isActive: true, updatedAt: '2026-10-30T00:00:00.000Z' }] })));
  const onPick = vi.fn();
  render(<PriceBookPicker onPick={onPick} />);
  const select = await screen.findByRole('combobox', { name: 'Add from price book' });
  fireEvent.change(select, { target: { value: 'a' } });
  expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 'a', name: 'Architectural shingles' }));
});
