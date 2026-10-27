// The dashboard has no sign-in form of its own: a visit without a handoff token goes to the Portal's.
import { render, screen } from '@testing-library/react';

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
