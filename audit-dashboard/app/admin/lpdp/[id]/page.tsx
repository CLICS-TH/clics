'use client';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { LpdpChart } from '@/components/LpdpChart';
import { PageIntro } from '@/components/PageIntro';
import { Button } from '@/components/ui/button';
import { STATUS_MAP, caseCategory } from '@/lib/labels';

type GroupBy = 'status' | 'case' | 'folder';
const round = (x: number) => Math.round(x);

export default function PhysicianProfilePage() {
  const { id } = useParams<{ id: string }>();
  const [profile, setProfile] = useState<any>(null);
  const [group, setGroup] = useState<GroupBy>('status');

  useEffect(() => {
    apiFetch<any>(`/admin/physicians/${id}/profile`).then(setProfile);
  }, [id]);

  if (!profile) return (
    <div className="max-w-3xl mx-auto p-6 md:p-10"><p className="text-muted-foreground">กำลังโหลด… / Loading…</p></div>
  );

  const { physician, sessions = [], lpdp = [] } = profile;
  const chartData = lpdp.map((s: any, i: number) => ({ label: `PLE ${i + 1}`, composite_score: Number(s.composite_score) }));

  const keyFor = (s: any) =>
    group === 'status' ? (STATUS_MAP[s.status] ?? s.status)
    : group === 'case' ? caseCategory(s.chief_complaint)
    : (s.folder_name || 'ไม่จัดหมวด / Uncategorized');

  const groups: Record<string, any[]> = {};
  sessions.forEach((s: any) => { (groups[keyFor(s)] ??= []).push(s); });

  const tabs: [GroupBy, string][] = [
    ['status', 'สถานะ / Status'], ['case', 'ประเภทเคส / Case'], ['folder', 'โฟลเดอร์ / Folder'],
  ];

  return (
    <div className="max-w-3xl mx-auto p-6 md:p-10">
      <PageIntro
        eyebrow="Superadmin · Physician scores"
        title={`${physician.full_name_th || physician.full_name_en}${physician.pseudonym ? ` · ${physician.pseudonym}` : ''}`}
        subtitle={`${physician.specialty ? physician.specialty + ' — ' : ''}สำรวจคะแนนและเซสชันรายบุคคล / Explore this user's scores & sessions`}
      />

      {chartData.length > 0 && <div className="mb-6"><LpdpChart data={chartData} /></div>}

      <div className="flex gap-2 mb-4">
        {tabs.map(([g, l]) => (
          <Button key={g} size="sm" variant={group === g ? 'default' : 'outline'} onClick={() => setGroup(g)}>{l}</Button>
        ))}
      </div>

      {sessions.length === 0 ? (
        <p className="text-muted-foreground text-sm py-8 text-center">ยังไม่มีเซสชัน / No sessions yet.</p>
      ) : Object.entries(groups).map(([label, items]) => (
        <div key={label} className="mb-5">
          <h3 className="text-sm font-semibold text-primary mb-2">{label} <span className="text-muted-foreground font-normal">({items.length})</span></h3>
          <div className="space-y-2">
            {items.map((s: any) => {
              const humanAvg = s.audits?.length
                ? round(s.audits.reduce((a: number, x: any) => a + Number(x.composite_score), 0) / s.audits.length)
                : null;
              return (
                <div key={s.id} className="border rounded-xl p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{s.chief_complaint || '—'}</p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(s.started_at).toLocaleDateString('th-TH')} · {s.turn_count} รอบ · {STATUS_MAP[s.status] ?? s.status}
                      </p>
                    </div>
                    <div className="text-right whitespace-nowrap text-sm">
                      <p>AI: <span className="font-semibold">{s.ai ? round(Number(s.ai.composite_score)) : '—'}</span></p>
                      <p className="text-muted-foreground">ผู้ตรวจ / Auditor: {humanAvg != null ? `${humanAvg} (n=${s.audits.length})` : '—'}</p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
