// AuditorChatBox: IME-safe Enter, scroll that respects reduced motion and a reader who scrolled up,
// and a discuss call that has a generous timeout and never re-sends on its own.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mockApi = jest.fn();
jest.mock('@/lib/api', () => ({ apiFetch: (...a: unknown[]) => mockApi(...a), REQUEST_TIMEOUT_CODE: 'timeout' }));
jest.mock('@/components/Markdown', () => ({ Markdown: ({ children }: { children: string }) => <div>{children}</div> }));
jest.mock('@/components/AuditorUsageBar', () => ({ AuditorUsageBar: () => null }));

import { AuditorChatBox, DISCUSS_TIMEOUT_MS } from '@/components/AuditorChatBox';

const box = () => screen.getByLabelText(/คำถามถึง AI/) as HTMLTextAreaElement;
const discussCalls = () => mockApi.mock.calls.filter(([p]) => /\/discuss$/.test(p));

beforeEach(() => {
  mockApi.mockReset();
  mockApi.mockImplementation((path: string) =>
    Promise.resolve(/\/discussion$/.test(path) ? [] : { content: 'ตอบแล้ว' }));
  // jsdom has no layout and no Element.scrollTo
  Element.prototype.scrollTo = jest.fn() as unknown as typeof Element.prototype.scrollTo;
});

async function renderBox() {
  render(<AuditorChatBox pleId="p1" />);
  await act(async () => {});
}
function type(text: string) { fireEvent.change(box(), { target: { value: text } }); }

describe('Enter and IME composition', () => {
  it('plain Enter sends', async () => {
    await renderBox();
    type('ทำไม');
    await act(async () => { fireEvent.keyDown(box(), { key: 'Enter' }); });
    expect(discussCalls()).toHaveLength(1);
  });

  it('Enter that confirms an IME candidate (isComposing) does NOT send', async () => {
    await renderBox();
    type('สวัสดี');
    // React's synthetic onKeyDown reads isComposing from the native event.
    await act(async () => { fireEvent.keyDown(box(), { key: 'Enter', isComposing: true }); });
    expect(discussCalls()).toHaveLength(0);
    expect(box().value).toBe('สวัสดี');
  });

  it('keyCode 229 (browsers that fire keydown after composition ends) does NOT send', async () => {
    await renderBox();
    type('สวัสดี');
    await act(async () => { fireEvent.keyDown(box(), { key: 'Enter', keyCode: 229 }); });
    expect(discussCalls()).toHaveLength(0);
  });

  it('Shift+Enter is a newline, not a send', async () => {
    await renderBox();
    type('a');
    await act(async () => { fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true }); });
    expect(discussCalls()).toHaveLength(0);
  });
});

