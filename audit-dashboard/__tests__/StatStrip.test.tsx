// StatStrip's big figure is text-4xl bold, so it is held to the 3:1 large-text bar. The default tone
// (bright --primary) clears that on the canvas, 3.11:1, but a LINKED card turns --secondary on hover,
// where it is 2.71:1. The figure therefore swaps to --coral-on-tint while hovered. contrast.test.ts
// pins the colours; this pins the wiring that makes the swap happen, which no colour test can see:
// drop `group` from the link, or the group-hover class from the tone, and the hover fails again.
import { render, screen } from '@testing-library/react';
import { StatStrip } from '@/components/StatStrip';

const figure = (text: string) => screen.getByText(text);

describe('StatStrip', () => {
  it('a linked card is the hover group, and its default figure swaps to coral-on-tint while hovered', () => {
    render(<StatStrip stats={[{ value: '12', label: 'All PLEs', href: '/admin/ples' }]} />);
    const link = screen.getByRole('link', { name: /All PLEs/ });
    expect(link).toHaveAttribute('href', '/admin/ples');
    expect(link).toHaveClass('group', 'hover:bg-secondary');
    expect(figure('12')).toHaveClass('text-primary', 'group-hover:text-coral-on-tint');
    // No title given: the bilingual drill-in hint is the default.
    expect(link).toHaveAttribute('title', expect.stringContaining('Click to explore'));
  });

  it('a static card is not a link and never tints', () => {
    const { container } = render(<StatStrip stats={[{ value: '3', label: 'Static', title: 'why' }]} />);
    expect(screen.queryByRole('link')).toBeNull();
    const card = figure('3').parentElement!;
    expect(card).toHaveAttribute('title', 'why');
    expect(card.className).not.toMatch(/hover:bg-/);
    // Default grid when the caller passes no className.
    expect(container.firstChild).toHaveClass('grid', 'grid-cols-2');
  });

  it('the status tones keep their own text tokens and take the caller\'s grid', () => {
    const { container } = render(
      <StatStrip
        className="custom-grid"
        stats={[
          { value: '1', label: 'Scored', tone: 'pass', href: '/auditor/queue', title: 'Scored PLEs' },
          { value: '2', label: 'To score', tone: 'warn', href: '/auditor/queue' },
          { value: '4', label: 'Failed', tone: 'fail' },
        ]}
      />,
    );
    expect(container.firstChild).toHaveClass('custom-grid');
    expect(screen.getByRole('link', { name: /Scored/ })).toHaveAttribute('title', 'Scored PLEs');
    expect(figure('1')).toHaveClass('text-[var(--chart-pass-text)]');
    expect(figure('2')).toHaveClass('text-warn');
    expect(figure('4')).toHaveClass('text-destructive');
    // Only the default tone needs the hover swap; the others clear 3:1 on --secondary as they are.
    for (const t of ['1', '2', '4']) expect(figure(t).className).not.toMatch(/group-hover/);
  });
});
