// NavBar a11y: the active link carries aria-current="page", and the mobile menu is a disclosure that
// names what it controls, closes on Escape, and hands focus back to its button. Layout/width is
// pinned separately (nav-width.test.ts); this file is about what a keyboard / screen-reader user gets.
import { act, fireEvent, render, screen } from '@testing-library/react';

let mockPath = '/auditor/queue';
let mockCompact = false;
const mockNavCounts: number[] = [];
jest.mock('next/navigation', () => ({ usePathname: () => mockPath }));
jest.mock('@/components/ViewportProvider', () => ({
  useIsNavCompact: (n: number) => { mockNavCounts.push(n); return mockCompact; },
  useViewport: () => ({ view: 'auto', setView: () => {} }),
}));

import { NavBar } from '@/components/NavBar';

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('clics_user', JSON.stringify({
    id: 'u1', email: 'a@b.c', role: 'admin', full_name_th: 'ผู้ดูแล', full_name_en: 'Admin',
  }));
  mockPath = '/admin/ples';
  mockCompact = false;
  mockNavCounts.length = 0;
});

const signIn = (u: Record<string, unknown>) =>
  localStorage.setItem('clics_user', JSON.stringify({ id: 'u1', email: 'a@b.c', full_name_th: 'ผู้ใช้', full_name_en: 'User', ...u }));

// The width model (lib/client-store.ts navRowWidthPx) is calibrated per CONTROL in the row, so what
// NavBar feeds it is part of the calibration: the dual-role physician's Return to Physician control
// is a full bilingual control and counts as one more link. Fed the bare roster (2), the row went
// inline at 1026px and wrapped "Return to/Physician" up to 1194px.
describe('NavBar — what the width model is sized by', () => {
  it.each([
    ['admin', 9, { role: 'admin' }],
    // The grouped menu's headings are not links: the row is sized by the 16 links alone.
    ['superadmin', 16, { role: 'superadmin' }],
    ['auditor', 2, { role: 'auditor' }],
    ['dual-role physician (Return counts)', 3, { role: 'physician', can_audit: true }],
  ])('%s → %i', (_label, n, u) => {
    signIn(u);
    render(<NavBar />);
    expect(mockNavCounts[mockNavCounts.length - 1]).toBe(n);
  });

  it('every control in the inline row is whitespace-nowrap, so a squeeze overflows instead of wrapping', () => {
    // A wrapped control is invisible to an overflow check; that is how the old constants came out
    // too eager. nav-width-audit.mjs now also fails on a wrap — this pins the cause at source.
    signIn({ role: 'physician', can_audit: true });
    mockPath = '/auditor/queue';
    render(<NavBar />);
    const row = document.querySelector('nav > div')!;
    const controls = [...row.querySelectorAll('a, button')].filter((el) => el.textContent?.trim());
    expect(controls.length).toBeGreaterThanOrEqual(6);   // wordmark, 2 links, 2 toggles, Return, Logout
    const wrapping = controls.filter((el) => !el.className.includes('whitespace-nowrap') && el.textContent !== 'CLICS');
    expect(wrapping.map((el) => el.textContent)).toEqual([]);
  });
});

describe('NavBar — active link', () => {
  it('marks exactly the current section with aria-current="page" (a child route keeps its parent lit)', () => {
    mockPath = '/admin/ples/abc-123';
    render(<NavBar />);
    const current = screen.getAllByRole('link').filter((a) => a.getAttribute('aria-current') === 'page');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAttribute('href', '/admin/ples');
  });

  it('marks nothing when the path matches no link', () => {
    mockPath = '/somewhere/else';
    render(<NavBar />);
    expect(screen.getAllByRole('link').some((a) => a.hasAttribute('aria-current'))).toBe(false);
  });
});

