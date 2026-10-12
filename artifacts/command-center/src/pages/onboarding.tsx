import { useMemo, useState } from 'react';
import { Link } from 'wouter';
import {
  getGetInstallationQueryKey,
  getGetOnboardingQueryKey,
  getGetSettingsQueryKey,
  useCreateOnboardingTestLead,
  useDeleteOnboardingTestLead,
  useGetInstallation,
  useGetMe,
  useGetOnboarding,
  useGetSettings,
  useUpdateOnboarding,
  useInviteUser,
  UserRole,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Building2,
  Wrench,
  Clock,
  Mail,
  CalendarCheck,
  ListChecks,
  Bot,
  Globe,
  Code2,
  BadgeCheck,
  FlaskConical,
  Rocket,
  Check,
  Loader2,
  ArrowRight,
  Users,
  Plus,
  X,
  Upload,
} from 'lucide-react';
import { HousecallCustomerImport } from '@/components/housecall-customer-import';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';

interface StepDef {
  key: string;
  title: string;
  description: string;
  icon: typeof Building2;
  href?: string;
  linkLabel?: string;
}

const STEP_DEFS: StepDef[] = [
  { key: 'company', title: 'Company info', description: 'Set your business name, phone, and address — this is the branding every customer-facing message uses.', icon: Building2, href: '/settings', linkLabel: 'Open settings' },
  { key: 'services', title: 'Services', description: 'List the services you offer so leads can be categorized and routed correctly.', icon: Wrench, href: '/settings', linkLabel: 'Open settings' },
  { key: 'hours', title: 'Sending & booking hours', description: 'Confirm quiet hours for automated outreach and the windows customers can book.', icon: Clock, href: '/settings', linkLabel: 'Open settings' },
  { key: 'channels', title: 'Email & SMS channels', description: 'Connect your email and SMS providers so follow-ups actually reach customers.', icon: Mail, href: '/settings', linkLabel: 'Open settings' },
  { key: 'booking', title: 'Appointment booking', description: 'Review appointment availability and capacity so the assistant can offer real slots.', icon: CalendarCheck, href: '/appointments', linkLabel: 'Open appointments' },
  { key: 'playbook', title: 'Follow-up playbook', description: 'Your default follow-up sequence is ready — review the touches and tune the copy.', icon: ListChecks, href: '/settings', linkLabel: 'Open settings' },
  { key: 'concierge', title: 'AI assistant & knowledge', description: 'Name your assistant, set its greeting, and add knowledge entries it can answer from.', icon: Bot, href: '/settings', linkLabel: 'Open settings' },
  { key: 'domain', title: 'Authorized domains', description: 'Add the website domains that are allowed to send you leads.', icon: Globe, href: '/settings', linkLabel: 'Open settings' },
  { key: 'snippet', title: 'Install the snippet', description: 'Copy the capture snippet or connect your existing forms and outside systems.', icon: Code2, href: '/capture', linkLabel: 'Open lead capture' },
  { key: 'verify', title: 'Verify installation', description: 'Run the installation check to confirm your website is talking to the CRM.', icon: BadgeCheck, href: '/settings', linkLabel: 'Open settings' },
  { key: 'import-customers', title: 'Bring your customers from Housecall Pro', description: 'Export your customer list from Housecall Pro, upload it here, check the columns and preview the result before anything is saved. Imported customers are never contacted automatically.', icon: Upload },
  { key: 'test-lead', title: 'Run a test lead', description: 'Create a sandboxed sample lead and watch the full journey — captured, scored, and enrolled in follow-up — without contacting anyone real.', icon: FlaskConical },
  { key: 'invite-team', title: 'Invite your team', description: 'Add the reps, managers, and admins who will work leads in this workspace. They\'ll get an email with a sign-in link.', icon: Users },
  { key: 'launch', title: 'Complete setup', description: 'Record your setup completion. Launch review is still required before serving real clients.', icon: Rocket },
];

