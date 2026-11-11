import { useEffect, useState } from 'react';
import { getGetMeQueryKey, useGetMe } from '@workspace/api-client-react';
import { useAuth } from '@workspace/replit-auth-web';
import { Loader2, ShieldOff } from 'lucide-react';

const REVOKED_STATUSES = new Set([401, 403]);

function errorStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * Blocks the entire CRM for teammates whose access has been revoked
 * (deactivated or removed from the organization). The profile is
 * re-checked periodically and on window focus so a mid-session
 * deactivation kicks the user out instead of showing stale screens.
 */
export function AccessGate({ children }: { children: React.ReactNode }) {
  const { logout } = useAuth();
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const { data: me, error, isLoading } = useGetMe({
    query: {
      queryKey: getGetMeQueryKey(),
      retry: (failureCount, err) => {
        const status = errorStatus(err);
        if (status !== undefined && REVOKED_STATUSES.has(status)) return false;
        return failureCount < 2;
      },
      refetchInterval: 30_000,
      refetchOnWindowFocus: true,
      refetchIntervalInBackground: true,
    },
  });

  const status = errorStatus(error);
  const revoked =
    (status !== undefined && REVOKED_STATUSES.has(status)) ||
    me?.isActive === false;

  useEffect(() => {
    if (!revoked) return;
    const timer = setTimeout(() => logout(), 2500);
    return () => clearTimeout(timer);
  }, [revoked, logout]);

  if (revoked) {
    return (
      <div
        data-testid="access-revoked"
        className="min-h-screen w-full flex items-center justify-center bg-background text-foreground"
      >
        <div className="max-w-md w-full px-8 py-12 flex flex-col items-center text-center">
          <div className="w-14 h-14 rounded-xl bg-destructive/10 text-destructive flex items-center justify-center mb-6">
            <ShieldOff className="w-7 h-7" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight mb-2">Access revoked</h1>
          <p className="text-sm text-muted-foreground mb-8">
            Your account is no longer active in this organization. You are being
            signed out. Contact an administrator if you believe this is a mistake.
          </p>
          <button
            onClick={logout}
            className="bg-primary text-primary-foreground hover:bg-primary/90 px-6 h-10 rounded-md font-semibold text-sm transition-colors"
          >
            Sign out now
          </button>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (me?.emailVerified === false) {
    const resend = async () => {
      setSending(true);
      setNotice(null);
      setSendError(null);
      try {
        const response = await fetch('/api/auth/resend-verification', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: me.email }),
        });
        if (!response.ok) throw new Error('We could not request your verification email. Please try again.');
        setNotice('Verification requested. Check your inbox and spam folder for a link from GrowthOS, then open it to confirm your email.');
      } catch {
        setSendError('We could not request your verification email. Please try again.');
      } finally {
        setSending(false);
      }
    };
    return (
      <main className="min-h-screen flex items-center justify-center bg-background text-foreground p-6">
        <div className="max-w-md space-y-5">
          <h1 className="text-2xl font-bold">Verify your email to open your workspace</h1>
          <p>Confirm {me.email || 'your account email'} so GrowthOS can give you secure access to your company’s work.</p>
          {notice && <p role="status">{notice}</p>}
          {sendError && <p role="alert">{sendError}</p>}
          <button className="min-h-11 rounded-md bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50" disabled={sending || !!notice || !me.email} onClick={() => void resend()}>
            {sending ? 'Requesting email…' : 'Send verification email'}
          </button>
          <p>Already confirmed? <button className="min-h-11 underline" onClick={() => window.location.reload()}>Check again</button></p>
          <button className="min-h-11 underline" onClick={logout}>Sign out</button>
        </div>
      </main>
    );
  }

  return <>{children}</>;
}