describe('NavBar — mobile menu', () => {
  beforeEach(() => { mockCompact = true; });

  it('the button names the region it controls, and only once that region exists', () => {
    render(<NavBar />);
    const btn = screen.getByRole('button', { name: /เมนู/ });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(btn).not.toHaveAttribute('aria-controls');
    fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    const id = btn.getAttribute('aria-controls');
    expect(id).toBeTruthy();
    expect(document.getElementById(id!)).not.toBeNull();
  });

  it('Escape closes the menu and returns focus to the button', () => {
    render(<NavBar />);
    const btn = screen.getByRole('button', { name: /เมนู/ });
    fireEvent.click(btn);
    const id = btn.getAttribute('aria-controls')!;
    screen.getAllByRole('link')[1].focus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(document.getElementById(id)).toBeNull();
    expect(btn).toHaveFocus();
  });

  it('other keys leave it open, and Escape with the menu shut does nothing', () => {
    render(<NavBar />);
    const btn = screen.getByRole('button', { name: /เมนู/ });
    fireEvent.keyDown(document, { key: 'Escape' });          // shut: no listener, no focus theft
    expect(btn).not.toHaveFocus();
    fireEvent.click(btn);
    fireEvent.keyDown(document, { key: 'a' });
    expect(btn).toHaveAttribute('aria-expanded', 'true');
  });

  it('marks the active link in the dropdown too, and choosing a link closes the menu', () => {
    mockPath = '/admin/users';
    render(<NavBar />);
    const btn = screen.getByRole('button', { name: /เมนู/ });
    fireEvent.click(btn);
    const items = within();
    expect(items.filter((a) => a.getAttribute('aria-current') === 'page').map((a) => a.getAttribute('href')))
      .toEqual(['/admin/users']);
    act(() => { fireEvent.click(items.find((a) => a.getAttribute('href') === '/admin/invites')!); });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
  });
});

// The superadmin's 16 links are grouped under six headings in the menu (2026-11-24). Each group is a
// role="group" named by its heading, so a screen reader announces "Review, group" before PLEs and QA Queue.
describe('NavBar — the superadmin menu is grouped', () => {
  beforeEach(() => { mockCompact = true; signIn({ role: 'superadmin' }); });
  const open = () => { render(<NavBar />); fireEvent.click(screen.getByRole('button', { name: /เมนู/ })); };
  const groups = () => screen.getAllByRole('group');
  const hrefs = (el: HTMLElement) => Array.from(el.querySelectorAll('a')).map((a) => a.getAttribute('href'));

  it('six named groups, in the approved order, holding every link once', () => {
    open();
    const gs = groups();
    // Each group is named by its heading, Thai then English (the accessible name puts a space between BiLabel's halves).
    expect(gs.map((g) => document.getElementById(g.getAttribute('aria-labelledby')!)?.textContent))
      .toEqual(['ภาพรวมOverview', 'งานตรวจReview', 'บุคคลPeople', 'ธรรมาภิบาลGovernance', 'AI', 'ระบบSystem']);
    expect(screen.getByRole('group', { name: 'งานตรวจ Review' })).toBe(gs[1]);
    expect(gs.map(hrefs)).toEqual([
      ['/admin/overview', '/admin/stats', '/admin/icc'],
      ['/admin/ples', '/admin/flagged'],
      ['/admin/users', '/admin/invites', '/admin/compensation'],
      ['/admin/privacy', '/admin/integrity', '/admin/identity', '/admin/governance'],
      ['/admin/ai-readiness', '/admin/evaluator-lock'],
      ['/admin/settings', '/admin/booth'],
    ]);
    const all = gs.flatMap(hrefs);
    expect(new Set(all).size).toBe(16);
  });

  it('lights the current page inside its group, and only there', () => {
    mockPath = '/admin/booth';
    open();
    const current = within().filter((a) => a.getAttribute('aria-current') === 'page');
    expect(current.map((a) => a.getAttribute('href'))).toEqual(['/admin/booth']);
    expect(current[0].closest('[role="group"]')).toBe(screen.getByRole('group', { name: 'ระบบ System' }));
  });

  it('choosing a grouped link closes the menu', () => {
    open();
    act(() => { fireEvent.click(within().find((a) => a.getAttribute('href') === '/admin/settings')!); });
    expect(screen.getByRole('button', { name: /เมนู/ })).toHaveAttribute('aria-expanded', 'false');
  });

  it('the inline row stays flat: the same 16 links in group order, with no headings', () => {
    mockCompact = false;
    render(<NavBar />);
    expect(screen.queryAllByRole('group')).toHaveLength(0);
    const row = Array.from(document.querySelectorAll('nav > div a')).map((a) => a.getAttribute('href')).filter((h) => h !== '/home');
    expect(row).toHaveLength(16);
    expect(row.slice(0, 3)).toEqual(['/admin/overview', '/admin/stats', '/admin/icc']);
    expect(row.slice(-2)).toEqual(['/admin/settings', '/admin/booth']);
  });

  it('an admin menu is not grouped', () => {
    signIn({ role: 'admin' });
    open();
    expect(screen.queryAllByRole('group')).toHaveLength(0);
    expect(within()).toHaveLength(9);
  });
});

