// /admin/settings's rule controls SAVE the moment they are used: the "Minimum auditors per PLE" radiogroup and
// the five switches below it (moved here from /admin/overview, 2026-11-24). The promises they have to keep,
// pinned against the real page:
//   - the radiogroup is operated with arrows from a single tab stop (what role="radiogroup" announces);
//   - using a control never drops focus: a control whose save is running is aria-disabled, never `disabled`
//     (which blurred it to <body>), and the page refuses a second write to that key until the first lands;
//   - a failed GET of the settings leaves EVERY control disabled and checking nothing, and says so. apiFetch
//     resolves a failure to {error}, which is truthy: the overview used to read that as "loaded" and enabled
//     switches showing OFF over values it had never read.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockApiFetch = jest.fn();
const mockApiDownload = jest.fn();
const mockToast = jest.fn();
jest.mock('@/lib/api', () => ({
  apiFetch: (...a: unknown[]) => mockApiFetch(...a),
  apiDownload: (...a: unknown[]) => mockApiDownload(...a),
}));
// ONE router object, as Next returns: the page's load effect depends on [router], so a fresh object
// per render would re-run it (and refetch) on every render.
const mockRouter = { push: jest.fn() };
jest.mock('next/navigation', () => ({ useRouter: () => mockRouter }));
jest.mock('@/components/Overlays', () => ({ toast: (...a: unknown[]) => mockToast(...a) }));
// Both cards have their own suites. The capacity card's stand-in shows what the page hands it, which is what
// this file has to pin: null until the settings load, then the loaded object.
jest.mock('@/components/AiProviderPanel', () => ({ AiProviderPanel: () => <div id="ai-provider" data-testid="ai-provider" /> }));
jest.mock('@/components/LocalAiCapacityCard', () => ({
  LocalAiCapacityCard: ({ usage }: { usage: unknown }) => <p data-testid="capacity-usage">{usage ? 'loaded' : 'none'}</p>,
}));

import SettingsPage from '@/app/admin/settings/page';

type Patch = (body: Record<string, unknown>) => Promise<unknown>;
// Echoes the write back, which is what the API does on success.
const echo = (usage: Record<string, unknown>): Patch => (body) => Promise.resolve({ ...usage, ...body });

function wire(usage: unknown, patch: Patch = echo(usage as Record<string, unknown>)) {
  mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
    if (path === '/admin/usage-settings') {
      return init?.method === 'PATCH' ? patch(JSON.parse(String(init.body))) : Promise.resolve(usage);
    }
    return Promise.resolve({ error: `unexpected ${path}` });
  });
}
const patches = () => mockApiFetch.mock.calls.filter(([, init]) => init?.method === 'PATCH');
const gets = () => mockApiFetch.mock.calls.filter(([path, init]) => path === '/admin/usage-settings' && !init?.method);

async function group() {
  const g = await screen.findByRole('radiogroup', { name: 'Minimum auditors per PLE' });
  // Enabled once /admin/usage-settings has loaded.
  await waitFor(() => expect(within(g).getAllByRole('radio')[0]).toBeEnabled());
  return { g, radios: within(g).getAllByRole('radio') };
}

beforeEach(() => {
  mockApiFetch.mockReset();
  mockApiDownload.mockReset();
  mockToast.mockReset();
  mockRouter.push.mockReset();
  localStorage.setItem('clics_user', JSON.stringify({ id: 'u1', role: 'superadmin', email: 's@x', full_name_th: 'ท', full_name_en: 'T' }));
});

describe('settings — access and layout', () => {
  it('sends anyone but a superadmin to /home and reads nothing', () => {
    localStorage.setItem('clics_user', JSON.stringify({ id: 'u2', role: 'admin', email: 'a@x' }));
    wire({});
    render(<SettingsPage />);
    expect(mockRouter.push).toHaveBeenCalledWith('/home');
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it('has the AI, Rules and Export sections, with the provider panel under #ai-provider', async () => {
    wire({});
    render(<SettingsPage />);
    expect(screen.getByRole('region', { name: 'AI' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /^กติกา/ })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /^ส่งออก/ })).toBeInTheDocument();
    // Model Lock links to /admin/settings#ai-provider.
    expect(document.getElementById('ai-provider')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('capacity-usage')).toHaveTextContent('loaded'));
  });
});

