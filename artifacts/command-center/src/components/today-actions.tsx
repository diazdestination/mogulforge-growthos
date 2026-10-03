import { useState } from 'react';
import { Link } from 'wouter';
import {
  useListTodayActions,
  getListTodayActionsQueryKey,
  useGetLeadNextAction,
  getGetLeadNextActionQueryKey,
  useRecordNextActionFeedback,
  useGetMe,
  type NextBestAction,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Sparkles, ChevronDown, ChevronUp, Phone, Send, CalendarClock, MessageSquareText, ArrowRight, Clock, X, Loader2 } from 'lucide-react';
import { canWrite } from '@/lib/permissions';
import { NextActionDraftComposer } from '@/components/next-best-action-card';

const ACTION_META: Record<string, { icon: typeof Phone; label: string }> = {
  call_now: { icon: Phone, label: 'Call' },
  reply_portal_message: { icon: MessageSquareText, label: 'Reply' },
  review_customer_reply: { icon: MessageSquareText, label: 'Review held reply' },
  send_message: { icon: Send, label: 'Message' },
  follow_up_estimate: { icon: Send, label: 'Follow up' },
  schedule_follow_up: { icon: CalendarClock, label: 'Schedule' },
};

/** Action types whose recommendation carries a sendable message draft. */
const MESSAGE_TYPES = new Set(['send_message', 'follow_up_estimate', 'reply_portal_message']);

/**
 * "Today's actions": the engine's prioritized queue across all workable
 * leads, ordered by conversion impact. Rows deep-link to the lead, and offer
 * inline quick actions — snooze/dismiss without leaving the pipeline, plus
 * an expandable draft panel for message-type recommendations.
 */
