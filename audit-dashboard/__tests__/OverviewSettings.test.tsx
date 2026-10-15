// /admin/overview's settings controls SAVE the moment they are used: the "Minimum auditors per PLE"
// radiogroup and the five on/off toggles below it. The keyboard promises they have to keep, pinned
// here against the real page:
//   - the radiogroup is operated with arrows from a single tab stop (what role="radiogroup" announces);
//   - using a control never drops focus. Every one of them used to be `disabled` while its save ran,
//     which blurred the control just used to <body>; they are aria-disabled now, and the page's own
//     guards refuse a second write until the first one lands.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockApiFetch = jest.fn();
const mockToast = jest.fn();
jest.mock('@/lib/api', () => ({ apiFetch: (...a: unknown[]) => mockApiFetch(...a), apiDownload: jest.fn() }));
// ONE router object, as Next returns: the page's load effect depends on [router], so a fresh object
// per render would re-run it (and refetch) on every render.
const mockRouter = { push: jest.fn() };
jest.mock('next/navigation', () => ({ useRouter: () => mockRouter }));
jest.mock('@/components/Overlays', () => ({ toast: (...a: unknown[]) => mockToast(...a) }));
// Panels that fetch their own data, and the charts (jsdom has no layout): not what this file tests.
jest.mock('@/components/AiProviderPanel', () => ({ AiProviderPanel: () => null }));
jest.mock('@/components/LocalAiCapacityCard', () => ({ LocalAiCapacityCard: () => null }));
jest.mock('@/components/IccPanel', () => ({ IccPanel: () => null }));
jest.mock('recharts', () => {
  const Nil = () => null;
  return { BarChart: Nil, Bar: Nil, Cell: Nil, XAxis: Nil, YAxis: Nil, CartesianGrid: Nil, Tooltip: Nil,
    ResponsiveContainer: Nil, ReferenceLine: Nil };
});

import OverviewPage from '@/app/admin/overview/page';

type Patch = (body: Record<string, unknown>) => Promise<unknown>;
// Echoes the write back, which is what the API does on success.
const echo = (usage: Record<string, unknown>): Patch => (body) => Promise.resolve({ ...usage, ...body });

function wire(usage: Record<string, unknown>, patch: Patch = echo(usage)) {
  mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
    if (path === '/admin/usage-settings') {
      return init?.method === 'PATCH' ? patch(JSON.parse(String(init.body))) : Promise.resolve(usage);
    }
    if (path === '/admin/icc') return Promise.resolve({ overall: null, per_domain: {}, per_council: {}, n: 0 });
    if (path === '/admin/stats') return Promise.resolve({});
    return Promise.resolve([]);
  });
}
const patches = () => mockApiFetch.mock.calls.filter(([, init]) => init?.method === 'PATCH');

async function group() {
  const g = await screen.findByRole('radiogroup', { name: 'Minimum auditors per PLE' });
  // Enabled once /admin/usage-settings has loaded.
  await waitFor(() => expect(within(g).getAllByRole('radio')[0]).toBeEnabled());
  return { g, radios: within(g).getAllByRole('radio') };
}

beforeEach(() => {
  mockApiFetch.mockReset();
  mockToast.mockReset();
  localStorage.setItem('clics_user', JSON.stringify({ id: 'u1', role: 'superadmin', email: 's@x', full_name_th: 'ท', full_name_en: 'T' }));
});

