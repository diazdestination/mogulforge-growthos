import { useEffect, useRef, useState, type ReactNode } from 'react';
import { contractorRequest } from '@/lib/contractor-api';

export const workdayButton = 'inline-flex min-h-11 max-w-full items-center justify-center rounded-lg border px-3 py-2 text-sm font-medium disabled:opacity-50';
export const workdayField = 'mt-1 block min-h-11 w-full min-w-0 max-w-full rounded-lg border bg-background p-2 text-base';
export const workdayCard = 'min-w-0 max-w-full space-y-3 rounded-xl border bg-card p-4 [overflow-wrap:anywhere]';
export const workdayLabel = (value: string) => value.replaceAll('_', ' ');

/** Does not mount its reader or fetch history until a person opens this section. */
export function WorkdayDisclosure({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <section className={workdayCard} aria-label={title}>
    <button type="button" className={`${workdayButton} text-left`} aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? 'Close' : 'Open'} {title.toLowerCase()}</button>
    {open && children}
  </section>;
}

export function WorkdayNotice({ error, notice, held }: { error: string; notice?: string; held?: boolean }) {
  return <>{error && <p role="alert" className="whitespace-pre-wrap break-words text-sm text-destructive">{error}</p>}{held && <p className="text-sm">The saved result must be checked before another change. No automatic retry was made. Refresh and review the original record.</p>}{notice && <p role="status" className="whitespace-pre-wrap break-words text-sm">{notice}</p>}</>;
}

export async function workdayRequest<T>(schema: { parse: (value: unknown) => T }, path: string, options?: Parameters<typeof contractorRequest>[1]): Promise<T> {
  const result = await contractorRequest(path, options);
  try { return schema.parse(result); } catch { throw new Error('The returned work record could not be verified for this company and exact record. Refresh and review before another change.'); }
}

/** Every callback is pinned to its semantic member/target generation. A failed
 * mutation may have committed; refresh, never quietly issue a new request key. */
export function useWorkdayOperation(scope: string) {
  const [busy, setBusy] = useState(false), [held, setHeld] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const current = useRef({ scope, generation: 0, mounted: true, busy: false, held: false });
  if (current.current.scope !== scope) current.current = { scope, generation: current.current.generation + 1, mounted: true, busy: false, held: false };
  useEffect(() => { current.current.mounted = true; return () => { current.current.mounted = false; current.current.generation++; }; }, []);
  useEffect(() => { setBusy(false); setHeld(false); setError(''); setNotice(''); }, [scope]);
  const invalidate = () => {
    if (current.current.busy) return false;
    current.current.generation++; setError(''); setNotice(''); return true;
  };
  async function run<T>(action: (stillCurrent: () => boolean) => Promise<T>, accept: (value: T) => void, options: { mutation?: boolean; refresh?: boolean; success?: string } = {}) {
    if (current.current.busy || (current.current.held && !options.refresh)) return;
    const token = current.current, generation = ++token.generation;
    token.busy = true; setBusy(true); setError(''); setNotice('');
    const active = () => current.current === token && token.mounted && token.generation === generation;
    try {
      const value = await action(active);
      if (!active()) return;
      accept(value);
      if (options.refresh) { token.held = false; setHeld(false); }
      if (options.success) setNotice(options.success);
    } catch (failure) {
      if (!active()) return;
      if (options.mutation) { token.held = true; setHeld(true); }
      setError(failure instanceof Error ? workdayLabel(failure.message) : 'The work record could not be verified.');
    } finally { if (active()) { token.busy = false; setBusy(false); } }
  }
  return { busy, held, error, notice, setError, setNotice, invalidate, run };
}
