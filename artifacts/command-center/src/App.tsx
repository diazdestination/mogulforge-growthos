import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, Router as WouterRouter, Link, Redirect, useRoute } from 'wouter';
import { useAuth } from '@workspace/replit-auth-web';
import { Shell } from '@/components/shell';
import { AccessGate } from '@/components/access-gate';
import { Loader2 } from 'lucide-react';
import { CLIENT } from '@/lib/client.config';

// Pages
import Dashboard from '@/pages/dashboard';
import Assistant from '@/pages/assistant';
import Pipeline from '@/pages/pipeline';
import Insights from '@/pages/insights';
import Reports from '@/pages/reports';
import LeadDetail from '@/pages/lead-detail';
import Contacts from '@/pages/contacts';
import Properties from '@/pages/properties';
import Estimates from '@/pages/estimates';
import Projects from '@/pages/projects';
import Tasks from '@/pages/tasks';
import Appointments from '@/pages/appointments';
import AuditLog from '@/pages/audit';
import Settings from '@/pages/settings';
import Billing from '@/pages/billing';
import LandingPage from '@/pages/landing';
import Forms from '@/pages/forms';
import Reactivation from '@/pages/reactivation';
import ServiceDesk from '@/pages/service-desk';
import Calls from '@/pages/calls';
import Capture from '@/pages/capture';
import Onboarding from '@/pages/onboarding';
import Platform from '@/pages/platform';
import Bie from '@/pages/bie';
import ProjectRoom from '@/pages/project-room';
import EvidenceIntelligence from '@/pages/evidence-intelligence';
import Account from '@/pages/account';
import { CreateOrgScreen } from '@/components/create-org';
import {
  useGetSession,
  getGetSessionQueryKey,
} from '@workspace/api-client-react';

const queryClient = new QueryClient();

const AUTH_INPUT_CLASS =
  'w-full h-11 px-4 rounded-md border border-input bg-background text-sm outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition-shadow';

