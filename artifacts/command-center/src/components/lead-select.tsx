import { useMemo, useState } from 'react';
import { getListLeadsQueryKey, useListLeads, type Lead } from '@workspace/api-client-react';
import { Search } from 'lucide-react';
import { useDebouncedValue } from '@/hooks/use-debounced-value';

/** Max options shown; we fetch one extra to detect more matches beyond the cap. */
const MAX_LEAD_OPTIONS = 50;

export function leadOptionLabel(lead: Pick<Lead, 'id' | 'contactName' | 'summary' | 'serviceType'>) {
  return lead.contactName || lead.summary || lead.serviceType || lead.id.substring(0, 8);
}

/**
 * Searchable lead picker backed by server-side `search`/`limit` on the leads
 * API, so it stays responsive for orgs with thousands of leads instead of
 * filtering a full (200-capped) download client-side.
 */
export default function LeadSelect({
  value,
  onChange,
  required,
  noneLabel = '-- None --',
  withStatus = false,
  testId = 'lead-select',
  id,
  label = 'Lead',
  queryScope,
}: {
  value: string;
  onChange: (leadId: string) => void;
  required?: boolean;
  /** Label for the empty option. Ignored when `required`. */
  noneLabel?: string;
  /** Append the lead status to each option label. */
  withStatus?: boolean;
  testId?: string;
  id?: string;
  /** Accessible name for the selection and its search input. */
  label?: string;
  /** Isolate option caches when the current member/company authority changes. */
  queryScope?: string;
}) {
  const [search, setSearch] = useState('');
  // Remember the selected lead's label so it stays visible even when the
  // current search results no longer include it.
  const [selectedLabel, setSelectedLabel] = useState<string | null>(null);
  const debouncedSearch = useDebouncedValue(search.trim(), 300);

  const params = {
    ...(debouncedSearch ? { search: debouncedSearch } : {}),
    limit: MAX_LEAD_OPTIONS + 1,
  };
  const { data, isLoading } = useListLeads(params, queryScope ? { query: { queryKey: [...getListLeadsQueryKey(params), queryScope] } } : undefined);

  const { visibleLeads, hasMore } = useMemo(() => {
    const rows = data ?? [];
    return { visibleLeads: rows.slice(0, MAX_LEAD_OPTIONS), hasMore: rows.length > MAX_LEAD_OPTIONS };
  }, [data]);

  const optionLabel = (lead: Lead) =>
    withStatus ? `${leadOptionLabel(lead)} (${lead.status.replace(/_/g, ' ')})` : leadOptionLabel(lead);

  const selectedInResults = !!value && visibleLeads.some(l => l.id === value);

  const handleChange = (id: string) => {
    const lead = visibleLeads.find(l => l.id === id);
    setSelectedLabel(lead ? optionLabel(lead) : null);
    onChange(id);
  };

  return (
    <div className="space-y-1.5">
      <div className="relative">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <input
          aria-label={`Search ${label.toLowerCase()}`}
          type="search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search leads by contact or service..."
          data-testid={`${testId}-search`}
          className="w-full pl-9 pr-3 py-2 text-sm bg-muted/50 border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
        />
      </div>
      <select
        id={id}
        aria-label={label}
        required={required}
        value={value}
        onChange={e => handleChange(e.target.value)}
        data-testid={testId}
        className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-primary focus:outline-none"
      >
        <option value="">{required ? '-- Select Lead --' : noneLabel}</option>
        {value && !selectedInResults && (
          <option value={value}>{selectedLabel || value.substring(0, 8)}</option>
        )}
        {visibleLeads.map(lead => (
          <option key={lead.id} value={lead.id}>{optionLabel(lead)}</option>
        ))}
      </select>
      {isLoading ? (
        <p className="text-xs text-muted-foreground">Searching…</p>
      ) : hasMore ? (
        <p className="text-xs text-muted-foreground">More matches exist — refine the search to narrow them down.</p>
      ) : debouncedSearch && visibleLeads.length === 0 ? (
        <p className="text-xs text-muted-foreground">No leads match "{debouncedSearch}".</p>
      ) : null}
    </div>
  );
}
