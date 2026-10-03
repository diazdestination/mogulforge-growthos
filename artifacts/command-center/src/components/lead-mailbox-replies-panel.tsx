import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod/v4";
import {
  getGetLeadNextActionQueryKey,
  getListTodayActionsQueryKey,
  getListTasksQueryKey,
} from "@workspace/api-client-react";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

const itemSchema = z.object({
  id: z.string().min(1),
  leadId: z.string().min(1),
  version: z.number().int().positive(),
  state: z.literal("confirmed"),
  reason: z.string(),
  replyAt: z.string().nullable(),
  receivedAt: z.string(),
  historical: z.boolean(),
  holdActive: z.boolean(),
  taskId: z.string().nullable(),
  assignedUserId: z.string().nullable(),
  taskTitle: z.string().nullable(),
  taskStatus: z.string().nullable(),
  assignedUserName: z.string().nullable(),
  content: z.object({ subject: z.string(), text: z.string() }).nullable(),
  rawExpiresAt: z.string().nullable(),
  releasedAt: z.string().nullable(),
  releaseNote: z.string().nullable(),
  effectSummary: z
    .object({
      pausedEnrollments: z.number().int().nonnegative(),
      cancelledActions: z.number().int().nonnegative(),
      blockedProposals: z.number().int().nonnegative(),
      reconciliationRequired: z.number().int().nonnegative(),
    })
    .nullable(),
  monitoringCurrent: z.boolean(),
  evidence: z.literal("original_mailbox_observation"),
});
const pageSchema = z.object({
  items: z.array(itemSchema).max(25),
  hasMore: z.boolean(),
  offset: z.number().int().nonnegative(),
  limit: z.literal(25),
});
type Reply = z.infer<typeof itemSchema>;
async function readPage(leadId: string, offset: number) {
  const response = await fetch(
    `/api/v1/leads/${encodeURIComponent(leadId)}/mailbox-replies?offset=${offset}`,
    { credentials: "include", cache: "no-store" },
  );
  if (!response.ok)
    throw new Error(
      "Lead reply evidence could not be loaded. Refresh to check current access and history.",
    );
  const page = pageSchema.parse(await response.json());
  if (
    page.offset !== offset ||
    page.items.some((item) => item.leadId !== leadId)
  )
    throw new Error(
      "Reply evidence did not match this lead. Refresh before reviewing.",
    );
  return page;
}
function ReplyEvidence({
  reply,
  canReview,
  refresh,
}: {
  reply: Reply;
  canReview: boolean;
  refresh: () => Promise<unknown>;
}) {
  const [draft, setDraft] = useState<{
    version: number;
    note: string;
    confirmed: boolean;
    requestId: string;
  } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [stale, setStale] = useState(false),
    [now, setNow] = useState(Date.now());
  const inFlight = useRef(false);
  useEffect(() => {
    if (!reply.rawExpiresAt) return;
    const until = Date.parse(reply.rawExpiresAt) - Date.now();
    if (until <= 0) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.min(until + 1, 2_147_483_647),
    );
    return () => clearTimeout(timer);
  }, [reply.rawExpiresAt, now]);
  const content =
    reply.content &&
    reply.rawExpiresAt &&
    Date.parse(reply.rawExpiresAt) > Math.max(now, Date.now())
      ? reply.content
      : null;
  const changed = stale || Boolean(draft && draft.version !== reply.version);
  const editable =
    canReview && reply.holdActive && !reply.releasedAt && !reply.historical;
  async function handle() {
    if (
      !draft ||
      inFlight.current ||
      changed ||
      !editable ||
      !draft.confirmed ||
      draft.note.trim().length < 10
    )
      return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        `/api/v1/leads/${encodeURIComponent(reply.leadId)}/mailbox-replies/${encodeURIComponent(reply.id)}/review`,
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            requestId: draft.requestId,
            expectedVersion: draft.version,
            decision: "handled",
            note: draft.note.trim(),
            reviewed: true,
          }),
        },
      );
      if (!response.ok) {
        if (response.status === 409) setStale(true);
        throw new Error();
      }
      setDraft(null);
      await refresh();
    } catch {
      setError(
        "The handling decision was not confirmed. Refresh the evidence and review the current version; no customer message or sequence restart was requested.",
      );
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  }
  return (
    <article className="min-w-0 space-y-3 rounded-lg border border-border p-3">
      <div className="space-y-1">
        <h3 className="break-words font-semibold">
          {content?.subject ||
            "Retained reply evidence — content expired or unavailable"}
        </h3>
        <p className="text-sm">
          {reply.holdActive
            ? "Follow-up held for the office"
            : reply.releasedAt
              ? "Reply handled"
              : "Historical reply — newer follow-up unchanged"}
        </p>
        <p className="text-xs text-muted-foreground">
          Original-mailbox observation · Reply{" "}
          {reply.replyAt
            ? new Date(reply.replyAt).toLocaleString()
            : "time unavailable"}{" "}
          · Received {new Date(reply.receivedAt).toLocaleString()}
        </p>
        <p className="text-xs text-muted-foreground">
          Exact association is evidence of this conversation, not verified
          customer intent or consent.
        </p>
      </div>
      {!reply.monitoringCurrent && (
        <p className="text-sm">
          Monitoring continuity changed or is stopped. This saved evidence can
          still be handled by the office; doing so does not reconnect the
          mailbox, adopt old messages or resume sends.
        </p>
      )}
      {content ? (
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 font-sans text-sm [overflow-wrap:anywhere]">
          {content.text}
        </pre>
      ) : (
        <p className="text-sm text-muted-foreground">
          Raw message content is not available. Use the original mailbox for
          review; the saved hold and duplicate evidence remain.
        </p>
      )}
      <p className="break-words text-sm">
        Responsible office worker:{" "}
        {reply.assignedUserName ||
          reply.assignedUserId ||
          "Assignment needs review"}
        .
      </p>
      <p className="break-words text-sm">
        {reply.taskId
          ? `Task: ${reply.taskTitle || "Review customer reply"} · ${reply.taskStatus || "status unavailable"} · ${reply.taskId}`
          : "No current response task recorded for this historical evidence."}
      </p>
      {reply.effectSummary && (
        <p className="text-xs text-muted-foreground">
          {reply.effectSummary.pausedEnrollments} sequences paused ·{" "}
          {reply.effectSummary.cancelledActions} pending actions cancelled ·{" "}
          {reply.effectSummary.blockedProposals} proposals blocked.
        </p>
      )}
      {Boolean(reply.effectSummary?.reconciliationRequired) && (
        <p className="text-sm">
          Already claimed or uncertain work still requires reconciliation. A
          dispatched message cannot be recalled here.
        </p>
      )}
      {reply.releaseNote && (
        <p className="break-words text-sm">
          Office handling: {reply.releaseNote}
        </p>
      )}
      {editable && !draft && (
        <Button
          variant="outline"
          onClick={() =>
            setDraft({
              version: reply.version,
              note: "",
              confirmed: false,
              requestId: crypto.randomUUID(),
            })
          }
        >
          Review office handling
        </Button>
      )}
      {draft && (
        <div className="space-y-3">
          {changed && (
            <p role="alert">
              This reply changed during review. Your note is preserved. Copy it
              if needed, then discard and refresh before another decision.
            </p>
          )}
          <label className="block space-y-1 text-sm">
            How did the office handle this reply?
            <Textarea
              value={draft.note}
              maxLength={1000}
              readOnly={busy || changed}
              onChange={(event) =>
                setDraft({ ...draft, note: event.target.value })
              }
            />
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              disabled={busy || changed || !editable}
              checked={draft.confirmed}
              onChange={(event) =>
                setDraft({ ...draft, confirmed: event.target.checked })
              }
            />
            I reviewed the original-mailbox evidence and recorded the office's
            handling.
          </label>
          <p className="text-xs text-muted-foreground">
            This handles only this saved reply and accountable task. Other holds
            remain. Cancelled actions and paused sequences never restart
            automatically.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={
                busy ||
                changed ||
                !editable ||
                !draft.confirmed ||
                draft.note.trim().length < 10
              }
              onClick={() => void handle()}
            >
              Mark reply handled
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setDraft(null);
                setStale(false);
                setError("");
                void refresh();
              }}
            >
              Discard note and refresh evidence
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </article>
  );
}
export function LeadMailboxRepliesPanel({
  leadId,
  canReview,
}: {
  leadId: string;
  canReview: boolean;
}) {
  const [offset, setOffset] = useState(0),
    client = useQueryClient();
  const query = useQuery({
    queryKey: ["lead-mailbox-replies", leadId, offset],
    queryFn: () => readPage(leadId, offset),
    retry: false,
  });
  const refresh = async () => {
    await Promise.all([
      query.refetch(),
      client.invalidateQueries({ queryKey: ["customer-replies"] }),
      client.invalidateQueries({ queryKey: ["bie"] }),
      client.invalidateQueries({ queryKey: ["revenue"] }),
      client.invalidateQueries({
        queryKey: getGetLeadNextActionQueryKey(leadId),
      }),
      client.invalidateQueries({ queryKey: getListTodayActionsQueryKey() }),
      client.invalidateQueries({ queryKey: getListTasksQueryKey() }),
      client.invalidateQueries({ queryKey: ["contractor-day"] }),
    ]);
  };
  return (
    <section
      id="mailbox-replies"
      aria-label="Original-mailbox lead replies"
      className="min-w-0 space-y-3 border-b border-border p-3 sm:p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold">Original-mailbox lead replies</h2>
          <p className="max-w-prose text-xs text-muted-foreground">
            Only individually reviewed tracked Microsoft lead emails appear
            here. This is not a general inbox. Email content cannot instruct
            agents, grant consent, book appointments or authorize another send.
          </p>
        </div>
        <Button
          variant="outline"
          disabled={query.isFetching}
          onClick={() => void refresh()}
        >
          Refresh lead reply evidence
        </Button>
      </div>
      {query.isPending ? (
        <p role="status">Loading reply evidence…</p>
      ) : query.isError ? (
        <p role="alert">
          Reply evidence is unavailable. Use Refresh to check again; no reply
          handling is enabled.
        </p>
      ) : (
        <>
          {!query.data.items.length && (
            <p className="text-sm text-muted-foreground">
              No tracked reply evidence on this page. This does not prove
              mailbox connection or absence of customer replies.
            </p>
          )}
          {query.data.items.map((reply) => (
            <ReplyEvidence
              key={reply.id}
              reply={reply}
              canReview={canReview}
              refresh={refresh}
            />
          ))}
          {(offset > 0 || query.data.hasMore) && (
            <nav
              aria-label="Lead reply evidence pages"
              className="flex flex-wrap items-center gap-3"
            >
              <Button
                variant="outline"
                disabled={offset === 0 || query.isFetching}
                onClick={() => setOffset(Math.max(0, offset - 25))}
              >
                Previous replies
              </Button>
              <span className="text-sm">
                Page {Math.floor(offset / 25) + 1} · up to 25 replies
              </span>
              <Button
                variant="outline"
                disabled={!query.data.hasMore || query.isFetching}
                onClick={() => setOffset(offset + 25)}
              >
                Next replies
              </Button>
            </nav>
          )}
        </>
      )}
    </section>
  );
}