describe('scrolling', () => {
  const list = () => document.querySelector('.overflow-y-auto') as HTMLElement;
  const setGeometry = (el: HTMLElement, scrollHeight: number, scrollTop: number, clientHeight: number) => {
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight });
    Object.defineProperty(el, 'scrollTop', { configurable: true, value: scrollTop });
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight });
  };
  const mq = (reduce: boolean) => {
    Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true,
      value: (q: string) => ({ matches: reduce && /reduce/.test(q), media: q }) });
  };
  const scrollTo = () => Element.prototype.scrollTo as unknown as jest.Mock;

  it('scrolls the list (not the page) and smooths it by default', async () => {
    mq(false);
    await renderBox();
    scrollTo().mockClear();
    type('q');
    await act(async () => { fireEvent.keyDown(box(), { key: 'Enter' }); });
    expect(scrollTo()).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'smooth' }));
  });

  it('prefers-reduced-motion: no smooth scrolling', async () => {
    mq(true);
    await renderBox();
    scrollTo().mockClear();
    type('q');
    await act(async () => { fireEvent.keyDown(box(), { key: 'Enter' }); });
    expect(scrollTo()).toHaveBeenCalled();
    expect(scrollTo().mock.calls.every(([o]) => o.behavior === 'auto')).toBe(true);
  });

  it('a throwing matchMedia falls back to a plain jump', async () => {
    Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: () => { throw new Error('x'); } });
    await renderBox();
    scrollTo().mockClear();
    type('q');
    await act(async () => { fireEvent.keyDown(box(), { key: 'Enter' }); });
    expect(scrollTo().mock.calls.every(([o]) => o.behavior === 'auto')).toBe(true);
  });

  it('does not yank a reader who scrolled up when the AI answers', async () => {
    mq(false);
    let release!: (v: unknown) => void;
    mockApi.mockImplementation((path: string) =>
      /\/discussion$/.test(path) ? Promise.resolve([]) : new Promise((r) => { release = r; }));
    await renderBox();
    type('q');
    await act(async () => { fireEvent.keyDown(box(), { key: 'Enter' }); });   // own message: follows
    // the reader scrolls up to re-read while the AI is thinking
    setGeometry(list(), 2000, 100, 500);
    fireEvent.scroll(list());
    scrollTo().mockClear();
    await act(async () => { release({ content: 'คำตอบ' }); });
    expect(await screen.findByText('คำตอบ')).toBeInTheDocument();
    expect(scrollTo()).not.toHaveBeenCalled();
  });

  it('follows again once the reader is back near the bottom, and the auditor\'s own send always follows', async () => {
    mq(false);
    await renderBox();
    setGeometry(list(), 2000, 100, 500);
    fireEvent.scroll(list());                       // scrolled up
    setGeometry(list(), 2000, 1450, 500);           // 50px from the bottom
    fireEvent.scroll(list());
    scrollTo().mockClear();
    type('q');
    await act(async () => { fireEvent.keyDown(box(), { key: 'Enter' }); });
    expect(scrollTo()).toHaveBeenCalled();
    // scrolled up again, then sending forces the view back down
    setGeometry(list(), 3000, 0, 500);
    fireEvent.scroll(list());
    scrollTo().mockClear();
    type('another');
    await act(async () => { fireEvent.keyDown(box(), { key: 'Enter' }); });
    expect(scrollTo()).toHaveBeenCalled();
  });

  it('tolerates a browser without Element.scrollTo', async () => {
    (Element.prototype as { scrollTo?: unknown }).scrollTo = undefined;
    mq(false);
    await renderBox();
    type('q');
    await expect(act(async () => { fireEvent.keyDown(box(), { key: 'Enter' }); })).resolves.not.toThrow();
  });
});

describe('discuss timeout', () => {
  it('passes a generous timeout: longer than the backend\'s ~100s ceiling', async () => {
    await renderBox();
    type('q');
    await act(async () => { fireEvent.keyDown(box(), { key: 'Enter' }); });
    const [, opts] = discussCalls()[0];
    expect(opts.timeoutMs).toBe(DISCUSS_TIMEOUT_MS);
    expect(DISCUSS_TIMEOUT_MS).toBeGreaterThan(100_000);
  });

  it('a timeout shows an alert that says the question may be saved, keeps the text, and never re-sends', async () => {
    mockApi.mockImplementation((path: string) =>
      Promise.resolve(/\/discussion$/.test(path) ? [] : { error: 'timed out', code: 'timeout' }));
    await renderBox();
    type('คำถามของฉัน');
    await act(async () => { fireEvent.keyDown(box(), { key: 'Enter' }); });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('อาจถูกบันทึกไว้แล้ว');
    expect(alert).toHaveTextContent(/reload the page/i);
    expect(box().value).toBe('คำถามของฉัน');          // nothing lost
    expect(discussCalls()).toHaveLength(1);           // and nothing re-sent on its own
    await new Promise((r) => setTimeout(r, 50));
    expect(discussCalls()).toHaveLength(1);
    expect(screen.queryByText('กำลังคิด… / Thinking…')).toBeNull();   // not stuck "sending"
  });

  it('other failures keep the plain retry message; budget keeps its own', async () => {
    mockApi.mockImplementation((path: string) =>
      Promise.resolve(/\/discussion$/.test(path) ? [] : { error: 'x' }));
    await renderBox();
    type('q');
    await act(async () => { fireEvent.keyDown(box(), { key: 'Enter' }); });
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not send');
    mockApi.mockImplementation((path: string) =>
      Promise.resolve(/\/discussion$/.test(path) ? [] : { error: 'x', code: 'budget_exceeded' }));
    await act(async () => { fireEvent.keyDown(box(), { key: 'Enter' }); });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('AI allowance used up'));
  });

  it('a thrown request is reported as a plain send failure', async () => {
    mockApi.mockImplementation((path: string) =>
      /\/discussion$/.test(path) ? Promise.resolve([]) : Promise.reject(new Error('boom')));
    await renderBox();
    type('q');
    await act(async () => { fireEvent.keyDown(box(), { key: 'Enter' }); });
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not send');
  });
});
