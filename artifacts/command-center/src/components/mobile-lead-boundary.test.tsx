import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotificationLeadGuard } from './mobile-lead-boundary';

const org = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const other = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const path = '/leads/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
afterEach(cleanup);

describe('notification tenant boundary', () => {
  it('does not mount or fetch a lead when notification belongs to another company', () => {
    const child = vi.fn(() => <p>Private lead</p>);
    const Child = child;
    render(<NotificationLeadGuard organizationId={org} path={`${path}?organizationId=${other}`}><Child /></NotificationLeadGuard>);
    expect(child).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('different company');
  });
  it('rejects malformed contexts before mounting lead details', () => {
    render(<NotificationLeadGuard organizationId={org} path={`${path}?organizationId=${org}&redirect=/settings`}><p>Private lead</p></NotificationLeadGuard>);
    expect(screen.queryByText('Private lead')).toBeNull();
  });
  it('permits current-company notification and ordinary authenticated navigation', () => {
    const view = render(<NotificationLeadGuard organizationId={org} path={`${path}?organizationId=${org}`}><p>Current company lead</p></NotificationLeadGuard>);
    expect(screen.getByText('Current company lead')).toBeTruthy();
    view.rerender(<NotificationLeadGuard organizationId={org} path={path}><p>Current company lead</p></NotificationLeadGuard>);
    expect(screen.getByText('Current company lead')).toBeTruthy();
  });
});
