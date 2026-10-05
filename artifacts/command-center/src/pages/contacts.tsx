import { Loader2, Search, Plus, Mail, Phone, Edit, Trash2, User, X } from 'lucide-react';
import { canWrite, canDelete } from '@/lib/permissions';
import { useGetMe } from '@workspace/api-client-react';
import { format } from 'date-fns';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { ToastAction } from '@/components/ui/toast';
import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useListContacts, useCreateContact, useUpdateContact, useDeleteContact, getListContactsQueryKey, listContacts, deleteContact as deleteContactRequest, type Contact } from '@workspace/api-client-react';
import { useToast, toast as globalToast } from '@/hooks/use-toast';
import { Link } from 'wouter';
import { customerWorkspacePath } from '@/lib/customer-workspace-links';

export default function Contacts() {
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  // Use a simple timeout for debouncing search
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  
  const handleSearch = (val: string) => {
    setSearch(val);
    clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => setDebouncedSearch(val), 300);
  };

  const contactParams = { search: debouncedSearch || undefined };
  const { data: contacts, isLoading, dataUpdatedAt } = useListContacts(contactParams);

  // Extra pages loaded as the rep scrolls past the first server page (200 rows).
  const PAGE_SIZE = 200;
  const [extraContacts, setExtraContacts] = useState<Contact[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reachedEnd, setReachedEnd] = useState(false);
  const paramsKey = JSON.stringify(contactParams);
  const loadTokenRef = useRef(0);
  useEffect(() => {
    // Search changed or the first page refetched: drop stale extra pages.
    loadTokenRef.current += 1;
    setExtraContacts([]);
    setReachedEnd(false);
    setLoadingMore(false);
  }, [paramsKey, dataUpdatedAt]);

  const firstPage = contacts ?? [];
  const hasMore = !reachedEnd && firstPage.length >= PAGE_SIZE;
  const loadMore = useCallback(async () => {
    if (loadingMore || reachedEnd || firstPage.length < PAGE_SIZE) return;
    const token = loadTokenRef.current;
    setLoadingMore(true);
    try {
      const next = await listContacts({
        ...contactParams,
        offset: firstPage.length + extraContacts.length,
      });
      if (token !== loadTokenRef.current) return; // search changed mid-flight
      setExtraContacts(prev => {
        const seen = new Set([...firstPage, ...prev].map(c => c.id));
        return [...prev, ...next.filter(c => !seen.has(c.id))];
      });
      if (next.length < PAGE_SIZE) setReachedEnd(true);
    } catch {
      // Leave state untouched; scrolling again retries.
    } finally {
      if (token === loadTokenRef.current) setLoadingMore(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadingMore, reachedEnd, firstPage, extraContacts.length, paramsKey]);

  const allContacts = useMemo(() => [...firstPage, ...extraContacts], [firstPage, extraContacts]);
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (!hasMore) return;
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 300) loadMore();
  };

  const { data: me, isError: memberError } = useGetMe();
  const workRecordPath = (contact: Contact) => !memberError && me?.isActive && contact.organizationId === me.organization?.id
    ? customerWorkspacePath(contact.id, contact.organizationId) : null;
  const queryClient = useQueryClient();
  
  const canEdit = canWrite(me?.role);
  const canDel = canDelete(me?.role);

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingContact, setEditingContact] = useState<any>(null);

  const deleteContact = useDeleteContact();

  const handleDelete = (id: string) => {
    if (!confirm('Are you sure you want to delete this contact?')) return;
    deleteContact.mutate({ id }, {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getListContactsQueryKey() }),
      onError: () => showContactDeleteFailedToast(id, queryClient),
    });
  };

  const openEdit = (contact: any) => {
    setEditingContact(contact);
    setIsFormOpen(true);
  };

  const openCreate = () => {
    setEditingContact(null);
    setIsFormOpen(true);
  };

  return (
    <div className="flex flex-col h-full bg-background overflow-hidden">
      <header className="px-4 py-3 md:px-6 md:py-4 border-b border-border flex flex-col md:flex-row md:items-center justify-between bg-card shrink-0 gap-4 sticky top-0 z-10">
        <div>
          <h1 className="text-xl md:text-2xl font-bold tracking-tight text-foreground">Contacts</h1>
          <p className="hidden md:block text-sm text-muted-foreground">Directory of all clients and stakeholders.</p>
        </div>
        <div className="flex items-center gap-3 md:gap-4 w-full md:w-auto">
          <div className="relative flex-1 md:w-64">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input 
              type="search"
              value={search}
              onChange={e => handleSearch(e.target.value)}
              placeholder="Search contacts..."
              className="w-full pl-9 pr-4 py-2.5 md:py-2 text-sm md:text-base bg-muted/50 border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary shadow-sm"
            />
          </div>
          {canEdit && (
            <button data-testid="add-contact" onClick={openCreate} className="bg-primary text-primary-foreground hover:bg-primary/90 px-4 py-2.5 md:px-3 md:py-2 rounded-xl text-sm font-semibold flex items-center gap-2 transition-transform active:scale-95 shrink-0 shadow-sm shadow-primary/20">
              <Plus className="w-4 h-4" /> <span className="hidden md:inline">Add Contact</span>
            </button>
          )}
        </div>
      </header>

      <div className="flex-1 overflow-auto p-4 md:p-6 pb-20 md:pb-6" onScroll={handleScroll}>
        {isLoading ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        ) : (
          <>
            {/* Mobile Card List */}
            <div className="md:hidden space-y-3">
               {allContacts.map(contact => (
                 <div key={contact.id} className="bg-card border border-border rounded-xl p-4 shadow-sm relative">
                    <div className="flex justify-between items-start mb-3">
                       <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center text-primary shrink-0">
                             <User className="w-5 h-5" />
                          </div>
                          <div>
                            <div className="font-bold text-foreground text-base">{workRecordPath(contact) ? <Link href={workRecordPath(contact)!} className="inline-flex min-h-11 items-center text-primary hover:underline" aria-label={`Open customer work record for ${contact.firstName} ${contact.lastName || ''}`}>{contact.firstName} {contact.lastName}</Link> : <>{contact.firstName} {contact.lastName}</>}</div>
                            <div className="text-[10px] text-muted-foreground font-mono opacity-60">ID: {contact.id.substring(0,8)}</div>
                          </div>
                       </div>
                       <div className="flex gap-1">
                          {canEdit && (
                            <button data-testid="edit-contact" aria-label={`Edit ${contact.firstName} ${contact.lastName}`} onClick={() => openEdit(contact)} className="w-8 h-8 flex items-center justify-center text-muted-foreground hover:text-primary hover:bg-primary/10 rounded-full transition-colors active:scale-95">
                              <Edit className="w-4 h-4" />
                            </button>
                          )}
                          {canDel && (
                            <button data-testid="delete-contact" aria-label={`Delete ${contact.firstName} ${contact.lastName}`} onClick={() => handleDelete(contact.id)} className="w-8 h-8 flex items-center justify-center text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-full transition-colors active:scale-95">
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                       </div>
                    </div>
                    <div className="space-y-2 text-sm bg-muted/20 p-3 rounded-lg border border-border/50">
                      {contact.email ? (
                        <div className="flex items-center gap-2 text-foreground font-medium">
                          <Mail className="w-3.5 h-3.5 text-muted-foreground shrink-0" /> {contact.email}
                        </div>
                      ) : (
                        <div className="flex items-center gap-2 text-muted-foreground/50 italic">
                           <Mail className="w-3.5 h-3.5 shrink-0" /> No email
                        </div>
                      )}
                      {contact.phone ? (
                        <div className="flex items-center gap-2 text-foreground font-mono font-medium">
                          <Phone className="w-3.5 h-3.5 text-muted-foreground shrink-0" /> {contact.phone}
                        </div>
                      ) : (
                        <div className="flex items-center gap-2 text-muted-foreground/50 italic font-mono">
                           <Phone className="w-3.5 h-3.5 shrink-0" /> No phone
                        </div>
                      )}
                    </div>
                    <div className="mt-3 text-[10px] uppercase tracking-widest text-muted-foreground font-semibold text-right">
                       Added {format(new Date(contact.createdAt), 'MMM d, yyyy')}
                    </div>
                 </div>
               ))}
               {loadingMore && (
                 <div className="flex justify-center py-3">
                   <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                 </div>
               )}
               {!allContacts.length && (
                 <div className="py-12 text-center text-muted-foreground border-2 border-dashed border-border rounded-xl bg-muted/10">
                   No contacts found.
                 </div>
               )}
            </div>

            {/* Desktop Table */}
            <div className="hidden md:block bg-card border border-border rounded-xl overflow-hidden shadow-sm">
              <table className="w-full text-sm text-left whitespace-nowrap">
                <thead className="text-xs text-muted-foreground uppercase tracking-widest bg-muted/30 border-b border-border font-bold">
                  <tr>
                    <th className="px-6 py-4">Name</th>
                    <th className="px-6 py-4">Contact Info</th>
                    <th className="px-6 py-4">Created</th>
                    <th className="px-6 py-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {allContacts.map(contact => (
                    <tr key={contact.id} className="hover:bg-muted/30 transition-colors group">
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                           <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-primary shrink-0 group-hover:bg-primary group-hover:text-primary-foreground transition-colors">
                              <User className="w-4 h-4" />
                           </div>
                           <div>
                              <div className="font-bold text-foreground text-base">{workRecordPath(contact) ? <Link href={workRecordPath(contact)!} className="inline-flex min-h-11 items-center text-primary hover:underline" aria-label={`Open customer work record for ${contact.firstName} ${contact.lastName || ''}`}>{contact.firstName} {contact.lastName}</Link> : <>{contact.firstName} {contact.lastName}</>}</div>
                              <div className="text-[10px] text-muted-foreground font-mono mt-0.5 opacity-60">ID: {contact.id.substring(0,8)}</div>
                           </div>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex flex-col gap-1.5">
                          {contact.email && (
                            <div className="flex items-center gap-2 text-foreground font-medium">
                              <Mail className="w-3.5 h-3.5 text-muted-foreground" /> {contact.email}
                            </div>
                          )}
                          {contact.phone && (
                            <div className="flex items-center gap-2 text-foreground font-mono font-medium">
                              <Phone className="w-3.5 h-3.5 text-muted-foreground" /> {contact.phone}
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4 text-muted-foreground font-mono text-xs">
                        {format(new Date(contact.createdAt), 'MMM d, yyyy')}
                      </td>
                      <td className="px-6 py-4 text-right space-x-2">
                        {canEdit && (
                          <button data-testid="edit-contact" aria-label={`Edit ${contact.firstName} ${contact.lastName}`} onClick={() => openEdit(contact)} className="text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors p-2 rounded-lg active:scale-95">
                            <Edit className="w-4 h-4" />
                          </button>
                        )}
                        {canDel && (
                          <button data-testid="delete-contact" aria-label={`Delete ${contact.firstName} ${contact.lastName}`} onClick={() => handleDelete(contact.id)} className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors p-2 rounded-lg active:scale-95">
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {loadingMore && (
                    <tr>
                      <td colSpan={4} className="px-6 py-4 text-center">
                        <Loader2 className="w-4 h-4 animate-spin text-muted-foreground inline-block" />
                      </td>
                    </tr>
                  )}
                  {!allContacts.length && (
                    <tr>
                      <td colSpan={4} className="px-6 py-12 text-center text-muted-foreground text-sm font-medium">
                        No contacts found.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {isFormOpen && (
        <ContactFormModal 
          contact={editingContact} 
          onClose={() => setIsFormOpen(false)} 
        />
      )}
    </div>
  );
}

/**
 * Error toast with a Retry action for the one-shot contact delete. Lives at
 * module level (global toast store + plain fetch client) so retrying keeps
 * working across re-renders, mirroring showStatusChangeFailedToast in pipeline.tsx.
 */
function showContactDeleteFailedToast(contactId: string, queryClient: QueryClient) {
  const { dismiss } = globalToast({
    variant: 'destructive',
    title: 'Contact not deleted',
    description: 'Deleting the contact failed. Retry below.',
    action: (
      <ToastAction
        altText="Retry contact delete"
        onClick={async () => {
          try {
            await deleteContactRequest(contactId);
            queryClient.invalidateQueries({ queryKey: getListContactsQueryKey() });
            dismiss();
          } catch {
            showContactDeleteFailedToast(contactId, queryClient);
          }
        }}
      >
        Retry
      </ToastAction>
    ),
  });
}
function ContactFormModal({ contact, onClose }: { contact?: any, onClose: () => void }) {
  const [firstName, setFirstName] = useState(contact?.firstName || '');
  const [lastName, setLastName] = useState(contact?.lastName || '');
  const [email, setEmail] = useState(contact?.email || '');
  const [phone, setPhone] = useState(contact?.phone || '');
  
  const createContact = useCreateContact();
  const updateContact = useUpdateContact();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const isSubmitting = createContact.isPending || updateContact.isPending;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!firstName.trim()) return;

    const data = {
      firstName,
      lastName: lastName || undefined,
      email: email || undefined,
      phone: phone || undefined,
    };

    const handleSaveError = (error: unknown) => {
      const serverMessage =
        error && typeof error === 'object' && 'data' in error
          ? (error as { data?: { error?: string } }).data?.error
          : undefined;
      toast({
        variant: 'destructive',
        title: contact ? 'Contact not saved' : 'Contact not created',
        description: serverMessage || 'Saving the contact failed. Check your connection and try again.',
      });
    };

    if (contact) {
      updateContact.mutate({ id: contact.id, data }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListContactsQueryKey() });
          onClose();
        },
        onError: handleSaveError,
      });
    } else {
      createContact.mutate({ data }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListContactsQueryKey() });
          onClose();
        },
        onError: handleSaveError,
      });
    }
  };

  return (
    <div className="fixed inset-0 bg-background/90 backdrop-blur-sm z-50 flex items-end md:items-center justify-center p-0 md:p-4 animate-in fade-in duration-200">
      <div className="bg-card border-t md:border border-border shadow-2xl md:rounded-2xl rounded-t-2xl w-full max-w-md overflow-hidden mt-auto md:mt-0 animate-in slide-in-from-bottom-8 md:slide-in-from-bottom-0 md:zoom-in-95 duration-300 pb-safe md:pb-0">
        <div className="p-4 md:p-6 border-b border-border flex justify-between items-center bg-muted/20">
          <h2 className="text-lg font-bold text-foreground">{contact ? 'Edit Contact' : 'New Contact'}</h2>
          <button onClick={onClose} aria-label="Close" className="w-8 h-8 flex items-center justify-center rounded-full bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground active:scale-95 transition-all">
             <X className="w-4 h-4" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-4 md:p-6 space-y-4 md:space-y-5">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-[10px] md:text-xs font-bold text-muted-foreground uppercase tracking-widest">First Name *</label>
              <input 
                required
                className="w-full bg-background border border-border rounded-xl px-4 py-3 md:py-2.5 text-base md:text-sm focus:ring-2 focus:ring-primary focus:outline-none shadow-sm transition-all"
                value={firstName} onChange={e => setFirstName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] md:text-xs font-bold text-muted-foreground uppercase tracking-widest">Last Name</label>
              <input 
                className="w-full bg-background border border-border rounded-xl px-4 py-3 md:py-2.5 text-base md:text-sm focus:ring-2 focus:ring-primary focus:outline-none shadow-sm transition-all"
                value={lastName} onChange={e => setLastName(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="text-[10px] md:text-xs font-bold text-muted-foreground uppercase tracking-widest">Email</label>
            <input 
              type="email"
              className="w-full bg-background border border-border rounded-xl px-4 py-3 md:py-2.5 text-base md:text-sm focus:ring-2 focus:ring-primary focus:outline-none shadow-sm transition-all"
              value={email} onChange={e => setEmail(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-[10px] md:text-xs font-bold text-muted-foreground uppercase tracking-widest">Phone</label>
            <input 
              type="tel"
              className="w-full bg-background border border-border rounded-xl px-4 py-3 md:py-2.5 text-base md:text-sm focus:ring-2 focus:ring-primary focus:outline-none font-mono shadow-sm transition-all"
              value={phone} onChange={e => setPhone(e.target.value)}
            />
          </div>
          
          <div className="pt-6 md:pt-4 flex flex-col-reverse md:flex-row justify-end gap-3">
            <button type="button" onClick={onClose} className="w-full md:w-auto px-4 py-3 md:py-2 text-base md:text-sm font-semibold hover:bg-muted rounded-xl border border-transparent hover:border-border transition-all active:scale-95">Cancel</button>
            <button type="submit" disabled={isSubmitting} className="w-full md:w-auto bg-primary text-primary-foreground px-6 py-3 md:py-2 rounded-xl text-base md:text-sm font-bold shadow-sm shadow-primary/20 hover:shadow-primary/40 hover:bg-primary/90 transition-all active:scale-95 disabled:opacity-50 flex items-center justify-center min-w-[120px]">
              {isSubmitting ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Save Contact'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
