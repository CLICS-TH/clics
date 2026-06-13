'use client';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { CHART } from '@/lib/chart-colors';

interface Props { data: { label: string; composite_score: number }[]; }
export function LpdpChart({ data }: Props) {
  return (
    <div className="border rounded-xl p-5">
      <h2 className="font-semibold mb-3">Longitudinal Professional Development Profile</h2>
      {/* text-muted-foreground sets `color`, so the chart's currentColor grid/ticks track the theme
          (recharts renders these as SVG attributes where a var() would not resolve). */}
      <div className="text-muted-foreground">
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={data}>
          <CartesianGrid stroke="currentColor" strokeOpacity={0.18} />
          <XAxis dataKey="label" tick={{ fill: 'currentColor', fontSize: 11 }} />
          <YAxis domain={[0,100]} label={{ value:'Score/100', angle:-90, position:'insideLeft' }} tick={{ fill: 'currentColor', fontSize: 11 }} />
          <Tooltip />
          <ReferenceLine y={75} stroke={CHART.threshold} strokeDasharray="4 4" label="เป้าหมาย" />
          <Line type="monotone" dataKey="composite_score" stroke="#cc785c" strokeWidth={2} dot={{ r:4 }} />
        </LineChart>
      </ResponsiveContainer>
      </div>
    </div>
  );
}