describe('settings — a failed load', () => {
  it('shows the error, checks nothing, and disables every control until a real load', async () => {
    wire({ error: 'Supabase unreachable', httpStatus: 503 });
    render(<SettingsPage />);
    const alert = await screen.findByTestId('settings-load-error');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveTextContent('Supabase unreachable');

    const switches = screen.getAllByRole('switch');
    expect(switches).toHaveLength(5);
    for (const s of switches) {
      expect(s).toBeDisabled();
      expect(s).toHaveAttribute('aria-checked', 'false');
    }
    const radios = within(screen.getByRole('radiogroup', { name: 'Minimum auditors per PLE' })).getAllByRole('radio');
    for (const r of radios) {
      expect(r).toBeDisabled();
      expect(r).toHaveAttribute('aria-checked', 'false');
    }
    // The capacity card is handed nothing to edit.
    expect(screen.getByTestId('capacity-usage')).toHaveTextContent('none');

    fireEvent.click(switches[0]);
    fireEvent.click(radios[1]);
    expect(patches()).toHaveLength(0);
  });

  it('Retry reads again, and a good read enables the controls with the saved values', async () => {
    let fail = true;
    mockApiFetch.mockImplementation((path: string) =>
      Promise.resolve(path === '/admin/usage-settings' && fail ? { error: 'boom' } : { pilot_test_mode: true, min_auditors_per_cle: 2 }));
    render(<SettingsPage />);
    await screen.findByTestId('settings-load-error');
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'ลองใหม่ / Retry' }));
    await waitFor(() => expect(screen.queryByTestId('settings-load-error')).not.toBeInTheDocument());
    expect(gets()).toHaveLength(2);
    const pilot = screen.getByRole('switch', { name: /Pilot test mode$/ });
    await waitFor(() => expect(pilot).toBeEnabled());
    expect(pilot).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: '2' })).toHaveAttribute('aria-checked', 'true');
  });

  it('a 401 (undefined: the sign-in redirect is under way) shows no error and enables nothing', async () => {
    wire(undefined);
    render(<SettingsPage />);
    await waitFor(() => expect(gets()).toHaveLength(1));
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByTestId('settings-load-error')).not.toBeInTheDocument();
    for (const s of screen.getAllByRole('switch')) expect(s).toBeDisabled();
  });
});

