// BoothFeedback: the anonymous post-play feedback on /admin/booth. What has to be RIGHT: the counts, the per-date
// split and every question's distribution are computed from the rows; a case filter narrows every number; a
// withheld comment shows its reason and never any text; rows are shown in the server's content order with no
// numbering (ADR 0015); the export goes only through apiDownload to the audited path.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { BoothFeedback as Feedback, BoothFeedbackRow } from '@/lib/types';

const mockApiFetch = jest.fn();
const mockApiDownload = jest.fn();
const mockToast = jest.fn();
jest.mock('@/lib/api', () => ({
  apiFetch: (...a: unknown[]) => mockApiFetch(...a),
  apiDownload: (...a: unknown[]) => mockApiDownload(...a),
}));
jest.mock('@/components/Overlays', () => ({ toast: (...a: unknown[]) => mockToast(...a) }));

import { BoothFeedback } from '@/components/BoothFeedback';

const ans = (o: Partial<BoothFeedbackRow['answers']> = {}): BoothFeedbackRow['answers'] =>
  ({ role: 'physician', mood: 'enjoyed', felt_like: ['game'], easy: 4, real: 3, fair: 4, use: 8, ...o });

// Server order: newest date first, then case.
const ROWS: BoothFeedbackRow[] = [
  { date: '2026-11-25', case_id: 'cap-adult', answers: ans({ easy: 5, felt_like: ['game', 'exam'], use: 10 }), comment: 'สนุกมาก fun' },
  { date: '2026-11-25', case_id: 'dka-teen', answers: ans({ easy: 4, role: 'student', mood: 'confused', felt_like: ['game'], use: 6 }), comment: null },
  { date: '2026-11-24', case_id: 'cap-adult', answers: ans({ easy: 3, role: 'resident', felt_like: ['textbook'], use: 2 }), comment: null, withheld: 'flagged' },
  { date: '2026-11-24', case_id: null, answers: ans({ easy: 2, mood: 'stressed', felt_like: ['exam'], use: 0 }), comment: null },
];
const DATA: Feedback = {
  event_code: 'NFCME-2026', form: 'fb-1', rows: ROWS,
  counts: { answers: 4, comments: 2, comments_withheld: 1 },
};

const wire = (answer: unknown) => mockApiFetch.mockImplementation((p: string) =>
  Promise.resolve(p === '/admin/booth/feedback' ? answer : { error: `unexpected ${p}` }));

beforeEach(() => {
  mockApiFetch.mockReset();
  mockApiDownload.mockReset();
  mockToast.mockReset();
});

const n = (id: string) => screen.getByTestId(id).textContent;   // a node holding only its number

