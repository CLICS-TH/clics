// A signed-out visitor never stays on a private page: not on a fresh load, and not when Back
// restores one from the back/forward cache after Sign out (#189). A restore under another user's
// session re-renders for that user. jsdom cannot navigate, so location is a stub.
import { act, render } from '@testing-library/react';

let mockPath = '/home';
jest.mock('next/navigation', () => ({ usePathname: () => mockPath }));

import { AuthGuard } from '@/components/AuthGuard';

const realLocation = window.location;
const replace = jest.fn();
const reload = jest.fn();

beforeEach(() => {
  localStorage.clear();
  replace.mockClear();
  reload.mockClear();
  mockPath = '/home';
  Object.defineProperty(window, 'location', { configurable: true, value: { replace, reload } });
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

it('reloads when Back restores /home after another user signed in on the same tab', () => {
  localStorage.setItem('clics_token', 'alpha');
  render(<AuthGuard />);
  localStorage.setItem('clics_token', 'bravo');
  pageshow(true);
  expect(reload).toHaveBeenCalled();
  expect(replace).not.toHaveBeenCalled();
});

it('leaves the page alone when Back restores it under the same session', () => {
  localStorage.setItem('clics_token', 'alpha');
  render(<AuthGuard />);
  pageshow(true);
  expect(reload).not.toHaveBeenCalled();
  expect(replace).not.toHaveBeenCalled();
});

it('takes the token stored by /login before a client-side navigation as the page\'s own', () => {
  mockPath = '/login';
  const { rerender } = render(<AuthGuard />);
  localStorage.setItem('clics_token', 'alpha');
  mockPath = '/auditor/queue';
  rerender(<AuthGuard />);
  pageshow(true);
  expect(reload).not.toHaveBeenCalled();
  expect(replace).not.toHaveBeenCalled();
});