describe('overview — Minimum auditors per PLE radiogroup', () => {
  it('has ONE tab stop, on the checked option', async () => {
    wire({ min_auditors_per_cle: 2 });
    render(<OverviewPage />);
    const { radios } = await group();
    expect(radios.map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
    expect(radios[1]).toHaveAttribute('aria-checked', 'true');
  });

  it('an arrow selects and saves the next option, and focus follows it', async () => {
    wire({ min_auditors_per_cle: 2 });
    render(<OverviewPage />);
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
    render(<OverviewPage />);
    const { g, radios } = await group();
    radios[0].focus();
    fireEvent.keyDown(g, { key: 'ArrowUp' });
    expect(radios[2]).toHaveFocus();
    await waitFor(() => expect(radios[2]).toHaveAttribute('aria-checked', 'true'));
    expect(JSON.parse(String(patches()[0][1].body))).toEqual({ min_auditors_per_cle: 3 });
  });

  it('a value outside 1-3 checks nothing: the stop is the first option and an arrow enters there', async () => {
    wire({ min_auditors_per_cle: 5 });
    render(<OverviewPage />);
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
    render(<OverviewPage />);
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
    render(<OverviewPage />);
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
    render(<OverviewPage />);
    const { g, radios } = await group();
    radios[1].focus();
    fireEvent.keyDown(g, { key: 'Home' });
    fireEvent.keyDown(g, { key: 'a' });
    expect(radios[1]).toHaveFocus();
    expect(patches()).toHaveLength(0);
  });
});

// [usage-settings key, the toggle's accessible name (its title) without the ON/OFF state]
const TOGGLES: [string, string][] = [
  ['pilot_test_mode', 'Pilot test mode is'],
  ['clinical_artifacts_enabled', 'Clinical artifacts are'],
  ['peer_calibration_enabled', 'Peer calibration is'],
  ['hold_result_until_audited', 'Hold result until audited is'],
  ['calibration_reveal_locked', 'Calibration reveal lock is'],
];

async function toggle(name: string) {
  const b = await screen.findByRole('button', { name: new RegExp(`^${name} (ON|OFF)$`) });
  // Enabled once /admin/usage-settings has loaded.
  await waitFor(() => expect(b).toBeEnabled());
  return b;
}

describe('overview — on/off setting toggles', () => {
  it.each(TOGGLES)('%s keeps focus while it saves, and refuses a second write until it lands', async (key, name) => {
    let land!: () => void;
    const usage = { [key]: false };
    wire(usage, (body) => new Promise((res) => { land = () => res({ ...usage, ...body }); }));
    render(<OverviewPage />);
    const b = await toggle(name);
    expect(b).toHaveAttribute('aria-pressed', 'false');

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
    await waitFor(() => expect(b).toHaveAttribute('aria-pressed', 'true'));
    expect(b).not.toHaveAttribute('aria-disabled');
    expect(b).toHaveFocus();
  });

  it.each(TOGGLES)('%s: a failed save keeps the old state, says so, and keeps focus', async (key, name) => {
    wire({ [key]: true }, () => Promise.resolve({ error: 'nope' }));
    render(<OverviewPage />);
    const b = await toggle(name);
    b.focus();
    fireEvent.click(b);
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(expect.stringContaining('Could not save'), 'error'));
    await waitFor(() => expect(b).not.toHaveAttribute('aria-disabled'));
    expect(b).toHaveAttribute('aria-pressed', 'true');
    expect(b).toHaveFocus();
  });

  it('one toggle saving does not block another', async () => {
    const held: (() => void)[] = [];
    const usage = {};
    wire(usage, (body) => new Promise((res) => { held.push(() => res({ ...usage, ...body })); }));
    render(<OverviewPage />);
    const pilot = await toggle('Pilot test mode is');
    const lock = await toggle('Calibration reveal lock is');
    fireEvent.click(pilot);
    await waitFor(() => expect(pilot).toHaveAttribute('aria-disabled', 'true'));
    expect(lock).not.toHaveAttribute('aria-disabled');
    fireEvent.click(lock);
    expect(patches().map(([, init]) => JSON.parse(String(init.body)))).toEqual([
      { pilot_test_mode: true }, { calibration_reveal_locked: true },
    ]);
    await act(async () => { held.forEach((land) => land()); });
    await waitFor(() => expect(lock).toHaveAttribute('aria-pressed', 'true'));
    expect(pilot).toHaveAttribute('aria-pressed', 'true');
  });
});
