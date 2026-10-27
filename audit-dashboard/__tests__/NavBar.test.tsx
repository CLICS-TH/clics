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
  beforeEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: { href: '' } });
  });
  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
  });

  it('Logout clears the session but keeps theme/view, then lands on the Portal sign-in in logout mode', () => {
    localStorage.setItem('clics_token', 'tok');
    localStorage.setItem('clics_theme', 'dark');
    localStorage.setItem('clics_view', 'mobile');
    render(<NavBar />);
    fireEvent.click(screen.getByRole('button', { name: /Logout/ }));
    expect(window.location.href).toBe('https://physician-ui.vercel.app/login?logout=1');
    expect(localStorage.getItem('clics_token')).toBeNull();
    expect(localStorage.getItem('clics_user')).toBeNull();
    expect(localStorage.getItem('clics_theme')).toBe('dark');
    expect(localStorage.getItem('clics_view')).toBe('mobile');
  });

  it('Return to Physician goes to the Portal dashboard and keeps the session', () => {
    signIn({ role: 'physician', can_audit: true });
    localStorage.setItem('clics_token', 'tok');
    render(<NavBar />);
    fireEvent.click(screen.getByRole('button', { name: /Return to Physician/ }));
    expect(window.location.href).toBe('https://physician-ui.vercel.app/dashboard');
    expect(localStorage.getItem('clics_token')).toBe('tok');
  });
});

function within() {
  const menu = document.querySelector('nav [id]')!;
  return Array.from(menu.querySelectorAll('a'));
}