function LoginScreen({
  initialMode = 'login',
}: {
  initialMode?: 'login' | 'register';
}) {
  const inviteParams =
    initialMode === 'register'
      ? new URLSearchParams(window.location.search)
      : null;
  const inviteToken = inviteParams?.get('invite')?.trim() || undefined;
  const invitedEmail = inviteParams?.get('email')?.trim() || '';
  const [mode, setMode] = useState<'login' | 'register'>(initialMode);
  const [email, setEmail] = useState(invitedEmail);
  const [password, setPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [canResendVerification, setCanResendVerification] = useState(false);
  const [busy, setBusy] = useState(false);

  const brandInitial = (CLIENT.businessShortName || CLIENT.appName || 'M')
    .trim()
    .charAt(0)
    .toUpperCase();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setCanResendVerification(false);
    setBusy(true);
    try {
      const path = mode === 'login' ? '/api/auth/login' : '/api/auth/register';
      const payload =
        mode === 'login'
          ? { email, password }
          : {
              email,
              password,
              firstName: firstName || undefined,
              lastName: lastName || undefined,
              inviteToken,
            };
      const res = await fetch(path, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        code?: string;
        message?: string;
        verificationRequired?: boolean;
      };
      if (!res.ok) {
        if (data.code === 'EMAIL_VERIFICATION_REQUIRED') {
          setCanResendVerification(true);
        }
        throw new Error(
          data.error || 'Something went wrong. Please try again.',
        );
      }
      if (data.verificationRequired) {
        setMode('login');
        setPassword('');
        setCanResendVerification(true);
        setNotice(data.message || 'Check your email to verify your account.');
        setBusy(false);
        return;
      }
      // Session cookie is set — reload so useAuth re-fetches the current user.
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      setBusy(false);
    }
  }

  async function resendVerification() {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const res = await fetch('/api/auth/resend-verification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
      };
      if (!res.ok) {
        throw new Error(
          data.error || 'Unable to request a verification email.',
        );
      }
      setNotice(
        data.message ||
          'If the account is eligible, a verification email is on its way.',
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background text-foreground selection:bg-primary selection:text-primary-foreground">
      <div className="max-w-md w-full px-8 py-12 flex flex-col items-center">
        <Link
          href="/"
          className="self-start mb-6 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          ← Back to home
        </Link>
        <div className="w-16 h-16 bg-primary rounded-xl flex items-center justify-center text-primary-foreground text-3xl font-bold mb-8 shadow-xl shadow-primary/20">
          {brandInitial}
        </div>
        <h1 className="text-3xl font-bold tracking-tight mb-2 text-center">
          {CLIENT.appName}
        </h1>
        <p className="text-muted-foreground text-center mb-8 text-sm">
          {mode === 'login'
            ? 'Sign in to your mission control.'
            : inviteToken
              ? 'Create your account to accept your secure team invitation.'
              : 'Create your account to get started.'}
        </p>

        <form onSubmit={submit} className="w-full flex flex-col gap-3">
          {mode === 'register' && (
            <div className="flex gap-3">
              <input
                className={AUTH_INPUT_CLASS}
                placeholder="First name"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                autoComplete="given-name"
              />
              <input
                className={AUTH_INPUT_CLASS}
                placeholder="Last name"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                autoComplete="family-name"
              />
            </div>
          )}
          <input
            className={AUTH_INPUT_CLASS}
            type="email"
            required
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            readOnly={mode === 'register' && !!inviteToken}
            autoComplete="email"
          />
          <input
            className={AUTH_INPUT_CLASS}
            type="password"
            required
            minLength={mode === 'register' ? 8 : undefined}
            placeholder={
              mode === 'register' ? 'Password (8+ characters)' : 'Password'
            }
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={
              mode === 'login' ? 'current-password' : 'new-password'
            }
          />

          {error && (
            <p className="text-sm text-destructive text-center" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p
              className="text-sm text-emerald-600 dark:text-emerald-400 text-center"
              role="status"
            >
              {notice}
            </p>
          )}
          {canResendVerification && (
            <button
              type="button"
              disabled={busy || !email}
              onClick={resendVerification}
              className="text-sm text-primary hover:underline disabled:opacity-50"
            >
              Resend verification email
            </button>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full bg-primary text-primary-foreground hover:bg-primary/90 h-12 rounded-md font-semibold text-sm tracking-wide transition-all shadow-lg shadow-primary/20 hover:shadow-primary/40 active:scale-[0.98] disabled:opacity-60 disabled:pointer-events-none"
          >
            {busy
              ? 'Please wait…'
              : mode === 'login'
                ? 'SIGN IN'
                : 'CREATE ACCOUNT'}
          </button>
        </form>

        {mode === 'login' && (
          <Link
            href="/forgot-password"
            className="mt-4 text-sm text-primary hover:underline"
          >
            Forgot your password?
          </Link>
        )}

        <button
          onClick={() => {
            setMode(mode === 'login' ? 'register' : 'login');
            setError(null);
            setNotice(null);
            setCanResendVerification(false);
          }}
          className="mt-6 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          {mode === 'login'
            ? "Don't have an account? Create one"
            : 'Already have an account? Sign in'}
        </button>

        <div className="mt-10 flex items-center gap-4 text-xs font-mono text-muted-foreground opacity-50 uppercase tracking-widest">
          <div className="h-[1px] w-8 bg-border" />
          Authorized Personnel Only
          <div className="h-[1px] w-8 bg-border" />
        </div>
      </div>
    </div>
  );
}

type IdentityActionKind = 'forgot' | 'reset' | 'verify';

function IdentityActionScreen({ kind }: { kind: IdentityActionKind }) {
  const token =
    new URLSearchParams(window.location.search).get('token')?.trim() || '';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [complete, setComplete] = useState(false);

  const title =
    kind === 'forgot'
      ? 'Reset your password'
      : kind === 'reset'
        ? 'Choose a new password'
        : 'Verify your email';
  const description =
    kind === 'forgot'
      ? 'Enter your account email and we will send a secure reset link.'
      : kind === 'reset'
        ? 'This single-use link will replace your password and sign out other sessions.'
        : 'Confirm this single-use link to secure your GrowthOS account.';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);

    if (kind === 'reset' && password !== confirmation) {
      setError('Passwords do not match.');
      return;
    }
    if (kind !== 'forgot' && !token) {
      setError(
        `This ${kind === 'verify' ? 'verification' : 'reset'} link is missing its secure token.`,
      );
      return;
    }

    setBusy(true);
    try {
      const endpoint =
        kind === 'forgot'
          ? '/api/auth/forgot-password'
          : kind === 'reset'
            ? '/api/auth/reset-password'
            : '/api/auth/verify-email';
      const payload =
        kind === 'forgot'
          ? { email }
          : kind === 'reset'
            ? { token, password }
            : { token };
      const res = await fetch(endpoint, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
      };
      if (!res.ok) {
        throw new Error(data.error || 'Unable to complete this request.');
      }
      setComplete(true);
      setNotice(
        data.message ||
          (kind === 'verify'
            ? 'Your email is verified. You are securely signed in.'
            : kind === 'reset'
              ? 'Your password has been reset. You can sign in now.'
              : 'If an eligible account exists, the reset link is on its way.'),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background text-foreground">
      <div className="max-w-md w-full px-8 py-12">
        <Link
          href="/login"
          className="inline-block mb-8 text-sm text-muted-foreground hover:text-foreground"
        >
          ← Back to sign in
        </Link>
        <h1 className="text-3xl font-bold tracking-tight mb-2">{title}</h1>
        <p className="text-muted-foreground mb-8 text-sm">{description}</p>

        <form onSubmit={submit} className="flex flex-col gap-3">
          {kind === 'forgot' && (
            <input
              className={AUTH_INPUT_CLASS}
              type="email"
              required
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
            />
          )}
          {kind === 'reset' && !complete && (
            <>
              <input
                className={AUTH_INPUT_CLASS}
                type="password"
                required
                minLength={8}
                maxLength={200}
                placeholder="New password (8+ characters)"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
              />
              <input
                className={AUTH_INPUT_CLASS}
                type="password"
                required
                minLength={8}
                maxLength={200}
                placeholder="Confirm new password"
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
                autoComplete="new-password"
              />
            </>
          )}

          {error && (
            <p className="text-sm text-destructive text-center" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p
              className="text-sm text-emerald-600 dark:text-emerald-400 text-center"
              role="status"
            >
              {notice}
            </p>
          )}

          {!complete && (
            <button
              type="submit"
              disabled={busy}
              className="w-full bg-primary text-primary-foreground hover:bg-primary/90 h-12 rounded-md font-semibold text-sm tracking-wide transition-all disabled:opacity-60"
            >
              {busy
                ? 'Please wait…'
                : kind === 'forgot'
                  ? 'SEND RESET LINK'
                  : kind === 'reset'
                    ? 'RESET PASSWORD'
                    : 'VERIFY EMAIL'}
            </button>
          )}
        </form>

        {complete && (
          <Link
            href={kind === 'verify' ? '/' : '/login'}
            onClick={(event) => {
              if (kind === 'verify') {
                event.preventDefault();
                window.location.replace('/');
              }
            }}
            className="mt-6 flex w-full items-center justify-center bg-primary text-primary-foreground h-12 rounded-md font-semibold text-sm"
          >
            {kind === 'verify' ? 'CONTINUE TO GROWTHOS' : 'RETURN TO SIGN IN'}
          </Link>
        )}
      </div>
    </div>
  );
}

function Router() {
  const { isAuthenticated, isLoading } = useAuth();
  const [isProjectRoom, projectParams] = useRoute('/project-room/:workspace/:leadId');
  if (isProjectRoom && projectParams) return <ProjectRoom key={`${projectParams.workspace}:${projectParams.leadId}`} workspace={projectParams.workspace} leadId={projectParams.leadId} />;

  if (isLoading) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <Switch>
        <Route path="/login">
          <LoginScreen initialMode="login" />
        </Route>
        <Route path="/signup">
          <LoginScreen initialMode="register" />
        </Route>
        <Route path="/forgot-password">
          <IdentityActionScreen kind="forgot" />
        </Route>
        <Route path="/reset-password">
          <IdentityActionScreen kind="reset" />
        </Route>
        <Route path="/verify-email">
          <IdentityActionScreen kind="verify" />
        </Route>
        <Route>
          <LandingPage />
        </Route>
      </Switch>
    );
  }

  return <AuthedApp />;
}

