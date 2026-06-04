'use client';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';

interface Props { data: { label: string; composite_score: number }[]; }
export function LpdpChart({ data }: Props) {
  return (
    <div className="border rounded-xl p-5">
      <h2 className="font-semibold mb-3">Longitudinal Professional Development Profile</h2>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={data}>
          <XAxis dataKey="label" />
          <YAxis domain={[0,100]} label={{ value:'Score/100', angle:-90, position:'insideLeft' }} />
          <Tooltip />
          <ReferenceLine y={75} stroke="#f59e0b" strokeDasharray="4 4" label="เป้าหมาย" />
          <Line type="monotone" dataKey="composite_score" stroke="#2563eb" strokeWidth={2} dot={{ r:4 }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
