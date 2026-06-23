'use client';
// PIS-7 comparison radar: the auditor's 7 domain scores (0–5) overlaid on the AI's, so a rater can
// see at a glance where they diverge. Used per-CLE (this session's scores) and on the auditor home
// (means across all scored CLEs). Data already arrives from GET /auditor/cles/:id and /calibration —
// this is pure presentation. recharts sets SVG fill/stroke ATTRIBUTES (CSS var() doesn't resolve
// there), so the series colours come from the hex CHART palette; the grid/ticks ride `currentColor`.
import { Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Legend, Tooltip, ResponsiveContainer } from 'recharts';
import { CHART } from '@/lib/chart-colors';
import { PIS7_RUBRIC } from '@/lib/pis7-rubric';
import { DOMAIN_LABELS } from '@/lib/labels';

// Loose: callers pass the AI evaluation object (which also carries composite_score/domain_rationale)
// or a plain d1–d7 means map. We only read the seven numeric domain keys and coerce.
type ScoreMap = Record<string, unknown> | null | undefined;
const v = (m: ScoreMap, k: string) => Number(m?.[k] ?? 0);

type Row = { domain: string; full: string; th: string; you: number; ai: number };

function ChartTooltip({ active, payload }: { active?: boolean; payload?: { payload: Row }[] }) {
  if (!active || !payload?.length) return null;
  const r = payload[0].payload;
  return (
    <div className="rounded-md border bg-background px-3 py-2 text-xs shadow-sm">
      <p className="font-medium">{r.th}</p>
      <p className="text-muted-foreground">{r.full}</p>
      <p className="mt-1 tabular-nums">คุณ / You: {r.you.toFixed(1)} · AI: {r.ai.toFixed(1)}</p>
    </div>
  );
}

export function Pis7Radar({ ai, human }: { ai: ScoreMap; human: ScoreMap }) {
  const data: Row[] = PIS7_RUBRIC.map((d, i) => ({
    domain: DOMAIN_LABELS[i],
    full: d.en,
    th: d.th,
    you: v(human, d.key),
    ai: v(ai, d.key),
  }));
  return (
    // text-muted-foreground drives currentColor for the grid/axes so they track light/dark mode.
    <div className="text-muted-foreground">
      <ResponsiveContainer width="100%" height={400}>
        <RadarChart data={data} outerRadius="78%" margin={{ top: 24, right: 36, bottom: 16, left: 36 }}>
          <PolarGrid stroke="currentColor" strokeOpacity={0.2} />
          <PolarAngleAxis dataKey="domain" tick={{ fill: 'currentColor', fontSize: 12 }} />
          <PolarRadiusAxis domain={[0, 5]} tickCount={6} angle={90} tick={{ fill: 'currentColor', fontSize: 10 }} />
          <Radar name="AI" dataKey="ai" stroke={CHART.ai} fill={CHART.ai} fillOpacity={0.25} strokeWidth={2} />
          <Radar name="คุณ / You" dataKey="you" stroke={CHART.human} fill={CHART.human} fillOpacity={0.25} strokeWidth={2} />
          <Tooltip content={<ChartTooltip />} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
        </RadarChart>
      </ResponsiveContainer>
    </div>
  );
}
