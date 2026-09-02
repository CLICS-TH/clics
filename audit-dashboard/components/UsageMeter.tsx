'use client';
// One AI usage meter: used / effective limit + a thin bar. Two units share one layout so the $ meter
// and the token meter in the same cell read as the same kind of thing:
//   usd    — $0.1234 / $0.50   the cloud-spend ceiling
//   tokens — 184k / 300k       the ceiling that actually throttles the $0-priced on-prem model
//
// For TOKENS a limit of 0 means NO cap (backend/src/lib/usage.js effectiveTokenLimit): the meter then
// shows the used figure alone and draws no bar, because a bar against nothing would have to invent a
// scale. For $ a limit of 0 keeps its old meaning (a $0 cap: the bar is simply empty) — the two
// ceilings are read by different code on the server and are not interchangeable here either.
//
// `showLimit` is false for admins, who cannot read /admin/usage-settings and so get spend-only.
// `hasOverride` marks a per-user ceiling with "*", the same mark the users page has always used.
import { fmtTokensK } from '@/lib/labels';

export type MeterUnit = 'usd' | 'tokens';

export function UsageMeter({
  used, limit, hasOverride = false, label, unit = 'usd', showLimit = true,
}: {
  used: number;
  limit: number;
  hasOverride?: boolean;
  label?: string;
  unit?: MeterUnit;
  showLimit?: boolean;
}) {
  const fmtUsed = unit === 'usd' ? `$${used.toFixed(4)}` : fmtTokensK(used);
  const tag = label
    ? <span className="text-[10px] uppercase tracking-wide text-muted-foreground mr-1">{label}</span>
    : null;
  if (!showLimit) return <p className="text-xs tabular-nums text-muted-foreground">{tag}{fmtUsed}</p>;

  const uncapped = unit === 'tokens' && limit <= 0;
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const over = limit > 0 && used >= limit;
  const tone = over ? 'bg-destructive' : pct >= 80 ? 'bg-[var(--chart-warn)]' : 'bg-[var(--chart-pass)]';
  const fmtLimit = unit === 'usd' ? `$${limit.toFixed(2)}` : fmtTokensK(limit);
  return (
    <div>
      {/* text-danger, not text-destructive: the fill red measures 3.70:1 as small text on the dark
          canvas (see app/globals.css); --danger is the text-safe sibling in both themes. */}
      <p className={`text-xs tabular-nums ${over ? 'text-danger font-medium' : 'text-muted-foreground'}`}>
        {tag}{fmtUsed}
        {uncapped ? ' · ไม่จำกัด / no cap' : ` / ${fmtLimit}`}
        {hasOverride ? ' *' : ''}
      </p>
      {!uncapped && (
        <div
          className="h-1.5 mt-1 rounded-full bg-muted overflow-hidden"
          role="progressbar"
          aria-label={unit === 'usd' ? 'AI spend vs limit' : 'AI tokens vs limit'}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
        >
          <div className={`h-full ${tone}`} style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}
