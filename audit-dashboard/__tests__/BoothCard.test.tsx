// BoothCard (#214) drives the Booth Mode event from /admin/overview. What has to be RIGHT here: times leave
// with an explicit +07:00 offset and come back as Bangkok wall-clock; the switch shows the server's echo, not
// the click; a window that closes before it opens or an out-of-range ceiling never leaves the page; and a
// failed count read shows "—", never 0.
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';

const apiFetch = jest.fn();
const toast = jest.fn();
jest.mock('@/lib/api', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
jest.mock('@/components/Overlays', () => ({ toast: (...a: unknown[]) => toast(...a) }));

import { BoothCard, toBangkokInput, fromBangkokInput, signedGap } from '@/components/BoothCard';
import type { BoothAuditSummary, BoothCase, BoothSettings } from '@/lib/types';

const CASE: BoothCase = {
  case_id: 'cap-adult', teaser: { th: 'ชายวัย 52 ปี มีไข้และไอมา 3 วัน', en: 'A 52-year-old man with fever and cough for 3 days' },
  version: 'v3', admitted_on: '2026-10-29', plays: 7, on: true,
};
const BOOTH: BoothSettings = {
  event_code: 'NFCME-2026', enabled: false, opens_at: '2026-11-03T08:00:00+07:00', closes_at: '2026-11-04T18:00:00+07:00',
  ceiling_usd: 3, state: 'off', plays: 12, scored: 9, spend_usd: 4.2, cases: [CASE], audits: null,
};

function wire(get: unknown = BOOTH, patch: (body: Record<string, unknown>) => unknown = (b) => ({ ...BOOTH, ...b })) {
  apiFetch.mockReset();
  apiFetch.mockImplementation((path: string, init?: RequestInit) => {
    if (path !== '/admin/booth') return Promise.resolve({ error: `unexpected ${path}` });
    return Promise.resolve(init?.method === 'PATCH' ? patch(JSON.parse(String(init.body))) : get);
  });
}
const patches = () => apiFetch.mock.calls.filter(([, o]) => o?.method === 'PATCH').map(([, o]) => JSON.parse(String(o.body)));
const loaded = () => screen.findByRole('button', { name: 'Booth event switch' });

beforeEach(() => { wire(); toast.mockReset(); });

describe('Bangkok time conversion', () => {
  it('shows a stored instant as Bangkok wall-clock whatever offset it was written with', () => {
    expect(toBangkokInput('2026-11-03T08:00:00+07:00')).toBe('2026-11-03T08:00');
    expect(toBangkokInput('2026-11-03T01:00:00Z')).toBe('2026-11-03T08:00');
    expect(toBangkokInput(null)).toBe('');
    expect(toBangkokInput('garbage')).toBe('');
  });

  it('sends an input value with an explicit +07:00 offset, and an empty input as null', () => {
    expect(fromBangkokInput('2026-11-03T08:00')).toBe('2026-11-03T08:00:00+07:00');
    expect(fromBangkokInput('')).toBeNull();
  });
});

describe('BoothCard', () => {
  it('shows the switch, the window, the ceiling and the totals', async () => {
    render(<BoothCard />);
    const sw = await loaded();
    expect(sw).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByLabelText(/Opens at/)).toHaveValue('2026-11-03T08:00');
    expect(screen.getByLabelText(/Closes at/)).toHaveValue('2026-11-04T18:00');
    expect(screen.getByLabelText(/Per-play ceiling/)).toHaveValue(3);
    const totals = within(screen.getByRole('group', { name: 'Booth totals' }));
    expect(totals.getByText('12')).toBeInTheDocument();
    expect(totals.getByText('9')).toBeInTheDocument();
    expect(totals.getByText('$4.20')).toBeInTheDocument();
    expect(screen.getByTestId('booth-state')).toHaveTextContent('Off');
  });

  it('flips the switch to the value the server echoes', async () => {
    wire(BOOTH, (b) => ({ ...BOOTH, ...b, state: 'not_yet' }));
    render(<BoothCard />);
    fireEvent.click(await loaded());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Booth event switch' })).toHaveAttribute('aria-pressed', 'true'));
    expect(patches()).toEqual([{ enabled: true }]);
    expect(screen.getByTestId('booth-state')).toHaveTextContent('Not open yet');
  });

  it('never lets a slow save echo leave the switch showing a state the server does not hold', async () => {
    // The server reads its echo when a PATCH arrives; the save's reply is held back until the switch has been
    // clicked and answered. If both could fly, the save's older echo would land last and show the booth off
    // while it is on, so the next click would ask for "on" again.
    let server: BoothSettings = { ...BOOTH };
    let releaseSave = () => {};
    wire(BOOTH, () => null);
    apiFetch.mockImplementation((_path: string, init?: RequestInit) => {
      if (init?.method !== 'PATCH') return Promise.resolve(server);
      server = { ...server, ...JSON.parse(String(init.body)) };
      const echo = { ...server };
      if ('opens_at' in echo && patches().length === 1) return new Promise((r) => { releaseSave = () => r(echo); });
      return Promise.resolve(echo);
    });
    render(<BoothCard />);
    await loaded();
    fireEvent.change(screen.getByLabelText(/Opens at/), { target: { value: '2026-11-03T09:30' } });
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Booth event switch' }));
    await act(async () => { await Promise.resolve(); });
    releaseSave();
    await waitFor(() => expect(screen.getByRole('button', { name: /Save/ })).toBeDisabled());
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole('button', { name: 'Booth event switch' })).toHaveAttribute('aria-pressed', String(server.enabled));
  });

  it('sends the state shown on the switch the moment it is clicked', async () => {
    wire({ ...BOOTH, enabled: true, state: 'open' });
    render(<BoothCard />);
    fireEvent.click(await loaded());
    await waitFor(() => expect(patches()).toEqual([{ enabled: false }]));
  });

  it('keeps the switch where it was and toasts when the save fails', async () => {
    wire(BOOTH, () => ({ error: 'boom' }));
    render(<BoothCard />);
    fireEvent.click(await loaded());
    await waitFor(() => expect(toast).toHaveBeenCalledWith('boom', 'error'));
    expect(screen.getByRole('button', { name: 'Booth event switch' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('saves only the edited fields, with the +07:00 offset', async () => {
    render(<BoothCard />);
    await loaded();
    fireEvent.change(screen.getByLabelText(/Opens at/), { target: { value: '2026-11-03T09:30' } });
    fireEvent.change(screen.getByLabelText(/Per-play ceiling/), { target: { value: '2.5' } });
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(patches()).toEqual([{ opens_at: '2026-11-03T09:30:00+07:00', ceiling_usd: 2.5 }]));
  });

  it.each([
    ['a window that closes before it opens', /Opens at/, '2026-11-05T08:00', /Closes-at must be after opens-at/],
    ['a ceiling of 0', /Per-play ceiling/, '0', /ceiling must be above 0/],
    ['a ceiling past $20', /Per-play ceiling/, '25', /ceiling must be above 0/],
  ])('refuses %s before it leaves the page', async (_name, field, value, message) => {
    render(<BoothCard />);
    await loaded();
    fireEvent.change(screen.getByLabelText(field), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(patches()).toEqual([]);
  });

  it('will not clear the window of a booth that is switched on', async () => {
    wire({ ...BOOTH, enabled: true, state: 'open' });
    render(<BoothCard />);
    await loaded();
    fireEvent.change(screen.getByLabelText(/Closes at/), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Switch the booth off/);
    expect(patches()).toEqual([]);
  });

  it('shows a failed count read as "—", not 0', async () => {
    wire({ ...BOOTH, plays: null, scored: null, spend_usd: null });
    render(<BoothCard />);
    await loaded();
    expect(within(screen.getByRole('group', { name: 'Booth totals' })).getAllByText('—')).toHaveLength(3);
  });

  it('lists each admitted case with its teaser, version, admission date, plays and switch', async () => {
    render(<BoothCard />);
    await loaded();
    const pool = within(screen.getByRole('group', { name: 'Case pool' }));
    expect(pool.getByText(CASE.teaser.th)).toBeInTheDocument();
    expect(pool.getByText(CASE.teaser.en)).toBeInTheDocument();
    expect(pool.getByText(/cap-adult · v3/)).toBeInTheDocument();
    expect(pool.getByText(/2026-10-29/)).toBeInTheDocument();
    expect(pool.getByText(/Plays/).parentElement?.parentElement).toHaveTextContent(/Plays\s*7$/);
    expect(pool.getByRole('button', { name: 'Case cap-adult switch' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('switches a case off with its own PATCH and shows the server\'s echo', async () => {
    wire(BOOTH, (b) => ({ ...BOOTH, cases: [{ ...CASE, on: (b.cases as Record<string, boolean>)['cap-adult'] }] }));
    render(<BoothCard />);
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Case cap-adult switch' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Case cap-adult switch' })).toHaveAttribute('aria-pressed', 'false'));
    expect(patches()).toEqual([{ cases: { 'cap-adult': false } }]);
  });

  it('keeps a case switch where it was and toasts when the write fails', async () => {
    wire(BOOTH, () => ({ error: 'boom' }));
    render(<BoothCard />);
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Case cap-adult switch' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('boom', 'error'));
    expect(screen.getByRole('button', { name: 'Case cap-adult switch' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('says so when the event has no admitted case', async () => {
    wire({ ...BOOTH, cases: [] });
    render(<BoothCard />);
    await loaded();
    expect(screen.getByText(/No admitted case/)).toBeInTheDocument();
  });

  it('says so when the settings cannot be loaded', async () => {
    wire({ error: 'Could not read the booth settings — try again' });
    render(<BoothCard />);
    expect(await screen.findByText(/Could not read the booth settings/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Booth event switch' })).not.toBeInTheDocument();
  });
});

describe('BoothCard case-study audits', () => {
  const AUDITS: BoothAuditSummary = {
    audits: 42, auditors: 9, plays: 30,
    mean_gap: { d1: 0.4, d2: -0.17, d3: 0, d4: 0.62, d5: -0.5, d6: 0.1, d7: -0.05 },
  };
  const block = async () => { await loaded(); return within(screen.getByRole('group', { name: 'Booth audits' })); };

  it('prints a gap signed, and zero without a sign', () => {
    expect(signedGap(0.4)).toBe('+0.4');
    expect(signedGap(-0.2)).toBe('-0.2');
    expect(signedGap(0)).toBe('0');
    expect(signedGap(-0)).toBe('0');
    expect(signedGap(-0.001)).toBe('0');
  });

  it('shows the counts over all events and seven signed gaps named by domain', async () => {
    wire({ ...BOOTH, audits: AUDITS });
    render(<BoothCard />);
    const g = await block();
    expect(g.getByText(/all events/)).toBeInTheDocument();
    expect(g.getByTestId('booth-audit-counts')).toHaveTextContent('42 ผลประเมิน / audits · 9 ผู้ประเมิน / auditors · 30 การเล่น / plays');
    const cells = g.getAllByRole('definition').map((dd) => dd.textContent);
    expect(cells).toEqual(['+0.4', '-0.17', '0', '+0.62', '-0.5', '+0.1', '-0.05']);
    const terms = g.getAllByRole('term');
    expect(terms.map((dt) => dt.textContent)).toEqual(['CQI', 'RD', 'CI', 'II', 'CA', 'RS', 'ALPS']);
    expect(terms[0]).toHaveAttribute('title', 'Clinical Question Intelligence');
    expect(g.getByText(/\+ means auditors score above the table/)).toBeInTheDocument();
  });

  it('says "no audits yet" when nobody has audited, and shows no gaps', async () => {
    wire({ ...BOOTH, audits: { audits: 0, auditors: 0, plays: 0, mean_gap: null } });
    render(<BoothCard />);
    const g = await block();
    expect(g.getByText(/No audits yet/)).toBeInTheDocument();
    expect(g.queryAllByRole('definition')).toHaveLength(0);
  });

  it('shows "—" when the audits could not be read, and the rest of the card still loads', async () => {
    render(<BoothCard />);
    const g = await block();
    expect(g.getByText('—')).toBeInTheDocument();
    expect(g.queryByTestId('booth-audit-counts')).not.toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Booth totals' })).toBeInTheDocument();
  });

  it('keeps the audits block after a PATCH, from the echo', async () => {
    wire({ ...BOOTH, audits: AUDITS }, (b) => ({ ...BOOTH, ...b, audits: { ...AUDITS, audits: 43 } }));
    render(<BoothCard />);
    fireEvent.click(await loaded());
    await waitFor(() => expect(screen.getByTestId('booth-audit-counts')).toHaveTextContent('43 ผลประเมิน / audits'));
  });
});
