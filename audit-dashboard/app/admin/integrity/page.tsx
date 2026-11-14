'use client';
/*
 * The integrity queue — the read surface for backend/src/services/integrity.js.
 *
 * WHY IT EXISTS. The detector has run on every /end since it shipped, writing flags into
 * ple_integrity_flags and forcing flagged sessions into the audit sample. Nothing could read them
 * back. A detector nobody can read is one nobody can act on, correct, or argue with — and this one
 * was designed specifically to be arguable: every rule is arithmetic, and every flag carries the
 * evidence that produced it. That evidence had nowhere to be shown until this page.
 *
 * WHAT THIS PAGE IS NOT. It is not a verdict screen. There is no "confirm cheating" button and no
 * accuse action, because a flag routes a session to a human and never penalises anyone — several
 * signals fire on entirely legitimate behaviour by design. So the page shows numbers and asks a
 * person to read the transcript. The strongest wording it uses is "worth reading".
 *
 * THE GENRE COUNTERS ARE THE POINT OF THE PASTE ROW. F3 fires on "a large turn arrived too fast to
 * have been typed", which is equally true of a physician pasting a de-identified case note (fine —
 * PIS-7 scores reasoning, not data entry) and of one pasting an answer they did not reason to (not
 * fine). The counters are printed side by side so the reader can see which they are looking at.
 * They are deliberately NOT collapsed into a label: no threshold here has been calibrated, and
 * services/integrity.js is explicit that an uncalibrated threshold eventually accuses someone
 * wrongly.
 */
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { PageIntro } from '@/components/PageIntro';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
// The dashboard's bilingual convention. `.bi-en` is a physician-ui class and does not exist
// here — using it would render every English half at full weight, which is the density problem
// BiLabel was introduced to remove.
import { BiLabel } from '@/components/BiLabel';
import { REPORT_REASON, REPORTED_REPLY_SIGNAL } from '@/lib/report-reasons';
import { AlertTriangle, ClipboardPaste, Repeat, Timer, Fingerprint, ShieldQuestion, Flag } from 'lucide-react';

type Severity = 'low' | 'medium' | 'high';
type Flag = { signal: string; severity: Severity; evidence: Record<string, unknown>; created_at: string };
type Row = {
  id: string; ple_code?: string | null; status?: string; ended_at?: string | null;
  turn_count?: number; token_count?: number; is_test?: boolean; flags: Flag[];
};

/*
 * One line per signal, in the physician's own language, saying what was MEASURED — never what it
 * means about the person. These mirror the comments in services/integrity.js; if a threshold there
 * changes, this copy has to change with it.
 */
