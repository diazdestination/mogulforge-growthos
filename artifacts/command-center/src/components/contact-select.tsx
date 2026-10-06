import { useMemo, useState } from 'react';
import { getListContactsQueryKey, useListContacts, type Contact } from '@workspace/api-client-react';
import { Search } from 'lucide-react';
import { useDebouncedValue } from '@/hooks/use-debounced-value';

/** Max options shown; we fetch one extra to detect more matches beyond the cap. */
const MAX_CONTACT_OPTIONS = 50;

export function contactOptionLabel(contact: Pick<Contact, 'id' | 'firstName' | 'lastName' | 'email'>) {
  const name = `${contact.firstName ?? ''} ${contact.lastName ?? ''}`.trim();
  return name || contact.email || contact.id.substring(0, 8);
}

/**
 * Searchable contact picker backed by server-side `search`/`limit` on the
 * contacts API, so any contact is reachable in large orgs instead of only the
 * newest rows of a capped full download.
 */
export default function ContactSelect({
  value,
  onChange,
  required,
  noneLabel = '-- None --',
  testId = 'contact-select',
  queryScope,
  label,
}: {
  value: string;
  onChange: (contactId: string) => void;
  required?: boolean;
  /** Label for the empty option. Ignored when `required`. */
  noneLabel?: string;
  testId?: string;
  /** Isolate sensitive option caches when the member/company authority changes. */
  queryScope?: string;
  label?: string;
}) {
  const [search, setSearch] = useState('');
  // Remember the selected contact's label so it stays visible even when the
  // current search results no longer include it.
  const [selectedLabel, setSelectedLabel] = useState<string | null>(null);
  const debouncedSearch = useDebouncedValue(search.trim(), 300);

  const params = {
    ...(debouncedSearch ? { search: debouncedSearch } : {}),
    limit: MAX_CONTACT_OPTIONS + 1,
  };
  const { data, isLoading } = useListContacts(params, queryScope ? { query: { queryKey: [...getListContactsQueryKey(params), queryScope] } } : undefined);

  const { visibleContacts, hasMore } = useMemo(() => {
    const rows = data ?? [];
    return { visibleContacts: rows.slice(0, MAX_CONTACT_OPTIONS), hasMore: rows.length > MAX_CONTACT_OPTIONS };
  }, [data]);

  const selectedInResults = !!value && visibleContacts.some(c => c.id === value);

  const handleChange = (id: string) => {
    const contact = visibleContacts.find(c => c.id === id);
    setSelectedLabel(contact ? contactOptionLabel(contact) : null);
    onChange(id);
  };

  return (
    <div className="space-y-1.5">
      <div className="relative">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <input
          type="search"
          aria-label={label ? `${label} search` : undefined}
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search contacts by name, email, or phone..."
          data-testid={`${testId}-search`}
          className="w-full pl-9 pr-3 py-2 text-sm bg-muted/50 border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
        />
      </div>
      <select
        aria-label={label}
        required={required}
        value={value}
        onChange={e => handleChange(e.target.value)}
        data-testid={testId}
        className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-primary focus:outline-none"
      >
        <option value="">{required ? '-- Select Contact --' : noneLabel}</option>
        {value && !selectedInResults && (
          <option value={value}>{selectedLabel || value.substring(0, 8)}</option>
        )}
        {visibleContacts.map(contact => (
          <option key={contact.id} value={contact.id}>{contactOptionLabel(contact)}</option>
        ))}
      </select>
      {isLoading ? (
        <p className="text-xs text-muted-foreground">Searching…</p>
      ) : hasMore ? (
        <p className="text-xs text-muted-foreground">More matches exist — refine the search to narrow them down.</p>
      ) : debouncedSearch && visibleContacts.length === 0 ? (
        <p className="text-xs text-muted-foreground">No contacts match "{debouncedSearch}".</p>
      ) : null}
    </div>
  );
}
