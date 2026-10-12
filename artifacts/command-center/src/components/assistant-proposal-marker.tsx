import { Link } from 'wouter';
import { ClipboardCheck } from 'lucide-react';

/** Streamed by POST /assistant/chat when the assistant PROPOSES (never performs) an action. */
export interface AssistantProposalMarker {
  id: string;
  actionType: 'create_task' | 'change_stage' | 'send_email';
  title: string;
  leadId?: string;
  status: 'proposed';
  duplicate?: boolean;
  reviewPath?: string;
}

export function isAssistantProposalMarker(value: unknown): value is AssistantProposalMarker {
  const v = value as Partial<AssistantProposalMarker> | null;
  return Boolean(v && typeof v.id === 'string' && typeof v.title === 'string' && v.status === 'proposed');
}

/** Review always happens in Revenue Desk; the marker never offers approve/execute controls. */
export function AssistantProposalMarkers({ proposals }: { proposals?: AssistantProposalMarker[] }) {
  if (!proposals?.length) return null;
  return (
    <ul className="flex flex-col gap-1.5" aria-label="Proposed actions awaiting approval">
      {proposals.map(proposal => (
        <li key={proposal.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/25 bg-primary/5 px-3 py-2 text-xs">
          <ClipboardCheck className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
          <span className="font-semibold">{proposal.title}</span>
          <span className="text-muted-foreground">
            {proposal.duplicate ? 'Already proposed' : 'Proposed'} — awaiting approval in Revenue Desk. Nothing has been changed or sent.
          </span>
          <Link href="/bie" className="font-semibold text-primary underline underline-offset-2">Review in Revenue Desk</Link>
        </li>
      ))}
    </ul>
  );
}
