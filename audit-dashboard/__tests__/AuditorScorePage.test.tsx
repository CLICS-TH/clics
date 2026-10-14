// /auditor/ples/[id] load failures. GET /auditor/ples/:id FAILS CLOSED with a 503
// (code 'deidentify_unavailable') when RIMPL cannot de-identify the transcript. That outage used to
// render as "not found or not assigned" — an auditor would read a few minutes of downtime as lost
// assignments. Only a 404/403 means "not yours"; everything else is retryable, in place.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockApiFetch = jest.fn();
const mockPush = jest.fn();
jest.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => mockApiFetch(...args) }));
jest.mock('next/navigation', () => ({
  useParams: () => ({ id: 'ple-1' }),
  useRouter: () => ({ push: mockPush }),
}));
jest.mock('@/components/Overlays', () => ({ toast: jest.fn(), confirmDialog: jest.fn() }));
jest.mock('@/components/TranscriptView', () => ({
  TranscriptView: ({ messages }: { messages: { content: string }[] }) => (
    <div data-testid="transcript">{messages.map((m) => m.content).join('|')}</div>
  ),
}));
jest.mock('@/components/Pis7Radar', () => ({ Pis7Radar: () => null }));
jest.mock('@/components/AuditorChatBox', () => ({ AuditorChatBox: () => null }));

import AuditorScorePage from '@/app/auditor/ples/[id]/page';

const NOT_FOUND = /could not be found, or it is not assigned to you/;
const OUTAGE_TITLE = /การแสดงบทสนทนาขัดข้องชั่วคราว \/ The transcript is temporarily unavailable/;

beforeEach(() => {
  mockApiFetch.mockReset();
  mockPush.mockReset();
});

describe('a de-identification outage is shown as temporary, never as a missing assignment', () => {
  it.each([
    ['the documented body (503 + code)', {
      error: 'การแสดงบทสนทนาขัดข้องชั่วคราว / The transcript is temporarily unavailable.',
      code: 'deidentify_unavailable', httpStatus: 503,
    }],
    ['the code alone', { error: 'unavailable', code: 'deidentify_unavailable' }],
    ['a 503 without a code (e.g. a proxy)', { error: 'Service Unavailable', httpStatus: 503 }],
    ['the earlier bare-string body', { error: 'deidentify_unavailable', httpStatus: 503 }],
  ])('%s', async (_label, body) => {
    mockApiFetch.mockResolvedValueOnce(body);
    render(<AuditorScorePage />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(OUTAGE_TITLE);
    expect(alert).toHaveTextContent(/ไม่มีข้อมูลใดสูญหาย/);
    expect(alert).toHaveTextContent(/Nothing was lost/);
    expect(alert).toHaveTextContent(/try again in a moment/);
    expect(alert).not.toHaveTextContent(NOT_FOUND);
    // The raw machine code is not copy for a reader.
    expect(alert).not.toHaveTextContent('deidentify_unavailable');
    expect(screen.getByRole('button', { name: 'ลองใหม่ / Retry' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Back to queue/ })).toBeInTheDocument();
  });

  it('Retry re-fetches in place and shows the transcript once the service is back', async () => {
    mockApiFetch
      .mockResolvedValueOnce({ error: 'x', code: 'deidentify_unavailable', httpStatus: 503 })
      .mockResolvedValueOnce({ messages: [{ role: 'physician', content: 'Masked transcript' }], audit_score: null });
    render(<AuditorScorePage />);

    fireEvent.click(await screen.findByRole('button', { name: 'ลองใหม่ / Retry' }));

    expect(await screen.findByTestId('transcript')).toHaveTextContent('Masked transcript');
    expect(screen.queryByText(OUTAGE_TITLE)).not.toBeInTheDocument();
    expect(mockApiFetch).toHaveBeenCalledTimes(2);
    expect(mockApiFetch).toHaveBeenNthCalledWith(1, '/auditor/ples/ple-1');
    expect(mockApiFetch).toHaveBeenNthCalledWith(2, '/auditor/ples/ple-1');
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('a retry that fails again stays on the outage state (no silent empty scoring form)', async () => {
    const outage = { error: 'x', code: 'deidentify_unavailable', httpStatus: 503 };
    mockApiFetch.mockResolvedValueOnce(outage).mockResolvedValueOnce(outage);
    render(<AuditorScorePage />);

    fireEvent.click(await screen.findByRole('button', { name: 'ลองใหม่ / Retry' }));

    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('alert')).toHaveTextContent(OUTAGE_TITLE);
    expect(screen.queryByTestId('transcript')).not.toBeInTheDocument();
  });
});

describe('only a 404/403 says "not found or not assigned"', () => {
  it.each([404, 403])('%i keeps the not-found message, without a Retry', async (httpStatus) => {
    mockApiFetch.mockResolvedValueOnce({ error: 'Not found or not assigned', httpStatus });
    render(<AuditorScorePage />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('ไม่พบเซสชันนี้ หรือคุณไม่ได้รับมอบหมายให้ตรวจ');
    expect(alert).toHaveTextContent(NOT_FOUND);
    expect(screen.queryByRole('button', { name: 'ลองใหม่ / Retry' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Back to queue/ }));
    expect(mockPush).toHaveBeenCalledWith('/auditor/queue');
  });

  it.each([
    ['a network failure (no status)', { error: 'เครือข่ายขัดข้อง กรุณาลองใหม่ / Network error. Please try again.' }],
    ['a 500', { error: 'Could not load the complete scoring evidence', httpStatus: 500 }],
  ])('%s is a retryable load failure, not a missing assignment', async (_label, body) => {
    mockApiFetch.mockResolvedValueOnce(body);
    render(<AuditorScorePage />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('โหลดเซสชันนี้ไม่สำเร็จ / Could not load this session');
    expect(alert).toHaveTextContent(body.error);
    expect(alert).not.toHaveTextContent(NOT_FOUND);
    expect(alert).not.toHaveTextContent(OUTAGE_TITLE);
    expect(screen.getByRole('button', { name: 'ลองใหม่ / Retry' })).toBeInTheDocument();
  });
});
