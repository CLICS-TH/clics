'use client';
import { ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, ReferenceLine, Tooltip, ResponsiveContainer } from 'recharts';

interface Props { pairs: { ai: number; human: number }[]; }

export function BlandAltmanPlot({ pairs }: Props) {
  const data = pairs.map(p => ({ mean: (p.ai + p.human) / 2, diff: p.ai - p.human }));
  const diffs = data.map(d => d.diff);
  const meanDiff = diffs.reduce((a,b) => a+b, 0) / (diffs.length || 1);
  const sd = Math.sqrt(diffs.reduce((a,b) => a+(b-meanDiff)**2, 0) / (diffs.length || 1));
  const loa = sd * 1.96;
  return (
    <div className="border rounded-xl p-5">
      <h2 className="font-semibold mb-1">Bland-Altman Plot</h2>
      <p className="text-xs text-muted-foreground mb-3">Mean diff: {meanDiff.toFixed(2)} · LoA: ±{loa.toFixed(2)}</p>
      <ResponsiveContainer width="100%" height={220}>
        <ScatterChart>
          <CartesianGrid stroke="#e6dfd8" />
          <XAxis dataKey="mean" name="Mean" label={{ value:'Mean score', position:'insideBottom', offset:-2 }} tick={{ fill: '#6c6a64', fontSize: 11 }} />
          <YAxis dataKey="diff" name="AI − Human" label={{ value:'AI − Human', angle:-90, position:'insideLeft' }} tick={{ fill: '#6c6a64', fontSize: 11 }} />
          <Tooltip />
          <ReferenceLine y={meanDiff} stroke="#5db8a6" strokeDasharray="4 4" />
          <ReferenceLine y={meanDiff + loa} stroke="#c64545" strokeDasharray="3 3" />
          <ReferenceLine y={meanDiff - loa} stroke="#c64545" strokeDasharray="3 3" />
          <Scatter data={data} fill="#cc785c" opacity={0.7} />
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}
