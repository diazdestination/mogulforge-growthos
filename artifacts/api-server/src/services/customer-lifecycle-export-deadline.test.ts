import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createCustomerLifecycleExporter } from './customer-lifecycle-export';

type ExportClient = ReturnType<NonNullable<NonNullable<Parameters<typeof createCustomerLifecycleExporter>[0]>['createClient']>>;
const orgId = '00000000-0000-4000-8000-000000000001';
const userId = 'synthetic-export-owner';
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function clientFixture(block?: 'authorization' | 'audit' | 'commit' | 'cleanup', revoked = false) {
  const queries: string[] = [];
  const end = vi.fn(async () => { if (block === 'cleanup') await new Promise(() => undefined); });
  const client = {
    connect: vi.fn(async () => undefined), end, on: vi.fn(),
    query: vi.fn(async (input: { text: string; values: unknown[] }) => {
      const text = input.text; queries.push(text);
      if ((block === 'authorization' && text.endsWith('FOR SHARE')) || (block === 'audit' && text.startsWith('INSERT')) || (block === 'commit' && text === 'COMMIT')) await new Promise(() => undefined);
      if (text.startsWith('SELECT id FROM public.users')) return { rows: revoked && text.endsWith('FOR SHARE') ? [] : [{ id: userId }] };
      if (text.startsWith('SELECT id, name')) return { rows: [{ id: orgId, name: 'Synthetic export company', slug: 'synthetic-export', created_at: new Date(0) }] };
      return { rows: [] };
    }),
  };
  return { client: client as unknown as ExportClient, queries, end };
}

it('uses a fresh bounded transaction for latest authorization and audit before returning data', async () => {
  const fixture = clientFixture();
  const result = await createCustomerLifecycleExporter({ createClient: () => fixture.client })(orgId, userId);
  expect(result.organization.id).toBe(orgId);
  const rollback = fixture.queries.indexOf('ROLLBACK');
  const authorize = fixture.queries.findIndex((q) => q.endsWith('FOR SHARE'));
  const insert = fixture.queries.findIndex((q) => q.startsWith('INSERT'));
  expect(authorize).toBeGreaterThan(rollback);
  expect(insert).toBeGreaterThan(authorize);
  expect(fixture.queries.at(-1)).toBe('COMMIT');
  expect(fixture.end).toHaveBeenCalledTimes(1);
});

it.each(['authorization', 'audit', 'commit'] as const)('bounds a stalled post-snapshot %s phase under the whole-export deadline', async (phase) => {
  const fixture = clientFixture(phase);
  const result = createCustomerLifecycleExporter({ createClient: () => fixture.client })(orgId, userId);
  const assertion = expect(result).rejects.toMatchObject({ status: 503, code: 'customer_export_unavailable' });
  await vi.advanceTimersByTimeAsync(20_000);
  await assertion;
  expect(fixture.queries).toContain('ROLLBACK');
  expect(fixture.end).toHaveBeenCalledTimes(1);
});

it('withholds the export and audit when the manager was revoked after the snapshot', async () => {
  const fixture = clientFixture(undefined, true);
  await expect(createCustomerLifecycleExporter({ createClient: () => fixture.client })(orgId, userId)).rejects.toMatchObject({ status: 403, code: 'lifecycle_manager_required' });
  expect(fixture.queries.some((q) => q.startsWith('INSERT'))).toBe(false);
  expect(fixture.end).toHaveBeenCalledTimes(1);
});

it('retains occupied slots for stuck cleanup, preventing an unlimited connection replacement loop', async () => {
  const fixtures = [clientFixture('cleanup'), clientFixture('cleanup')];
  const createClient = vi.fn(() => fixtures[createClient.mock.calls.length - 1].client);
  const exporter = createCustomerLifecycleExporter({ createClient });
  const first = exporter(orgId, userId); const second = exporter(orgId, userId);
  await vi.advanceTimersByTimeAsync(500);
  await first; await second;
  await expect(exporter(orgId, userId)).rejects.toMatchObject({ status: 503 });
  expect(createClient).toHaveBeenCalledTimes(2);
});
