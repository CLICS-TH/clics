// The dashboard has no sign-in form of its own: a visit without a handoff token goes to the Portal's.
import { render, screen, waitFor } from '@testing-library/react';

let mockParams = new URLSearchParams();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
  useSearchParams: () => mockParams,
}));
const mockApiFetch = jest.fn();
jest.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => mockApiFetch(...args) }));

import LoginPage from '@/app/login/page';

const realLocation = window.location;
const replace = jest.fn();

beforeEach(() => {
  replace.mockReset();
  mockApiFetch.mockReset();
  localStorage.clear();
  Object.defineProperty(window, 'location', { configurable: true, value: { href: '', replace } });
});
afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
});

it('without a token, replaces the visit with the Portal sign-in', () => {
  mockParams = new URLSearchParams();
  render(<LoginPage />);
  expect(replace).toHaveBeenCalledWith('https://physician-ui.vercel.app/login');
});

it('a failed token handoff links back to the Portal sign-in', async () => {
  mockParams = new URLSearchParams('token=bad');
  mockApiFetch.mockResolvedValue({ error: 'Account pending' });
  render(<LoginPage />);
  const back = await screen.findByRole('link', { name: /Back to the sign-in portal/ });
  expect(back).toHaveAttribute('href', 'https://physician-ui.vercel.app/login');
  expect(replace).not.toHaveBeenCalled();
});

// #182: a ?token= left in history lets Back after Sign out restore the previous user's session.
it('strips the handoff token from the URL before validating it', () => {
  const replaceState = jest.spyOn(window.history, 'replaceState');
  mockParams = new URLSearchParams('token=abc');
  mockApiFetch.mockImplementation(() => {
    expect(replaceState).toHaveBeenCalledWith(window.history.state, '', '/login');
    return new Promise(() => {});
  });
  render(<LoginPage />);
  expect(mockApiFetch).toHaveBeenCalledWith('/auth/me');
  replaceState.mockRestore();
});

it('a role with no dashboard home clears the session and goes to the Portal sign-in', async () => {
  mockParams = new URLSearchParams('token=abc');
  mockApiFetch.mockResolvedValue({ user: { id: 'u', role: 'physician', full_name_th: '', full_name_en: '' } });
  render(<LoginPage />);
  await waitFor(() => expect(replace).toHaveBeenCalledWith('https://physician-ui.vercel.app/login'));
  expect(localStorage.getItem('clics_token')).toBeNull();
  expect(localStorage.getItem('clics_user')).toBeNull();
});

it('stripping the token does not bounce a signing-in user to the Portal', () => {
  mockParams = new URLSearchParams('token=abc');
  mockApiFetch.mockReturnValue(new Promise(() => {}));
  const { rerender } = render(<LoginPage />);
  // Next syncs useSearchParams with history.replaceState, so the params lose the token.
  mockParams = new URLSearchParams();
  rerender(<LoginPage />);
  expect(replace).not.toHaveBeenCalled();
  expect(screen.getByText(/Signing you in/)).toBeInTheDocument();
  expect(localStorage.getItem('clics_token')).toBe('abc');
});
