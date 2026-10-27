// A signed-out visitor never stays on a private page: not on a fresh load, and not when Back
// restores one from the back/forward cache after Sign out (#189). jsdom cannot navigate, so
// location is a stub that records replace().
import { act, render } from '@testing-library/react';

let mockPath = '/home';
jest.mock('next/navigation', () => ({ usePathname: () => mockPath }));

import { AuthGuard } from '@/components/AuthGuard';

const realLocation = window.location;
const replace = jest.fn();

beforeEach(() => {
  localStorage.clear();
  replace.mockClear();
  mockPath = '/home';
  Object.defineProperty(window, 'location', { configurable: true, value: { replace } });
});
afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
});

function pageshow(persisted: boolean) {
  const e = new Event('pageshow') as PageTransitionEvent;
  Object.defineProperty(e, 'persisted', { value: persisted });
  act(() => { window.dispatchEvent(e); });
}

it('sends a visitor without a session from /home to /login', () => {
  render(<AuthGuard />);
  expect(replace).toHaveBeenCalledWith('/login');
});

it.each(['/login', '/forgot', '/reset', '/manual', '/manual/auditor'])('leaves public %s alone', (path) => {
  mockPath = path;
  render(<AuthGuard />);
  expect(replace).not.toHaveBeenCalled();
});

it('leaves a signed-in visitor on /home', () => {
  localStorage.setItem('clics_token', 'tok');
  render(<AuthGuard />);
  expect(replace).not.toHaveBeenCalled();
});

it('sends the visitor to /login when Back restores /home from the cache after Sign out', () => {
  localStorage.setItem('clics_token', 'tok');
  render(<AuthGuard />);
  localStorage.removeItem('clics_token');
  pageshow(true);
  expect(replace).toHaveBeenCalledWith('/login');
});

it('ignores an ordinary pageshow, which a fresh load already checked', () => {
  localStorage.setItem('clics_token', 'tok');
  render(<AuthGuard />);
  localStorage.removeItem('clics_token');
  pageshow(false);
  expect(replace).not.toHaveBeenCalled();
});
