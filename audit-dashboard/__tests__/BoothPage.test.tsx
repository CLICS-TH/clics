// /admin/booth: BoothCard (its own suite), the leaderboard of every scored play, and the internal JSON export.
// What has to be RIGHT on the leaderboard: the rows arrive ranked and are shown in that order (the rank on this
// page is the rank the visitor was told); every row is shown, with the count; a participant reads "Participant #042" as on
// the kiosk; the By case view picks a case by its Thai teaser; a board that never loaded says so, and a refresh
// that fails keeps the last board. The export goes to the one path that writes its audit row.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { BoothStanding, BoothStandings } from '@/lib/types';

const mockApiFetch = jest.fn();
const mockApiDownload = jest.fn();
const mockToast = jest.fn();
let mockMobile = false;
jest.mock('@/lib/api', () => ({
  apiFetch: (...a: unknown[]) => mockApiFetch(...a),
  apiDownload: (...a: unknown[]) => mockApiDownload(...a),
}));
const mockRouter = { push: jest.fn() };
jest.mock('next/navigation', () => ({ useRouter: () => mockRouter }));
jest.mock('@/components/Overlays', () => ({ toast: (...a: unknown[]) => mockToast(...a) }));
jest.mock('@/components/ViewportProvider', () => ({ useIsMobile: () => mockMobile }));
jest.mock('@/components/BoothCard', () => ({ BoothCard: () => <section data-testid="booth-card" /> }));

import BoothPage from '@/app/admin/booth/page';
import { BoothLeaderboard, REFRESH_MS } from '@/components/BoothLeaderboard';

const row = (rank: number, tag: number, score: number, raw: number, case_id: string | null, scored_at: string): BoothStanding =>
  ({ rank, tag, score, raw, case_id, case_version: case_id ? 'v3' : null, scored_at });

// The server's order. Tag 120 is listed before tag 7 on purpose: the page must keep it.
const OVERALL = [
  row(1, 42, 87.4, 61.2, 'cap-adult', '2026-11-24T07:05:00Z'),
  row(2, 120, 71.6, 54.0, 'cap-adult', '2026-11-24T06:40:00Z'),
  row(3, 7, 71.6, 54.0, 'dka-teen', '2026-11-24T06:52:00Z'),
];
const STANDINGS: BoothStandings = {
  event_code: 'NFCME-2026', steps: 5, generated_at: '2026-11-24T07:06:00Z', total: 3,
  overall: OVERALL,
  cases: [
    { case_id: 'cap-adult', version: 'v3', teaser: { th: 'ชายวัย 52 ปี มีไข้และไอมา 3 วัน', en: 'A 52-year-old man with fever and cough for 3 days' },
      rows: [row(1, 42, 87.4, 61.2, 'cap-adult', '2026-11-24T07:05:00Z'), row(2, 120, 71.6, 54.0, 'cap-adult', '2026-11-24T06:40:00Z')] },
    { case_id: 'dka-teen', version: null, teaser: null, rows: [row(1, 7, 71.6, 54.0, 'dka-teen', '2026-11-24T06:52:00Z')] },
    { case_id: 'stroke-elder', version: 'v1', teaser: { th: 'หญิงวัย 78 ปี แขนขาซีกขวาอ่อนแรง', en: 'A 78-year-old woman with right-sided weakness' }, rows: [] },
  ],
};

function wire(...answers: unknown[]) {
  // Each GET of the standings takes the next answer; the last one repeats.
  let i = 0;
  mockApiFetch.mockImplementation((path: string) => {
    if (path !== '/admin/booth/standings') return Promise.resolve({ error: `unexpected ${path}` });
    const a = answers[Math.min(i, answers.length - 1)];
    i += 1;
    return Promise.resolve(a);
  });
}
const reads = () => mockApiFetch.mock.calls.filter(([p]) => p === '/admin/booth/standings').length;
const bodyRows = (table: HTMLElement) => within(table).getAllByRole('row').slice(1);

let visibility: DocumentVisibilityState = 'visible';
beforeAll(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
});

