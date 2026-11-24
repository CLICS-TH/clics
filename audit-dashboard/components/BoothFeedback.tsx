'use client';
// The Booth Mode page's feedback section (GET /admin/booth/feedback): the anonymous post-play form of the event.
// Counts, a per-date split, every question's distribution, and the comments. A row has no id, time or tag, and the
// server sends the rows in content order on purpose (ADR 0015): nothing here numbers, timestamps or re-orders them.
// A comment the server withheld arrives without its text; only the reason is shown. The export goes through the one
// path that writes its audit row.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiDownload, apiFetch } from '@/lib/api';
import { BiLabel } from '@/components/BiLabel';
import { MoodFace, MOODS, ScaleFace } from '@/components/BoothFaces';
import { toast } from '@/components/Overlays';
import { StateMessage } from '@/components/ui/state-message';
import { useChartColors } from '@/lib/chart-colors';
import { boothFeedbackFilename } from '@/lib/booth';
import {
  type ApiResult, type BoothFeedback as Feedback, type BoothFeedbackRow, formatApiError,
} from '@/lib/types';

const EXPORT_PATH = '/admin/booth/feedback.json';
const LOAD_ERROR = 'โหลดแบบประเมินไม่สำเร็จ / Could not load the feedback.';
const ALL = '__all';
const NONE = '__none';

type Label = { th: string; en: string };
// Mirrors FEEDBACK_COPY in physician-ui/public/js/booth-feedback-copy.js (the dashboard cannot import from it).
const QUESTIONS: Record<string, Label> = {
  role: { th: 'คุณคือ', en: 'You are' },
  mood: { th: 'ระหว่างเล่น คุณรู้สึกอย่างไร', en: 'How did you feel while playing?' },
  felt_like: { th: 'เล่นแล้วรู้สึกเหมือน…', en: 'It felt like…' },
  easy: { th: 'เล่นง่าย เข้าใจได้ทันที', en: 'Easy to play' },
  real: { th: 'เคสสมจริง เหมือนเจอในงานจริง', en: 'The case felt real' },
  fair: { th: 'คะแนนและคำอธิบายสมเหตุสมผล', en: 'The score and feedback were fair' },
  use: { th: 'อยากใช้ CLICS เก็บหน่วยกิต CME แทนการนั่งฟังบรรยาย', en: "I'd use CLICS for CME credit instead of lectures" },
};
const ROLES: [string, Label][] = [
  ['physician', { th: 'แพทย์', en: 'Physician' }],
  ['resident', { th: 'แพทย์ประจำบ้าน', en: 'Resident' }],
  ['student', { th: 'นักศึกษาแพทย์', en: 'Medical student' }],
  ['other', { th: 'อื่น ๆ', en: 'Other' }],
];
const MOOD_LABELS: Record<string, Label> = {
  stressed: { th: 'เครียด', en: 'Stressed' },
  confused: { th: 'งง', en: 'Confused' },
  neutral: { th: 'เฉย ๆ', en: 'Neutral' },
  enjoyed: { th: 'สนุก', en: 'Enjoyed it' },
  excited: { th: 'ตื่นเต้น', en: 'Excited' },
};
const FELT_LIKE: [string, Label][] = [
  ['exam', { th: 'ทำข้อสอบ', en: 'Taking an exam' }],
  ['real_patient', { th: 'วินิจฉัยคนไข้จริง', en: 'Diagnosing a real patient' }],
  ['ward_round', { th: 'ราวด์วอร์ดกับอาจารย์', en: 'A ward round with a teacher' }],
  ['game', { th: 'เล่นเกม', en: 'Playing a game' }],
  ['textbook', { th: 'อ่านตำรา', en: 'Reading a textbook' }],
  ['other', { th: 'อย่างอื่น', en: 'Something else' }],
];
// The labels under a 1-5 slider, value 1 first.
const SCALE: Label[] = [
  { th: 'น้อยมาก', en: 'Very little' }, { th: 'น้อย', en: 'Little' }, { th: 'ปานกลาง', en: 'Moderate' },
  { th: 'มาก', en: 'Much' }, { th: 'มากที่สุด', en: 'Very much' },
];

type Bar = { key: string; label: React.ReactNode; count: number; testId: string };