// jsdom evaluates no media queries, so this pins the WIRING: which copy of the chip carries which
// breakpoint class. That the layout then fits at 320px is a Playwright measurement, not a jest one.
describe('NavBar — role chip on phones', () => {
  const chips = () => Array.from(document.querySelectorAll('nav span.rounded-full'));

  it('the compact bar sheds its chip below sm, and the open menu carries it with the Thai role', () => {
    mockCompact = true;
    render(<NavBar />);
    expect(chips()).toHaveLength(1);
    expect(chips()[0]).toHaveClass('max-sm:hidden');
    fireEvent.click(screen.getByRole('button', { name: /เมนู/ }));
    const inMenu = chips().filter((c) => c.closest('nav [id]'));
    expect(inMenu).toHaveLength(1);
    expect(inMenu[0]).toHaveClass('sm:hidden');
    expect(inMenu[0]).toHaveTextContent('Admin · จัดการ pilot');
    expect(inMenu[0].querySelector('.hidden')).toBeNull();   // the Thai subtitle is not phone-hidden here
  });

  it('the full desktop row keeps its chip at every width', () => {
    render(<NavBar />);
    expect(chips()).toHaveLength(1);
    expect(chips()[0]).not.toHaveClass('max-sm:hidden');
  });
});

// The Portal owns sign-in, so both exits leave this origin. jsdom cannot navigate, so location is a stub.
describe('NavBar — leaving for the Portal', () => {
  const realLocation = window.location;
  const replace = jest.fn();
  const realFetch = global.fetch;
  const fetchMock = jest.fn();
  beforeEach(() => {
    replace.mockClear();
    fetchMock.mockReset().mockResolvedValue({ ok: true });
    global.fetch = fetchMock;
    Object.defineProperty(window, 'location', { configurable: true, value: { href: '', replace } });
  });
  afterEach(() => {
    global.fetch = realFetch;
    Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
  });

  it('Logout clears the session but keeps theme/view, then lands on the Portal sign-in in logout mode', () => {
    localStorage.setItem('clics_token', 'tok');
    localStorage.setItem('clics_theme', 'dark');
    localStorage.setItem('clics_view', 'mobile');
    render(<NavBar />);
    fireEvent.click(screen.getByRole('button', { name: /Logout/ }));
    expect(window.location.href).toBe('/login?logout=1');
    expect(localStorage.getItem('clics_token')).toBeNull();
    expect(localStorage.getItem('clics_user')).toBeNull();
    expect(localStorage.getItem('clics_theme')).toBe('dark');
    expect(localStorage.getItem('clics_view')).toBe('mobile');
  });

  // Without the revoke the token stays valid for its TTL, and a restored page holding it still works (#189).
  it('Logout revokes the old token server-side with a request that outlives the page', () => {
    localStorage.setItem('clics_token', 'tok');
    render(<NavBar />);
    fireEvent.click(screen.getByRole('button', { name: /Logout/ }));
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/logout', expect.objectContaining({
      method: 'POST', keepalive: true, headers: { Authorization: 'Bearer tok' },
    }));
  });

  it('Logout still signs out when the revoke request fails', () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    localStorage.setItem('clics_token', 'tok');
    render(<NavBar />);
    fireEvent.click(screen.getByRole('button', { name: /Logout/ }));
    expect(window.location.href).toBe('/login?logout=1');
    expect(localStorage.getItem('clics_token')).toBeNull();
  });

  // #203: the route answers 502 revoke_failed when the server-side revoke fails.
  it('Logout still signs out, with no notice, when the revoke answers 502', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502, json: async () => ({ error: 'x', code: 'revoke_failed' }) });
    localStorage.setItem('clics_token', 'tok');
    render(<NavBar />);
    fireEvent.click(screen.getByRole('button', { name: /Logout/ }));
    await act(async () => {});
    expect(window.location.href).toBe('/login?logout=1');
    expect(localStorage.getItem('clics_token')).toBeNull();
    expect(sessionStorage.getItem('clics_reauth_next')).toBeNull();
  });

  // The Portal shares this origin's session: going back must not sign the dual-role user out of it.
  it('Return to Physician keeps the shared session and replaces itself with the Portal dashboard', () => {
    signIn({ role: 'physician', can_audit: true });
    localStorage.setItem('clics_token', 'tok');
    render(<NavBar />);
    fireEvent.click(screen.getByRole('button', { name: /Return to Physician/ }));
    expect(replace).toHaveBeenCalledWith('/dashboard');
    expect(localStorage.getItem('clics_token')).toBe('tok');
    expect(localStorage.getItem('clics_user')).not.toBeNull();
  });
});

function within() {
  const menu = document.querySelector('nav [id]')!;
  return Array.from(menu.querySelectorAll('a'));
}