export function TodayActionsPanel() {
  const { data: actions, isLoading } = useListTodayActions(undefined, {
    query: { queryKey: getListTodayActionsQueryKey() },
  });
  const { data: me } = useGetMe();
  const [collapsed, setCollapsed] = useState(false);

  if (isLoading || !actions || actions.length === 0) return null;

  const shown = collapsed ? [] : actions.slice(0, 8);
  const canEdit = canWrite(me?.role);

  return (
    <div data-testid="today-actions-panel" className="mx-4 md:mx-6 mt-3 md:mt-4 border border-primary/20 bg-gradient-to-r from-primary/5 to-transparent rounded-2xl shadow-sm overflow-hidden">
      <button
        type="button"
        onClick={() => setCollapsed(v => !v)}
        aria-expanded={!collapsed}
        className="w-full flex items-center gap-2 px-4 py-3 text-left"
      >
        <Sparkles className="w-4 h-4 text-primary shrink-0" />
        <span className="font-bold text-sm text-foreground">Today's actions</span>
        <span className="text-xs font-bold text-primary bg-primary/10 border border-primary/20 rounded-full px-2 py-0.5">
          {actions.length}
        </span>
        <span className="text-xs text-muted-foreground hidden md:inline">— highest-impact leads first, straight from the Closer Engine</span>
        <span className="ml-auto text-muted-foreground">
          {collapsed ? <ChevronDown className="w-4 h-4" aria-hidden /> : <ChevronUp className="w-4 h-4" aria-hidden />}
        </span>
      </button>
      {!collapsed && (
        <div className="px-3 pb-3 grid gap-1.5">
          {shown.map(a => (
            <TodayActionRow key={a.leadId} action={a} canEdit={canEdit} />
          ))}
          {actions.length > 8 && (
            <div className="text-xs text-muted-foreground px-3 pt-1 font-medium">
              +{actions.length - 8} more — work the list top-down for the biggest impact.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TodayActionRow({ action: a, canEdit }: { action: NextBestAction; canEdit: boolean }) {
  const meta = ACTION_META[a.actionType] ?? { icon: Sparkles, label: 'Act' };
  const Icon = meta.icon;
  const name = a.contactName || a.leadSummary || 'Lead';
  const [expanded, setExpanded] = useState(false);
  const feedback = useRecordNextActionFeedback();
  const queryClient = useQueryClient();

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: getListTodayActionsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetLeadNextActionQueryKey(a.leadId) });
  };

  const record = async (
    actionType: string,
    response: 'sent' | 'edited' | 'snoozed' | 'dismissed',
    snoozeHours?: number,
  ) => {
    try {
      await feedback.mutateAsync({
        id: a.leadId,
        data: { actionType, response, ...(snoozeHours ? { snoozeHours } : {}) },
      });
    } catch {
      // Feedback is best-effort; never block the rep's flow on it.
    }
    refresh();
  };

  const replyHeld = String(a.actionType) === 'review_customer_reply';
  const expandable = canEdit && !replyHeld && MESSAGE_TYPES.has(a.actionType);

  return (
    <div className="bg-card border border-border/60 rounded-xl hover:border-primary/40 hover:shadow-sm transition-all">
      <div className="flex items-center gap-3 px-3 py-2">
        <Link
          href={`/leads/${encodeURIComponent(a.leadId)}${replyHeld ? '?tab=messages#mailbox-replies' : ''}`}
          className="flex items-center gap-3 min-w-0 flex-1 group"
        >
          <span className="w-7 h-7 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
            <Icon className="w-3.5 h-3.5 text-primary" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-bold text-foreground truncate">
              {name}
            </span>
            <span className="block text-xs text-muted-foreground truncate">
              {a.title}{a.reasons[0] ? ` — ${a.reasons[0]}` : ''}
            </span>
          </span>
          <span className="text-[10px] font-bold uppercase tracking-widest text-primary bg-primary/5 border border-primary/15 rounded-md px-2 py-1 shrink-0 hidden sm:inline">
            {meta.label}
          </span>
          <ArrowRight className="w-3.5 h-3.5 text-muted-foreground group-hover:text-primary transition-colors shrink-0 hidden sm:block" aria-hidden />
        </Link>
        {canEdit && !replyHeld && (
          <span className="flex items-center gap-1 shrink-0">
            {expandable && (
              <button
                type="button"
                onClick={() => setExpanded(v => !v)}
                aria-expanded={expanded}
                aria-label={`${expanded ? 'Hide' : 'Show'} draft for ${name}`}
                title={expanded ? 'Hide draft' : 'Show draft'}
                className="w-7 h-7 flex items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              >
                {expanded ? <ChevronUp className="w-3.5 h-3.5" aria-hidden /> : <ChevronDown className="w-3.5 h-3.5" aria-hidden />}
              </button>
            )}
            <button
              type="button"
              onClick={() => record(a.actionType, 'snoozed', 24)}
              disabled={feedback.isPending}
              aria-label={`Snooze suggestion for ${name} for 24 hours`}
              title="Snooze 24h"
              className="w-7 h-7 flex items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-muted hover:text-foreground transition-colors disabled:opacity-50"
            >
              <Clock className="w-3.5 h-3.5" aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => record(a.actionType, 'dismissed')}
              disabled={feedback.isPending}
              aria-label={`Dismiss suggestion for ${name}`}
              title="Dismiss"
              className="w-7 h-7 flex items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-muted hover:text-foreground transition-colors disabled:opacity-50"
            >
              <X className="w-3.5 h-3.5" aria-hidden />
            </button>
          </span>
        )}
      </div>
      {expandable && expanded && (
        <ExpandedDraft
          leadId={a.leadId}
          name={name}
          onRecorded={(response) => record(a.actionType, response)}
        />
      )}
    </div>
  );
}

/**
 * Inline draft panel: fetches the single-lead recommendation (which carries
 * the AI draft) only once the rep expands the row, then reuses the same
 * composer as the lead-detail copilot card.
 */
function ExpandedDraft({
  leadId,
  name,
  onRecorded,
}: {
  leadId: string;
  name: string;
  onRecorded: (response: 'sent' | 'edited') => void | Promise<void>;
}) {
  const { data: action, isLoading } = useGetLeadNextAction(leadId, {
    query: { queryKey: getGetLeadNextActionQueryKey(leadId) },
  });

  if (isLoading) {
    return (
      <div className="px-3 pb-3 flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> Fetching the draft…
      </div>
    );
  }
  if (action && String(action.actionType) === 'review_customer_reply') return <div className="px-3 pb-3 text-sm">Follow-up is held for office review. <Link href={`/leads/${encodeURIComponent(leadId)}?tab=messages#mailbox-replies`} className="font-semibold underline">Review held customer reply</Link></div>;
  if (!action || action.actionType === 'none' || !action.draft) {
    return (
      <div className="px-3 pb-3 text-xs text-muted-foreground">
        No ready-to-send draft for this one —{' '}
        <Link href={`/leads/${leadId}`} className="text-primary font-semibold hover:underline">
          open {name}
        </Link>{' '}
        for the full recommendation.
      </div>
    );
  }

  return (
    <div className="px-3 pb-3 border-t border-border/60 pt-3">
      <NextActionDraftComposer leadId={leadId} action={action} onRecorded={onRecorded} />
    </div>
  );
}