function Bars({ title, bars, total, mean, meanId }: { title: Label; bars: Bar[]; total: number; mean?: number | null; meanId?: string }) {
  const color = useChartColors().human;   // a human's answers: coral, never the AI blue
  return (
    <section className="space-y-2 rounded-xl border p-4" aria-label={`${title.th} / ${title.en}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-sm font-medium text-foreground"><BiLabel th={title.th} en={title.en} /></h3>
        {meanId && (
          <p className="text-sm text-muted-foreground tabular-nums">
            <BiLabel th="ค่าเฉลี่ย" en="mean" /> <span data-testid={meanId}>{mean == null ? '—' : mean.toFixed(1)}</span>
            {' · '}n = <span data-testid={`${meanId}-n`}>{total}</span>
          </p>
        )}
      </div>
      <ul className="space-y-1.5">
        {bars.map((b) => (
          <li key={b.key} data-testid={b.testId} className="grid grid-cols-[minmax(0,45%)_minmax(3rem,1fr)_2.5rem] items-center gap-3 text-sm">
            <span className="flex items-center gap-2 text-foreground [overflow-wrap:anywhere]">{b.label}</span>
            <span className="h-3 rounded-sm bg-muted" aria-hidden="true">
              <span className="block h-3 rounded-sm" style={{ width: `${total ? (b.count / total) * 100 : 0}%`, background: color }} />
            </span>
            <span className="text-right font-medium text-foreground tabular-nums" data-testid={`${b.testId}-n`}>{b.count}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const count = (rows: BoothFeedbackRow[], pick: (r: BoothFeedbackRow) => boolean) => rows.filter(pick).length;
const mean = (rows: BoothFeedbackRow[], pick: (r: BoothFeedbackRow) => number) =>
  rows.length ? rows.reduce((s, r) => s + pick(r), 0) / rows.length : null;

function Scale({ q, rows, from, to }: { q: 'easy' | 'real' | 'fair' | 'use'; rows: BoothFeedbackRow[]; from: number; to: number }) {
  const values = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const bars: Bar[] = values.map((v) => ({
    key: String(v),
    testId: `fb-bar-${q}-${v}`,
    count: count(rows, (r) => r.answers[q] === v),
    label: (
      <>
        <ScaleFace t={(v - from) / (to - from)} size={24} />
        <span className="tabular-nums">{v}{to === 5 && <> <BiLabel th={SCALE[v - 1].th} en={SCALE[v - 1].en} /></>}</span>
      </>
    ),
  }));
  return <Bars title={QUESTIONS[q]} bars={bars} total={rows.length} mean={mean(rows, (r) => r.answers[q])} meanId={`fb-mean-${q}`} />;
}

function Distributions({ rows }: { rows: BoothFeedbackRow[] }) {
  return (
    <div className="grid grid-cols-1 gap-4 @min-[1024px]:grid-cols-2">
      <Bars title={QUESTIONS.role} total={rows.length}
        bars={ROLES.map(([k, l]) => ({ key: k, testId: `fb-bar-role-${k}`, label: <BiLabel th={l.th} en={l.en} />, count: count(rows, (r) => r.answers.role === k) }))} />
      <Bars title={QUESTIONS.mood} total={rows.length}
        bars={MOODS.map((k) => ({
          key: k, testId: `fb-bar-mood-${k}`, count: count(rows, (r) => r.answers.mood === k),
          label: <><MoodFace mood={k} size={24} /><BiLabel th={MOOD_LABELS[k].th} en={MOOD_LABELS[k].en} /></>,
        }))} />
      <Bars title={QUESTIONS.felt_like} total={rows.length}
        bars={FELT_LIKE.map(([k, l]) => ({ key: k, testId: `fb-bar-felt_like-${k}`, label: <BiLabel th={l.th} en={l.en} />, count: count(rows, (r) => r.answers.felt_like.includes(k as never)) }))} />
      <Scale q="easy" rows={rows} from={1} to={5} />
      <Scale q="real" rows={rows} from={1} to={5} />
      <Scale q="fair" rows={rows} from={1} to={5} />
      <Scale q="use" rows={rows} from={0} to={10} />
    </div>
  );
}

function Comments({ rows }: { rows: BoothFeedbackRow[] }) {
  const shown = rows.filter((r) => r.withheld || r.comment);
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium text-foreground"><BiLabel th="ความเห็น" en="Comments" /></h3>
      {shown.length === 0 ? (
        <p className="text-sm text-muted-foreground"><BiLabel th="ยังไม่มีความเห็น" en="No comments." /></p>
      ) : (
        // A plain list: a row number would imply an order of play (ADR 0015).
        <ul aria-label="ความเห็น / Comments" className="divide-y rounded-xl border">
          {shown.map((r, i) => (
            <li key={i} className="space-y-1 px-4 py-3 text-sm">
              <p className="text-muted-foreground tabular-nums">{r.date}{r.case_id ? ` · ${r.case_id}` : ''}</p>
              {r.withheld
                ? <p className="font-medium text-foreground"><BiLabel th="ถูกซ่อน ระบบตรวจพบว่าควรให้ผู้ดูแลตรวจก่อน" en="Withheld: flagged for review" /></p>
                : <p className="text-foreground [overflow-wrap:anywhere] whitespace-pre-wrap">{r.comment}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ExportButton({ eventCode }: { eventCode: string }) {
  const [exporting, setExporting] = useState(false);
  async function run() {
    if (exporting) return;
    setExporting(true);
    try {
      const res = await apiDownload(EXPORT_PATH, boothFeedbackFilename(eventCode));
      if (res.error) toast(res.error, 'error');
    } finally {
      setExporting(false);
    }
  }
  return (
    <button type="button" onClick={run} aria-disabled={exporting || undefined}
      className="whitespace-nowrap rounded-md bg-coral-active px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity aria-disabled:cursor-wait aria-disabled:opacity-50 aria-disabled:focus-visible:opacity-100">
      {exporting ? 'กำลังส่งออก… / Exporting…' : 'Export แบบประเมิน (JSON)'}
    </button>
  );
}

export function BoothFeedback() {
  const [data, setData] = useState<Feedback | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState(ALL);

  // Promise-chain form: react-hooks/set-state-in-effect does not treat `await` as deferring.
  const load = useCallback(() => apiFetch<ApiResult<Feedback>>('/admin/booth/feedback').then((r) => {
    if (!r) return;   // 401: on its way to the sign-in
    if (r.error || !Array.isArray(r.rows)) { setError(formatApiError(r.error, LOAD_ERROR)); return; }
    setError('');
    setData(r as Feedback);
  }), []);
  useEffect(() => { void load(); }, [load]);

  const caseIds = useMemo(() => [...new Set((data?.rows ?? []).map((r) => r.case_id).filter((c): c is string => !!c))].sort(), [data]);
  const rows = useMemo(() => (data?.rows ?? []).filter((r) =>
    filter === ALL ? true : filter === NONE ? r.case_id === null : r.case_id === filter), [data, filter]);
  const dates = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.date, (m.get(r.date) ?? 0) + 1);
    return [...m.entries()];   // already newest first: the rows arrive in that order
  }, [rows]);

  return (
    <section className="space-y-4" aria-labelledby="booth-feedback-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <h2 id="booth-feedback-heading" className="font-heading text-2xl font-semibold text-foreground">
          <BiLabel th="ความเห็นผู้เล่น" en="Player feedback" />
        </h2>
        {data && <ExportButton eventCode={data.event_code} />}
      </div>

      {!data ? (
        error
          ? <StateMessage kind="error" title={LOAD_ERROR} onRetry={() => void load()}>{error !== LOAD_ERROR ? error : null}</StateMessage>
          : <StateMessage kind="loading" title="กำลังโหลดแบบประเมิน… / Loading the feedback…" />
      ) : data.rows.length === 0 ? (
        <StateMessage kind="empty" title="ยังไม่มีแบบประเมิน / No feedback yet." />
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            ไม่ระบุตัวตน ไม่มีเวลาหรือหมายเลขผู้เล่น / Anonymous: no time of play and no player number.
          </p>
          <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
            <p className="text-sm text-muted-foreground" data-testid="fb-answers-line">
              <BiLabel th="จำนวนแบบประเมิน" en="Responses" />{' '}
              <span className="font-heading text-2xl font-semibold text-foreground lining-nums tabular-nums" data-testid="fb-answers">{rows.length}</span>
            </p>
            <label className="flex flex-col gap-1 text-sm text-muted-foreground">
              <BiLabel th="เลือกเคส" en="Case" />
              <select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="กรองตามเคส / Filter by case"
                className="rounded-md border border-field bg-background px-3 py-2 text-sm text-foreground">
                <option value={ALL}>ทุกเคส / All cases</option>
                {caseIds.map((c) => <option key={c} value={c}>{c}</option>)}
                {data.rows.some((r) => r.case_id === null) && <option value={NONE}>ไม่ระบุเคส / No case</option>}
              </select>
            </label>
          </div>

          <ul aria-label="จำนวนต่อวัน / Per date" className="flex flex-wrap gap-2">
            {dates.map(([d, n]) => (
              <li key={d} data-testid={`fb-date-${d}`} className="rounded-lg border px-3 py-1.5 text-sm text-foreground tabular-nums">
                {d} <span className="font-medium" data-testid={`fb-date-n-${d}`}>{n}</span>
              </li>
            ))}
          </ul>

          <Distributions rows={rows} />
          <p className="text-sm text-muted-foreground tabular-nums">
            <BiLabel th="ความเห็นที่ถูกซ่อน" en="Withheld comments" /> {count(rows, (r) => !!r.withheld)}
          </p>
          <Comments rows={rows} />
        </div>
      )}
    </section>
  );
}
