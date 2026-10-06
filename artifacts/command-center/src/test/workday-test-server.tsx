import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { vi } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { appointment, assets, catalog, contact, org, property, template, wid, work } from './workday-fixtures';
import { workspacePage } from './customer-workspace-fixtures';

export type WorkdayRequest = { path: string; query: URLSearchParams; method: string; body: Record<string, any>; rawBody: BodyInit | null | undefined; init?: RequestInit };
export const json = (value: unknown, status = 200) => Response.json(value, { status });
export function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
export function workdayServer(handler?: (request: WorkdayRequest) => Response | Promise<Response> | undefined) {
  const requests: WorkdayRequest[] = [], state = { work: work(), assets: assets(), catalog: catalog() };
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.origin);
    const request: WorkdayRequest = { path: url.pathname, query: url.searchParams, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : {}, rawBody: init?.body, init }; requests.push(request);
    const override = handler?.(request); if (override) return override;
    if (request.path === '/api/v1/users') return json([{ id: 'office-a', role: 'office', isActive: true, operationallyEligible: true, firstName: 'Accepted', lastName: 'Office', email: 'office@example.test' }, { id: 'invite:a', role: 'office', isActive: true, operationallyEligible: false, firstName: 'Pending', lastName: 'Invitation', email: 'pending@example.test' }]);
    if (request.path === `/api/v1/contacts/${contact}/workspace/properties`) { const page = workspacePage('properties', contact); return json({ ...page, organizationId: org, items: page.items.map(item => ({ ...item, id: property })) }); }
    if (request.path === `/api/v1/contacts/${contact}/assets` && request.method === 'GET') return json({ ...state.assets, propertyId: request.query.get('propertyId') });
    if (request.path === '/api/v1/work-checklists' && request.method === 'GET') return json(state.catalog);
    if (request.path === `/api/v1/appointments/${appointment}/work` && request.method === 'GET') return json(state.work);
    if (request.path.endsWith('/completion-preview')) return json({ organizationId: org, appointmentId: appointment, expiresAt: new Date(Date.now() + 60_000).toISOString(), previewToken: 'synthetic-completion-review', entries: state.work.entries.filter(entry => request.body.entries.some((pick: { id: string }) => pick.id === entry.id)), intent: request.body, serviceVersions: state.work.linkedServices.map(service => ({ id: service.id, updatedAt: service.updatedAt })), warning: 'Staff-recorded work; not warranty coverage, customer acceptance, invoice delivery or payment.' });
    if (request.path === `/api/v1/work-checklists/${template().id}/preview`) return json({ organizationId: org, templateId: template().id, expectedVersion: state.catalog.templates[0].version, revision: state.catalog.templates[0].latestRevision, expiresAt: new Date(Date.now() + 60_000).toISOString(), previewToken: 'synthetic-checklist-review' });
    return json({ code: 'unexpected_synthetic_route', error: request.path }, 404);
  }); vi.stubGlobal('fetch', fetch);
  return { requests, state, fetch, writes: () => requests.filter(request => request.method !== 'GET') };
}
export const workdayClients: QueryClient[] = [];
export function mountWorkday(node: ReactNode) { const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); workdayClients.push(client); const location = memoryLocation({ path: `/appointments?appointmentId=${appointment}&organizationId=${org}` }); const wrap = (child: ReactNode) => <QueryClientProvider client={client}><Router hook={location.hook}>{child}</Router></QueryClientProvider>; const view = render(wrap(node)); return { client, ...view, rerender: (child: ReactNode) => view.rerender(wrap(child)) }; }
export const otherOrg = wid(101);