function AuthedApp() {
  // Session probe works BEFORE the user belongs to an org: users without an
  // organization see the create-company screen instead of the app shell.
  const { data: session, isLoading: sessionLoading } = useGetSession({
    query: { queryKey: getGetSessionQueryKey(), retry: 1 },
  });

  if (sessionLoading) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (session && !session.organization) {
    return <CreateOrgScreen />;
  }

  return (
    <AccessGate>
      <Shell>
        <Switch>
          <Route path="/login">
            <Redirect to="/" replace />
          </Route>
          <Route path="/signup">
            <Redirect to="/" replace />
          </Route>
          <Route path="/forgot-password">
            <Redirect to="/" replace />
          </Route>
          <Route path="/reset-password">
            <Redirect to="/" replace />
          </Route>
          <Route path="/verify-email">
            <Redirect to="/" replace />
          </Route>
          <Route path="/" component={Bie} />
          <Route path="/bie" component={Bie} />
          <Route path="/evidence" component={EvidenceIntelligence} />
          <Route path="/dashboard" component={Dashboard} />
          <Route path="/assistant" component={Assistant} />
          <Route path="/pipeline" component={Pipeline} />
          <Route path="/insights" component={Insights} />
          <Route path="/reports" component={Reports} />
          <Route path="/leads/:id" component={LeadDetail} />
          <Route path="/contacts" component={Contacts} />
          <Route path="/properties" component={Properties} />
          <Route path="/estimates" component={Estimates} />
          <Route path="/projects" component={Projects} />
          <Route path="/tasks" component={Tasks} />
          <Route path="/appointments" component={Appointments} />
          <Route path="/audit" component={AuditLog} />
          <Route path="/settings" component={Settings} />
          <Route path="/account" component={Account} />
          <Route path="/billing" component={Billing} />
          <Route path="/forms" component={Forms} />
          <Route path="/reactivation" component={Reactivation} />
          <Route path="/service" component={ServiceDesk} />
          <Route path="/calls" component={Calls} />
          <Route path="/capture" component={Capture} />
          <Route path="/onboarding" component={Onboarding} />
          <Route path="/platform" component={Platform} />
          <Route component={NotFound} />
        </Switch>
      </Shell>
    </AccessGate>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
