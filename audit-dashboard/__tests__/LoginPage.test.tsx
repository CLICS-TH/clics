// The dashboard has no sign-in form of its own. It shares the Portal's origin and reads the session the
// Portal's sign-in left in localStorage; a visit without one goes to the Portal's sign-in.
import { render, screen, waitFor } from '@testing-library/react';

let mockParams = new URLSearchParams();
const mockRouterReplace = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockRouterReplace }),
  useSearchParams: () => mockParams,
}));
const mockApiFetch = jest.fn();
jest.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => mockApiFetch(...args) }));

import LoginPage from '@/app/login/page';

const realLocation = window.location;
const replace = jest.fn();

beforeEach(() => {
  replace.mockReset();
  mockRouterReplace.mockReset();
  mockApiFetch.mockReset();
  localStorage.clear();
  sessionStorage.clear();
  Object.defineProperty(window, 'location', { configurable: true, value: { href: '', pathname: '/audit/login', replace } });
});
afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
});

it('with ?logout=1, drops the session but keeps theme/view, then replaces itself with the Portal sign-in', () => {
  mockParams = new URLSearchParams('logout=1');
  localStorage.setItem('clics_token', 'tok');
  localStorage.setItem('clics_user', '{"id":"u1","role":"physician","can_audit":true}');
  localStorage.setItem('clics_theme', 'dark');
  localStorage.setItem('clics_view', 'mobile');
  render(<LoginPage />);
  expect(replace).toHaveBeenCalledWith('/login');
  expect(localStorage.getItem('clics_token')).toBeNull();
  expect(localStorage.getItem('clics_user')).toBeNull();
  expect(localStorage.getItem('clics_theme')).toBe('dark');
  expect(localStorage.getItem('clics_view')).toBe('mobile');
  expect(mockApiFetch).not.toHaveBeenCalled();
});

it('without a session, replaces the visit with the Portal sign-in', () => {
  mockParams = new URLSearchParams();
  render(<LoginPage />);
  expect(replace).toHaveBeenCalledWith('/login');
  expect(mockApiFetch).not.toHaveBeenCalled();
});

it('validates the stored session and sends an admin to /home', async () => {
  mockParams = new URLSearchParams();
  localStorage.setItem('clics_token', 'tok');
  mockApiFetch.mockResolvedValue({ user: { id: 'u', role: 'admin', full_name_th: '', full_name_en: '' } });
  render(<LoginPage />);
  expect(mockApiFetch).toHaveBeenCalledWith('/auth/me');
  await waitFor(() => expect(mockRouterReplace).toHaveBeenCalledWith('/home'));
  expect(JSON.parse(localStorage.getItem('clics_user') || '{}').role).toBe('admin');
  expect(replace).not.toHaveBeenCalled();
});

// A session never travels in a URL: an old ?token= link must neither sign anyone in nor stay in history (#182).
it('drops a ?token= from the URL unread', () => {
  const replaceState = jest.spyOn(window.history, 'replaceState');
  mockParams = new URLSearchParams('token=from-url');
  render(<LoginPage />);
  expect(replaceState).toHaveBeenCalledWith(window.history.state, '', '/audit/login');
  expect(localStorage.getItem('clics_token')).toBeNull();
  expect(mockApiFetch).not.toHaveBeenCalled();
  expect(replace).toHaveBeenCalledWith('/login');
  replaceState.mockRestore();
});

it('a rejected session is cleared and links back to the Portal sign-in', async () => {
  mockParams = new URLSearchParams();
  localStorage.setItem('clics_token', 'bad');
  mockApiFetch.mockResolvedValue({ error: 'Account pending' });
  render(<LoginPage />);
  const back = await screen.findByRole('link', { name: /Back to the sign-in portal/ });
  expect(back).toHaveAttribute('href', '/login');
  expect(localStorage.getItem('clics_token')).toBeNull();
  expect(replace).not.toHaveBeenCalled();
});

it('a physician without can_audit goes back to the Portal dashboard with the session kept', async () => {
  mockParams = new URLSearchParams();
  localStorage.setItem('clics_token', 'tok');
  mockApiFetch.mockResolvedValue({ user: { id: 'u', role: 'physician', full_name_th: '', full_name_en: '' } });
  render(<LoginPage />);
  await waitFor(() => expect(replace).toHaveBeenCalledWith('/dashboard'));
  expect(localStorage.getItem('clics_token')).toBe('tok');
});

it('returns a user bounced by an expiry to the page they were on', async () => {
  mockParams = new URLSearchParams();
  localStorage.setItem('clics_token', 'tok');
  sessionStorage.setItem('clics_reauth_next', '/admin/ples?x=1');
  mockApiFetch.mockResolvedValue({ user: { id: 'u', role: 'admin', full_name_th: '', full_name_en: '' } });
  render(<LoginPage />);
  await waitFor(() => expect(mockRouterReplace).toHaveBeenCalledWith('/admin/ples?x=1'));
});

it('re-syncing the search params does not bounce a signing-in user to the Portal', () => {
  mockParams = new URLSearchParams();
  localStorage.setItem('clics_token', 'tok');
  mockApiFetch.mockReturnValue(new Promise(() => {}));
  const { rerender } = render(<LoginPage />);
  rerender(<LoginPage />);
  expect(replace).not.toHaveBeenCalled();
  expect(screen.getByText(/Signing you in/)).toBeInTheDocument();
});
