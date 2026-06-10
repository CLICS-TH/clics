'use client';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { PageIntro } from '@/components/PageIntro';
import { TranscriptView } from '@/components/TranscriptView';
import { Button } from '@/components/ui/button';
import { STATUS_MAP } from '@/lib/labels';

export default function AdminTranscriptPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<any>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    apiFetch<any>(`/admin/ples/${id}/transcript`).then(d => {
      if (d?.error) setNotFound(true); else setData(d);
    });
  }, [id]);

  if (notFound) return (
    <div className="max-w-3xl mx-auto p-6 md:p-10">
      <p className="text-muted-foreground">ไม่พบเซสชัน หรืออยู่นอกสภาของคุณ / Session not found or outside your council.</p>
      <Button variant="outline" className="mt-4" onClick={() => history.back()}>← กลับ / Back</Button>
    </div>
  );
  if (!data) return (
    <div className="max-w-3xl mx-auto p-6 md:p-10"><p className="text-muted-foreground">กำลังโหลด… / Loading…</p></div>
  );

  const { ple, messages = [] } = data;
  const physician = ple.professionals;

  return (
    <div className="max-w-3xl mx-auto p-6 md:p-10">
      <PageIntro
        eyebrow="Admin · Investigate session"
        title={ple.title || ple.chief_complaint || 'เซสชัน / Session'}
        subtitle={`${physician?.full_name_th || physician?.full_name_en || ''}${physician?.pseudonym ? ` · ${physician.pseudonym}` : ''} — ${STATUS_MAP[ple.status] ?? ple.status} · ${ple.turn_count ?? 0} รอบ`}
      />
      <div className="mb-4">
        <Button variant="outline" size="sm" onClick={() => history.back()}>← กลับ / Back</Button>
      </div>
      {messages.length === 0
        ? <p className="text-muted-foreground text-sm py-8 text-center">ยังไม่มีข้อความ / No messages.</p>
        : <TranscriptView messages={messages} />}
    </div>
  );
}
