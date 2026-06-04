'use client';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { NavBar } from '@/components/NavBar';

export default function StatsPage() {
  const [stats, setStats] = useState<any>(null);
  const [icc, setIcc] = useState<any>(null);
  useEffect(() => {
    apiFetch('/admin/stats').then(setStats);
    apiFetch('/admin/icc').then(setIcc);
  }, []);
  if (!stats) return <div className="p-8 text-slate-400">กำลังโหลด...</div>;
  const cards = [
    { label: 'PLEs ทั้งหมด', value: stats.total },
    { label: 'ผ่าน CLE', value: stats.cle_pass ?? 0 },
    { label: 'ประเมินแล้ว', value: stats.evaluated ?? 0 },
    { label: 'รอ QA', value: stats.cle_flag_t2 ?? 0 },
  ];
  return (
    <>
      <NavBar />
      <div className="max-w-4xl mx-auto p-6">
      <h1 className="text-xl font-bold mb-6">สถิติ Pilot Study / Pilot Study Statistics</h1>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        {cards.map(c => (
          <div key={c.label} className="border rounded-xl p-4 text-center">
            <p className="text-3xl font-bold text-blue-600">{c.value}</p>
            <p className="text-xs text-slate-500 mt-1">{c.label}</p>
          </div>
        ))}
      </div>
      {icc?.overall && (
        <div className="border rounded-xl p-5">
          <h2 className="font-semibold mb-2">ICC ปัจจุบัน (AI vs Auditor)</h2>
          <p className="text-3xl font-bold text-blue-600">{icc.overall.icc}</p>
          <p className="text-sm text-slate-500">95% CI: [{icc.overall.lower}, {icc.overall.upper}] · n={icc.overall.n}</p>
          <p className={`text-sm font-medium mt-1 ${icc.overall.icc >= 0.75 ? 'text-green-600' : 'text-red-500'}`}>
            {icc.overall.interpretation}
          </p>
        </div>
      )}
    </div>
    </>
  );
}
