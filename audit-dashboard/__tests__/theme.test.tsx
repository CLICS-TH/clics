// Theme preference: System | Light | Dark.
//   - a missing / unrecognised `clics_theme` means SYSTEM, and system is tracked LIVE
//   - the two legacy values 'light' | 'dark' stay valid
//   - the <html> `.dark` class and <meta name="theme-color"> move together
import fs from 'fs';
import path from 'path';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { ThemeProvider, useTheme } from '@/components/ThemeProvider';
import { ThemeToggle } from '@/components/Toggles';
import {
  THEME_BOOT, THEME_COLOR, applyTheme, readPref, resolveTheme, setPref, systemIsDark,
} from '@/lib/theme';

type MQ = { matches: boolean; listeners: Set<() => void> };
let mq: MQ;

function installMatchMedia(dark: boolean) {
  mq = { matches: dark, listeners: new Set() };
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: () => ({
      get matches() { return mq.matches; },
      addEventListener: (_: string, cb: () => void) => mq.listeners.add(cb),
      removeEventListener: (_: string, cb: () => void) => mq.listeners.delete(cb),
    }),
  });
}
function osSwitchesTo(dark: boolean) {
  mq.matches = dark;
  mq.listeners.forEach((cb) => cb());
}
function addMetas() {
  document.head.insertAdjacentHTML('beforeend',
    '<meta name="theme-color" media="(prefers-color-scheme: light)" content="#faf9f5">'
    + '<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#181715">');
}
const metaFor = (m: 'light' | 'dark') =>
  document.querySelector<HTMLMetaElement>(`meta[name="theme-color"][media*="${m}"]`)!.content;

beforeEach(() => {
  localStorage.clear();
  document.documentElement.className = '';
  document.head.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove());
  installMatchMedia(false);
});

describe('lib/theme', () => {
  it('a missing or unrecognised stored value means system; light and dark stay valid', () => {
    expect(readPref()).toBe('system');
    localStorage.setItem('clics_theme', 'dark');
    expect(readPref()).toBe('dark');
    localStorage.setItem('clics_theme', 'light');
    expect(readPref()).toBe('light');
    localStorage.setItem('clics_theme', 'sepia');
    expect(readPref()).toBe('system');
  });

  it('survives blocked storage', () => {
    const get = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    const set = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(readPref()).toBe('system');
    expect(() => setPref('dark')).not.toThrow();
    expect(document.documentElement.classList.contains('dark')).toBe(true); // applies for this view anyway
    get.mockRestore(); set.mockRestore();
  });

  it('resolveTheme: an explicit choice beats the OS; system follows it', () => {
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });

  it('systemIsDark tolerates a missing or throwing matchMedia', () => {
    installMatchMedia(true);
    expect(systemIsDark()).toBe(true);
    Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: undefined });
    expect(systemIsDark()).toBe(false);
    Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: () => { throw new Error('x'); } });
    expect(systemIsDark()).toBe(false);
  });

  it('applyTheme toggles .dark and, under a manual override, pins BOTH theme-color metas', () => {
    addMetas();
    installMatchMedia(false);
    applyTheme('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(metaFor('light')).toBe(THEME_COLOR.dark);
    expect(metaFor('dark')).toBe(THEME_COLOR.dark);
    applyTheme('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(metaFor('light')).toBe(THEME_COLOR.light);
    expect(metaFor('dark')).toBe(THEME_COLOR.light);
    // back to system: each meta returns to its own media colour
    applyTheme('system');
    expect(metaFor('light')).toBe(THEME_COLOR.light);
    expect(metaFor('dark')).toBe(THEME_COLOR.dark);
  });

  it('applyTheme with a meta that has no media attribute treats it as the light one', () => {
    document.head.insertAdjacentHTML('beforeend', '<meta name="theme-color" content="#000000">');
    applyTheme('system');
    expect(document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')!.content).toBe(THEME_COLOR.light);
  });

  it('THEME_COLOR mirrors --background in globals.css', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'app', 'globals.css'), 'utf8');
    expect(css).toMatch(new RegExp(`--background:\\s*${THEME_COLOR.light}`));
    expect(css).toMatch(new RegExp(`\\.dark\\s*\\{[^}]*--background:\\s*${THEME_COLOR.dark}`));
  });

  it('the viewport export carries the same pair in the media form', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'layout.tsx'), 'utf8');
    expect(src).toContain(`media: "(prefers-color-scheme: light)", color: "${THEME_COLOR.light}"`);
    expect(src).toContain(`media: "(prefers-color-scheme: dark)", color: "${THEME_COLOR.dark}"`);
  });

  it('the boot snippet resolves the legacy values and the system case (the real string, run on jsdom)', () => {
    const run = () => {
      document.documentElement.className = '';
      new Function(`try{${THEME_BOOT}}catch(e){}`)();
      return document.documentElement.classList.contains('dark');
    };
    installMatchMedia(true);
    expect(run()).toBe(true);                                // no value + OS dark -> dark
    localStorage.setItem('clics_theme', 'light');
    expect(run()).toBe(false);                               // explicit light beats OS dark
    installMatchMedia(false);
    localStorage.setItem('clics_theme', 'dark');
    expect(run()).toBe(true);                                // explicit dark beats OS light
    localStorage.removeItem('clics_theme');
    expect(run()).toBe(false);                               // no value + OS light -> light
  });

  it('layout.tsx uses that snippet, not a private copy', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'layout.tsx'), 'utf8');
    expect(src).toContain('THEME_BOOT');
    expect(src).not.toMatch(/getItem\('clics_theme'\)/);
  });
});

