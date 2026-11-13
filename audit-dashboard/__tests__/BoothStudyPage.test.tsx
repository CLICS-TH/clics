import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { BoothStudy } from '@/lib/types';
import { PIS7_RUBRIC } from '@/lib/pis7-rubric';
import { pis7Conclusion } from '@/lib/pis7-delta';

const mockApiFetch = jest.fn();
const mockToast = jest.fn();
const mockRadar = jest.fn();
jest.mock('@/lib/api', () => ({ apiFetch: (...a: unknown[]) => mockApiFetch(...a) }));
jest.mock('next/navigation', () => ({ useParams: () => ({ id: 'play-1' }) }));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a>,
}));
jest.mock('@/components/Overlays', () => ({ toast: (...a: unknown[]) => mockToast(...a) }));
jest.mock('@/components/TranscriptView', () => ({
  TranscriptView: ({ messages }: { messages: { content: string }[] }) => (
    <div data-testid="transcript">{messages.map((m) => m.content).join('|')}</div>
  ),
}));
jest.mock('@/components/Pis7Radar', () => ({
  Pis7Radar: (props: Record<string, unknown>) => { mockRadar(props); return <div data-testid="radar" />; },
}));

import BoothStudyPage from '@/app/auditor/booth/[id]/page';

const PLAY = { id: 'play-1', played_on: '2026-11-20', case: { case_id: 'chest-pain-01', teaser: { th: 'ชายอายุ 58 ปี เจ็บหน้าอก', en: 'A 58-year-old man with chest pain' } } };
const MESSAGES = [{ role: 'physician' as const, content: 'คำตอบที่หนึ่ง' }, { role: 'assistant' as const, content: 'คำตอบกลับ' }];
const BLIND: BoothStudy = { state: 'blind', play: PLAY, messages: MESSAGES };
const MINE = { d1: 3, d2: 4, d3: 2, d4: 3, d5: 4, d6: 3, d7: 2 };
const AUDIT = { ...MINE, composite: 61.43, created_at: '2026-11-21T08:00:00Z' };
const DEMO = { d1: 4, d2: 4, d3: 3, d4: 3, d5: 3, d6: 4, d7: 3, composite: 68.57 };
const REVEALED: BoothStudy = { state: 'revealed', play: PLAY, messages: MESSAGES, audit: AUDIT, demo: DEMO };

const submitButton = () => screen.getByRole('button', { name: /Score all 7 domains|Submit score/ });
function pick(domainEn: string, level: number) {
  fireEvent.click(within(screen.getByRole('radiogroup', { name: `${domainEn} (0–5)` })).getByRole('radio', { name: new RegExp(`^${level} — `) }));
}
const scoreAll = (s: Record<string, number>) => PIS7_RUBRIC.forEach((d) => pick(d.en, s[d.key]));
const posts = () => mockApiFetch.mock.calls.filter(([, init]) => init?.method === 'POST');

beforeEach(() => {
  mockApiFetch.mockReset();
  mockToast.mockReset();
  mockRadar.mockReset();
});

describe('blind scoring', () => {
  it('shows the transcript and nothing of the demo score', async () => {
    mockApiFetch.mockResolvedValueOnce(BLIND);
    render(<BoothStudyPage />);
    expect(await screen.findByTestId('transcript')).toHaveTextContent('คำตอบที่หนึ่ง|คำตอบกลับ');
    expect(mockApiFetch).toHaveBeenCalledWith('/auditor/booth/play-1');
    expect(screen.getByText(PLAY.case.teaser.th)).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('Demo score');
    expect(document.body).not.toHaveTextContent('คะแนนสาธิต');
    expect(screen.queryByTestId('radar')).not.toBeInTheDocument();
    expect(mockRadar).not.toHaveBeenCalled();
  });

  it('keeps Submit disabled until all seven domains are set', async () => {
    mockApiFetch.mockResolvedValueOnce(BLIND);
    render(<BoothStudyPage />);
    await screen.findByTestId('transcript');
    expect(submitButton()).toBeDisabled();
    PIS7_RUBRIC.slice(0, 6).forEach((d) => pick(d.en, 3));
    expect(submitButton()).toBeDisabled();
    pick(PIS7_RUBRIC[6].en, 3);
    expect(submitButton()).toBeEnabled();
    expect(submitButton()).toHaveTextContent('ส่งคะแนน / Submit score');
  });
});

