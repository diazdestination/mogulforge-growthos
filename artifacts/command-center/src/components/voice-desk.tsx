import { useEffect, useRef, useState } from "react";
type Call = {
  id: string;
  direction: string;
  phone: string;
  status: string;
  dialStatus: string | null;
  contactId: string | null;
};
export function VoiceDesk() {
  const [calls, setCalls] = useState<Call[]>([]),
    [enabled, setEnabled] = useState(false),
    [contact, setContact] = useState(""),
    [requested, setRequested] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const operation = useRef(crypto.randomUUID());
  async function refresh() {
    try {
      const response = await fetch("/api/v1/communications/voice", {
        credentials: "include",
      });
      if (!response.ok) throw new Error();
      const state = await response.json();
      setCalls(state.calls);
      setEnabled(state.enabled);
    } catch {
      setMessage("Calling status could not be loaded.");
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  async function call() {
    setBusy(true);
    try {
      const response = await fetch("/api/v1/communications/voice", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contactId: contact,
          requestedByContact: requested,
          requestId: operation.current,
        }),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(
          data.error ?? "Call not confirmed. Review the call log.",
        );
      setMessage(
        `Call operation: ${data.status}. Answer the approved staff phone and press 1 to connect. This does not confirm the customer answered.`,
      );
      operation.current = crypto.randomUUID();
      setRequested(false);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Call not confirmed.",
      );
    } finally {
      setBusy(false);
      await refresh();
    }
  }
  return (
    <section
      className="rounded-lg border bg-card p-5 space-y-3"
      aria-label="Business calls"
    >
      <div className="flex justify-between">
        <h3 className="font-semibold">Business calls</h3>
        <button
          type="button"
          className="underline text-sm"
          onClick={() => void refresh()}
        >
          Refresh calls
        </button>
      </div>
      <p className="text-sm">
        Start a requested call from GrowthOS. Audio uses the approved staff
        phone, then connects to the contact. Both call legs can incur charges.
        Calls are limited to five minutes.
      </p>
      {!enabled && (
        <p className="text-sm text-muted-foreground">
          Calling is disabled until the sender, staff phone, geographic
          permissions and usage allowance are approved.
        </p>
      )}
      <label className="block text-sm">
        Contact record ID
        <input
          className="block border rounded p-2 w-full"
          value={contact}
          onChange={(event) => setContact(event.target.value)}
        />
      </label>
      <label className="flex gap-2 text-sm">
        <input
          type="checkbox"
          checked={requested}
          onChange={(event) => setRequested(event.target.checked)}
        />
        This contact asked us to call this number. I authorize this call.
      </label>
      <button
        type="button"
        className="border rounded px-4 py-2 disabled:opacity-50"
        disabled={!enabled || !contact || !requested || busy}
        onClick={() => void call()}
      >
        Call through staff phone
      </button>
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        No call recording or emergency calling. Missed calls appear here for
        manual review; they do not grant SMS consent.
      </p>
      <ul className="text-sm space-y-2">
        {calls.map((item) => (
          <li key={item.id}>
            {item.direction} · {item.phone} · {item.status}
            {item.dialStatus ? ` · connection: ${item.dialStatus}` : ""}
            {item.contactId && (
              <button
                type="button"
                className="underline ml-2"
                onClick={() => {
                  setContact(item.contactId!);
                  setRequested(false);
                }}
              >
                Select contact
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
