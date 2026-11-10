import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { BoothQueueItem } from '@/lib/types';

const mockApiFetch = jest.fn();
jest.mock('@/lib/api', () => ({ apiFetch: (...a: unknown[]) => mockApiFetch(...a) }));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a>,
}));

import BoothQueuePage from '@/app/auditor/booth/page';

const item = (id: string, th: string, audited: boolean): BoothQueueItem => ({
  id, played_on: '2026-11-20', audited,
  case: { case_id: `case-${id}`, teaser: { th, en: `${th} (en)` } },
});

beforeEach(() => mockApiFetch.mockReset());

describe('booth case-study queue', () => {
  it('lists plays in the order served, each linking to its study, with the audited badge', async () => {
    mockApiFetch.mockResolvedValueOnce([item('b', 'ชายอายุ 58 ปี', false), item('a', 'หญิงอายุ 30 ปี', true)]);
    render(<BoothQueuePage />);
    const newest = await screen.findByRole('link', { name: /ชายอายุ 58 ปี/ });
    expect(mockApiFetch).toHaveBeenCalledWith('/auditor/booth');
    const rows = screen.getAllByRole('listitem');
    expect(rows.map((r) => r.querySelector('a')?.getAttribute('href'))).toEqual(['/auditor/booth/b', '/auditor/booth/a']);
    expect(newest).toHaveTextContent('รอประเมิน / To score');
    expect(screen.getByRole('link', { name: /หญิงอายุ 30 ปี/ })).toHaveTextContent('ให้คะแนนแล้ว / Scored');
    expect(screen.getByText(/not counted in the pilot/)).toBeInTheDocument();
  });

  it('says so when there is nothing to study', async () => {
    mockApiFetch.mockResolvedValueOnce([]);
    render(<BoothQueuePage />);
    expect(await screen.findByText('ยังไม่มีกรณีศึกษาจากบูธ / No booth case studies yet.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a non-array body is an error with a Retry, never an empty queue', async () => {
    mockApiFetch.mockResolvedValueOnce({ error: 'Requires role: auditor', httpStatus: 403 }).mockResolvedValueOnce([item('a', 'หญิงอายุ 30 ปี', false)]);
    render(<BoothQueuePage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the case studies.');
    expect(screen.queryByText(/No booth case studies yet/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'ลองใหม่ / Retry' }));
    expect(await screen.findByRole('link', { name: /หญิงอายุ 30 ปี/ })).toBeInTheDocument();
  });
});
