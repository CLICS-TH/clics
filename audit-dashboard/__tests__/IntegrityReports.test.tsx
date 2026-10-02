// The integrity queue's rendering of a physician-reported AI reply (signal S1_PHYSICIAN_REPORTED_REPLY).
//
// The flag arrives as one row per session with the individual reports inside evidence.reports[]. The
// generic evidence renderer would print that array as raw JSON, so the page has its own block. These
// tests pin what a reviewer has to be able to read: which reason, which reply, the physician's note,
// and WHICH MODEL said it — and that a reply with no recorded provenance says so instead of showing a blank.
import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockApiFetch = jest.fn();
jest.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => mockApiFetch(...args) }));
jest.mock('@/components/PageIntro', () => ({ PageIntro: () => <div>intro</div> }));
jest.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
}));
jest.mock('@/components/ui/badge', () => ({ Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
jest.mock('@/components/ui/card', () => ({ Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
jest.mock('lucide-react', () => ({
  AlertTriangle: () => null, ClipboardPaste: () => null, Repeat: () => null, Timer: () => null,
  Fingerprint: () => null, ShieldQuestion: () => null, Flag: () => null,
}));

import IntegrityQueuePage from '@/app/admin/integrity/page';

const MSG_A = '11111111-1111-4111-8111-111111111111';
const MSG_B = '22222222-2222-4222-8222-222222222222';

const row = (reports: unknown[], severity = 'high') => ({
  ples: [{
    id: 'ple-1', ple_code: 'PLE-101', status: 'evaluated', turn_count: 6, ended_at: '2026-10-01T00:00:00Z',
    flags: [{
      signal: 'S1_PHYSICIAN_REPORTED_REPLY', severity, created_at: '2026-10-01T00:00:00Z',
      evidence: { report_count: reports.length, reports, note: 'A physician reported an AI reply as wrong or unsafe.' },
    }],
  }],
});

const report = (over: Record<string, unknown> = {}) => ({
  message_id: MSG_A, reason: 'unsafe_advice', note: null, turn: 3,
  provider: 'local', model: 'deepseek-v4', prompt_version: 'chat-prompt-1a2b3c4d',
  reported_at: '2026-10-01T10:00:00Z', ...over,
});

beforeEach(() => mockApiFetch.mockReset());

test('names the signal in both languages and says it is OUR output, not the physician', async () => {
  mockApiFetch.mockResolvedValue(row([report()]));
  render(<IntegrityQueuePage />);
  expect(await screen.findByText(/แพทย์รายงานคำตอบของ AI/)).toBeInTheDocument();
  expect(screen.getByText(/A physician reported an AI reply/)).toBeInTheDocument();
  expect(screen.getByText(/does not affect their score or the audit sample/)).toBeInTheDocument();
});

test('shows the reason, the reply position, the note and the model that answered', async () => {
  mockApiFetch.mockResolvedValue(row([report({ note: 'dose is ten times too high' })]));
  render(<IntegrityQueuePage />);
  expect(await screen.findByText(/คำแนะนำที่อาจไม่ปลอดภัยต่อผู้ป่วย/)).toBeInTheDocument();
  expect(screen.getByText(/AI reply #3/)).toBeInTheDocument();
  expect(screen.getByText('dose is ten times too high')).toBeInTheDocument();
  expect(screen.getByText('local · deepseek-v4 · chat-prompt-1a2b3c4d')).toBeInTheDocument();
  expect(screen.getByText(MSG_A)).toBeInTheDocument();
});

test('lists every report in the session, each with its OWN model', async () => {
  mockApiFetch.mockResolvedValue(row([
    report({ reason: 'wrong_fact', turn: 1, prompt_version: 'p1', model: 'deepseek-v4' }),
    report({ message_id: MSG_B, reason: 'fabricated_reference', turn: 4, provider: 'anthropic', model: 'claude-x', prompt_version: 'p2' }),
  ], 'medium'));
  render(<IntegrityQueuePage />);
  await screen.findByText(/ข้อมูลทางการแพทย์ไม่ถูกต้อง/);
  expect(screen.getByText('local · deepseek-v4 · p1')).toBeInTheDocument();
  expect(screen.getByText('anthropic · claude-x · p2')).toBeInTheDocument();
  expect(screen.getAllByRole('listitem')).toHaveLength(2);
});

test('a reply with no recorded provenance says "not recorded" rather than showing a blank', async () => {
  mockApiFetch.mockResolvedValue(row([report({ reason: 'other', provider: null, model: null, prompt_version: null })], 'low'));
  render(<IntegrityQueuePage />);
  expect(await screen.findByText(/ไม่ได้บันทึก \/ not recorded/)).toBeInTheDocument();
});

test('no note means no note block — never written is not shown as an empty quotation', async () => {
  mockApiFetch.mockResolvedValue(row([report({ reason: 'other', note: null })], 'low'));
  const { container } = render(<IntegrityQueuePage />);
  await screen.findByText(/อื่น ๆ/);
  expect(container.querySelector('p.border-l-2')).toBeNull();
});

test('the note is rendered as text, never as markup', async () => {
  mockApiFetch.mockResolvedValue(row([report({ reason: 'other', note: '<img src=x onerror=alert(1)>' })], 'low'));
  const { container } = render(<IntegrityQueuePage />);
  await screen.findByText('<img src=x onerror=alert(1)>');
  expect(container.querySelector('img')).toBeNull();
});

test('an unrecognised reason is printed raw, not hidden — it is still a safety report', async () => {
  mockApiFetch.mockResolvedValue(row([report({ reason: 'brand_new_reason' })], 'low'));
  render(<IntegrityQueuePage />);
  expect(await screen.findByText('brand_new_reason')).toBeInTheDocument();
});

test('does not dump the evidence array as raw JSON the way the generic renderer would', async () => {
  mockApiFetch.mockResolvedValue(row([report({ reason: 'wrong_fact' })]));
  const { container } = render(<IntegrityQueuePage />);
  await screen.findByText(/ข้อมูลทางการแพทย์ไม่ถูกต้อง/);
  expect(container.textContent).not.toMatch(/\[\{"message_id"/);
  expect(within(container).queryByText('reports')).toBeNull();
});