const SIGNAL: Record<string, { th: string; en: string; icon: typeof Repeat; note: string }> = {
  F1_NEAR_DUPLICATE: { th: 'ข้อความซ้ำในเซสชันเดียว', en: 'Repeated turns in one session', icon: Repeat,
    note: 'คนที่กำลังคิดเคสไม่ส่งย่อหน้าเดิมซ้ำ / A person exploring a case does not send the same paragraph twice.' },
  F2_CROSS_SESSION_REUSE: { th: 'ข้อความซ้ำข้ามบทเรียนของตัวเอง', en: 'Reuse across their own episodes', icon: Repeat,
    note: 'ทุกกรณีที่เคยพบมาจากเซสชันทดสอบของทีม อัตราจริงจึงยังไม่ทราบ / Every observed instance came from the team’s own test sessions, so the real rate is unknown.' },
  F3_PASTE_BURST: { th: 'ข้อความยาวมาถึงเร็วเกินกว่าจะพิมพ์', en: 'A large turn arrived too fast to type', icon: ClipboardPaste,
    note: 'การวาง case note จริงหน้าตาเหมือนกันทุกประการ — ดูตัวเลข genre ด้านล่าง / Pasting a real case note looks identical. Read the genre counters below.' },
  F4_COMPOSITION_RATE: { th: 'อัตราการพิมพ์สูงเกินมนุษย์', en: 'Composition rate above human typing', icon: Timer,
    note: 'ปิดไว้โดยค่าเริ่มต้น — ไม่ผ่าน calibration / Off by default: it did not survive calibration.' },
  F5_LATENCY_UNIFORMITY: { th: 'จังหวะการส่งสม่ำเสมอเกินไป', en: 'Machine-regular rhythm', icon: Timer,
    note: 'จังหวะของคนไม่สม่ำเสมอ ของลูปสม่ำเสมอ / A person’s rhythm is irregular; a loop’s is not.' },
  F6_REGISTER_DISCONTINUITY: { th: 'สำนวนต่างจาก turn อื่นของตัวเอง', en: 'Writes unlike their own other turns', icon: Fingerprint,
    note: 'เทียบกับตัวเองเท่านั้น ไม่ได้เทียบกับคนอื่น / Compared only against this physician’s own baseline, never against other people.' },
  R1_RESCUE_REPLY_BREACH: { th: 'คำตอบ rescue ผิดข้อกำหนด', en: 'A rescue reply broke the protocol', icon: ShieldQuestion,
    note: 'นี่คือ output ของระบบเรา ไม่ใช่ของแพทย์ / This flags OUR output, not the physician’s.' },
  // Raised BY the physician (POST /ples/:id/messages/:messageId/report), not about them — the CREC082
  // Risk & Incident Plan's safety event log. Keep the key in step with REPORTED_REPLY_SIGNAL in
  // backend/src/services/integrity-scan.js (__tests__/backend-mirrors.test.ts reads it).
  [REPORTED_REPLY_SIGNAL]: { th: 'แพทย์รายงานคำตอบของ AI', en: 'A physician reported an AI reply', icon: Flag,
    note: 'แพทย์ระบุว่าคำตอบของ AI ผิดหรือไม่ปลอดภัย นี่คือ output ของระบบเรา ไม่ใช่ของแพทย์ และไม่มีผลต่อคะแนนหรือการสุ่มตรวจ / The physician said an AI reply was wrong or unsafe. This flags OUR output, not the physician, and does not affect their score or the audit sample.' },
};

type ReplyReport = {
  message_id?: string; reason?: string; note?: string | null; turn?: number | null;
  provider?: string | null; model?: string | null; prompt_version?: string | null; reported_at?: string;
};

/*
 * One block per reported reply. Three things are deliberate:
 *
 * ATTRIBUTION IS THE POINT. provider / model / prompt_version were read from the message row on the
 * server when the report was filed — it is how a safety event gets pinned on a model. A reply that
 * predates per-turn provenance has none, and that is printed as "not recorded" rather than left blank:
 * a blank would read as "no model", which is a different (and false) statement.
 *
 * THE NOTE IS PHYSICIAN-TYPED TEXT and may contain identifiers despite the warning shown when it was
 * written. It is rendered as text (React escapes it), wrapped, and capped by the API at 500 chars. It
 * is not in the audit log and never reached an AI. A missing note shows nothing: never written is not
 * the same as written-and-empty.
 *
 * `break-words` on every value: message ids and prompt labels have no break opportunity, and the
 * Card clips its overflow — without it the page does not scroll, it silently CUTS the evidence off.
 */