beforeEach(() => {
  mockApiFetch.mockReset();
  mockApiDownload.mockReset();
  mockToast.mockReset();
  mockRouter.push.mockReset();
  mockMobile = false;
  visibility = 'visible';
  localStorage.setItem('clics_user', JSON.stringify({ id: 'u1', role: 'superadmin', email: 's@x' }));
});
afterEach(() => { jest.useRealTimers(); });

describe('/admin/booth page', () => {
  it('sends anyone but a superadmin to /home', async () => {
    localStorage.setItem('clics_user', JSON.stringify({ id: 'u2', role: 'admin', email: 'a@x' }));
    wire(STANDINGS);
    render(<BoothPage />);
    expect(mockRouter.push).toHaveBeenCalledWith('/home');
    await act(async () => {});   // let the leaderboard's read settle inside act
  });

  it('holds the event settings, the leaderboard and the export, marked internal', async () => {
    wire(STANDINGS);
    render(<BoothPage />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('โหมดบูธ / Booth Mode');
    expect(screen.getByTestId('booth-card')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Leaderboard/ })).toBeInTheDocument();
    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export ข้อมูลบูท (JSON)' })).toBeInTheDocument();
    expect(screen.getByText('ใช้ภายในเท่านั้น / Internal use only')).toBeInTheDocument();
  });

  it('exports from /admin/booth/export.json under the server\'s file name', async () => {
    wire(STANDINGS);
    mockApiDownload.mockResolvedValue({});
    render(<BoothPage />);
    await screen.findByTestId('booth-updated');   // the event code comes with the board
    fireEvent.click(screen.getByRole('button', { name: 'Export ข้อมูลบูท (JSON)' }));
    await waitFor(() => expect(mockApiDownload).toHaveBeenCalledTimes(1));
    const [path, name] = mockApiDownload.mock.calls[0];
    expect(path).toBe('/admin/booth/export.json');
    expect(name).toMatch(/^clics-booth-NFCME-2026-\d{4}-\d{2}-\d{2}\.json$/);
    expect(mockToast).not.toHaveBeenCalled();
  });

  it('a second press while exporting is ignored, and a failure is said in a toast', async () => {
    wire(STANDINGS);
    let land!: (v: unknown) => void;
    mockApiDownload.mockReturnValue(new Promise((res) => { land = res; }));
    render(<BoothPage />);
    const btn = screen.getByRole('button', { name: 'Export ข้อมูลบูท (JSON)' });
    btn.focus();
    fireEvent.click(btn);
    await waitFor(() => expect(btn).toHaveAttribute('aria-disabled', 'true'));
    expect(btn).toHaveTextContent('กำลังส่งออก… / Exporting…');
    expect(btn).toHaveFocus();
    fireEvent.click(btn);
    expect(mockApiDownload).toHaveBeenCalledTimes(1);
    await act(async () => { land({ error: 'ดาวน์โหลดไม่สำเร็จ / Download failed (status 503).' }); });
    expect(mockToast).toHaveBeenCalledWith('ดาวน์โหลดไม่สำเร็จ / Download failed (status 503).', 'error');
    expect(btn).not.toHaveAttribute('aria-disabled');
  });
});