describe('settings — Minimum auditors per PLE radiogroup', () => {
  it('has ONE tab stop, on the checked option', async () => {
    wire({ min_auditors_per_cle: 2 });
    render(<SettingsPage />);
    const { radios } = await group();
    expect(radios.map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
    expect(radios[1]).toHaveAttribute('aria-checked', 'true');
  });

  it('an arrow selects and saves the next option, and focus follows it', async () => {
    wire({ min_auditors_per_cle: 2 });
    render(<SettingsPage />);
    const { g, radios } = await group();
    radios[1].focus();
    fireEvent.keyDown(g, { key: 'ArrowRight' });
    expect(radios[2]).toHaveFocus();
    await waitFor(() => expect(radios[2]).toHaveAttribute('aria-checked', 'true'));
    expect(patches()).toHaveLength(1);
    expect(JSON.parse(String(patches()[0][1].body))).toEqual({ min_auditors_per_cle: 3 });
    // The tab stop moved with the saved value.
    expect(radios.map((r) => r.tabIndex)).toEqual([-1, -1, 0]);
  });

  it('arrows wrap, and Up/Left go back', async () => {
    wire({ min_auditors_per_cle: 1 });
    render(<SettingsPage />);
    const { g, radios } = await group();
    radios[0].focus();
    fireEvent.keyDown(g, { key: 'ArrowUp' });
    expect(radios[2]).toHaveFocus();
    await waitFor(() => expect(radios[2]).toHaveAttribute('aria-checked', 'true'));
    expect(JSON.parse(String(patches()[0][1].body))).toEqual({ min_auditors_per_cle: 3 });
  });

  it('a value outside 1-3 checks nothing: the stop is the first option and an arrow enters there', async () => {
    wire({ min_auditors_per_cle: 5 });
    render(<SettingsPage />);
    const { g, radios } = await group();
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'false', 'false']);
    expect(radios.map((r) => r.tabIndex)).toEqual([0, -1, -1]);
    radios[0].focus();
    fireEvent.keyDown(g, { key: 'ArrowRight' });
    expect(radios[0]).toHaveFocus();
    await waitFor(() => expect(radios[0]).toHaveAttribute('aria-checked', 'true'));
  });

  it('keeps focus on the chosen option while it saves, and refuses a second write until it lands', async () => {
    let land!: () => void;
    const usage = { min_auditors_per_cle: 1 };
    wire(usage, (body) => new Promise((res) => { land = () => res({ ...usage, ...body }); }));
    render(<SettingsPage />);
    const { g, radios } = await group();

    radios[1].focus();
    fireEvent.click(radios[1]);
    // Saving: still focusable and focused (aria-disabled, not disabled).
    await waitFor(() => expect(radios[1]).toHaveAttribute('aria-disabled', 'true'));
    for (const r of radios) expect(r).toBeEnabled();
    expect(radios[1]).toHaveFocus();
    // The busy dimming skips the focused option, or its focus ring would fade with it (jsdom cannot
    // compute the opacity; the Playwright check measured 0.5 / 0.5 / 1).
    expect(radios[1]).toHaveClass('aria-disabled:opacity-50', 'aria-disabled:focus-visible:opacity-100');

    // Input during the save is ignored: no second PATCH from a click or an arrow.
    fireEvent.click(radios[2]);
    fireEvent.keyDown(g, { key: 'ArrowRight' });
    expect(patches()).toHaveLength(1);

    await act(async () => { land(); });
    await waitFor(() => expect(radios[1]).toHaveAttribute('aria-checked', 'true'));
    expect(radios[1]).not.toHaveAttribute('aria-disabled');
    expect(radios[1]).toHaveFocus();
  });

  it('a failed save keeps the old value, says so, and leaves focus where it was', async () => {
    const usage = { min_auditors_per_cle: 1 };
    wire(usage, () => Promise.resolve({ error: 'nope' }));
    render(<SettingsPage />);
    const { g, radios } = await group();
    radios[0].focus();
    fireEvent.keyDown(g, { key: 'ArrowRight' });
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(expect.stringContaining('Could not save'), 'error'));
    expect(radios[0]).toHaveAttribute('aria-checked', 'true');
    expect(radios[1]).toHaveFocus();
    expect(radios[1]).not.toHaveAttribute('aria-disabled');
  });

  it('ignores keys that are not arrows', async () => {
    wire({ min_auditors_per_cle: 2 });
    render(<SettingsPage />);
    const { g, radios } = await group();
    radios[1].focus();
    fireEvent.keyDown(g, { key: 'Home' });
    fireEvent.keyDown(g, { key: 'a' });
    expect(radios[1]).toHaveFocus();
    expect(patches()).toHaveLength(0);
  });
});

// [usage-settings key, the switch's accessible name: its row title, Thai then English (BiLabel)]
const SWITCHES: [string, RegExp][] = [
  ['pilot_test_mode', /^โหมดทดสอบ Pilot\s*Pilot test mode$/],
  ['clinical_artifacts_enabled', /^รายงานคลินิกแบบ artifact\s*Clinical artifacts$/],
  ['peer_calibration_enabled', /^การปรับเทียบระหว่างผู้ประเมิน\s*Peer calibration$/],
  ['hold_result_until_audited', /^ระงับผลจนกว่าผู้ตรวจจะให้คะแนน\s*Hold result until audited$/],
  ['calibration_reveal_locked', /^ปิดการเผยคะแนน AI ตลอดรอบสอบเทียบ\s*Lock AI reveal for the round$/],
];

async function sw(name: RegExp) {
  const b = await screen.findByRole('switch', { name });
  // Enabled once /admin/usage-settings has loaded.
  await waitFor(() => expect(b).toBeEnabled());
  return b;
}