function ReportEvidence({ e }: { e: Record<string, unknown> }) {
  const reports = (Array.isArray(e.reports) ? e.reports : []) as ReplyReport[];
  if (!reports.length) return null;
  return (
    <ul className="mt-2 space-y-2">
      {reports.map((r, i) => {
        const reason = r.reason ? REPORT_REASON[r.reason] : undefined;
        const attributed = r.provider || r.model || r.prompt_version;
        return (
          <li key={r.message_id ?? i} className="rounded-lg border border-border bg-muted/40 p-3">
            <p className="text-sm font-medium text-foreground">
              {reason ? <BiLabel th={reason.th} en={reason.en} /> : (r.reason ?? '—')}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
              {typeof r.turn === 'number' ? `คำตอบ AI ครั้งที่ ${r.turn} / AI reply #${r.turn}` : 'ไม่ทราบลำดับ / reply position unknown'}
              {r.reported_at ? ` · ${new Date(r.reported_at).toLocaleString('th-TH')}` : ''}
            </p>
            {r.note ? (
              <p className="mt-2 border-l-2 border-border pl-3 text-sm leading-relaxed whitespace-pre-wrap break-words text-foreground">
                {r.note}
              </p>
            ) : null}
            <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <div className="flex min-w-0 gap-1.5">
                <dt className="shrink-0 font-medium">
                  <BiLabel th="ผู้ตอบ" en="answered by" />
                </dt>
                <dd className="min-w-0 font-mono break-all text-foreground">
                  {attributed
                    ? [r.provider, r.model, r.prompt_version].filter(Boolean).join(' · ')
                    : 'ไม่ได้บันทึก / not recorded'}
                </dd>
              </div>
              {r.message_id && (
                <div className="flex min-w-0 gap-1.5">
                  <dt className="shrink-0 font-medium">message_id</dt>
                  <dd className="min-w-0 font-mono break-all tabular-nums text-foreground">{r.message_id}</dd>
                </div>
              )}
            </dl>
          </li>
        );
      })}
    </ul>
  );
}

const SEV: Record<Severity, { cls: string; th: string; en: string }> = {
  high: { cls: 'bg-destructive/10 text-danger', th: 'สูง', en: 'High' },
  medium: { cls: 'bg-primary/12 text-coral-on-tint', th: 'กลาง', en: 'Medium' },
  low: { cls: 'bg-muted text-muted-foreground', th: 'ต่ำ', en: 'Low' },
};
const RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1 };

const FILTERS: { key: string; th: string; en: string }[] = [
  { key: '', th: 'ทั้งหมด', en: 'All' },
  { key: 'high', th: 'สูง', en: 'High' },
  { key: 'medium', th: 'กลาง', en: 'Medium' },
  { key: 'low', th: 'ต่ำ', en: 'Low' },
];

/*
 * The two densities that separate pasted DATA from pasted REASONING, shown as a pair because
 * neither means anything alone. A case note runs high on clinical and zero on discourse; generated
 * prose does the reverse. Markdown is called out separately: a plain <textarea> does not produce
 * `**bold**` or bulleted lists by accident, so it is the highest-precision number on this page.
 */
