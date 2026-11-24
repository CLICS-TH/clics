// components/ui/switch.tsx: the one on/off control (Settings rules, Booth Mode). What a screen reader and a
// keyboard get from it, and the two "not now" states: `busy` (a save is running: still focusable, presses
// ignored) and `disabled` (nothing loaded to switch). Its look is measured by Playwright; jsdom has no layout.
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { Switch } from '@/components/ui/switch';

const onChange = jest.fn();
beforeEach(() => onChange.mockReset());

describe('Switch', () => {
  it('is a native button announced as a switch, with its state in aria-checked', () => {
    const { rerender } = render(<Switch checked={false} onCheckedChange={onChange} aria-label="Pilot test mode" />);
    const sw = screen.getByRole('switch', { name: 'Pilot test mode' });
    // A native <button type="button">: Space and Enter press it, and it never submits a surrounding form.
    expect(sw.tagName).toBe('BUTTON');
    expect(sw).toHaveAttribute('type', 'button');
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(sw).toHaveAttribute('data-state', 'off');
    rerender(<Switch checked onCheckedChange={onChange} aria-label="Pilot test mode" />);
    expect(sw).toHaveAttribute('aria-checked', 'true');
    expect(sw).toHaveAttribute('data-state', 'on');
  });

  it('a press asks for the opposite state and leaves the state to the caller', () => {
    const { rerender } = render(<Switch checked={false} onCheckedChange={onChange} aria-label="s" />);
    const sw = screen.getByRole('switch');
    fireEvent.click(sw);
    expect(onChange).toHaveBeenLastCalledWith(true);
    // Controlled: nothing changes until the caller passes the new value.
    expect(sw).toHaveAttribute('aria-checked', 'false');
    rerender(<Switch checked onCheckedChange={onChange} aria-label="s" />);
    fireEvent.click(sw);
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it('busy: stays enabled and focused, says so with aria-disabled, and ignores presses', () => {
    render(<Switch checked={false} busy onCheckedChange={onChange} aria-label="s" />);
    const sw = screen.getByRole('switch');
    sw.focus();
    expect(sw).toBeEnabled();
    expect(sw).toHaveFocus();
    expect(sw).toHaveAttribute('aria-disabled', 'true');
    // The dimming skips the keyboard-focused switch, or its focus ring would fade with it.
    expect(sw).toHaveClass('aria-disabled:opacity-50', 'aria-disabled:focus-visible:opacity-100');
    fireEvent.click(sw);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('not busy: no aria-disabled at all (not "false")', () => {
    render(<Switch checked={false} onCheckedChange={onChange} aria-label="s" />);
    expect(screen.getByRole('switch')).not.toHaveAttribute('aria-disabled');
  });

  it('disabled: really disabled, so it takes no focus and no press', () => {
    render(<Switch checked={false} disabled onCheckedChange={onChange} aria-label="s" />);
    const sw = screen.getByRole('switch');
    expect(sw).toBeDisabled();
    fireEvent.click(sw);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('the hit area is 44px tall around a 28px track, and the focus ring is drawn on the track', () => {
    render(<Switch checked onCheckedChange={onChange} aria-label="s" className="-my-2.5" />);
    const sw = screen.getByRole('switch');
    expect(sw).toHaveClass('h-11', 'w-14', 'outline-none', '-my-2.5');
    const track = sw.firstElementChild!;
    expect(track).toHaveAttribute('aria-hidden', 'true');
    expect(track).toHaveClass('h-7', 'w-12', 'group-focus-visible/switch:outline-ring', 'bg-primary');
    expect(track.firstElementChild).toHaveClass('bg-primary-foreground');
  });

  it('passes labelling and description through', () => {
    render(
      <>
        <p id="t">Hold result until audited</p>
        <p id="d">Physicians see no score until an auditor has scored.</p>
        <Switch checked={false} onCheckedChange={onChange} aria-labelledby="t" aria-describedby="d" />
      </>,
    );
    expect(screen.getByRole('switch', { name: 'Hold result until audited' }))
      .toHaveAccessibleDescription('Physicians see no score until an auditor has scored.');
  });
});
