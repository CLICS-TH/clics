// /admin/overview is read only since 2026-11-24: the controls that sat on it (the AI provider switch, Local AI
// capacity, the minimum auditors, the five rules, the XLSX export) are on /admin/settings, and Booth Mode has its
// own page. SettingsPage.test.tsx carries the controls' tests. Pinned here: nothing on the overview can change a
// setting, and a failed budget read is said as a failure, not drawn as a $0.00 pool.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockApiFetch = jest.fn();
jest.mock('@/lib/api', () => ({ apiFetch: (...a: unknown[]) => mockApiFetch(...a) }));
const mockRouter = { push: jest.fn() };
jest.mock('next/navigation', () => ({ useRouter: () => mockRouter }));
// The charts need a layout jsdom does not have.
jest.mock('@/components/IccPanel', () => ({ IccPanel: () => null }));
jest.mock('recharts', () => {
  const Nil = () => null;
  return { BarChart: Nil, Bar: Nil, Cell: Nil, XAxis: Nil, YAxis: Nil, CartesianGrid: Nil, Tooltip: Nil,
    ResponsiveContainer: Nil, ReferenceLine: Nil };
});

import OverviewPage from '@/app/admin/overview/page';

function wire(usage: unknown) {
  mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
    if (init?.method) return Promise.resolve({ error: 'the overview must not write' });
    if (path === '/admin/usage-settings') return Promise.resolve(typeof usage === 'function' ? usage() : usage);
    if (path === '/admin/icc') return Promise.resolve({ overall: null, per_domain: {}, per_council: {}, n: 0 });
    if (path === '/admin/stats') return Promise.resolve({});
    return Promise.resolve([]);
  });
}

beforeEach(() => {
  mockApiFetch.mockReset();
  mockRouter.push.mockReset();
  localStorage.setItem('clics_user', JSON.stringify({ id: 'u1', role: 'superadmin', email: 's@x', full_name_th: 'ท', full_name_en: 'T' }));
});

describe('overview — read only', () => {
  it('has no switch, no radiogroup and no export, and links to Settings', async () => {
    wire({ api_budget_pool_usd: 10, total_used_usd: 2.5 });
    render(<OverviewPage />);
    expect(await screen.findByText('$2.50')).toBeInTheDocument();
    expect(screen.queryAllByRole('switch')).toHaveLength(0);
    expect(screen.queryAllByRole('radiogroup')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /Download|Export/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open Settings/ })).toHaveAttribute('href', '/admin/settings');
    expect(mockApiFetch.mock.calls.some(([, init]) => init?.method)).toBe(false);
  });

  it('a failed budget read says so and retries, instead of drawing an empty pool', async () => {
    let fail = true;
    wire(() => (fail ? { error: 'Supabase unreachable' } : { api_budget_pool_usd: 10, total_used_usd: 1 }));
    render(<OverviewPage />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('โหลดงบประมาณไม่สำเร็จ / Could not load the budget.');
    expect(alert).toHaveTextContent('Supabase unreachable');
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'ลองใหม่ / Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.getByText('$1.00')).toBeInTheDocument();
  });

  it('sends anyone but a superadmin to /home', () => {
    localStorage.setItem('clics_user', JSON.stringify({ id: 'u2', role: 'admin', email: 'a@x' }));
    wire({});
    render(<OverviewPage />);
    expect(mockRouter.push).toHaveBeenCalledWith('/home');
  });
});