export default function Onboarding() {
  const { data: me } = useGetMe();
  const { data: onboarding, isLoading } = useGetOnboarding();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [testLeadResult, setTestLeadResult] = useState<{ leadId: string; score: number; enrolled: boolean } | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<string>(UserRole.sales_rep);
  const [invitedEmails, setInvitedEmails] = useState<string[]>([]);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getGetOnboardingQueryKey() });

  const update = useUpdateOnboarding({
    mutation: {
      onSuccess: () => invalidate(),
      onError: () =>
        toast({ title: 'Could not save progress', description: 'Please try again.', variant: 'destructive' }),
    },
  });
  const createTestLead = useCreateOnboardingTestLead({
    mutation: {
      onSuccess: (result) => {
        setTestLeadResult(result);
        update.mutate({ data: { completeSteps: ['test-lead'] } });
        toast({
          title: 'Test lead created',
          description: `Scored ${result.score}/100${result.enrolled ? ' and enrolled in your follow-up playbook' : ''}. No real messages were sent.`,
        });
      },
      onError: () =>
        toast({ title: 'Could not create the test lead', description: 'Please try again.', variant: 'destructive' }),
    },
  });
  const deleteTestLead = useDeleteOnboardingTestLead({
    mutation: {
      onSuccess: () => {
        setTestLeadResult(null);
        toast({ title: 'Test data removed', description: 'The sandbox lead and its records were deleted.' });
      },
      onError: () =>
        toast({ title: 'Could not remove test data', description: 'Please try again.', variant: 'destructive' }),
    },
  });

  const sendInvite = useInviteUser({
    mutation: {
      onSuccess: (member) => {
        const email = member.email ?? inviteEmail;
        if (member.inviteEmail?.sent !== true) {
          toast({
            title: 'Invite created; email outcome unconfirmed',
            description: 'The email may already have been accepted. Check provider delivery records before sending another invitation.',
            variant: 'destructive',
          });
          return;
        }
        setInvitedEmails((prev) => [...prev, email]);
        setInviteEmail('');
        update.mutate({ data: { completeSteps: ['invite-team'] } });
        toast({
          title: 'Invitation email accepted for sending',
          description: 'Inbox delivery is not yet confirmed.',
        });
      },
      onError: () => {
        toast({
          title: 'Invitation request unconfirmed',
          description: 'Check the team list and provider delivery records before another attempt.',
          variant: 'destructive',
        });
      },
    },
  });

  // Pre-warm settings/installation so step links land on loaded pages.
  useGetSettings({ query: { queryKey: getGetSettingsQueryKey(), staleTime: 60_000 } });
  useGetInstallation({ query: { queryKey: getGetInstallationQueryKey(), staleTime: 60_000 } });

  const completed = useMemo(
    () => new Set(onboarding?.state.completedSteps ?? []),
    [onboarding],
  );
  const doneCount = STEP_DEFS.filter((s) => completed.has(s.key)).length;
  const launched = !!onboarding?.state.completedAt;
  const orgName = me?.organization?.name ?? 'your company';

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto p-4 md:p-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Get {orgName} set up</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Work through these steps at your own pace — progress is saved, so you can come back any time.
        </p>
        <div className="mt-4 flex items-center gap-3">
          <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
            <div
              data-testid="onboarding-progress"
              className="h-full bg-primary transition-all"
              style={{ width: `${Math.round((doneCount / STEP_DEFS.length) * 100)}%` }}
            />
          </div>
          <span className="text-xs font-mono text-muted-foreground shrink-0">
            {doneCount}/{STEP_DEFS.length}
          </span>
        </div>
        {launched && (
          <div className="mt-4 rounded-md border border-primary/30 bg-primary/5 px-4 py-3 text-sm" data-testid="onboarding-launched">
            Setup completion recorded. Launch review is still required before serving real clients. You can revisit any step from Settings.
          </div>
        )}
      </div>

      <ol className="space-y-3">
        {STEP_DEFS.map((step, idx) => {
          const isDone = completed.has(step.key);
          const Icon = step.icon;
          const isTestLead = step.key === 'test-lead';
          const isInviteTeam = step.key === 'invite-team';
          const isLaunch = step.key === 'launch';
          return (
            <li
              key={step.key}
              data-testid={`onboarding-step-${step.key}`}
              className={cn(
                'rounded-lg border p-4 flex gap-4',
                isDone ? 'border-primary/40 bg-primary/5' : 'border-border bg-card',
              )}
            >
              <div
                className={cn(
                  'w-9 h-9 rounded-full flex items-center justify-center shrink-0 mt-0.5',
                  isDone ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
                )}
              >
                {isDone ? <Check className="w-5 h-5" /> : <Icon className="w-4 h-4" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono text-muted-foreground">{idx + 1}</span>
                  <h2 className="font-semibold text-sm">{step.title}</h2>
                </div>
                <p className="text-sm text-muted-foreground mt-1">{step.description}</p>
                {isTestLead && testLeadResult && (
                  <div className="mt-2 text-xs rounded bg-muted px-3 py-2" data-testid="test-lead-result">
                    Sample lead scored {testLeadResult.score}/100
                    {testLeadResult.enrolled ? ' and enrolled in your follow-up playbook' : ''}.{' '}
                    <Link href={`/leads/${testLeadResult.leadId}`} className="underline">
                      View its timeline
                    </Link>{' '}
                    to see the journey, then clean it up below.
                  </div>
                )}
                {step.key === 'import-customers' && (
                  <HousecallCustomerImport
                    onImported={() => update.mutate({ data: { completeSteps: ['import-customers'] } })}
                  />
                )}
                {isInviteTeam && (
                  <div className="mt-3 space-y-3">
                    {invitedEmails.length > 0 && (
                      <ul className="space-y-1" data-testid="invited-emails-list">
                        {invitedEmails.map((e) => (
                          <li key={e} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <Check className="w-3 h-3 text-primary shrink-0" />
                            {e}
                          </li>
                        ))}
                      </ul>
                    )}
                    <form
                      data-testid="invite-team-form"
                      onSubmit={(ev) => {
                        ev.preventDefault();
                        if (!inviteEmail.trim()) return;
                        sendInvite.mutate({ data: { email: inviteEmail.trim(), role: inviteRole as typeof UserRole[keyof typeof UserRole] } });
                      }}
                      className="flex flex-wrap items-end gap-2"
                    >
                      <div className="flex flex-col gap-1">
                        <label htmlFor="invite-email" className="text-xs text-muted-foreground">Email</label>
                        <input
                          id="invite-email"
                          type="email"
                          required
                          value={inviteEmail}
                          onChange={(e) => setInviteEmail(e.target.value)}
                          placeholder="teammate@example.com"
                          data-testid="invite-email-input"
                          className="h-8 rounded-md border border-input bg-background px-3 text-xs focus:outline-none focus:ring-1 focus:ring-ring w-52"
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <label htmlFor="invite-role" className="text-xs text-muted-foreground">Role</label>
                        <select
                          id="invite-role"
                          value={inviteRole}
                          onChange={(e) => setInviteRole(e.target.value)}
                          data-testid="invite-role-select"
                          className="h-8 rounded-md border border-input bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                        >
                          <option value={UserRole.admin}>Admin</option>
                          <option value={UserRole.sales_manager}>Sales manager</option>
                          <option value={UserRole.sales_rep}>Sales rep</option>
                          <option value={UserRole.inspector}>Inspector</option>
                        </select>
                      </div>
                      <button
                        type="submit"
                        disabled={sendInvite.isPending || !inviteEmail.trim()}
                        data-testid="send-invite-button"
                        className="inline-flex items-center gap-1.5 h-8 text-xs font-semibold bg-primary text-primary-foreground rounded-md px-3 hover:bg-primary/90 disabled:opacity-50"
                      >
                        {sendInvite.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
                        Invite
                      </button>
                    </form>
                    <div className="flex items-center gap-2">
                      {!isDone && (
                        <button
                          onClick={() => update.mutate({ data: { completeSteps: ['invite-team'] } })}
                          disabled={update.isPending}
                          data-testid="skip-invite-team"
                          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground underline"
                        >
                          <X className="w-3 h-3" /> Skip for now
                        </button>
                      )}
                    </div>
                  </div>
                )}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {step.href && (
                    <Link
                      href={step.href}
                      className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                    >
                      {step.linkLabel} <ArrowRight className="w-3 h-3" />
                    </Link>
                  )}
                  {isTestLead && (
                    <>
                      <button
                        onClick={() => createTestLead.mutate()}
                        disabled={createTestLead.isPending}
                        data-testid="create-test-lead"
                        className="inline-flex items-center gap-1.5 text-xs font-semibold bg-primary text-primary-foreground rounded-md px-3 h-8 hover:bg-primary/90 disabled:opacity-50"
                      >
                        {createTestLead.isPending && <Loader2 className="w-3 h-3 animate-spin" />}
                        {testLeadResult ? 'Re-run test lead' : 'Create test lead'}
                      </button>
                      {(testLeadResult || isDone) && (
                        <button
                          onClick={() => deleteTestLead.mutate()}
                          disabled={deleteTestLead.isPending}
                          data-testid="cleanup-test-lead"
                          className="inline-flex items-center gap-1.5 text-xs font-medium border border-border rounded-md px-3 h-8 hover:bg-muted disabled:opacity-50"
                        >
                          Remove test data
                        </button>
                      )}
                    </>
                  )}
                  {isLaunch ? (
                    !launched && (
                      <button
                        onClick={() =>
                          update.mutate({ data: { completeSteps: ['launch'], launched: true } })
                        }
                        disabled={update.isPending || doneCount < STEP_DEFS.length - 1}
                        data-testid="launch-workspace"
                        className="inline-flex items-center gap-1.5 text-xs font-semibold bg-primary text-primary-foreground rounded-md px-3 h-8 hover:bg-primary/90 disabled:opacity-50"
                        title={doneCount < STEP_DEFS.length - 1 ? 'Finish the steps above first' : undefined}
                      >
                        <Rocket className="w-3 h-3" /> Record setup completion
                      </button>
                    )
                  ) : (
                    !isDone &&
                    !isTestLead &&
                    !isInviteTeam && (
                      <button
                        onClick={() => update.mutate({ data: { completeSteps: [step.key], currentStep: step.key } })}
                        disabled={update.isPending}
                        data-testid={`complete-step-${step.key}`}
                        className="inline-flex items-center gap-1.5 text-xs font-medium border border-border rounded-md px-3 h-8 hover:bg-muted disabled:opacity-50"
                      >
                        Mark done
                      </button>
                    )
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      {!launched && (
        <div className="flex justify-end">
          <button
            onClick={() => update.mutate({ data: { dismissed: true } })}
            disabled={update.isPending}
            data-testid="dismiss-onboarding"
            className="text-xs text-muted-foreground hover:text-foreground underline"
          >
            Hide setup from the sidebar
          </button>
        </div>
      )}
    </div>
  );
}
