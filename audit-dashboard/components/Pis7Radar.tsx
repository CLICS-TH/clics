'use client';
// PIS-7 comparison radar: the auditor's 7 domain scores (0–5) overlaid on the AI's, so a rater can
// see at a glance where they diverge. Used per-PLE (this session's scores) and on the auditor home
// (means across all scored PLEs). Data already arrives from GET /auditor/ples/:id and /calibration —
// this is pure presentation. recharts sets SVG fill/stroke ATTRIBUTES (CSS var() doesn't resolve
// there), so the series colours come from the hex CHART palette; the grid/ticks ride `currentColor`.
import { Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Legend, Tooltip, ResponsiveContainer } from 'recharts';
import { useChartColors } from '@/lib/chart-colors';
import { PIS7_RUBRIC } from '@/lib/pis7-rubric';
import { DOMAIN_LABELS } from '@/lib/labels';

// Loose: callers pass the AI evaluation object (which also carries composite_score/domain_rationale)
// or a plain d1–d7 means map. We only read the seven numeric domain keys and coerce.
type ScoreMap = Record<string, unknown> | null | undefined;
const v = (m: ScoreMap, k: string) => Number(m?.[k] ?? 0);

type Row = { domain: string; full: string; th: string; you: number; cmp: number };

function ChartTooltip({ active, payload, cmpName }: { active?: boolean; payload?: { payload: Row }[]; cmpName: string }) {
  if (!active || !payload?.length) return null;
  const r = payload[0].payload;
  return (
    <div className="rounded-md border bg-background px-3 py-2 text-xs shadow-sm">
      <p className="font-medium">{r.th}</p>
      <p className="text-muted-foreground">{r.full}</p>
      <p className="mt-1 tabular-nums">คุณ / You: {r.you.toFixed(1)} · {cmpName}: {r.cmp.toFixed(1)}</p>
    </div>
  );
}

// Legend label in the body colour (the <Legend> below says why); its own span overrides the series
// colour recharts sets on the wrapper.
export const legendLabel = (value: string) => <span className="text-foreground">{value}</span>;

type Comparison = { ai?: ScoreMap; peer?: ScoreMap; label?: string };
const isPeerSeries = ({ ai, peer }: Comparison) => ai == null && peer != null;

export function comparisonName(c: Comparison): string {
  return c.label ?? (isPeerSeries(c) ? 'ค่าเฉลี่ย / Avg' : 'AI');
}

// Two-series PIS-7 radar: the auditor's own scores ("You", coral) overlaid on a comparison series —
// either the AI (slate-blue, pass `ai`) or the auditor-cohort average (violet, pass `peer`). The same
// component powers both the vs-AI and vs-peer cards so they read identically.
export function Pis7Radar({ ai, peer, human, label }: Comparison & { human: ScoreMap }) {
  const CHART = useChartColors();
  const isPeer = isPeerSeries({ ai, peer });
  const cmpMap = isPeer ? peer : ai;
  const cmpName = comparisonName({ ai, peer, label });
  const cmpColor = isPeer ? CHART.peer : CHART.ai;
  const data: Row[] = PIS7_RUBRIC.map((d, i) => ({
    domain: DOMAIN_LABELS[i],
    full: d.en,
    th: d.th,
    you: v(human, d.key),
    cmp: v(cmpMap, d.key),
  }));
  return (
    // text-muted-foreground drives currentColor for the grid/axes so they track light/dark mode.
    <div className="text-muted-foreground">
      <ResponsiveContainer width="100%" height={400}>
        {/* Generous horizontal margin + a pulled-back outerRadius so the side labels (ALPS/RS/CI/RD)
            never clip on a narrow, width-constrained mobile column (real-device fonts run wider than
            headless Chromium). PolarAngleAxis labels render just outside outerRadius. */}
        <RadarChart data={data} outerRadius="70%" margin={{ top: 28, right: 52, bottom: 24, left: 52 }}>
          <PolarGrid stroke="currentColor" strokeOpacity={0.2} />
          <PolarAngleAxis dataKey="domain" tick={{ fill: 'currentColor', fontSize: 12 }} />
          <PolarRadiusAxis domain={[0, 5]} tickCount={6} angle={90} tick={{ fill: 'currentColor', fontSize: 12 }} />
          <Radar name={cmpName} dataKey="cmp" stroke={cmpColor} fill={cmpColor} fillOpacity={0.25} strokeWidth={2} />
          <Radar name="คุณ / You" dataKey="you" stroke={CHART.human} fill={CHART.human} fillOpacity={0.25} strokeWidth={2} />
          <Tooltip content={<ChartTooltip cmpName={cmpName} />} />
          {/* The swatch carries the series colour; the label is body text. recharts paints legend
              text in the series colour, a MARK colour (3:1 bar), not a text one: coral, slate-blue
              and violet measured 2.71–4.48:1 as 12px text on the page, the card and --secondary. */}
          <Legend wrapperStyle={{ fontSize: 12 }} formatter={legendLabel} />
        </RadarChart>
      </ResponsiveContainer>
    </div>
  );
}
