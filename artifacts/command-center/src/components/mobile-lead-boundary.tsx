import { useEffect, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Link } from 'wouter';
import { notificationContext } from '@/lib/mobile-lead';
import { enforcePushOwner, renewExistingDevicePush } from '@/lib/staff-push';

/** Remounted by identity. No authenticated query cache is shared across accounts. */
export function TenantMobileBoundary({ userId, organizationId, children }: { userId: string; organizationId: string; children: ReactNode }) {
  const [client] = useState(() => new QueryClient());
  const [cleanupError, setCleanupError] = useState(false);
  useEffect(() => {
    let mounted = true;
    void enforcePushOwner(userId, organizationId).then(() => renewExistingDevicePush(userId, organizationId)).catch(() => { if (mounted) setCleanupError(true); });
    return () => { mounted = false; void client.cancelQueries(); client.clear(); };
  }, [client, userId, organizationId]);
  return <QueryClientProvider client={client}>
    {cleanupError && <p role="alert" className="p-3 bg-destructive/10 text-sm">Phone notification setup needs attention. Open My Profile to reconnect alerts. Before sharing this device, sign out and turn off GrowthOS notifications in device settings.</p>}
    {children}
  </QueryClientProvider>;
}

export function NotificationLeadGuard({ organizationId, children, path = window.location.pathname + window.location.search }: { organizationId?: string | null; children: ReactNode; path?: string }) {
  const decision = notificationContext(path, window.location.origin, organizationId);
  if (decision === 'allowed' || decision === 'ordinary') return <>{children}</>;
  return <section className="p-6 space-y-3" role="alert">
    <h1 className="text-xl font-bold">This lead notification cannot be opened in this account</h1>
    <p>{decision === 'different-company' ? 'You are signed in to a different company. Sign out and sign in with the company account that received this notification.' : 'This notification link is invalid. Open the lead from your pipeline instead.'}</p>
    <p>No company was switched and no lead details were loaded.</p>
    <Link href="/pipeline" className="text-primary underline">Open my pipeline</Link>
  </section>;
}
