// First tests for Overlays (toast + confirmDialog). The confirm dialog is the one place a stray
// keypress can destroy something, so the keyboard contract is pinned here:
//   - focus starts on Cancel, is trapped, and returns to the opener
//   - Enter never confirms while Cancel is focused, and never confirms a DANGER dialog unless OK is
//     the focused control (a jsdom keydown does not synthesise the browser's button click, so "not
//     intercepted" is asserted as: the handler left the event alone and nothing resolved)
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Overlays, confirmDialog, toast } from '@/components/Overlays';

type Opts = Parameters<typeof confirmDialog>[0];

// Open a confirm and report how (and whether) it settled.
function open(opts: Opts = {}) {
  const result: { value: boolean | null } = { value: null };
  let p!: Promise<boolean>;
  act(() => { p = confirmDialog(opts); });
  void p.then((v) => { result.value = v; });
  return result;
}
const settle = () => act(async () => { await Promise.resolve(); });

const dialog = () => screen.getByRole('dialog');
const cancelBtn = () => screen.getByRole('button', { name: /ยกเลิก|Cancel/ });
const okBtn = () => screen.getByRole('button', { name: /ยืนยัน|Confirm|ลบ/ });

// Overlays keeps its queue in module state. RTL unmounts BEFORE a file-level afterEach runs, so a test
// that leaves a confirm open would leak it into the next one — drain it with a throwaway mount first.
beforeEach(async () => {
  const { unmount } = render(<Overlays />);
  while (screen.queryByRole('dialog')) {
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await settle();
  }
  unmount();
});

describe('confirmDialog — semantics', () => {
  it('is a modal dialog named by its title and described by its body', () => {
    render(<Overlays />);
    open({ title: 'ลบรายการ? / Delete?', body: 'จะลบถาวร / Permanent.' });
    const d = dialog();
    expect(d).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('dialog', { name: 'ลบรายการ? / Delete?' })).toBe(d);
    expect(d).toHaveAccessibleDescription('จะลบถาวร / Permanent.');
  });

  it('still has an accessible name when no title is given', () => {
    render(<Overlays />);
    open({ body: 'x' });
    expect(screen.getByRole('dialog', { name: 'ยืนยัน / Confirm' })).toBeInTheDocument();
  });

  it('uses the custom labels', () => {
    render(<Overlays />);
    open({ title: 't', confirmLabel: 'ลบ / Delete', cancelLabel: 'เก็บไว้ / Keep' });
    expect(screen.getByRole('button', { name: 'ลบ / Delete' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'เก็บไว้ / Keep' })).toBeInTheDocument();
  });
});

describe('confirmDialog — focus', () => {
  it('starts on Cancel, not on the action', () => {
    render(<Overlays />);
    open({ title: 't', danger: true });
    expect(cancelBtn()).toHaveFocus();
  });

  it('traps Tab and Shift+Tab inside the dialog', () => {
    render(<Overlays />);
    open({ title: 't' });
    okBtn().focus();
    fireEvent.keyDown(okBtn(), { key: 'Tab' });                    // last -> wraps to first
    expect(cancelBtn()).toHaveFocus();
    fireEvent.keyDown(cancelBtn(), { key: 'Tab', shiftKey: true }); // first -> wraps to last
    expect(okBtn()).toHaveFocus();
  });

  it('pulls focus back in if it has strayed outside the dialog', () => {
    render(<><button>outside</button><Overlays /></>);
    open({ title: 't' });
    screen.getByText('outside').focus();
    fireEvent.keyDown(document.body, { key: 'Tab' });
    expect(cancelBtn()).toHaveFocus();
  });

  it('lets Tab move normally between the two buttons', () => {
    render(<Overlays />);
    open({ title: 't' });
    // Cancel -> OK is not a wrap, so the handler must not interfere.
    expect(fireEvent.keyDown(cancelBtn(), { key: 'Tab' })).toBe(true);
  });

  it('returns focus to the control that opened it, on Escape', async () => {
    render(<><button>opener</button><Overlays /></>);
    const opener = screen.getByText('opener');
    opener.focus();
    open({ title: 't' });
    expect(cancelBtn()).toHaveFocus();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
  });
});

