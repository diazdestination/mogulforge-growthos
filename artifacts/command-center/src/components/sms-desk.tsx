import { useEffect, useState, useRef } from "react";
type Inbox = {
  messageSid: string;
  contactId: string | null;
  phone: string;
  body: string | null;
  eventType: string;
  receivedAt: string;
};
type Receipt = {
  id: string;
  phone: string;
  status: string;
  errorCode: string | null;
  createdAt: string;
};
type State = {
  enabled: boolean;
  inbound: Inbox[];
  outbound: Receipt[];
  usage: {
    operations: number;
    limit: number;
    warning: boolean;
    uncertain: number;
    failed: number;
  };
};
export function SmsDesk() {
  const [state, setState] = useState<State | null>(null),
    [contact, setContact] = useState(""),
    [body, setBody] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const requestId = useRef(crypto.randomUUID());
  async function refresh() {
    try {
      const response = await fetch("/api/v1/communications/sms", {
        credentials: "include",
      });
      if (!response.ok) throw new Error();
      setState(await response.json());
    } catch {
      setMessage("The communications inbox could not be loaded.");
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  async function send() {
    setBusy(true);
    try {
      const response = await fetch("/api/v1/communications/sms", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contactId: contact,
          body,
          requestId: requestId.current,
        }),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error ?? "Sending was not confirmed.");
      setMessage(
        "Twilio accepted the message. Check its delivery status below.",
      );
      setBody("");
      requestId.current = crypto.randomUUID();
      await refresh();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Sending was not confirmed. Review the receipt before trying again.",
      );
      await refresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="rounded-lg border bg-card p-5 space-y-4"
      aria-label="SMS conversations"
    >
      <div className="flex justify-between">
        <h3 className="font-semibold">SMS conversations</h3>
        <button
          className="underline text-sm"
          type="button"
          onClick={() => void refresh()}
        >
          Refresh status
        </button>
      </div>
      {!state?.enabled && (
        <p className="text-sm text-muted-foreground">
          Text delivery is disabled for this organization. Enrollment and sender
          approval must be complete before messages can be sent.
        </p>
      )}
      {state && (
        <p className="text-sm" role={state.usage.warning ? "alert" : undefined}>
          Today: {state.usage.operations} of{" "}
          {state.usage.limit || "unconfigured"} app operations ·{" "}
          {state.usage.failed} failures · {state.usage.uncertain} awaiting
          reconciliation.
          {state.usage.warning ? " Daily allowance is nearly used." : ""}
        </p>
      )}
      <ul className="space-y-2">
        {state?.inbound
          .filter((item) => item.eventType === "message")
          .map((item) => (
            <li key={item.messageSid} className="border rounded p-3 text-sm">
              <strong>{item.phone}</strong>
              <p className="whitespace-pre-wrap">{item.body}</p>
              {item.contactId && (
                <button
                  className="underline"
                  type="button"
                  onClick={() => setContact(item.contactId!)}
                >
                  Reply to this contact
                </button>
              )}
            </li>
          ))}
      </ul>
      <label className="block text-sm">
        Contact record ID
        <input
          className="block border rounded p-2 w-full"
          value={contact}
          onChange={(event) => setContact(event.target.value)}
          placeholder="Choose an incoming contact or paste its CRM ID"
        />
      </label>
      <label className="block text-sm">
        Customer-care reply
        <textarea
          className="block border rounded p-2 w-full"
          value={body}
          maxLength={1000}
          onChange={(event) => setBody(event.target.value)}
        />
      </label>
      <p className="text-xs text-muted-foreground">
        MogulForge identification and STOP/HELP instructions are added
        automatically. Promotional texts are not enabled.
      </p>
      <button
        className="border rounded px-4 py-2 disabled:opacity-50"
        type="button"
        disabled={!state?.enabled || !contact || !body.trim() || busy}
        onClick={() => void send()}
      >
        Send reply
      </button>
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      <ul className="text-sm space-y-1">
        {state?.outbound.map((item) => (
          <li key={item.id}>
            {item.phone} · <strong>{item.status}</strong>
            {item.errorCode ? ` · error ${item.errorCode}` : ""}
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        An uncertain or interrupted operation must be reconciled against Twilio
        before creating a new send. Usage alerts do not cap your Twilio bill;
        the configured daily operation limit only controls this app.
      </p>
    </section>
  );
}
