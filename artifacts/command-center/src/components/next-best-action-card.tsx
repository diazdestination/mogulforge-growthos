import { useEffect, useState } from 'react';
import {
  useGetLeadNextAction,
  getGetLeadNextActionQueryKey,
  useRecordNextActionFeedback,
  useSendLeadEmail,
  getListLeadActivitiesQueryKey,
  getListTodayActionsQueryKey,
  type NextBestAction,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, Sparkles, Phone, Send, Clock, X, CalendarClock, MessageSquareText } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { Link } from 'wouter';

const ACTION_ICONS: Record<string, typeof Phone> = {
  call_now: Phone,
  reply_portal_message: MessageSquareText,
  review_customer_reply: MessageSquareText,
  send_message: Send,
  follow_up_estimate: Send,
  schedule_follow_up: CalendarClock,
};

/**
 * Editable AI-draft composer for a message-type recommendation: subject/body
 * editing plus the confirm-to-send (email) or copy-and-mark-sent (SMS)
 * buttons. Shared by the lead-detail copilot card and the Today's Actions
 * queue's inline expand panel.
 */
export function NextActionDraftComposer({
  leadId,
  action,
  onRecorded,
}: {
  leadId: string;
  action: NextBestAction;
  onRecorded: (response: 'sent' | 'edited') => void | Promise<void>;
}) {
  const sendEmail = useSendLeadEmail();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [edited, setEdited] = useState(false);

  useEffect(() => {
    if (action?.draft) {
      setSubject(action.draft.subject ?? '');
      setBody(action.draft.body);
      setEdited(false);
    }
  }, [action?.draft?.body, action?.draft?.subject]);

  const isEmailDraft = !!action.draft && action.channel === 'email';
  const isSmsDraft = !!action.draft && action.channel === 'sms';
  if (String(action.actionType) === 'review_customer_reply' || (!isEmailDraft && !isSmsDraft)) return null;

  const handleSend = async () => {
    if (!body.trim()) return;
    try {
      await sendEmail.mutateAsync({
        id: leadId,
        data: { subject: subject.trim() || 'Checking in', body: body.trim() },
      });
      toast({ title: 'Email sent', description: 'Logged on the lead timeline.' });
      queryClient.invalidateQueries({ queryKey: getListLeadActivitiesQueryKey(leadId) });
      await onRecorded(edited ? 'edited' : 'sent');
    } catch (err) {
      const msg =
        err && typeof err === 'object' && 'data' in err
          ? (err as { data?: { error?: string } }).data?.error
          : undefined;
      toast({
        variant: 'destructive',
        title: 'Send failed',
        description: msg || 'Sending the email failed. Try again in a moment.',
      });
    }
  };

  return (
    <div className="space-y-2">
      {isEmailDraft && (
        <input
          type="text"
          value={subject}
          onChange={(e) => { setSubject(e.target.value); setEdited(true); }}
          aria-label="Draft subject"
          className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary font-semibold"
        />
      )}
      <textarea
        value={body}
        onChange={(e) => { setBody(e.target.value); setEdited(true); }}
        rows={isSmsDraft ? 3 : 6}
        aria-label="Draft message"
        className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary resize-y font-medium"
      />
      <div className="text-[10px] text-muted-foreground font-medium uppercase tracking-widest">
        AI draft ({action.draft!.provider}) — edit freely, you always confirm the send
      </div>
      <div className="flex gap-2 flex-wrap">
        {isEmailDraft && (
          <button
            type="button"
            onClick={handleSend}
            disabled={sendEmail.isPending || !body.trim()}
            className="flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 bg-primary text-primary-foreground rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50 shadow-sm"
          >
            {sendEmail.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
            {edited ? 'Send edited draft' : 'Send'}
          </button>
        )}
        {isSmsDraft && (
          <button
            type="button"
            onClick={async () => {
              await navigator.clipboard.writeText(body).catch(() => {});
              toast({ title: 'Draft copied', description: 'Paste it into your texting app, then it will be logged as sent.' });
              await onRecorded(edited ? 'edited' : 'sent');
            }}
            className="flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 bg-primary text-primary-foreground rounded-lg hover:opacity-90 transition-opacity shadow-sm"
          >
            <Send className="w-3.5 h-3.5" /> Copy text & mark sent
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * "Next best action" copilot card: the engine's single recommended move for
 * this lead, why it thinks so, and (for messages) a one-click-editable AI
 * draft. The rep always confirms — send, edit-then-send, snooze, or dismiss.
 */
export function NextBestActionCard({
  leadId,
  canWrite,
}: {
  leadId: string;
  canWrite: boolean;
}) {
  const { data: action, isLoading } = useGetLeadNextAction(leadId, {
    query: { enabled: !!leadId, queryKey: getGetLeadNextActionQueryKey(leadId) },
  });
  const feedback = useRecordNextActionFeedback();
  const queryClient = useQueryClient();

  if (isLoading) {
    return (
      <section>
        <SectionTitle />
        <div className="bg-card border border-border/50 rounded-xl p-4 shadow-sm flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Sizing up this lead…
        </div>
      </section>
    );
  }
  if (!action || action.actionType === 'none') return null;

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: getGetLeadNextActionQueryKey(leadId) });
    queryClient.invalidateQueries({ queryKey: getListTodayActionsQueryKey() });
  };

  const record = async (
    response: 'sent' | 'edited' | 'snoozed' | 'dismissed',
    snoozeHours?: number,
  ) => {
    try {
      await feedback.mutateAsync({
        id: leadId,
        data: { actionType: action.actionType, response, ...(snoozeHours ? { snoozeHours } : {}) },
      });
    } catch {
      // Feedback is best-effort; never block the rep's flow on it.
    }
    refresh();
  };

  const Icon = ACTION_ICONS[action.actionType] ?? Sparkles;
  const replyHeld = String(action.actionType) === 'review_customer_reply';

  return (
    <section data-testid="next-best-action-card">
      <SectionTitle />
      <div className="bg-gradient-to-br from-primary/5 to-transparent border border-primary/20 rounded-xl p-3 md:p-4 text-sm shadow-sm space-y-3">
        <div className="flex items-start gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
            <Icon className="w-4 h-4 text-primary" />
          </div>
          <div className="min-w-0">
            <div className="font-bold text-foreground">{action.title}</div>
            <ul className="mt-1 space-y-0.5">
              {action.reasons.map((r, i) => (
                <li key={i} className="text-xs text-muted-foreground flex gap-1.5 items-start">
                  <span className="text-primary mt-0.5">•</span> {r}
                </li>
              ))}
            </ul>
          </div>
        </div>

        {replyHeld && <Link href={`/leads/${encodeURIComponent(leadId)}?tab=messages#mailbox-replies`} className="inline-flex min-h-10 items-center rounded-lg border border-primary/30 px-3 text-sm font-semibold text-primary">Review held customer reply</Link>}
        {replyHeld && <p className="text-xs text-muted-foreground">Handle the exact saved reply and office task first. This hold cannot be snoozed, dismissed or treated as a send.</p>}
        {canWrite && !replyHeld && (
          <NextActionDraftComposer leadId={leadId} action={action} onRecorded={record} />
        )}

        {canWrite && !replyHeld && (
          <div className="flex gap-2 flex-wrap">
            {action.actionType === 'call_now' && (
              <button
                type="button"
                onClick={() => record('sent')}
                className="flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 bg-primary text-primary-foreground rounded-lg hover:opacity-90 transition-opacity shadow-sm"
              >
                <Phone className="w-3.5 h-3.5" /> Mark as called
              </button>
            )}
            <button
              type="button"
              onClick={() => record('snoozed', 24)}
              className="flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-lg border border-border hover:bg-muted transition-colors"
            >
              <Clock className="w-3.5 h-3.5" /> Snooze 24h
            </button>
            <button
              type="button"
              onClick={() => record('dismissed')}
              className="flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-lg border border-border text-muted-foreground hover:bg-muted transition-colors"
            >
              <X className="w-3.5 h-3.5" /> Dismiss
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function SectionTitle() {
  return (
    <h3 className="flex items-center gap-2 text-[10px] md:text-xs font-bold text-muted-foreground uppercase tracking-widest mb-3">
      <Sparkles className="w-3.5 h-3.5 text-primary" /> Next Best Action
    </h3>
  );
}
