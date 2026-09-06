import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockApiFetch = jest.fn();
const mockToast = jest.fn();
jest.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => mockApiFetch(...args) }));
jest.mock('@/components/Overlays', () => ({ toast: (...args: unknown[]) => mockToast(...args) }));
jest.mock('@/components/PageIntro', () => ({ PageIntro: () => <div>Privacy review</div> }));
jest.mock('@/components/TranscriptView', () => ({
  TranscriptView: ({ messages }: { messages: { content: string }[] }) => <div>{messages.map(m => m.content).join('|')}</div>,
}));
jest.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
}));
jest.mock('lucide-react', () => ({
  ShieldCheck: () => null, EyeOff: () => null, Scissors: () => null, Ban: () => null, ChevronDown: () => null,
}));

import PrivacyReviewPage from '@/app/admin/privacy/page';

beforeEach(() => {
  mockApiFetch.mockReset();
  mockToast.mockReset();
});

test('a failed transcript load stays visibly failed and cannot be reviewed as an empty transcript', async () => {
  mockApiFetch
    .mockResolvedValueOnce({ ples: [{ id: 'ple-1', ple_code: 'PLE-001', turn_count: 2, token_count: 50 }] })
    .mockRejectedValueOnce(new Error('transcript unavailable'));

  render(<PrivacyReviewPage />);
  fireEvent.click(await screen.findByText('PLE-001'));

  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the transcript');
  expect(screen.getByRole('button', { name: /^ผ่าน \/ Pass$/ })).toBeDisabled();
  expect(mockToast).toHaveBeenCalledWith(expect.stringMatching(/Could not load the transcript/), 'error');
  expect(mockApiFetch).toHaveBeenCalledTimes(2);
});

test('a complete transcript enables review decisions', async () => {
  mockApiFetch
    .mockResolvedValueOnce({ ples: [{ id: 'ple-1', ple_code: 'PLE-001', turn_count: 2, token_count: 50 }] })
    .mockResolvedValueOnce({ messages: [{ role: 'reflection', content: 'Saved reflection' }] });

  render(<PrivacyReviewPage />);
  fireEvent.click(await screen.findByText('PLE-001'));

  await waitFor(() => expect(screen.getByText('Saved reflection')).toBeInTheDocument());
  expect(screen.getByRole('button', { name: /^ผ่าน \/ Pass$/ })).toBeEnabled();
});
