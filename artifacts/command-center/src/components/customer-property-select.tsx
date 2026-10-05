import { useEffect, useId, useRef, useState } from 'react';
import { customerWorkspacePageSchema, customerWorkspacePropertySchema, type CustomerWorkspaceProperty } from '../../../api-server/src/services/customer-workspace-contract';

type Props = {
  organizationId: string;
  contactId: string;
  scopeKey: string;
  value: string;
  onChange: (propertyId: string) => void;
  disabled?: boolean;
  purpose?: 'service' | 'appointment';
};

/** This picker only links new work. A single returned address is never auto-selected. */
export default function CustomerPropertySelect(props: Props) {
  return <PropertyPicker key={`${props.scopeKey}:${props.organizationId}:${props.contactId}`} {...props} />;
}

function PropertyPicker({ organizationId, contactId, value, onChange, disabled, purpose = 'service' }: Props) {
  const [rows, setRows] = useState<CustomerWorkspaceProperty[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const alive = useRef(true), sequence = useRef(0), controller = useRef<AbortController | null>(null);
  const cursors = useRef(new Set<string>()), change = useRef(onChange);
  change.current = onChange;
  const helpId = useId();
  const contextValid = customerWorkspacePropertySchema.shape.id.safeParse(contactId).success && customerWorkspacePropertySchema.shape.id.safeParse(organizationId).success;

  async function load(cursor: string | null = null) {
    if (!contextValid) return;
    controller.current?.abort();
    const request = new AbortController(); controller.current = request;
    const current = ++sequence.current;
    setLoading(true); setFailed(false);
    if (!cursor) { setRows([]); setNextCursor(null); setLoaded(false); cursors.current.clear(); change.current(''); }
    const isCurrent = () => alive.current && current === sequence.current && !request.signal.aborted;
    try {
      const response = await fetch(`/api/v1/contacts/${encodeURIComponent(contactId)}/workspace/properties${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, { credentials: 'include', cache: 'no-store', signal: request.signal });
      if (!response.ok) throw new Error('Properties unavailable');
      const page = customerWorkspacePageSchema.parse(await response.json());
      if (!isCurrent()) return;
      if (page.section !== 'properties' || page.organizationId !== organizationId || page.contactId !== contactId || page.hasMore !== (page.nextCursor !== null) || (page.nextCursor !== null && (!/^[A-Za-z0-9_-]+$/.test(page.nextCursor) || page.nextCursor === cursor || cursors.current.has(page.nextCursor)))) throw new Error('Property context changed');
      const combined = cursor ? [...rows, ...page.items] : page.items;
      if (new Set(combined.map(row => row.id)).size !== combined.length) throw new Error('Property pages overlap');
      if (cursor) cursors.current.add(cursor);
      setRows(combined); setNextCursor(page.nextCursor); setLoaded(true);
    } catch {
      if (!isCurrent()) return;
      setRows([]); setNextCursor(null); setLoaded(false); setFailed(true); change.current('');
    } finally { if (isCurrent()) setLoading(false); }
  }

  useEffect(() => {
    alive.current = true;
    change.current('');
    if (contextValid) void load();
    return () => { alive.current = false; ++sequence.current; controller.current?.abort(); };
  }, []);

  const selected = rows.some(row => row.id === value) ? value : '';
  return <div className="min-w-0 space-y-2 text-sm">
    <label className="block min-w-0">Property for this new {purpose}
      <select aria-describedby={helpId} className="block min-h-11 w-full min-w-0 max-w-full rounded-lg border bg-background p-2" value={selected} disabled={disabled || !contextValid || loading || failed} onChange={event => onChange(rows.some(row => row.id === event.target.value) ? event.target.value : '')}>
        <option value="">No property linked</option>
        {rows.map(row => <option key={row.id} value={row.id}>{[row.addressLine1, row.addressLine2, row.city, row.state, row.postalCode].filter(Boolean).join(', ')}</option>)}
      </select>
    </label>
    <p id={helpId} className="text-muted-foreground">{purpose === 'appointment' ? 'Optional. Choose a property only for this new appointment. Existing visits and their notes are not changed.' : 'Optional. Choose a property only for this new service record. Existing service history is not changed.'}</p>
    {!contextValid && <p className="text-muted-foreground">Choose a customer to check their linked properties.</p>}
    {loading && <p role="status">Checking customer properties…</p>}
    {failed && <div role="alert"><p>Customer properties could not be verified. No property is selected; this is not an empty-property result.</p><button type="button" disabled={disabled} className="min-h-11 underline" onClick={() => void load()}>Retry customer properties</button></div>}
    {loaded && !loading && !failed && <>
      <p className="text-muted-foreground">{rows.length ? `${rows.length} linked properties loaded.${nextCursor ? ' More properties are available.' : ''}` : 'No linked properties were found for this customer.'}</p>
      <div className="flex flex-wrap gap-2">
        {nextCursor && <button type="button" disabled={disabled} className="min-h-11 rounded border px-3" onClick={() => void load(nextCursor)}>Load more customer properties</button>}
        <button type="button" disabled={disabled} className="min-h-11 underline" onClick={() => void load()}>Refresh properties and clear selection</button>
      </div>
    </>}
  </div>;
}