describe('leaderboard — overall', () => {
  it('shows every row in the server\'s order, with the count, the player, both scores, the case and Bangkok time', async () => {
    wire(STANDINGS);
    render(<BoothLeaderboard />);
    const table = await screen.findByRole('table');
    expect(screen.getByTestId('booth-row-count')).toHaveTextContent('3 แถว / 3 rows');
    const rows = bodyRows(table);
    expect(rows).toHaveLength(3);
    // Not re-sorted: #120 stays above #7 although both scored 71.6.
    expect(rows.map((r) => within(r).getAllByRole('cell')[1].textContent)).toEqual([
      'หมายเลขผู้เข้าร่วม 042 Participant #042', 'หมายเลขผู้เข้าร่วม 120 Participant #120', 'หมายเลขผู้เข้าร่วม 007 Participant #007',
    ]);
    const first = within(rows[0]).getAllByRole('cell').map((c) => c.textContent);
    expect(first).toEqual(['1', 'หมายเลขผู้เข้าร่วม 042 Participant #042', '87ดิบ / raw 61.2', 'cap-adult', '24 พ.ย. 14:05']);
    expect(screen.getByTestId('booth-updated')).toHaveTextContent('อัปเดต 14:06 น. / Updated 14:06');
  });

  it('hands the loaded board to the page (the export names its file by the event code)', async () => {
    wire(STANDINGS);
    const onLoad = jest.fn();
    render(<BoothLeaderboard onLoad={onLoad} />);
    await waitFor(() => expect(onLoad).toHaveBeenCalledWith(STANDINGS));
  });

  it('an event with no scored play says so, with a zero count', async () => {
    wire({ ...STANDINGS, total: 0, overall: [], cases: [] });
    render(<BoothLeaderboard />);
    expect(await screen.findByText('ยังไม่มีการเล่นที่ได้คะแนน / No scored play yet.')).toBeInTheDocument();
    expect(screen.getByTestId('booth-row-count')).toHaveTextContent('0 แถว / 0 rows');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('on a phone the rows are a list, not a sideways-scrolling table', async () => {
    mockMobile = true;
    wire(STANDINGS);
    render(<BoothLeaderboard />);
    const list = await screen.findByRole('list', { name: 'กระดานคะแนนรวม / Overall leaderboard' });
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('หมายเลขผู้เข้าร่วม 042');
    expect(items[0]).toHaveTextContent('cap-adult 24 พ.ย. 14:05');
    expect(items[0]).toHaveTextContent('87');
  });
});

describe('leaderboard — tabs and the case picker', () => {
  async function byCase() {
    wire(STANDINGS);
    render(<BoothLeaderboard />);
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('tab', { name: /By case/ }));
  }

  it('three tabs with one tab stop; Overall is selected first', async () => {
    wire(STANDINGS);
    render(<BoothLeaderboard />);
    const tabs = within(await screen.findByRole('tablist', { name: 'มุมมองกระดานคะแนน / Leaderboard view' })).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['รวมทุกเคสOverall', 'รายวันBy day', 'รายเคสBy case']);
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1]);
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', tabs[0].id);
  });

  it('arrows move between the tabs, show the view and take focus with them', async () => {
    wire(STANDINGS);
    render(<BoothLeaderboard />);
    const list = await screen.findByRole('tablist');
    const [overall, perDay, perCase] = within(list).getAllByRole('tab');
    overall.focus();
    fireEvent.keyDown(list, { key: 'ArrowRight' });
    expect(perDay).toHaveFocus();
    expect(perDay).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('radiogroup', { name: 'เลือกวัน / Choose a day' })).toBeInTheDocument();
    fireEvent.keyDown(list, { key: 'ArrowRight' });
    expect(perCase).toHaveFocus();
    expect(perCase).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('radiogroup', { name: 'เลือกเคส / Choose a case' })).toBeInTheDocument();
    fireEvent.keyDown(list, { key: 'ArrowRight' });   // wraps
    expect(overall).toHaveFocus();
    fireEvent.keyDown(list, { key: 'Enter' });        // not an arrow: nothing moves
    expect(overall).toHaveAttribute('aria-selected', 'true');
  });

  it('By case: the picker names each case by its Thai teaser and id, the first is chosen, and its board has no case column', async () => {
    await byCase();
    const picker = screen.getByRole('radiogroup', { name: 'เลือกเคส / Choose a case' });
    const radios = within(picker).getAllByRole('radio');
    expect(radios).toHaveLength(3);
    expect(radios[0]).toHaveTextContent('ชายวัย 52 ปี มีไข้และไอมา 3 วัน');
    expect(radios[0]).toHaveTextContent('cap-adult v3');
    expect(radios[0]).toHaveTextContent('2 แถว / 2 rows');
    // A case no longer in the pool has no teaser to show.
    expect(radios[1]).toHaveTextContent('เคสที่ถอดออกจากชุดแล้วRetired case');
    expect(radios[1]).toHaveTextContent('dka-teen');
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
    expect(radios.map((r) => r.tabIndex)).toEqual([0, -1, -1]);

    // ui/table names its scroll region (the focusable wrapper), and the table sits inside it.
    const table = within(screen.getByRole('region', { name: 'กระดานคะแนนเคส cap-adult / Leaderboard for cap-adult' })).getByRole('table');
    expect(within(table).getAllByRole('columnheader')).toHaveLength(4);
    expect(bodyRows(table)).toHaveLength(2);
    expect(screen.getByTestId('booth-row-count')).toHaveTextContent('2 แถว / 2 rows');
  });

  it('choosing another case shows its board; arrows choose too; an empty case says so', async () => {
    await byCase();
    const picker = screen.getByRole('radiogroup');
    const radios = within(picker).getAllByRole('radio');
    fireEvent.click(radios[1]);
    expect(radios[1]).toHaveAttribute('aria-checked', 'true');
    const table = within(screen.getByRole('region', { name: /dka-teen/ })).getByRole('table');
    expect(bodyRows(table).map((r) => within(r).getAllByRole('cell')[1].textContent)).toEqual(['หมายเลขผู้เข้าร่วม 007 Participant #007']);

    radios[1].focus();
    fireEvent.keyDown(picker, { key: 'ArrowDown' });
    expect(radios[2]).toHaveFocus();
    expect(radios[2]).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('เคสนี้ยังไม่มีการเล่นที่ได้คะแนน / No scored play in this case yet.')).toBeInTheDocument();
    expect(screen.getByTestId('booth-row-count')).toHaveTextContent('0 แถว / 0 rows');
  });

  it('an event with no cases says so in the By case view', async () => {
    wire({ ...STANDINGS, cases: [] });
    render(<BoothLeaderboard />);
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('tab', { name: /By case/ }));
    expect(screen.getByText('งานนี้ยังไม่มีเคส / This event has no cases.')).toBeInTheDocument();
  });
});

