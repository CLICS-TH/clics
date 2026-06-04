'use client';
import { ScatterChart, Scatter, XAxis, YAxis, ReferenceLine, Tooltip, ResponsiveContainer } from 'recharts';

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
      <p className="text-xs text-slate-500 mb-3">Mean diff: {meanDiff.toFixed(2)} · LoA: ±{loa.toFixed(2)}</p>
      <ResponsiveContainer width="100%" height={220}>
        <ScatterChart>
          <XAxis dataKey="mean" name="Mean" label={{ value:'Mean score', position:'insideBottom', offset:-2 }} />
          <YAxis dataKey="diff" name="AI − Human" label={{ value:'AI − Human', angle:-90, position:'insideLeft' }} />
          <Tooltip />
          <ReferenceLine y={meanDiff} stroke="#3b82f6" strokeDasharray="4 4" />
          <ReferenceLine y={meanDiff + loa} stroke="#ef4444" strokeDasharray="3 3" />
          <ReferenceLine y={meanDiff - loa} stroke="#ef4444" strokeDasharray="3 3" />
          <Scatter data={data} fill="#2563eb" opacity={0.7} />
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}
