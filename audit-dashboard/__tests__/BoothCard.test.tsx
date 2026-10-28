// BoothCard (#214) drives the Booth Mode event from /admin/overview. What has to be RIGHT here: times leave
// with an explicit +07:00 offset and come back as Bangkok wall-clock; the switch shows the server's echo, not
// the click; a window that closes before it opens or an out-of-range ceiling never leaves the page; and a
// failed count read shows "—", never 0.
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';

const apiFetch = jest.fn();
const toast = jest.fn();
jest.mock('@/lib/api', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
jest.mock('@/components/Overlays', () => ({ toast: (...a: unknown[]) => toast(...a) }));

import { BoothCard, toBangkokInput, fromBangkokInput } from '@/components/BoothCard';
import type { BoothSettings } from '@/lib/types';

const BOOTH: BoothSettings = {
  event_code: 'NFCME-2026', enabled: false, opens_at: '2026-11-03T08:00:00+07:00', closes_at: '2026-11-04T18:00:00+07:00',
  ceiling_usd: 3, state: 'off', plays: 12, scored: 9, spend_usd: 4.2,
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

  it('shows a failed count read as "—", not 0', async () => {
    wire({ ...BOOTH, plays: null, scored: null, spend_usd: null });
    render(<BoothCard />);
    await loaded();
    expect(screen.getAllByText('—')).toHaveLength(3);
  });

  it('says so when the settings cannot be loaded', async () => {
    wire({ error: 'Could not read the booth settings — try again' });
    render(<BoothCard />);
    expect(await screen.findByText(/Could not read the booth settings/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Booth event switch' })).not.toBeInTheDocument();
  });
});
