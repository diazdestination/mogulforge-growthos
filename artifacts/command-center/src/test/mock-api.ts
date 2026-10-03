import { vi } from 'vitest';

export const sampleMe = (role: string) => ({
  id: 'u1',
  email: 'user@example.com',
  firstName: 'Test',
  lastName: 'User',
  role,
  isActive: true,
  organization: { id: 'o1', name: 'Painless', slug: 'painless', timezone: 'UTC' },
});

const now = new Date().toISOString();

export const sampleContact = {
  id: 'c1-00000000',
  firstName: 'Jane',
  lastName: 'Homeowner',
  email: 'jane@example.com',
  phone: '555-0100',
  createdAt: now,
};

export const sampleTask = {
  id: 't1-00000000',
  title: 'Call the adjuster',
  description: 'Follow up on the claim',
  status: 'open',
  priority: 'normal',
  dueAt: null,
  createdAt: now,
};

export const sampleAppointment = {
  id: 'a1-00000000',
  type: 'inspection',
  status: 'scheduled',
  scheduledStart: now,
  scheduledEnd: now,
  notes: 'Roof inspection',
  leadId: null,
  assignedUserId: null,
};

export const sampleLead = {
  id: 'l1-00000000',
  summary: 'Hail damage roof',
  source: 'website',
  status: 'new',
  urgency: 'normal',
  score: 50,
  estimatedValueCents: 1200000,
  createdAt: now,
};

export const sampleSavedFilter = {
  id: 'sf1-00000000',
  name: 'Hot leads',
  filters: { status: 'new', search: null },
  createdAt: now,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export interface MockApiOptions {
  /** When set, GET /api/v1/me responds with this HTTP error status. */
  meStatus?: number;
  /** Override the /me payload (e.g. isActive: false). */
  me?: Record<string, unknown>;
  /** Extra route handlers checked first; return a Response to override. */
  handler?: (method: string, path: string, rawUrl?: string) => Response | undefined;
}

/**
 * Stubs global fetch with a tiny route table covering the endpoints the
 * CRM screens under test call. Returns the spy for assertions.
 */
export function mockApi(role: string, options: MockApiOptions = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const path = raw.split('?')[0];
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();

    const override = options.handler?.(method, path, raw);
    if (override) return override;

    if (path.endsWith('/api/auth/user')) {
      return json({ user: { id: 'u1', email: 'user@example.com' } });
    }
    if (path.endsWith('/api/v1/me')) {
      if (options.meStatus) {
        return json({ error: 'Account is not active' }, options.meStatus);
      }
      return json({ ...sampleMe(role), ...options.me });
    }
    if (path.endsWith('/api/v1/communications/sms')) {
      return json({
        enabled: false,
        inbound: [],
        outbound: [],
        usage: {
          operations: 0,
          limit: 0,
          warning: false,
          uncertain: 0,
          failed: 0,
        },
      });
    }
    if (path.endsWith('/api/v1/communications/voice')) {
      return json({ enabled: false, calls: [] });
    }
    if (path.endsWith('/api/v1/source-adoption')) {
      return json({ candidates: [], campaigns: [], page: 0, campaignPage: 0, hasMore: false, hasMoreCampaigns: false, limits: { cohort: 10, rollingCompanyLimit: 25, oneAddressLifetimeTouch: true }, detail: 'Synthetic reviewed source work only.' });
    }
    if (path.endsWith('/api/v1/contacts')) return json([sampleContact]);
    if (path.endsWith('/api/v1/tasks')) return json([sampleTask]);
    if (path.endsWith('/api/v1/appointments')) return json([sampleAppointment]);
    if (path.endsWith('/api/v1/leads')) return json([sampleLead]);
    if (path.endsWith('/api/v1/saved-filters')) return json([sampleSavedFilter]);
    if (path.endsWith('/behavior')) {
      // Visitor-intelligence panel: default to "no visitor linked" so it
      // stays quiet in unrelated page tests. Override via options.handler.
      return json({
        linked: false,
        attribution: {
          source: 'website',
          latestSource: null,
          campaign: null,
          landingPage: null,
          referrer: null,
          creationMethod: null,
          firstTouch: null,
          lastTouch: null,
        },
        behavior: {
          pageViews: 0,
          sessions: 0,
          activeDays: 0,
          firstSeenAt: null,
          lastSeenAt: null,
          topPages: [],
          highIntentPages: [],
          toolsStarted: [],
          abandonedForms: 0,
          highlights: [],
        },
      });
    }
    if (path.endsWith('/next-action')) {
      // Next-best-action copilot: default to "nothing to do" so the card
      // stays out of unrelated page tests. Override via options.handler.
      return json({
        leadId: 'lead-1',
        actionType: 'none',
        title: 'No action needed',
        reasons: [],
        priority: 0,
        leadStatus: 'won',
        score: 0,
      });
    }
    // users, tags, duplicates, saved filters, anything else list-shaped
    return json([]);
  });

  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
