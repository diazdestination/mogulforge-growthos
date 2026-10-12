import { useEffect, useId, useRef, useState } from 'react';
import {
  CUSTOMER_MEMORY_KIND_VALUES, customerMemoryKindLabels, customerMemoryListSchema, customerMemorySchema,
  type CustomerMemoryDto,
} from '../../../api-server/src/services/customer-memory-contract';
import { contractorRequest } from '@/lib/contractor-api';
import { workdayButton as button, workdayCard as card, workdayField as field } from './workday-ui';

type Props = { organizationId: string; contactId: string; scopeKey: string; canWrite: boolean };
type Kind = (typeof CUSTOMER_MEMORY_KIND_VALUES)[number];

/** Small staff-authored notes that travel with a customer. Retiring keeps provenance. */
export default function CustomerMemoryPanel(props: Props) {
  return <Memory key={`${props.scopeKey}:${props.organizationId}:${props.contactId}`} {...props} />;
}

function Memory({ organizationId, contactId, canWrite }: Props) {
  const [memories, setMemories] = useState<CustomerMemoryDto[] | null>(null);
  const [kind, setKind] = useState<Kind>('fact'), [content, setContent] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const alive = useRef(true);
  const kindId = useId(), contentId = useId();
  const verify = (value: CustomerMemoryDto) => {
    if (value.organizationId !== organizationId || value.contactId !== contactId) throw new Error('Customer context changed');
    return value;
  };
  async function load(signal?: AbortSignal) {
    try {
      const data = customerMemoryListSchema.parse(await contractorRequest(`/contacts/${contactId}/memories`, { signal }));
      if (data.organizationId !== organizationId || data.contactId !== contactId) throw new Error('Customer context changed');
      data.memories.forEach(verify);
      if (alive.current) { setMemories(data.memories); setError(''); }
    } catch {
      if (alive.current && !signal?.aborted) setError('Customer memory could not be loaded. Refresh to try again.');
    }
  }
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    void load(controller.signal);
    return () => { alive.current = false; controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  async function add() {
    const text = content.trim();
    if (!text || busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      verify(customerMemorySchema.parse(await contractorRequest(`/contacts/${contactId}/memories`, { method: 'POST', body: { kind, content: text } })));
      if (!alive.current) return;
      setContent(''); setNotice('Memory saved.');
      await load();
    } catch {
      if (alive.current) setError('The memory was not confirmed. Refresh the list before adding it again.');
    } finally { if (alive.current) setBusy(false); }
  }
  async function retire(memory: CustomerMemoryDto) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      verify(customerMemorySchema.parse(await contractorRequest(`/contacts/${contactId}/memories/${memory.id}/retire`, { method: 'POST' })));
      if (!alive.current) return;
      setNotice('Memory retired. It no longer appears in customer search.');
      await load();
    } catch {
      if (alive.current) setError('Retiring was not confirmed. Refresh the list to see the saved state.');
    } finally { if (alive.current) setBusy(false); }
  }
  return <section className={card} aria-labelledby={`${kindId}-title`}>
    <div>
      <h2 id={`${kindId}-title`} className="font-semibold">Customer memory</h2>
      <p className="text-sm text-muted-foreground">Short notes your team should remember about this customer. Avoid passwords, card numbers or other secrets.</p>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {memories === null && !error && <p role="status" className="text-sm text-muted-foreground">Loading customer memory…</p>}
    {memories?.length === 0 && <p className="text-sm text-muted-foreground">No active memories yet.</p>}
    {memories && memories.length > 0 && <ul className="space-y-2">
      {memories.map(memory => <li key={memory.id} className="flex flex-wrap items-start justify-between gap-2 rounded-lg border p-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase text-muted-foreground">{customerMemoryKindLabels[memory.kind]}</p>
          <p className="text-sm">{memory.content}</p>
        </div>
        {canWrite && <button type="button" className={button} disabled={busy} onClick={() => void retire(memory)} aria-label={`Retire memory: ${memory.content.slice(0, 60)}`}>Retire</button>}
      </li>)}
    </ul>}
    {canWrite && <form className="space-y-2" onSubmit={event => { event.preventDefault(); void add(); }}>
      <label htmlFor={kindId} className="block text-sm font-medium">Type
        <select id={kindId} className={field} value={kind} onChange={event => setKind(event.target.value as Kind)}>
          {CUSTOMER_MEMORY_KIND_VALUES.map(value => <option key={value} value={value}>{customerMemoryKindLabels[value]}</option>)}
        </select>
      </label>
      <label htmlFor={contentId} className="block text-sm font-medium">Memory
        <textarea id={contentId} className={field} maxLength={1000} rows={2} value={content} onChange={event => setContent(event.target.value)} />
      </label>
      <button type="submit" className={button} disabled={busy || !content.trim()}>Add memory</button>
    </form>}
  </section>;
}
