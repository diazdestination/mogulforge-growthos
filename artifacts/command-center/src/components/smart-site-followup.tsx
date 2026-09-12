import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { Clock3, UserCheck, ArrowUpRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

type Inquiry = {
  leadId: string;
  name: string;
  service: string;
  siteName: string;
  assignedUserId: string | null;
  dueAt: string | null;
  receivedAt: string;
  firstAttemptAt: string | null;
};
type Followup = {
  serverNow: string;
  summary: {
    awaitingAttempt: number;
    unassigned: number;
    overdue: number;
    noTarget: number;
    logged: number;
    medianMinutesToLog: number | null;
  };
  pending: Inquiry[];
  members: { id: string; name: string }[];
};
async function api<T>(
  path: string,
  body?: unknown,
  method = 'POST',
): Promise<T> {
  const response = await fetch(`/api/v1/smart-sites${path}`, {
    method: body ? method : 'GET',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const value = await response.json();
  if (!response.ok)
    throw new Error(
      value.error === 'owner_changed_refresh_first'
        ? 'Another teammate changed ownership. Refresh before assigning again.'
        : value.error ||
            'Could not save. Your entry is still here; please try again.',
    );
  return value;
}

export function SmartSiteFollowup({
  organizationId,
  userId,
  canWrite,
}: {
  organizationId: string;
  userId: string;
  canWrite: boolean;
}) {
  const client = useQueryClient();
  const report = useQuery({
    queryKey: ['smart-sites', organizationId, 'follow-up'],
    queryFn: async () => {
      const data = await api<Followup>('/follow-up');
      if (
        !data?.summary ||
        !Array.isArray(data.pending) ||
        !Array.isArray(data.members)
      )
        throw new Error('Follow-up information is unavailable.');
      return data;
    },
    refetchInterval: 30_000,
  });
  const refresh = async () => {
    await client.invalidateQueries({
      queryKey: ['smart-sites', organizationId],
    });
    await client.invalidateQueries({
      predicate: (q) =>
        /leads|tasks|activities|next-action|today-actions/.test(
          JSON.stringify(q.queryKey),
        ),
    });
  };
  const summary = report.data?.summary;
  return (
    <Card className="border-primary/30">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-xl">
            <Clock3 className="h-5 w-5 text-primary" /> No inquiry left waiting
          </CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void report.refetch()}
          >
            Refresh follow-up
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Assign a person. Make contact. Record what actually happened.
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        {report.error && (
          <p role="alert" className="text-sm text-destructive">
            {report.error.message}
          </p>
        )}
        <dl className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          {[
            ['Awaiting a logged attempt', summary?.awaitingAttempt],
            ['Past internal target', summary?.overdue],
            ['Need an owner', summary?.unassigned],
            [
              'Median time to first log',
              summary?.medianMinutesToLog == null
                ? 'Not yet measured'
                : `${Math.round(summary.medianMinutesToLog)} min`,
            ],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg border bg-background/60 p-3">
              <dt className="text-sm text-muted-foreground">{label}</dt>
              <dd className="mt-2 text-xl font-semibold tabular-nums">
                {report.isError || report.isLoading ? '—' : value}
              </dd>
            </div>
          ))}
        </dl>
        <p className="text-sm text-muted-foreground">
          Elapsed time to a staff-logged attempt—not verified delivery or a
          customer reply. Notes and stage changes do not count. Targets run
          24/7, including weekends; they are internal goals, not customer
          promises.
        </p>
        {!!summary?.noTarget && (
          <p className="text-sm">
            {summary.noTarget} earlier{' '}
            {summary.noTarget === 1 ? 'inquiry has' : 'inquiries have'} no
            target snapshot. Historical deadlines are not invented.
          </p>
        )}
        {report.data && (
          <div className="space-y-3">
            <p className="text-sm font-medium">
              Priority queue · up to 25 open inquiries needing an owner or first
              logged attempt
            </p>
            {report.data.pending.length ? (
              report.data.pending.map((lead) => (
                <FollowupItem
                  key={`${lead.leadId}:${lead.assignedUserId}:${lead.firstAttemptAt}`}
                  lead={lead}
                  members={report.data!.members}
                  now={report.data!.serverNow}
                  userId={userId}
                  canWrite={canWrite}
                  refresh={refresh}
                />
              ))
            ) : (
              <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
                No open inquiries need an owner or first logged attempt.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function FollowupItem({
  lead,
  members,
  now,
  userId,
  canWrite,
  refresh,
}: {
  lead: Inquiry;
  members: Followup['members'];
  now: string;
  userId: string;
  canWrite: boolean;
  refresh: () => Promise<void>;
}) {
  const [owner, setOwner] = useState(lead.assignedUserId ?? '');
  const [channel, setChannel] = useState('phone');
  const [outcome, setOutcome] = useState('no_answer');
  const [confirmed, setConfirmed] = useState(false);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [notice, setNotice] = useState('');
  const assignment = useMutation({
    mutationFn: (assignedUserId: string | null) =>
      api(
        `/leads/${lead.leadId}/owner`,
        { assignedUserId, expectedOwnerId: lead.assignedUserId },
        'PATCH',
      ),
    onSuccess: async () => {
      setNotice('Ownership saved.');
      await refresh();
    },
  });
  const attempt = useMutation({
    mutationFn: () =>
      api(`/leads/${lead.leadId}/contact-attempts`, {
        requestId,
        channel,
        outcome,
        confirmed,
      }),
    onSuccess: async () => {
      setNotice('Attempt recorded. No message was sent by this control.');
      setConfirmed(false);
      setRequestId(crypto.randomUUID());
      await refresh();
    },
  });
  const overdue =
    !lead.firstAttemptAt &&
    lead.dueAt &&
    Date.parse(lead.dueAt) <= Date.parse(now);
  const busy = assignment.isPending || attempt.isPending;
  const selectClass =
    'min-h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm';
  return (
    <article
      aria-label={`${lead.name} follow-up`}
      className="space-y-4 rounded-lg border bg-background/40 p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link
            href={`/leads/${lead.leadId}`}
            className="inline-flex items-center gap-2 font-medium"
          >
            {lead.name}
            <ArrowUpRight className="h-4 w-4 shrink-0" />
          </Link>
          <p className="text-sm text-muted-foreground">
            {lead.service} · {lead.siteName}
          </p>
        </div>
        <Badge variant={overdue ? 'destructive' : 'secondary'}>
          {lead.firstAttemptAt
            ? 'Attempt logged'
            : overdue
              ? 'Past internal target'
              : lead.dueAt
                ? 'Awaiting first attempt'
                : 'No target snapshot'}
        </Badge>
      </div>
      <p className="text-sm text-muted-foreground">
        Received {new Date(lead.receivedAt).toLocaleString()}
        {lead.dueAt ? ` · Target ${new Date(lead.dueAt).toLocaleString()}` : ''}
      </p>
      {canWrite ? (
        <>
          <div className="flex flex-wrap items-end gap-2">
            <label className="w-full min-w-0 space-y-1 text-sm sm:w-auto sm:flex-1">
              <span>Inquiry owner</span>
              <select
                aria-label={`Owner for ${lead.name}`}
                className={selectClass}
                value={owner}
                disabled={busy}
                onChange={(e) => setOwner(e.target.value)}
              >
                <option value="">Unassigned</option>
                {lead.assignedUserId &&
                  !members.some((m) => m.id === lead.assignedUserId) && (
                    <option value={lead.assignedUserId}>
                      Previous team member · reassign
                    </option>
                  )}
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
            <Button
              variant="outline"
              disabled={busy || (owner || null) === lead.assignedUserId}
              onClick={() => assignment.mutate(owner || null)}
            >
              Save owner
            </Button>
            {!lead.assignedUserId && (
              <Button disabled={busy} onClick={() => assignment.mutate(userId)}>
                <UserCheck className="mr-2 h-4 w-4" /> Claim inquiry
              </Button>
            )}
          </div>
          <details className="rounded-md border p-3">
            <summary className="cursor-pointer text-sm font-medium">
              Log a contact attempt
            </summary>
            <form
              className="mt-4 space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (confirmed) attempt.mutate();
              }}
            >
              <p className="text-sm text-muted-foreground">
                Use this after you contact the customer. It records your action
                now; it does not call, email or text anyone.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1 text-sm">
                  <span>Contact channel</span>
                  <select
                    className={selectClass}
                    disabled={busy}
                    value={channel}
                    onChange={(e) => {
                      setChannel(e.target.value);
                      setOutcome(
                        e.target.value === 'phone' ? 'no_answer' : 'sent',
                      );
                      setConfirmed(false);
                      setRequestId(crypto.randomUUID());
                    }}
                  >
                    <option value="phone">Phone</option>
                    <option value="email">Email</option>
                    <option value="sms">Text message</option>
                  </select>
                </label>
                <label className="space-y-1 text-sm">
                  <span>What happened?</span>
                  <select
                    className={selectClass}
                    disabled={busy}
                    value={outcome}
                    onChange={(e) => {
                      setOutcome(e.target.value);
                      setConfirmed(false);
                      setRequestId(crypto.randomUUID());
                    }}
                  >
                    {channel === 'phone' ? (
                      <>
                        <option value="no_answer">No answer</option>
                        <option value="left_message">Left a message</option>
                        <option value="connected">Spoke with customer</option>
                      </>
                    ) : (
                      <option value="sent">I sent the message</option>
                    )}
                  </select>
                </label>
              </div>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 shrink-0"
                  checked={confirmed}
                  disabled={busy}
                  onChange={(e) => setConfirmed(e.target.checked)}
                  required
                />
                <span>
                  I performed this contact attempt and have permission to use
                  this channel.
                </span>
              </label>
              <Button type="submit" disabled={!confirmed || busy}>
                {attempt.isPending ? 'Recording…' : 'Record completed attempt'}
              </Button>
            </form>
          </details>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          Owner:{' '}
          {members.find((m) => m.id === lead.assignedUserId)?.name ??
            (lead.assignedUserId ? 'Previous team member' : 'Unassigned')}
          . Read-only access.
        </p>
      )}
      {(assignment.error || attempt.error) && (
        <p role="alert" className="text-sm text-destructive">
          {(assignment.error || attempt.error)?.message}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
    </article>
  );
}

export function ResponseTarget({
  id,
  minutes,
  organizationId,
}: {
  id: string;
  minutes: number;
  organizationId: string;
}) {
  const [value, setValue] = useState(String(minutes));
  const client = useQueryClient();
  const save = useMutation({
    mutationFn: () =>
      api(`/${id}/response-target`, { minutes: Number(value) }, 'PATCH'),
    onSuccess: () => {
      void client.invalidateQueries({
        queryKey: ['smart-sites', organizationId],
      });
    },
  });
  return (
    <form
      className="space-y-2 border-t pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <label className="block space-y-1 text-sm">
        <span>Internal first-attempt target (minutes)</span>
        <input
          type="number"
          min={5}
          max={10080}
          required
          className="min-h-10 w-full rounded-md border bg-background px-3"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </label>
      <p className="text-sm text-muted-foreground">
        Elapsed time, 24/7. Changes apply to future inquiries only.
      </p>
      <Button
        type="submit"
        size="sm"
        variant="outline"
        disabled={save.isPending || Number(value) === minutes}
      >
        Save target
      </Button>
      {save.error && (
        <p role="alert" className="text-sm text-destructive">
          {save.error.message}
        </p>
      )}
    </form>
  );
}
