'use client';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { NavBar } from '@/components/NavBar';

const STATUS_MAP: Record<string,string> = {
  active:'กำลังดำเนินการ', ended:'สิ้นสุด', cle_pass:'ผ่าน CLE',
  cle_fail_t1:'ไม่ผ่าน T1', cle_flag_t2:'รอตรวจสอบ', evaluated:'ประเมินแล้ว',
};

export default function AdminPlesPage() {
  const [ples, setPlEs] = useState<any[]>([]);
  const [filter, setFilter] = useState('');
  const [auditors, setAuditors] = useState<any[]>([]);

  useEffect(() => {
    apiFetch<any[]>('/admin/ples').then(d => setPlEs(d ?? []));
    apiFetch<any[]>('/admin/users').then(all =>
      setAuditors((all ?? []).filter((u: any) => u.role === 'auditor'))
    );
  }, []);

  const filtered = filter ? ples.filter(p => p.status === filter) : ples;

  async function assign(pleId: string, auditorId: string) {
    try {
      const res: any = await apiFetch(`/admin/ples/${pleId}/assign`, { method: 'POST', body: JSON.stringify({ auditor_id: auditorId }) });
      if (res?.error) { alert(`ไม่สำเร็จ: ${res.error}`); return; }
      apiFetch<any[]>('/admin/ples').then(d => setPlEs(d ?? []));
    } catch { alert('เกิดข้อผิดพลาด / Error assigning auditor'); }
  }

  return (
    <>
      <NavBar />
      <div className="max-w-5xl mx-auto p-6">
      <h1 className="text-xl font-bold mb-4 font-heading">จัดการ PLEs ทั้งหมด / Manage All PLEs</h1>
      <div className="flex gap-2 mb-4 flex-wrap">
        {['','active','cle_pass','cle_flag_t2','evaluated'].map(s => (
          <Button key={s} variant={filter===s?'default':'outline'} size="sm" onClick={() => setFilter(s)}>
            {s ? STATUS_MAP[s] : 'ทั้งหมด / All'}
          </Button>
        ))}
      </div>
      <div className="border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-secondary"><tr>
            <th className="px-4 py-3 text-left">แพทย์ / Physician</th>
            <th className="px-4 py-3 text-left">วันที่ / Date</th>
            <th className="px-4 py-3 text-left">สถานะ / Status</th>
            <th className="px-4 py-3 text-left">มอบหมาย / Assign Auditor</th>
          </tr></thead>
          <tbody>{filtered.map(p => (
            <tr key={p.id} className="border-t hover:bg-secondary">
              <td className="px-4 py-3">{p.professionals?.full_name_th ?? '—'}</td>
              <td className="px-4 py-3">{new Date(p.started_at).toLocaleDateString('th-TH')}</td>
              <td className="px-4 py-3"><Badge variant="outline">{STATUS_MAP[p.status]??p.status}</Badge></td>
              <td className="px-4 py-3">
                {p.status === 'evaluated' && !p.auditor_id
                  ? <select className="border rounded px-2 py-1 text-xs"
                      onChange={e => e.target.value && assign(p.id, e.target.value)}>
                      <option value="">เลือก Auditor...</option>
                      {auditors.map((a:any) => <option key={a.id} value={a.id}>{a.full_name_th}</option>)}
                    </select>
                  : p.auditor_id ? <span className="text-xs text-[#5db872]">✓ Assigned</span> : null
                }
              </td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
    </>
  );
}