describe('submit', () => {
  it('posts exactly the seven domains and reveals the radar against the demo score', async () => {
    mockApiFetch.mockResolvedValueOnce(BLIND).mockResolvedValueOnce(REVEALED);
    render(<BoothStudyPage />);
    await screen.findByTestId('transcript');
    scoreAll(MINE);
    fireEvent.click(submitButton());

    expect(await screen.findByTestId('radar')).toBeInTheDocument();
    const [[path, init]] = posts();
    expect(path).toBe('/auditor/booth/play-1/audit');
    expect(JSON.parse(String(init.body))).toEqual(MINE);
    expect(Object.keys(JSON.parse(String(init.body)))).toEqual(['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7']);

    const props = mockRadar.mock.calls.at(-1)[0];
    expect(props.label).toBe('คะแนนสาธิต / Demo score');
    expect(props.ai).toEqual(DEMO);
    expect(props.human).toEqual(AUDIT);
    expect(screen.getByText(pis7Conclusion(DEMO, AUDIT, { th: 'คะแนนสาธิต', en: 'the demo score' }))).toBeInTheDocument();
    expect(screen.getByText(/You 61\.4 · คะแนนสาธิต \/ Demo score 68\.6 · ต่างกัน \/ Difference -7\.1/)).toBeInTheDocument();
    expect(screen.getByText(/Submitted/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Submit score/ })).not.toBeInTheDocument();
    expect(mockApiFetch).toHaveBeenCalledTimes(2);
  });

  it('on 409 re-reads the study and reveals it', async () => {
    mockApiFetch
      .mockResolvedValueOnce(BLIND)
      .mockResolvedValueOnce({ error: 'Already audited', code: 'booth_already_audited', httpStatus: 409 })
      .mockResolvedValueOnce(REVEALED);
    render(<BoothStudyPage />);
    await screen.findByTestId('transcript');
    scoreAll(MINE);
    fireEvent.click(submitButton());

    expect(await screen.findByTestId('radar')).toBeInTheDocument();
    expect(mockApiFetch).toHaveBeenNthCalledWith(3, '/auditor/booth/play-1');
    expect(mockToast).toHaveBeenCalledWith(expect.stringMatching(/already scored this case/), 'info');
  });

  it('toasts a failed submit and keeps the scores editable', async () => {
    mockApiFetch.mockResolvedValueOnce(BLIND).mockResolvedValueOnce({ error: 'Could not save the audit — try again', httpStatus: 502 });
    render(<BoothStudyPage />);
    await screen.findByTestId('transcript');
    scoreAll(MINE);
    fireEvent.click(submitButton());

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('Could not save the audit — try again', 'error'));
    expect(submitButton()).toBeEnabled();
    expect(screen.queryByTestId('radar')).not.toBeInTheDocument();
  });
});

describe('an audited play reopens revealed', () => {
  it('shows the submitted scores, locked', async () => {
    mockApiFetch.mockResolvedValueOnce(REVEALED);
    render(<BoothStudyPage />);
    expect(await screen.findByTestId('radar')).toBeInTheDocument();
    const d1 = within(screen.getByRole('radiogroup', { name: `${PIS7_RUBRIC[0].en} (0–5)` }));
    expect(d1.getByRole('radio', { name: /^3 — / })).toHaveAttribute('aria-checked', 'true');
    expect(d1.getByRole('radio', { name: /^3 — / })).toBeDisabled();
    expect(screen.getByText('61.4')).toBeInTheDocument();
  });
});

describe('load failures', () => {
  it('a 404 says the case study was not found, without a Retry', async () => {
    mockApiFetch.mockResolvedValueOnce({ error: 'Not found', code: 'booth_study_not_found', httpStatus: 404 });
    render(<BoothStudyPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('This case study could not be found.');
    expect(screen.queryByRole('button', { name: 'ลองใหม่ / Retry' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Back/ })).toHaveAttribute('href', '/auditor/booth');
  });

  it('any other failure is an error with a Retry that re-reads in place', async () => {
    mockApiFetch.mockResolvedValueOnce({ error: 'Could not reach the booth audits — try again', httpStatus: 502 }).mockResolvedValueOnce(BLIND);
    render(<BoothStudyPage />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load this case study.');
    expect(alert).toHaveTextContent('Could not reach the booth audits — try again');
    fireEvent.click(screen.getByRole('button', { name: 'ลองใหม่ / Retry' }));
    expect(await screen.findByTestId('transcript')).toBeInTheDocument();
    expect(mockApiFetch).toHaveBeenCalledTimes(2);
  });

  it('a body that is not a study is a failure, never an empty scoring form', async () => {
    mockApiFetch.mockResolvedValueOnce({ state: 'revealed', play: PLAY, messages: MESSAGES });
    render(<BoothStudyPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load this case study.');
    expect(screen.queryByTestId('transcript')).not.toBeInTheDocument();
  });
});
