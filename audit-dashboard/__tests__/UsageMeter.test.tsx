// UsageMeter shows one pool's spend or tokens against the ceiling that applies. The cases that matter
// are the ones a glance gets wrong: an UNCAPPED token pool must not draw a bar (a bar needs a scale,
// and there is none), a $0 limit on the $ meter must keep meaning "$0 cap", and admins — who cannot
// read the org ceilings — must see the used figure and nothing that pretends to be a limit.
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { UsageMeter } from '@/components/UsageMeter';

describe('UsageMeter — tokens', () => {
  it('formats used / limit in k and sizes the bar to the share used', () => {
    render(<UsageMeter unit="tokens" used={184_321} limit={300_000} />);
    expect(screen.getByText('184k / 300k')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '61');
  });

  it('shows used only and NO bar when the pool is uncapped (limit 0)', () => {
    render(<UsageMeter unit="tokens" used={184_321} limit={0} />);
    expect(screen.getByText(/^184k · ไม่จำกัด \/ no cap$/)).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('keeps small counts as plain numbers rather than "0k"', () => {
    render(<UsageMeter unit="tokens" used={640} limit={0} />);
    expect(screen.getByText(/^640 · ไม่จำกัด/)).toBeInTheDocument();
  });

  it('marks a per-user override with * and an exhausted pool in the danger tone', () => {
    render(<UsageMeter unit="tokens" used={300_000} limit={300_000} hasOverride />);
    const line = screen.getByText('300k / 300k *');
    expect(line).toHaveClass('text-danger');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  });

  it('caps the bar at 100% when usage has overshot the ceiling', () => {
    render(<UsageMeter unit="tokens" used={450_000} limit={300_000} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  });
});

describe('UsageMeter — dollars (the original meter, unchanged)', () => {
  it('formats $used to 4 places and $limit to 2', () => {
    render(<UsageMeter used={0.1234} limit={0.5} />);
    expect(screen.getByText('$0.1234 / $0.50')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25');
  });

  it('a $0 limit is a $0 cap, not "no cap" — the bar stays, empty', () => {
    render(<UsageMeter used={0} limit={0} />);
    expect(screen.getByText('$0.0000 / $0.00')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  });

  it('prefixes the pool label when two pools share a cell', () => {
    render(<UsageMeter used={0.01} limit={0.5} label="ผู้ใช้/User" />);
    expect(screen.getByText('ผู้ใช้/User')).toBeInTheDocument();
  });
});

describe('UsageMeter — admins (showLimit=false)', () => {
  it('shows the used figure alone, no limit and no bar, for either unit', () => {
    const { rerender } = render(<UsageMeter used={0.1234} limit={0.5} showLimit={false} />);
    expect(screen.getByText('$0.1234')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    rerender(<UsageMeter unit="tokens" used={184_321} limit={300_000} showLimit={false} />);
    expect(screen.getByText('184k')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });
});