describe('confirmDialog — Enter', () => {
  it('does not hijack Enter while Cancel is focused (the browser cancels, not confirms)', async () => {
    render(<Overlays />);
    const r = open({ title: 't' });
    expect(cancelBtn()).toHaveFocus();
    const notPrevented = fireEvent.keyDown(cancelBtn(), { key: 'Enter' });
    await settle();
    expect(notPrevented).toBe(true);        // left alone for native button activation
    expect(r.value).toBeNull();             // and, crucially, nothing confirmed
  });

  it('does not hijack Enter while OK is focused either — OK confirms via its own click', async () => {
    render(<Overlays />);
    const r = open({ title: 't', danger: true });
    okBtn().focus();
    expect(fireEvent.keyDown(okBtn(), { key: 'Enter' })).toBe(true);
    expect(r.value).toBeNull();
    fireEvent.click(okBtn());               // what the browser does for Enter on a button
    await settle();
    expect(r.value).toBe(true);
  });

  it('does NOT confirm a danger dialog on Enter when focus is on the dialog itself', async () => {
    render(<Overlays />);
    const r = open({ title: 't', danger: true });
    dialog().focus();
    expect(fireEvent.keyDown(dialog(), { key: 'Enter' })).toBe(false); // swallowed
    await settle();
    expect(r.value).toBeNull();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('confirms a NON-danger dialog on Enter when focus is on the dialog itself', async () => {
    render(<Overlays />);
    const r = open({ title: 't' });
    dialog().focus();
    fireEvent.keyDown(dialog(), { key: 'Enter' });
    await settle();
    expect(r.value).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('leaves Enter alone inside a text field in the body', () => {
    render(<Overlays />);
    open({ title: 't', body: <input aria-label="reason" /> });
    const input = screen.getByLabelText('reason');
    input.focus();
    expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(true);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('ignores unrelated keys', () => {
    render(<Overlays />);
    const r = open({ title: 't' });
    fireEvent.keyDown(cancelBtn(), { key: 'a' });
    expect(r.value).toBeNull();
  });
});

describe('confirmDialog — resolving', () => {
  it('Escape resolves false', async () => {
    render(<Overlays />);
    const r = open({ title: 't' });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await settle();
    expect(r.value).toBe(false);
  });

  it('Cancel resolves false and OK resolves true', async () => {
    render(<Overlays />);
    const a = open({ title: 'a' });
    fireEvent.click(cancelBtn());
    await settle();
    expect(a.value).toBe(false);
    const b = open({ title: 'b' });
    fireEvent.click(okBtn());
    await settle();
    expect(b.value).toBe(true);
  });

  it('a click on the backdrop cancels; a click inside the panel does not', async () => {
    render(<Overlays />);
    const r = open({ title: 't' });
    fireEvent.click(dialog());
    expect(r.value).toBeNull();
    fireEvent.click(dialog().parentElement!);
    await settle();
    expect(r.value).toBe(false);
  });

  it('stacked confirms show the newest on top and resolve independently', async () => {
    render(<Overlays />);
    const first = open({ title: 'first' });
    const second = open({ title: 'second' });
    expect(screen.getByRole('dialog', { name: 'second' })).toBeInTheDocument();
    fireEvent.click(cancelBtn());
    await settle();
    expect(second.value).toBe(false);
    expect(first.value).toBeNull();
    expect(screen.getByRole('dialog', { name: 'first' })).toBeInTheDocument();
  });
});

describe('toast', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  it('errors are announced as alerts, everything else as status', () => {
    render(<Overlays />);
    act(() => { toast('บันทึกแล้ว', 'success'); toast('ไม่สำเร็จ', 'error'); toast('fyi'); });
    expect(screen.getByRole('alert')).toHaveTextContent('ไม่สำเร็จ');
    expect(screen.getAllByRole('status').map((n) => n.textContent)).toEqual(['บันทึกแล้ว', 'fyi']);
  });

  it('dismisses itself — errors stay longer than the rest', () => {
    render(<Overlays />);
    act(() => { toast('ok', 'success'); toast('bad', 'error'); });
    act(() => { jest.advanceTimersByTime(3100); });
    expect(screen.queryByText('ok')).toBeNull();
    expect(screen.getByText('bad')).toBeInTheDocument();
    act(() => { jest.advanceTimersByTime(1500); });
    expect(screen.queryByText('bad')).toBeNull();
  });
});
