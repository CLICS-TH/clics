'use client';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { LpdpChart } from '@/components/LpdpChart';
import { PageIntro } from '@/components/PageIntro';

export default function LpdpPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<any[]>([]);
  const [name, setName] = useState('');

  useEffect(() => {
    apiFetch<any[]>(`/admin/lpdp/${id}`).then(d =>
      setData((d ?? []).map((s, i) => ({ ...s, label: `PLE ${i+1}` })))
    );
    apiFetch<any[]>('/admin/users').then(users => {
      const user = (users ?? []).find((u: any) => u.id === id);
      if (user) setName(user.full_name_th);
    });
  }, [id]);

  return (
    <div className="max-w-3xl mx-auto p-6 md:p-10">
      <PageIntro
        eyebrow="Superadmin · LPDP"
        title={`${name || 'LPDP'} — ความก้าวหน้า`}
        subtitle="Longitudinal Personal Development Profile — PIS-7 score trajectory"
      />
      {data.length ? <LpdpChart data={data} /> : <p className="text-muted-foreground">ยังไม่มีข้อมูล</p>}
    </div>
  );
}