describe('leaderboard — loading, errors and refresh', () => {
  it('a board that never loaded says what failed and offers Retry', async () => {
    wire({ error: 'Could not read the booth standings — try again', httpStatus: 502 }, STANDINGS);
    render(<BoothLeaderboard />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('โหลดกระดานคะแนนไม่สำเร็จ / Could not load the leaderboard.');
    expect(alert).toHaveTextContent('Could not read the booth standings — try again');
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    fireEvent.click(within(alert).getByRole('button', { name: 'ลองใหม่ / Retry' }));
    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a body without the lists is a failure, not an empty board', async () => {
    wire({ event_code: 'X' });
    render(<BoothLeaderboard />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the leaderboard.');
  });

  it('says it is loading until the first answer', () => {
    mockApiFetch.mockReturnValue(new Promise(() => {}));
    render(<BoothLeaderboard />);
    expect(screen.getByRole('status')).toHaveTextContent('กำลังโหลดกระดานคะแนน… / Loading the leaderboard…');
  });

  it('refreshes every 60 s while the tab is visible, and keeps the last board when a refresh fails', async () => {
    jest.useFakeTimers();
    const later = { ...STANDINGS, generated_at: '2026-11-24T07:07:00Z' };
    wire(STANDINGS, later, { error: 'boom' });
    render(<BoothLeaderboard />);
    expect(await screen.findByTestId('booth-updated')).toHaveTextContent('Updated 14:06');
    expect(reads()).toBe(1);

    await act(async () => { jest.advanceTimersByTime(REFRESH_MS); });
    expect(reads()).toBe(2);
    expect(screen.getByTestId('booth-updated')).toHaveTextContent('Updated 14:07');

    await act(async () => { jest.advanceTimersByTime(REFRESH_MS); });
    expect(reads()).toBe(3);
    expect(screen.getByText(/Could not refresh/).closest('[role="status"]')).toHaveAttribute('data-kind', 'notice');
    // The last good board stays.
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByTestId('booth-updated')).toHaveTextContent('Updated 14:07');
  });

  it('skips the refresh while the tab is hidden, and catches up on coming back', async () => {
    jest.useFakeTimers();
    wire(STANDINGS);
    render(<BoothLeaderboard />);
    await screen.findByTestId('booth-updated');
    visibility = 'hidden';
    await act(async () => { jest.advanceTimersByTime(REFRESH_MS * 3); });
    expect(reads()).toBe(1);
    visibility = 'visible';
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(reads()).toBe(2);
    // Back again within the minute: no extra read.
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(reads()).toBe(2);
  });

  it('stops refreshing once it leaves the page', async () => {
    jest.useFakeTimers();
    wire(STANDINGS);
    const { unmount } = render(<BoothLeaderboard />);
    await screen.findByTestId('booth-updated');
    unmount();
    await act(async () => { jest.advanceTimersByTime(REFRESH_MS * 2); });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(reads()).toBe(1);
  });
});

describe('leaderboard — by day (a prize for each day\'s top player)', () => {
  // Bangkok days: the 24th runs to 16:59:59Z, the 25th starts at 17:00Z. The server's order, as it ranks the event.
  const SPREAD = [
    row(1, 42, 87.4, 61.2, 'cap-adult', '2026-11-24T07:05:00Z'),
    row(2, 120, 71.6, 54.0, 'cap-adult', '2026-11-25T02:40:00Z'),
    row(3, 7, 71.6, 54.0, 'dka-teen', '2026-11-25T03:52:00Z'),
    row(4, 9, 60.2, 50.0, 'dka-teen', '2026-11-24T16:59:00Z'),
    row(5, 11, 55.0, 48.0, 'cap-adult', '2026-11-24T17:00:00Z'),
  ];
  async function byDay() {
    wire({ ...STANDINGS, generated_at: '2026-11-25T05:00:00Z', total: SPREAD.length, overall: SPREAD });
    render(<BoothLeaderboard />);
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('tab', { name: /By day/ }));
  }

  it('lists the event\'s days newest first, marks today, and shows the newest day ranked from 1', async () => {
    await byDay();
    const radios = within(screen.getByRole('radiogroup', { name: 'เลือกวัน / Choose a day' })).getAllByRole('radio');
    expect(radios.map((r) => r.textContent)).toEqual([
      'พุธ 25 พ.ย. · วันนี้Wed 25 Nov · Today3 แถว / 3 rows',
      'อังคาร 24 พ.ย.Tue 24 Nov2 แถว / 2 rows',
    ]);
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    const table = within(screen.getByRole('region', { name: 'กระดานคะแนน พุธ 25 พ.ย. / Leaderboard for Wed 25 Nov' })).getByRole('table');
    // #011 scored at Bangkok midnight, so it is the 25th's, not the 24th's.
    expect(bodyRows(table).map((r) => within(r).getAllByRole('cell').slice(0, 2).map((c) => c.textContent))).toEqual([
      ['1', 'หมายเลขผู้เข้าร่วม 120 Participant #120'],
      ['2', 'หมายเลขผู้เข้าร่วม 007 Participant #007'],
      ['3', 'หมายเลขผู้เข้าร่วม 011 Participant #011'],
    ]);
  });

  it('choosing another day shows that day\'s ranking, its top player first', async () => {
    await byDay();
    const radios = within(screen.getByRole('radiogroup', { name: 'เลือกวัน / Choose a day' })).getAllByRole('radio');
    fireEvent.click(radios[1]);
    expect(radios[1]).toHaveAttribute('aria-checked', 'true');
    const table = within(screen.getByRole('region', { name: 'กระดานคะแนน อังคาร 24 พ.ย. / Leaderboard for Tue 24 Nov' })).getByRole('table');
    expect(bodyRows(table).map((r) => within(r).getAllByRole('cell').slice(0, 2).map((c) => c.textContent))).toEqual([
      ['1', 'หมายเลขผู้เข้าร่วม 042 Participant #042'],
      ['2', 'หมายเลขผู้เข้าร่วม 009 Participant #009'],
    ]);
    expect(screen.getByTestId('booth-row-count')).toHaveTextContent('2 แถว / 2 rows');
  });

  it('an event with no scored play says so', async () => {
    wire({ ...STANDINGS, total: 0, overall: [], cases: [] });
    render(<BoothLeaderboard />);
    await screen.findByText('ยังไม่มีการเล่นที่ได้คะแนน / No scored play yet.');
    fireEvent.click(screen.getByRole('tab', { name: /By day/ }));
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(screen.getByText('ยังไม่มีการเล่นที่ได้คะแนน / No scored play yet.')).toBeInTheDocument();
  });
});