function GenreCounters({ g }: { g: Record<string, number> }) {
  const items = [
    { k: 'clinical_density', th: 'ตัวเลข/หน่วย/ค่า lab', en: 'clinical data', v: g.clinical_density },
    { k: 'discourse_density', th: 'คำเชื่อม/เรียงลำดับ/สรุป', en: 'discourse markers', v: g.discourse_density },
    { k: 'markdown_marks', th: 'สัญลักษณ์ Markdown', en: 'Markdown marks', v: g.markdown_marks, raw: true },
  ];
  return (
    <div className="mt-2 rounded-lg border border-border bg-muted/40 p-3">
      <p className="mb-2 text-sm text-muted-foreground">
        <BiLabel th="ลักษณะของข้อความที่วาง — ตัวเลขดิบ ไม่ใช่ข้อสรุป"
          en="The pasted turn’s shape. Raw counts, not a conclusion." />
      </p>
      <dl className="grid gap-2 @min-[520px]:grid-cols-3">
        {items.map((it) => (
          <div key={it.k} className="rounded border border-border bg-background px-2.5 py-2">
            <dt className="text-xs leading-snug text-muted-foreground">
              <BiLabel th={it.th} en={it.en} />
            </dt>
            <dd className="mt-0.5 font-mono text-sm tabular-nums text-foreground">
              {typeof it.v === 'number' ? it.v : '—'}
              {!it.raw && <span className="ml-1 text-xs text-muted-foreground">/100 ตัวอักษร</span>}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/*
 * Everything in the evidence object that is not the genre profile, printed plainly.
 *
 * TWO THINGS HERE ARE NOT COSMETIC.
 *
 * `min-w-0` + `break-all` on the value. A flex item's default `min-width: auto` refuses to shrink
 * below its content, and two of these values have no break opportunity at all: `other_ple_id` is a
 * 36-character UUID, and F6's `shifted_features` stringifies to ~250 unbroken characters. The Card
 * clips its overflow, so without this the page does not scroll — it silently CUTS the evidence off,
 * which on an evidence panel is the worse of the two failures.
 *
 * `shifted_features` gets read out rather than JSON.stringify'd. It is the only nested value any
 * signal emits, and `[{"feature":"discourse","value":3.2,"z":4.1},…]` is not something a reader can
 * act on. The point of this page is that a person can check the arithmetic.
 */
type Shift = { feature: string; value: number; z: number };
const isShiftList = (v: unknown): v is Shift[] =>
  Array.isArray(v) && v.every((x) => x && typeof x === 'object' && 'feature' in x && 'z' in x);

/*
 * F6's `shifted_features` gets its OWN full-width row, and that is a layout requirement rather than
 * a preference. Measured at 320px: as an inline dt/dd pair it was one flex item among several, so it
 * shrank to 30px while its contents stayed intact — and the Card's `overflow-hidden` then CUT 142px
 * of evidence off with no scrollbar and no page overflow, so a page-level check would have called
 * the layout clean. On an evidence panel, silently hiding the evidence is the worse failure.
 *
 * One shift per line, wrapping allowed: the content column is only ~136px wide at 320px, which is
 * narrower than a single "discourse 3.21 (z 4.4)" chip. Two wrapped lines are readable; a clipped
 * one is not.
 */
function ShiftList({ v }: { v: Shift[] }) {
  return (
    <div className="basis-full">
      <p className="mb-0.5 text-xs font-medium text-muted-foreground">shifted_features</p>
      <ul className="space-y-0.5">
        {v.map((s) => (
          <li key={s.feature} className="font-mono text-xs text-foreground">
            {s.feature} {s.value} <span className="text-muted-foreground">(z {s.z})</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/*
 * Everything in the evidence object that is not the genre profile, printed plainly.
 *
 * `min-w-0` + `break-all` on the scalar values is also load-bearing: `other_ple_id` is a
 * 36-character UUID with no break opportunity, and a flex item's default `min-width: auto` refuses
 * to shrink below its content.
 *
 * `excerpt` is filtered out on purpose. It is 120 characters of the physician's own turn — raw PII
 * — and this page's answer to "what did they write" is the transcript link, which is access-checked.
 */
function EvidenceRows({ e }: { e: Record<string, unknown> }) {
  const entries = Object.entries(e).filter(([k]) => k !== 'genre' && k !== 'excerpt');
  if (!entries.length) return null;
  return (
    <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {entries.map(([k, v]) => (isShiftList(v) ? (
        <ShiftList key={k} v={v} />
      ) : (
        <div key={k} className="flex min-w-0 gap-1.5">
          <dt className="shrink-0 font-medium">{k}</dt>
          <dd className="min-w-0 font-mono break-all tabular-nums text-foreground">
            {typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)}
          </dd>
        </div>
      )))}
    </dl>
  );
}

export default function IntegrityQueuePage() {
  const [severity, setSeverity] = useState('');
  const [rows, setRows] = useState<Row[] | null>(null);   // null = loading
  const [err, setErr] = useState(false);

  const fetchQueue = useCallback(() => {
    // The `?` goes BEFORE the interpolation, always — the same shape as /admin/privacy-queue and
    // /admin/identity-queue. Appending a pre-built `?severity=…` string instead makes the
    // interpolation read as a PATH segment, and backend/tests/api-contract.js then reports the
    // endpoint as an orphan (it did). An empty severity is the "All" filter: the route treats any
    // unrecognised value, empty included, as no filter.
    apiFetch<{ ples: Row[] }>(`/admin/integrity-queue?severity=${severity}`)
      // An error envelope is not an empty queue: coercing it to [] would render "nothing has ever
      // been flagged", which is the most misleading thing this page could say.
      .then((d) => (Array.isArray(d?.ples) ? setRows(d.ples) : setErr(true)))
      .catch(() => setErr(true));
  }, [severity]);

  useEffect(() => { fetchQueue(); }, [fetchQueue]);
  const reload = () => { setErr(false); setRows(null); fetchQueue(); };

  return (
    <div className="mx-auto max-w-4xl p-6 md:p-10">
      <PageIntro
        eyebrow="Admin · Integrity"
        title="สัญญาณความสุจริต"
        subtitle="สัญญาณเชิงกำหนด (deterministic) ที่คำนวณจากข้อมูลที่มีอยู่แล้ว — ไม่มีโมเดลใดตัดสิน flag คือ “ควรมีคนอ่าน” ไม่ใช่ “คนนี้ทำผิด” / Deterministic signals over data we already store. No model judges anyone; a flag means a person should read the session."
      />

      <div className="mb-6 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Button key={f.key} size="sm" variant={severity === f.key ? 'default' : 'outline'}
            onClick={() => setSeverity(f.key)}>
            <BiLabel th={f.th} en={f.en} />
          </Button>
        ))}
      </div>

      {err && (
        <Card className="p-6 text-center">
          <p className="text-sm text-danger">โหลดคิวไม่สำเร็จ / Could not load the queue.</p>
          <Button className="mt-3" size="sm" variant="outline" onClick={reload}>ลองใหม่ / Retry</Button>
        </Card>
      )}

      {!err && rows === null && <p className="text-sm text-muted-foreground">กำลังโหลด… / Loading…</p>}

      {!err && rows?.length === 0 && (
        <Card className="p-8 text-center">
          <p className="text-sm text-muted-foreground">
            <BiLabel th="ไม่มีบทเรียนที่ถูกทำเครื่องหมายไว้" en="No sessions are flagged." />
          </p>
        </Card>
      )}

      <div className="space-y-4">
        {(rows ?? []).map((r) => {
          const worst = r.flags.reduce<Severity>((a, f) => (RANK[f.severity] > RANK[a] ? f.severity : a), 'low');
          return (
            <Card key={r.id} className="overflow-hidden p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm text-foreground">{r.ple_code ?? r.id.slice(0, 8)}</span>
                <Badge className={SEV[worst].cls}><BiLabel th={SEV[worst].th} en={SEV[worst].en} /></Badge>
                {r.is_test && <Badge variant="outline">test</Badge>}
                <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                  {r.turn_count ?? '—'} รอบ · {r.ended_at ? new Date(r.ended_at).toLocaleDateString('th-TH') : '—'}
                </span>
              </div>

              <div className="mt-3 space-y-3">
                {r.flags.map((f) => {
                  const meta = SIGNAL[f.signal];
                  const Icon = meta?.icon ?? AlertTriangle;
                  const genre = (f.evidence?.genre ?? null) as Record<string, number> | null;
                  return (
                    <div key={f.signal} className="rounded-lg border border-border p-3">
                      <div className="flex items-start gap-2">
                        <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-foreground">
                            {meta ? <BiLabel th={meta.th} en={meta.en} /> : f.signal}
                          </p>
                          {meta?.note && <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{meta.note}</p>}
                          {f.signal === REPORTED_REPLY_SIGNAL
                            ? <ReportEvidence e={f.evidence ?? {}} />
                            : <EvidenceRows e={f.evidence ?? {}} />}
                          {genre && <GenreCounters g={genre} />}
                        </div>
                        {/* Thai-first, like every other severity on this page. The card-level
                            badge above shows the WORST severity; this one is per-signal. */}
                        <Badge className={`${SEV[f.severity].cls} shrink-0`}>{SEV[f.severity].th}</Badge>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Reading the transcript is the action. There is deliberately no decision button:
                  this queue routes work to a person, and the person's job is to read. */}
              <div className="mt-3 border-t border-border pt-3">
                <Link href={`/admin/ples?id=${r.id}`} className="text-sm text-link underline underline-offset-2">
                  <BiLabel th="อ่านบทสนทนา" en="Read the transcript" /> →
                </Link>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