describe('BoothFeedback', () => {
  it("shows counts, per-date split and every question's distribution", async () => {
    wire(DATA);
    render(<BoothFeedback />);
    await screen.findByTestId('fb-answers');
    expect(n('fb-answers')).toBe('4');
    expect(n('fb-date-n-2026-11-25')).toBe('2');
    expect(n('fb-date-n-2026-11-24')).toBe('2');
    // easy: (5+4+3+2)/4 = 3.5, n = 4
    expect(n('fb-mean-easy')).toBe('3.5');
    expect(n('fb-mean-easy-n')).toBe('4');
    // felt_like is multi-choice: game x2, exam x2, textbook x1, the others 0
    expect(n('fb-bar-felt_like-game-n')).toBe('2');
    expect(n('fb-bar-felt_like-exam-n')).toBe('2');
    expect(n('fb-bar-felt_like-textbook-n')).toBe('1');
    expect(n('fb-bar-felt_like-ward_round-n')).toBe('0');
    expect(screen.getAllByTestId(/^fb-bar-felt_like-[a-z_]+$/)).toHaveLength(6);
    expect(n('fb-bar-role-physician-n')).toBe('2');
    expect(n('fb-bar-mood-confused-n')).toBe('1');
    expect(n('fb-bar-use-10-n')).toBe('1');
    expect(n('fb-bar-use-1-n')).toBe('0');
    expect(screen.getAllByTestId(/^fb-bar-use-\d+$/)).toHaveLength(11);
  });

  it('a case filter narrows every number', async () => {
    wire(DATA);
    render(<BoothFeedback />);
    await screen.findByTestId('fb-answers');
    fireEvent.change(screen.getByRole('combobox', { name: /เคส/ }), { target: { value: 'cap-adult' } });
    expect(n('fb-answers')).toBe('2');
    expect(n('fb-date-n-2026-11-24')).toBe('1');
    expect(n('fb-date-n-2026-11-25')).toBe('1');
    expect(n('fb-mean-easy')).toBe('4.0');   // (5+3)/2
    expect(n('fb-mean-easy-n')).toBe('2');   // n follows the filter
    expect(n('fb-mean-use-n')).toBe('2');
    expect(n('fb-bar-felt_like-textbook-n')).toBe('1');
    expect(n('fb-bar-role-student-n')).toBe('0');
  });

  it('a withheld comment shows its reason, never text', async () => {
    wire({ ...DATA, rows: [{ ...ROWS[2], comment: 'LEAKED-TEXT' }] , counts: { answers: 1, comments: 1, comments_withheld: 1 } });
    render(<BoothFeedback />);
    await screen.findByTestId('fb-answers');
    const list = screen.getByRole('list', { name: /ความเห็น/ });
    expect(within(list).getByText(/ถูกซ่อน/)).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('LEAKED-TEXT');
  });

  it('shows a comment in the server order, without numbering', async () => {
    wire(DATA);
    render(<BoothFeedback />);
    await screen.findByTestId('fb-answers');
    const items = within(screen.getByRole('list', { name: /ความเห็น/ })).getAllByRole('listitem');
    expect(items).toHaveLength(2);   // one comment, one withheld
    expect(items[0]).toHaveTextContent('สนุกมาก fun');
    expect(items[1]).toHaveTextContent('ถูกซ่อน');
    expect(screen.getByRole('list', { name: /ความเห็น/ }).tagName).toBe('UL');
  });

  it('empty event says so', async () => {
    wire({ ...DATA, rows: [], counts: { answers: 0, comments: 0, comments_withheld: 0 } });
    render(<BoothFeedback />);
    expect(await screen.findByText('ยังไม่มีแบบประเมิน / No feedback yet.')).toBeInTheDocument();
    expect(screen.queryByTestId('fb-answers')).not.toBeInTheDocument();
  });

  it('a failed load says so and Retry reads again', async () => {
    mockApiFetch.mockResolvedValueOnce({ error: 'boom', httpStatus: 502 }).mockResolvedValue(DATA);
    render(<BoothFeedback />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load the feedback');
    fireEvent.click(within(alert).getByRole('button', { name: /Retry/ }));
    expect(await screen.findByTestId('fb-answers')).toBeInTheDocument();
  });

  it('export goes to the audited path', async () => {
    wire(DATA);
    mockApiDownload.mockResolvedValue({});
    render(<BoothFeedback />);
    await screen.findByTestId('fb-answers');
    fireEvent.click(screen.getByRole('button', { name: /Export/ }));
    await waitFor(() => expect(mockApiDownload).toHaveBeenCalledTimes(1));
    expect(mockApiDownload).toHaveBeenCalledWith('/admin/booth/feedback.json', 'booth-feedback-NFCME-2026.json');
    expect(mockToast).not.toHaveBeenCalled();
  });

  it('an export failure is said in a toast', async () => {
    wire(DATA);
    mockApiDownload.mockResolvedValue({ error: 'nope' });
    render(<BoothFeedback />);
    await screen.findByTestId('fb-answers');
    fireEvent.click(screen.getByRole('button', { name: /Export/ }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('nope', 'error'));
  });
});
