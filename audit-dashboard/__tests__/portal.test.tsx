// A Portal URL configured with a trailing slash must still send users to single-slash URLs.
// lib/portal.ts reads the env once at load, so it is set before the components are required.
process.env.NEXT_PUBLIC_PORTAL_URL = 'https://portal.example.test//';

import { fireEvent, render, screen } from '@testing-library/react';

jest.mock('next/navigation', () => ({
  usePathname: () => '/auditor/queue',
  useRouter: () => ({ push: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock('@/components/ViewportProvider', () => ({
  useIsNavCompact: () => false,
  useViewport: () => ({ view: 'auto', setView: () => {} }),
}));
jest.mock('@/lib/api', () => ({ apiFetch: jest.fn() }));

/* eslint-disable @typescript-eslint/no-require-imports */
const { NavBar } = require('@/components/NavBar');
const LoginPage = require('@/app/login/page').default;
/* eslint-enable @typescript-eslint/no-require-imports */

const realLocation = window.location;
const replace = jest.fn();

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('clics_token', 'tok');
  localStorage.setItem('clics_user', JSON.stringify({
    id: 'u1', email: 'a@b.c', role: 'physician', can_audit: true, full_name_th: 'ผู้ใช้', full_name_en: 'User',
  }));
  Object.defineProperty(window, 'location', { configurable: true, value: { href: '', replace } });
});
afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
});

it('the bounce from a token-less dashboard visit', () => {
  render(<LoginPage />);
  expect(replace).toHaveBeenCalledWith('https://portal.example.test/login');
});

it('Sign out', () => {
  render(<NavBar />);
  fireEvent.click(screen.getByRole('button', { name: /Logout/ }));
  expect(window.location.href).toBe('https://portal.example.test/login?logout=1');
});

it('Return to Physician', () => {
  render(<NavBar />);
  fireEvent.click(screen.getByRole('button', { name: /Return to Physician/ }));
  expect(window.location.href).toBe('https://portal.example.test/dashboard');
});
