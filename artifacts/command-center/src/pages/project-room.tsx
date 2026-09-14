import { useState, useEffect } from "react";
import { ShieldCheck, ArrowRight, MessageSquare } from "lucide-react";

interface PublicRoom {
  photos?: string[];
  versions: {
    id: string;
    version: number;
    title: string;
    scope: string;
    warranty: string;
    estimateTotalCents: number;
    isCurrent: boolean;
    options: { name: string; description: string }[];
  }[];
  appointments: { id: string; status: string; scheduledStart: string }[];
  boundary: string;
}
const field =
  "w-full rounded-xl border border-input bg-background px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40";
export default function ProjectRoom({
  workspace,
  leadId,
}: {
  workspace: string;
  leadId: string;
}) {
  const [identifier, setIdentifier] = useState("");
  const [code, setCode] = useState("");
  const [token, setToken] = useState("");
  const [room, setRoom] = useState<PublicRoom | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [question, setQuestion] = useState("");
  async function request(path: string, body?: unknown, authorization = token) {
    const response = await fetch(`/api/v1${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json",
        ...(authorization ? { "x-portal-token": authorization } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await response.json();
    if (!response.ok)
      throw new Error(data.error || "Your project could not be loaded.");
    return data;
  }
  async function work(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="min-h-screen bg-background p-4 text-foreground sm:p-8">
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="rounded-3xl border border-primary/25 bg-gradient-to-br from-primary/10 to-card p-6 sm:p-9">
          <span className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-primary">
            <ShieldCheck className="h-4 w-4" />
            Your private project room
          </span>
          <h1 className="mt-4 text-3xl font-semibold tracking-tight sm:text-4xl">
            A clearer path to your finished project.
          </h1>
          <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
            Review your approved scope and options, see appointment details, and
            ask your project team a question.
          </p>
        </header>
        {error && (
          <p
            role="alert"
            className="rounded-xl border border-destructive/30 p-4 text-sm text-destructive"
          >
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="rounded-xl border p-4 text-sm">
            {notice}
          </p>
        )}
        {!room && (
          <section className="mx-auto max-w-lg space-y-5 rounded-2xl border bg-card p-6">
            <h2 className="text-xl font-semibold">Sign in to your project</h2>
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                void work(async () => {
                  const result = await request(
                    `/portal/workspaces/${encodeURIComponent(workspace)}/login/request`,
                    { identifier },
                  );
                  setNotice(result.message);
                });
              }}
            >
              <label className="block space-y-2 text-sm">
                Email address or phone on your project
                <input
                  className={field}
                  required
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  autoComplete="username"
                />
              </label>
              <button
                disabled={busy}
                className="min-h-11 rounded-xl border px-4 text-sm font-medium"
              >
                Request sign-in code
              </button>
            </form>
            <form
              className="space-y-4 border-t pt-4"
              onSubmit={(e) => {
                e.preventDefault();
                void work(async () => {
                  const session = await request(
                    `/portal/workspaces/${encodeURIComponent(workspace)}/login/verify`,
                    { identifier, code },
                  );
                  const result = await request(
                    `/portal/projects/${encodeURIComponent(leadId)}/decision-room`,
                    undefined,
                    session.token,
                  );
                  setToken(session.token);
                  setRoom(result);
                  setCode("");
                });
              }}
            >
              <label className="block space-y-2 text-sm">
                Six-digit sign-in code
                <input
                  className={field}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  required
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              </label>
              <button
                disabled={busy || !identifier}
                className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-primary px-5 text-sm font-semibold text-primary-foreground"
              >
                Open my project
                <ArrowRight className="h-4 w-4" />
              </button>
            </form>
            <p className="text-xs text-muted-foreground">
              Only the contact recorded on this project can access it. Sign-in
              codes require the business’s delivery setup.
            </p>
          </section>
        )}
        {room && (
          <>
            <div className="flex flex-wrap justify-between gap-3">
              <p className="text-sm text-muted-foreground">
                Approved project information
              </p>
              <button
                className="text-sm text-primary underline"
                disabled={busy}
                onClick={() =>
                  void work(async () => {
                    await request("/portal/logout", {});
                    setRoom(null);
                    setToken("");
                    setQuestion("");
                    setNotice("Project room closed. Your session was revoked.");
                  })
                }
              >
                Close project room
              </button>
            </div>
            {!room.versions.length && (
              <p className="rounded-xl border p-5">
                Your team has not shared a decision package yet. You can ask a
                question below.
              </p>
            )}
            {room.versions.map((v, index) => (
              <article
                className="space-y-5 rounded-2xl border bg-card p-6"
                key={v.id}
              >
                <div>
                  <p className="text-xs font-semibold uppercase tracking-widest text-primary">
                    {index === 0 ? "Latest shared package" : "Earlier version"}{" "}
                    · Version {v.version}
                  </p>
                  <h2 className="mt-2 text-2xl font-semibold">{v.title}</h2>
                </div>
                {!v.isCurrent && (
                  <p
                    role="note"
                    className="rounded-lg bg-amber-500/10 p-3 text-sm"
                  >
                    The estimate has changed since this package was shared. Ask
                    your team for an updated version before making a decision.
                  </p>
                )}
                <p className="whitespace-pre-wrap text-sm leading-relaxed">
                  {v.scope}
                </p>
                <div className="grid gap-3 md:grid-cols-3">
                  {v.options.map((o) => (
                    <div
                      className="rounded-xl border bg-background p-4"
                      key={o.name}
                    >
                      <h3 className="font-semibold">{o.name}</h3>
                      <p className="mt-2 text-sm text-muted-foreground">
                        {o.description}
                      </p>
                    </div>
                  ))}
                </div>
                <p className="text-lg font-semibold">
                  Estimate snapshot:{" "}
                  {(v.estimateTotalCents / 100).toLocaleString("en-US", {
                    style: "currency",
                    currency: "USD",
                  })}
                </p>
                <p className="text-sm">
                  <strong>Warranty information:</strong> {v.warranty}
                </p>
              </article>
            ))}
            {!!room.photos?.length && (
              <section className="rounded-2xl border p-6">
                <h2 className="text-lg font-semibold">Your project photos</h2>
                <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {room.photos.map((path, index) => (
                    <PrivateProjectPhoto
                      key={path}
                      path={path}
                      token={token}
                      index={index}
                    />
                  ))}
                </div>
              </section>
            )}
            <section className="rounded-2xl border p-6">
              <h2 className="text-lg font-semibold">Appointments</h2>
              {room.appointments.length ? (
                room.appointments.map((a) => (
                  <p key={a.id} className="mt-3 text-sm">
                    {new Date(a.scheduledStart).toLocaleString()} · {a.status}
                  </p>
                ))
              ) : (
                <p className="mt-2 text-sm text-muted-foreground">
                  No appointment is recorded yet. A request or conversation
                  alone does not confirm a booking.
                </p>
              )}
            </section>
            <form
              className="space-y-3 rounded-2xl border p-6"
              onSubmit={(e) => {
                e.preventDefault();
                void work(async () => {
                  await request(
                    `/portal/claims/${encodeURIComponent(leadId)}/messages`,
                    { content: question },
                  );
                  setQuestion("");
                  setNotice(
                    "Your question was saved for the project team. This does not confirm an appointment or a response time.",
                  );
                });
              }}
            >
              <label className="block space-y-2 font-medium">
                Ask your project team
                <textarea
                  className={field}
                  rows={4}
                  required
                  minLength={1}
                  maxLength={2000}
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                />
              </label>
              <button
                disabled={busy}
                className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-primary px-5 text-sm font-semibold text-primary-foreground"
              >
                <MessageSquare className="h-4 w-4" />
                Send question to team
              </button>
            </form>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {room.boundary}
            </p>
          </>
        )}
      </div>
    </main>
  );
}

function PrivateProjectPhoto({
  path,
  token,
  index,
}: {
  path: string;
  token: string;
  index: number;
}) {
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!path.startsWith("/objects/")) {
      setFailed(true);
      return;
    }
    const controller = new AbortController();
    let objectUrl = "";
    void fetch(
      `/api/v1/portal/photos/objects/${path.slice("/objects/".length).split("/").map(encodeURIComponent).join("/")}`,
      { headers: { "x-portal-token": token }, signal: controller.signal },
    )
      .then(async (response) => {
        if (
          !response.ok ||
          !response.headers.get("content-type")?.startsWith("image/")
        )
          throw new Error("Photo unavailable");
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path, token]);
  return failed ? (
    <p className="rounded-xl border p-4 text-sm">
      Photo unavailable. Ask your project team for help.
    </p>
  ) : url ? (
    <img
      className="aspect-[4/3] w-full rounded-xl object-cover"
      src={url}
      alt={`Customer-supplied project photo ${index + 1}`}
    />
  ) : (
    <p role="status" className="rounded-xl border p-4 text-sm">
      Loading private photo…
    </p>
  );
}
