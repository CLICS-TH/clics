'use client';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';

interface Props { data: { label: string; composite_score: number }[]; }
export function LpdpChart({ data }: Props) {
  return (
    <div className="border rounded-xl p-5">
      <h2 className="font-semibold mb-3">Longitudinal Professional Development Profile</h2>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={data}>
          <CartesianGrid stroke="#e6dfd8" />
          <XAxis dataKey="label" tick={{ fill: '#6c6a64', fontSize: 11 }} />
          <YAxis domain={[0,100]} label={{ value:'Score/100', angle:-90, position:'insideLeft' }} tick={{ fill: '#6c6a64', fontSize: 11 }} />
          <Tooltip />
          <ReferenceLine y={75} stroke="#e8a55a" strokeDasharray="4 4" label="เป้าหมาย" />
          <Line type="monotone" dataKey="composite_score" stroke="#cc785c" strokeWidth={2} dot={{ r:4 }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