function Probe() {
  const { theme, pref } = useTheme();
  return <p data-testid="probe">{pref}/{theme}</p>;
}

describe('ThemeProvider + ThemeToggle', () => {
  it('follows the OS live while the preference is system', async () => {
    addMetas();
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(screen.getByTestId('probe').textContent).toBe('system/light');
    await act(async () => osSwitchesTo(true));
    expect(screen.getByTestId('probe').textContent).toBe('system/dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    await act(async () => osSwitchesTo(false));
    expect(screen.getByTestId('probe').textContent).toBe('system/light');
  });

  it('does NOT follow the OS once the person chose light or dark', async () => {
    localStorage.setItem('clics_theme', 'light');
    render(<ThemeProvider><Probe /></ThemeProvider>);
    await act(async () => osSwitchesTo(true));
    expect(screen.getByTestId('probe').textContent).toBe('light/light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('the toggle steps system -> light -> dark -> system and persists accordingly', () => {
    render(<ThemeProvider><ThemeToggle /><Probe /></ThemeProvider>);
    const btn = () => screen.getByRole('button');
    expect(btn().getAttribute('aria-label')).toBe('Theme: System. Switch to Light');
    fireEvent.click(btn());
    expect(screen.getByTestId('probe').textContent).toBe('light/light');
    expect(localStorage.getItem('clics_theme')).toBe('light');
    expect(btn().getAttribute('aria-label')).toBe('Theme: Light. Switch to Dark');
    fireEvent.click(btn());
    expect(screen.getByTestId('probe').textContent).toBe('dark/dark');
    expect(localStorage.getItem('clics_theme')).toBe('dark');
    expect(btn().getAttribute('aria-label')).toBe('Theme: Dark. Switch to System');
    fireEvent.click(btn());
    expect(screen.getByTestId('probe').textContent).toBe('system/light');
    expect(localStorage.getItem('clics_theme')).toBeNull();   // system = no stored value
  });

  it('picks up a preference changed in another tab', async () => {
    render(<ThemeProvider><Probe /></ThemeProvider>);
    await act(async () => {
      localStorage.setItem('clics_theme', 'dark');
      window.dispatchEvent(new StorageEvent('storage', { key: 'clics_theme' }));
    });
    expect(screen.getByTestId('probe').textContent).toBe('dark/dark');
    await act(async () => { window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated' })); });
    expect(screen.getByTestId('probe').textContent).toBe('dark/dark');
  });

  it('mounts safely where matchMedia does not exist', () => {
    Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: undefined });
    expect(() => render(<ThemeProvider><Probe /></ThemeProvider>)).not.toThrow();
  });

  it('the default context (no provider) is inert', () => {
    const { result } = renderHook(() => useTheme());
    expect(`${result.current.pref}/${result.current.theme}`).toBe('system/light');
    expect(() => { result.current.cycle(); result.current.setPref('dark'); }).not.toThrow();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

});
