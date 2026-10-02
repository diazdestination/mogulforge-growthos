import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useListUsers } from '@workspace/api-client-react';
import { canWrite } from '@/lib/permissions';
import { staffPushRequest } from '@/lib/staff-push';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export interface LeadAlertPolicy {
  enabled: boolean;
  timezone: string;
  days: number[];
  opensAt: string;
  closesAt: string;
  businessHoursUserIds: string[];
  afterHoursUserIds: string[];
}
const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const emptyPolicy: LeadAlertPolicy = {
  enabled: false, timezone: 'America/New_York', days: [1, 2, 3, 4, 5], opensAt: '09:00', closesAt: '18:00',
  businessHoursUserIds: [], afterHoursUserIds: [],
};
const inputClass = 'w-full rounded-md border bg-background px-3 py-2 text-sm';

export function LeadAlertRouting() {
  const queryClient = useQueryClient();
  const policyQuery = useQuery({ queryKey: ['staff-push', 'policy'], queryFn: () => staffPushRequest<{ policy: LeadAlertPolicy | null }>('policy'), retry: false });
  const usersQuery = useListUsers();
  const [policy, setPolicy] = useState<LeadAlertPolicy>(emptyPolicy);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { if (policyQuery.data) setPolicy(policyQuery.data.policy ?? emptyPolicy); }, [policyQuery.data]);
  const users = usersQuery.data?.filter((user) => user.isActive && canWrite(user.role)) ?? [];
  const selectedIds = [...policy.businessHoursUserIds, ...policy.afterHoursUserIds];
  const unavailable = selectedIds.some((id) => !users.some((u) => u.id === id));
  const complete = policy.days.length > 0 && policy.opensAt < policy.closesAt && policy.businessHoursUserIds.length > 0 && policy.afterHoursUserIds.length > 0 && !unavailable;
  const ready = Boolean(policyQuery.data) && Boolean(usersQuery.data) && !policyQuery.isError && !usersQuery.isError;
  const dirty = JSON.stringify(policy) !== JSON.stringify(policyQuery.data?.policy ?? emptyPolicy);

  function toggleUser(field: 'businessHoursUserIds' | 'afterHoursUserIds', id: string, checked: boolean) {
    setPolicy((value) => ({ ...value, [field]: checked ? [...value[field], id] : value[field].filter((current) => current !== id) }));
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!ready || !complete || saving) return;
    setSaving(true); setNotice(''); setError('');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch('/api/v1/staff-push/policy', {
        method: 'PUT', credentials: 'include', cache: 'no-store', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(policy),
      });
      if (!response.ok) throw new Error('Routing was not saved. Check the time zone, hours and active responders, then retry.');
      const result = await response.json() as { policy: LeadAlertPolicy };
      queryClient.setQueryData(['staff-push', 'policy'], result);
      await queryClient.invalidateQueries({ queryKey: ['staff-push', 'status'] });
      setNotice('Lead-alert routing saved. Each selected person must enable this device in My Profile. Platform sending controls still apply.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save routing.');
    } finally { clearTimeout(timeout); setSaving(false); }
  }

  return <Card>
    <CardHeader>
      <CardTitle>New-lead phone alerts</CardTitle>
      <CardDescription>Choose which staff receive Home Screen notifications during normal hours and after hours. This does not send a text to the customer or change customer outreach hours.</CardDescription>
    </CardHeader>
    <CardContent className="space-y-4">
      {policyQuery.isLoading || usersQuery.isLoading ? <p role="status">Loading alert routing…</p> : null}
      {(policyQuery.isError || usersQuery.isError) && <p role="alert">Could not load routing or your team. Reload online before making changes.</p>}
      {policyQuery.data?.policy === null && <p className="text-sm">No alert routing has been saved. The schedule below is an editable starting point, not active coverage.</p>}
      <form onSubmit={save} className="space-y-5">
        <fieldset disabled={!ready || saving} className="space-y-5">
          <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={policy.enabled} onChange={(e) => setPolicy({ ...policy, enabled: e.target.checked })} /> Route new-lead notifications to the selected staff</label>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="space-y-1 text-sm">Business time zone<input aria-label="Business time zone" className={inputClass} value={policy.timezone} maxLength={80} required onChange={(e) => setPolicy({ ...policy, timezone: e.target.value })} /></label>
            <label className="space-y-1 text-sm">Opens at<input aria-label="Opens at" type="time" className={inputClass} value={policy.opensAt} required onChange={(e) => setPolicy({ ...policy, opensAt: e.target.value })} /></label>
            <label className="space-y-1 text-sm">Closes at<input aria-label="Closes at" type="time" className={inputClass} value={policy.closesAt} required onChange={(e) => setPolicy({ ...policy, closesAt: e.target.value })} /></label>
          </div>
          <p className="text-xs text-muted-foreground">Use an IANA zone such as America/New_York. Daylight saving adjusts automatically. Opening is inclusive; closing and all unselected days are after-hours coverage.</p>
          <fieldset className="space-y-2"><legend className="text-sm font-medium">Normal business days</legend><div className="flex flex-wrap gap-3">{weekdays.map((day, i) => <label key={day} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={policy.days.includes(i + 1)} onChange={(e) => setPolicy({ ...policy, days: e.target.checked ? [...policy.days, i + 1].sort() : policy.days.filter((d) => d !== i + 1) })} />{day}</label>)}</div></fieldset>
          <div className="grid gap-4 sm:grid-cols-2">{([
            ['businessHoursUserIds', 'During business hours'], ['afterHoursUserIds', 'After hours and closed days'],
          ] as const).map(([field, title]) => <fieldset key={field} className="space-y-2 rounded-lg border p-3"><legend className="px-1 text-sm font-medium">{title}</legend>{users.length === 0 && <p className="text-sm">Add an active responder in Team first.</p>}{users.map((user) => <label key={user.id} className="flex items-center gap-2 text-sm"><input type="checkbox" aria-label={`${title}: ${[user.firstName, user.lastName].filter(Boolean).join(' ') || user.email || 'Staff member'}`} checked={policy[field].includes(user.id)} onChange={(e) => toggleUser(field, user.id, e.target.checked)} />{[user.firstName, user.lastName].filter(Boolean).join(' ') || user.email || 'Staff member'}</label>)}</fieldset>)}</div>
          {unavailable && <div className="text-sm" role="alert">A saved responder is no longer active or available. <button type="button" className="underline" onClick={() => setPolicy({ ...policy, businessHoursUserIds: policy.businessHoursUserIds.filter((id) => users.some((u) => u.id === id)), afterHoursUserIds: policy.afterHoursUserIds.filter((id) => users.some((u) => u.id === id)) })}>Remove unavailable responders</button>, then choose current staff.</div>}
          {!complete && ready && <p className="text-sm">Select at least one business day and an active responder for both time windows. Closing time must follow opening time.</p>}
          <Button type="submit" disabled={!ready || !complete || !dirty || saving}>{saving ? 'Saving…' : 'Save lead-alert routing'}</Button>
        </fieldset>
      </form>
      {notice && <p role="status" className="text-sm">{notice}</p>}
      {error && <p role="alert" className="text-sm">{error}</p>}
      <p className="text-xs text-muted-foreground">Responders opt in under <a href="/account" className="underline">My Profile → GrowthOS on your phone</a>. A saved policy does not prove device delivery. Focus modes, connectivity and expired sign-ins can prevent alerts. Imports and existing-lead updates do not create a new-lead notification.</p>
    </CardContent>
  </Card>;
}