describe('settings — the five rule switches', () => {
  it('lists the five rules, each switch described by its own line', async () => {
    wire({});
    render(<SettingsPage />);
    for (const [, name] of SWITCHES) {
      const b = await sw(name);
      expect(b).toHaveAccessibleDescription(/•/);
    }
    expect(screen.getAllByRole('switch')).toHaveLength(5);
  });

  it.each(SWITCHES)('%s keeps focus while it saves, and refuses a second write until it lands', async (key, name) => {
    let land!: () => void;
    const usage = { [key]: false };
    wire(usage, (body) => new Promise((res) => { land = () => res({ ...usage, ...body }); }));
    render(<SettingsPage />);
    const b = await sw(name);
    expect(b).toHaveAttribute('aria-checked', 'false');

    b.focus();
    fireEvent.click(b);
    await waitFor(() => expect(b).toHaveAttribute('aria-disabled', 'true'));
    expect(b).toBeEnabled();
    expect(b).toHaveFocus();
    expect(b).toHaveClass('aria-disabled:opacity-50', 'aria-disabled:focus-visible:opacity-100');

    fireEvent.click(b);   // a second press during the save is ignored
    expect(patches()).toHaveLength(1);
    expect(JSON.parse(String(patches()[0][1].body))).toEqual({ [key]: true });

    await act(async () => { land(); });
    await waitFor(() => expect(b).toHaveAttribute('aria-checked', 'true'));
    expect(b).not.toHaveAttribute('aria-disabled');
    expect(b).toHaveFocus();
  });

  it.each(SWITCHES)('%s: a failed save keeps the old state, says so, and keeps focus', async (key, name) => {
    wire({ [key]: true }, () => Promise.resolve({ error: 'nope' }));
    render(<SettingsPage />);
    const b = await sw(name);
    b.focus();
    fireEvent.click(b);
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(expect.stringContaining('Could not save'), 'error'));
    await waitFor(() => expect(b).not.toHaveAttribute('aria-disabled'));
    expect(b).toHaveAttribute('aria-checked', 'true');
    expect(b).toHaveFocus();
  });

  it('an echo that differs from the request shows the echo and says so', async () => {
    wire({ pilot_test_mode: false }, () => Promise.resolve({ pilot_test_mode: false }));
    render(<SettingsPage />);
    const b = await sw(SWITCHES[0][1]);
    fireEvent.click(b);
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(expect.stringContaining('different value'), 'error'));
    expect(b).toHaveAttribute('aria-checked', 'false');
  });

  it('one switch saving does not block another', async () => {
    const held: (() => void)[] = [];
    const usage = {};
    wire(usage, (body) => new Promise((res) => { held.push(() => res({ ...usage, ...body })); }));
    render(<SettingsPage />);
    const pilot = await sw(SWITCHES[0][1]);
    const lock = await sw(SWITCHES[4][1]);
    fireEvent.click(pilot);
    await waitFor(() => expect(pilot).toHaveAttribute('aria-disabled', 'true'));
    expect(lock).not.toHaveAttribute('aria-disabled');
    fireEvent.click(lock);
    expect(patches().map(([, init]) => JSON.parse(String(init.body)))).toEqual([
      { pilot_test_mode: true }, { calibration_reveal_locked: true },
    ]);
    await act(async () => { held.forEach((land) => land()); });
    await waitFor(() => expect(lock).toHaveAttribute('aria-checked', 'true'));
    expect(pilot).toHaveAttribute('aria-checked', 'true');
  });
});

describe('settings — export', () => {
  it('downloads the pilot workbook', async () => {
    wire({});
    mockApiDownload.mockResolvedValue({});
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'ดาวน์โหลด / Download' }));
    await waitFor(() => expect(mockApiDownload).toHaveBeenCalledWith('/admin/export.xlsx', 'clics-export.xlsx'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'ดาวน์โหลด / Download' })).toBeEnabled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('says why a download failed', async () => {
    wire({});
    mockApiDownload.mockResolvedValue({ error: 'Export failed (500)' });
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'ดาวน์โหลด / Download' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Export failed (500)');
  });
});
