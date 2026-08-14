import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, Router as WouterRouter, Link } from 'wouter';
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
import Capture from '@/pages/capture';
import Onboarding from '@/pages/onboarding';
import Platform from '@/pages/platform';
import Bie from '@/pages/bie';
import EvidenceIntelligence from '@/pages/evidence-intelligence';
import Account from '@/pages/account';
import { CreateOrgScreen } from '@/components/create-org';
import { useGetSession, getGetSessionQueryKey } from '@workspace/api-client-react';

const queryClient = new QueryClient();

const AUTH_INPUT_CLASS =
  'w-full h-11 px-4 rounded-md border border-input bg-background text-sm outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition-shadow';

function LoginScreen({ initialMode = 'login' }: { initialMode?: 'login' | 'register' }) {
  const [mode, setMode] = useState<'login' | 'register'>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const brandInitial = (CLIENT.businessShortName || CLIENT.appName || 'M')
    .trim()
    .charAt(0)
    .toUpperCase();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
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
            };
      const res = await fetch(path, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || 'Something went wrong. Please try again.');
      }
      // Session cookie is set — reload so useAuth re-fetches the current user.
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
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
            autoComplete="email"
          />
          <input
            className={AUTH_INPUT_CLASS}
            type="password"
            required
            minLength={mode === 'register' ? 8 : undefined}
            placeholder={mode === 'register' ? 'Password (8+ characters)' : 'Password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          />

          {error && (
            <p className="text-sm text-destructive text-center" role="alert">
              {error}
            </p>
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

        <button
          onClick={() => {
            setMode(mode === 'login' ? 'register' : 'login');
            setError(null);
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

function Router() {
  const { isAuthenticated, isLoading } = useAuth();

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
