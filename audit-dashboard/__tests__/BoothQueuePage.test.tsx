import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { BoothQueueItem } from '@/lib/types';

const mockApiFetchPaged = jest.fn();
jest.mock('@/lib/api', () => ({ apiFetchPaged: (...a: unknown[]) => mockApiFetchPaged(...a) }));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a>,
}));

import BoothQueuePage from '@/app/auditor/booth/page';

const item = (id: string, th: string, audited: boolean): BoothQueueItem => ({
  id, played_on: '2026-11-20', audited,
  case: { case_id: `case-${id}`, teaser: { th, en: `${th} (en)` } },
});
const served = (items: BoothQueueItem[], total = items.length) => ({ items, total });

beforeEach(() => mockApiFetchPaged.mockReset());

describe('booth case-study queue', () => {
  it('lists the first page in the order served, each linking to its study, with the audited badge and the count', async () => {
    mockApiFetchPaged.mockResolvedValueOnce(served([item('b', 'ชายอายุ 58 ปี', false), item('a', 'หญิงอายุ 30 ปี', true)]));
    render(<BoothQueuePage />);
    const newest = await screen.findByRole('link', { name: /ชายอายุ 58 ปี/ });
    expect(mockApiFetchPaged).toHaveBeenCalledWith('/auditor/booth?page=1');
    const rows = screen.getAllByRole('listitem');
    expect(rows.map((r) => r.querySelector('a')?.getAttribute('href'))).toEqual(['/auditor/booth/b', '/auditor/booth/a']);
    expect(newest).toHaveTextContent('รอประเมิน / To score');
    expect(screen.getByRole('link', { name: /หญิงอายุ 30 ปี/ })).toHaveTextContent('ให้คะแนนแล้ว / Scored');
    expect(screen.getByText('2 การเล่น / plays')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'หน้า / Pages' })).not.toBeInTheDocument();
    expect(screen.getByText(/not counted in the pilot/)).toBeInTheDocument();
  });

  it('pages through every play with Previous and Next, showing the total', async () => {
    mockApiFetchPaged
      .mockResolvedValueOnce(served([item('p1', 'หน้าแรก', false)], 120))
      .mockResolvedValueOnce(served([item('p2', 'หน้าสอง', false)], 120))
      .mockResolvedValueOnce(served([item('p3', 'หน้าสาม', true)], 120))
      .mockResolvedValueOnce(served([item('p2', 'หน้าสอง', false)], 120));
    render(<BoothQueuePage />);
    await screen.findByRole('link', { name: /หน้าแรก/ });
    expect(screen.getByText('120 การเล่น / plays · หน้า 1 จาก 3 / page 1 of 3')).toBeInTheDocument();
    const previous = () => screen.getByRole('button', { name: 'หน้าที่แล้ว / Previous page' });
    const next = () => screen.getByRole('button', { name: 'หน้าถัดไป / Next page' });
    expect(screen.getByText('หน้า 1 จาก 3 / Page 1 of 3')).toBeInTheDocument();
    expect(previous()).toBeDisabled();

    next().focus();
    fireEvent.click(next());
    await screen.findByRole('link', { name: /หน้าสอง/ });
    expect(document.activeElement).toHaveTextContent('120 การเล่น / plays · หน้า 2 จาก 3 / page 2 of 3');
    fireEvent.click(next());
    await screen.findByRole('link', { name: /หน้าสาม/ });
    expect(screen.getByText('หน้า 3 จาก 3 / Page 3 of 3')).toBeInTheDocument();
    expect(next()).toBeDisabled();
    fireEvent.click(previous());
    await screen.findByRole('link', { name: /หน้าสอง/ });
    expect(mockApiFetchPaged.mock.calls.map(([path]) => path)).toEqual(
      ['/auditor/booth?page=1', '/auditor/booth?page=2', '/auditor/booth?page=3', '/auditor/booth?page=2']);
  });

  it('says so when there is nothing to study', async () => {
    mockApiFetchPaged.mockResolvedValueOnce(served([]));
    render(<BoothQueuePage />);
    expect(await screen.findByText('ยังไม่มีกรณีศึกษาจากบูธ / No booth case studies yet.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a failed load is an error with a Retry, never an empty queue', async () => {
    mockApiFetchPaged.mockResolvedValueOnce({ items: [], total: 0, failed: true })
      .mockResolvedValueOnce(served([item('a', 'หญิงอายุ 30 ปี', false)]));
    render(<BoothQueuePage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the case studies.');
    expect(screen.queryByText(/No booth case studies yet/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'ลองใหม่ / Retry' }));
    expect(await screen.findByRole('link', { name: /หญิงอายุ 30 ปี/ })).toBeInTheDocument();
    expect(mockApiFetchPaged.mock.calls.map(([path]) => path)).toEqual(['/auditor/booth?page=1', '/auditor/booth?page=1']);
  });
});
