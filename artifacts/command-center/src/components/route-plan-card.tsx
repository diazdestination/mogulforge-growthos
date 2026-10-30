import { useCallback, useEffect, useState } from 'react';
import { Loader2, MapPin, Navigation, Route } from 'lucide-react';

type Stop = {
  routeId: string;
  kind: 'appointment' | 'project';
  appointmentId: string | null;
  projectId: string | null;
  continuesFromPreviousDay: boolean;
  scheduledStart: string;
  type: string;
  customerName: string;
  address: string | null;
  located: boolean;
};

type Plan = {
  date: string;
  timeZone: string;
  stops: Stop[];
  currentOrder: string[];
  suggestedOrder: string[];
  currentMiles: number;
  suggestedMiles: number;
  savedMiles: number;
  currentDriveMinutes: number;
  suggestedDriveMinutes: number;
  unlocatedCount: number;
  mapsUrl: string | null;
  suggestedMapsUrl: string | null;
  estimateNote: string;
  geocoderEnabled?: boolean;
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1${path}`, { credentials: 'include', ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body;
}

const linkClass = 'inline-flex min-h-11 items-center gap-2 rounded-lg border border-border px-3 text-sm font-medium hover:bg-muted';

/**
 * SCHED route plan for the signed-in crew member's day: stops in booked order,
 * estimated miles, a one-tap maps route, and a shorter order when one exists.
 * Suggestions never move an appointment; customer times stay as booked.
 */
export function RoutePlanCard({ date, canWrite }: { date: string; canWrite: boolean }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [loading, setLoading] = useState(true);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await api<Plan>(`/route-plan?date=${encodeURIComponent(date)}`);
      setPlan(Array.isArray(next?.stops) ? next : null);
    } catch (cause) {
      setPlan(null);
      setError(cause instanceof Error ? cause.message : 'Could not load the route');
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => {
    void load();
  }, [load]);

  const locate = async () => {
    setLocating(true);
    setError(null);
    try {
      const result = await api<{ located: number; notFound: number; plan: Plan }>('/route-plan/locate', { method: 'POST', body: JSON.stringify({ date }) });
      setPlan({ ...result.plan, geocoderEnabled: plan?.geocoderEnabled });
      if (result.notFound > 0) setError(`${result.notFound} address${result.notFound === 1 ? '' : 'es'} could not be found. Check them on the property record.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not look up addresses');
    } finally {
      setLocating(false);
    }
  };

  if (loading && !plan) return null;
  if (!plan || plan.stops.length === 0) return null;

  const time = new Intl.DateTimeFormat('en-US', { timeZone: plan.timeZone, hour: 'numeric', minute: '2-digit' });
  const byId = new Map(plan.stops.map((stop) => [stop.routeId, stop]));
  const priorTime = new Intl.DateTimeFormat('en-US', { timeZone: plan.timeZone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const reorder = plan.savedMiles > 0 && plan.suggestedOrder.join() !== plan.currentOrder.join();

  return (
    <section aria-label="Route plan" className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-center gap-3 border-b border-border p-4">
        <Route className="h-4 w-4 text-primary" aria-hidden />
        <h2 className="font-semibold">My route</h2>
        <span className="text-sm text-muted-foreground">
          {plan.stops.length} stop{plan.stops.length === 1 ? '' : 's'}
          {plan.currentOrder.length > 1 && ` · about ${plan.currentMiles} mi, ${plan.currentDriveMinutes} min driving`}
        </span>
        <div className="ml-auto flex flex-wrap gap-2">
          {plan.mapsUrl && (
            <a className={linkClass} href={plan.mapsUrl} target="_blank" rel="noreferrer">
              <Navigation className="h-4 w-4" aria-hidden /> Open route in Maps
            </a>
          )}
        </div>
      </div>
      <ol className="divide-y divide-border">
        {plan.stops.map((stop) => (
          <li key={stop.routeId} className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
            <span className="shrink-0 font-mono text-xs text-muted-foreground">{stop.continuesFromPreviousDay ? `Started ${priorTime.format(new Date(stop.scheduledStart))}` : time.format(new Date(stop.scheduledStart))}</span>
            <span className="text-xs text-muted-foreground">{stop.kind === 'project' ? 'Job' : 'Appointment'}</span>
            <span className="font-medium">{stop.customerName}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{stop.address ?? `No property on this ${stop.kind === 'project' ? 'job' : 'appointment'}`}</span>
            {!stop.located && stop.address && <MapPin className="h-4 w-4 text-amber-500" aria-label="Not on the map yet" />}
          </li>
        ))}
      </ol>
      {(reorder || plan.unlocatedCount > 0 || error) && (
        <div className="space-y-2 border-t border-border bg-muted/20 p-4 text-sm">
          {reorder && (
            <div className="flex flex-wrap items-center gap-2">
              <span>
                SCHED found a shorter order that saves about <strong>{plan.savedMiles} mi</strong> (
                {plan.currentDriveMinutes - plan.suggestedDriveMinutes} min):{' '}
                {plan.suggestedOrder.map((id) => byId.get(id)?.customerName).join(' → ')}. Times stay as booked unless you move them.
              </span>
              {plan.suggestedMapsUrl && (
                <a className={linkClass} href={plan.suggestedMapsUrl} target="_blank" rel="noreferrer">
                  <Navigation className="h-4 w-4" aria-hidden /> Shorter route in Maps
                </a>
              )}
            </div>
          )}
          {plan.unlocatedCount > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">
                {plan.unlocatedCount} stop{plan.unlocatedCount === 1 ? ' is' : 's are'} not on the map yet, so mileage leaves {plan.unlocatedCount === 1 ? 'it' : 'them'} out.
              </span>
              {canWrite && plan.geocoderEnabled !== false && (
                <button type="button" className={linkClass} disabled={locating} onClick={() => void locate()}>
                  {locating ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <MapPin className="h-4 w-4" aria-hidden />} Find on map
                </button>
              )}
            </div>
          )}
          {error && <p role="alert" className="text-destructive">{error}</p>}
          <p className="text-xs text-muted-foreground">{plan.estimateNote}</p>
        </div>
      )}
    </section>
  );
}
