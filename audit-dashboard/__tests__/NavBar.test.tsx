// NavBar a11y: the active link carries aria-current="page", and the mobile menu is a disclosure that
// names what it controls, closes on Escape, and hands focus back to its button. Layout/width is
// pinned separately (nav-width.test.ts); this file is about what a keyboard / screen-reader user gets.
import { act, fireEvent, render, screen } from '@testing-library/react';

let mockPath = '/auditor/queue';
let mockCompact = false;
jest.mock('next/navigation', () => ({ usePathname: () => mockPath }));
jest.mock('@/components/ViewportProvider', () => ({
  useIsNavCompact: () => mockCompact,
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

function within() {
  const menu = document.querySelector('nav [id]')!;
  return Array.from(menu.querySelectorAll('a'));
}
