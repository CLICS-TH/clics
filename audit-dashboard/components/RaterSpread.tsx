'use client';
// Can the raters discriminate at all? — the reading that has to be understood before an ICC means
// anything.
//
// The 2026-08-28 baseline was ICC = −0.315, and the screen showing it said only that. The cause was
// six points of human range against the AI's twenty on the same episodes: restriction of range, not
// disagreement. Read as a bare ICC that looks like "the AI is wrong about our episodes", which calls
// for the opposite work from what is needed. This panel is the sentence the ICC cannot say.
import type { RaterSpread } from '@/lib/types';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

// ICC = var_between / (var_between + var_error), so 0.75 needs var_between ≥ 3 × var_error. Stated in
// score points because that is what an instruction can use.
function GateReading({ gate }: { gate: RaterSpread['gate'] }) {
  if (!gate.measurable) {
    return (
      <p className="text-sm text-muted-foreground">
        ยังวัดไม่ได้ / Not yet measurable — {gate.why}
      </p>
    );
  }
  const short = !gate.meets;
  return (
    <div className="space-y-2">
      <div className="grid gap-3 @min-[560px]:grid-cols-3">
        <Figure label="ผู้ตรวจต่างกันเอง / Raters differ" value={gate.sd_error} unit="SD" />
        <Figure label="เคสต่างกัน / Episodes differ" value={gate.sd_between_observed} unit="SD" tone={short ? 'bad' : 'ok'} />
        <Figure label="ต้องต่างกันอย่างน้อย / Needed for 0.75" value={gate.sd_between_required} unit="SD" />
      </div>
      {short && gate.sd_between_observed != null && gate.sd_error != null
        && gate.sd_between_observed < gate.sd_error && (
        // The clearest statement of the problem, and the one nobody reads off an ICC.
        <p className="text-sm text-danger">
          เคสต่างกันน้อยกว่าที่ผู้ตรวจต่างกันเอง / The episodes differ from each other by less than the
          raters differ on the same episode. No agreement statistic can be high while that holds.
        </p>
      )}
    </div>
  );
}

function Figure({ label, value, unit, tone }: { label: string; value: number | null | undefined; unit?: string; tone?: 'ok' | 'bad' }) {
  return (
    <div className="rounded-xl border border-border p-4">
      <p className={`text-2xl font-bold tabular-nums ${tone === 'bad' ? 'text-danger' : tone === 'ok' ? 'text-ok' : ''}`}>
        {value == null ? '—' : value}
        {value != null && unit ? <span className="ml-1 text-xs font-normal text-muted-foreground">{unit}</span> : null}
      </p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

export function RaterSpreadPanel({ data }: { data: RaterSpread | null }) {
  if (!data) return null;
  if (data.empty) {
    return (
      <div className="border rounded-xl p-5">
        <h2 className="font-semibold">การกระจายคะแนนผู้ตรวจ / Rater spread</h2>
        <p className="mt-2 text-sm text-muted-foreground">ยังไม่มีคะแนนจากผู้ตรวจ / No auditor scores yet.</p>
      </div>
    );
  }

  const c = data.comparison_on_shared;
  const domains = Object.entries(data.per_domain);

  return (
    <div className="border rounded-xl p-5 space-y-5">
      <div>
        <h2 className="font-semibold">
          การกระจายคะแนนผู้ตรวจ / Rater spread
          <span className="ml-2 text-sm font-normal text-muted-foreground">
            · {data.n_scores} scores · {data.n_episodes} episodes · {data.n_auditors} auditors
          </span>
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          ICC วัดว่าผู้ตรวจสองฝ่าย <em>จัดอันดับ</em> เคสเหมือนกันไหม / An ICC measures whether two raters
          rank the same episodes the same way. If the episodes barely differ, there is nothing to rank —
          and no evaluator can agree with a rating that does not discriminate.
        </p>
      </div>

      <GateReading gate={data.gate} />

      {/* Same episodes, both raters. A wide AI spread against a narrow human one is the signature of
          restriction of range rather than of the two disagreeing about which episode is better. */}
      {c.n > 0 && (
        <div>
          <h3 className="text-sm font-medium">ช่วงคะแนนบนเคสเดียวกัน / Range on the same {c.n} episodes</h3>
          <div className="mt-2 grid gap-3 @min-[560px]:grid-cols-2">
            <Figure label="ผู้ตรวจ (คน) / Human range" value={c.human_range} unit="pts" />
            <Figure label="AI / AI range" value={c.ai_range} unit="pts" />
          </div>
          {data.scale_use && (
            <p className="mt-2 text-xs text-muted-foreground">
              ใช้สเกลจริง {data.scale_use.span_pct_of_scale}% ของ 0–100 ({data.scale_use.min}–{data.scale_use.max})
              {' '}/ humans used {data.scale_use.span_pct_of_scale}% of the 0–100 composite.
            </p>
          )}
        </div>
      )}

      {/* Two different problems with two different fixes, deliberately not merged: a domain everyone
          scores IDENTICALLY is a discrimination problem; a domain everyone calls AMBIGUOUS is a
          rubric problem. */}
      <div>
        <h3 className="text-sm font-medium mb-2">รายด้าน / Per domain</h3>
        <Table label="รายด้าน / Per domain">
          <TableHeader>
            <TableRow className="border-border text-left">
              <TableHead className="h-auto py-2 pr-4 pl-0">ด้าน / Domain</TableHead>
              <TableHead className="h-auto py-2 pr-4 pl-0">SD</TableHead>
              <TableHead className="h-auto py-2 pr-4 pl-0">ค่าที่ใช้ซ้ำ / Modal</TableHead>
              <TableHead className="h-auto py-2 pl-0">ระบุว่ากำกวม / Ambiguous</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {domains.map(([d, v]) => {
              const anchor = data.anchor_clarity?.[d];
              const collapsed = v.distinct <= 1 && v.n > 1;
              return (
                <TableRow key={d} className="border-border/50">
                  <TableHead scope="row" className="h-auto py-2 pr-4 pl-0 uppercase">{d}</TableHead>
                  <TableCell className={`py-2 pr-4 pl-0 tabular-nums ${collapsed ? 'text-danger' : ''}`}>{v.sd ?? '—'}</TableCell>
                  <TableCell className="py-2 pr-4 pl-0 tabular-nums">
                    {v.modal_value ?? '—'}
                    {v.modal_share != null && (
                      <span className="ml-1 text-xs text-muted-foreground">{Math.round(v.modal_share * 100)}%</span>
                    )}
                  </TableCell>
                  <TableCell className="py-2 pl-0 tabular-nums">
                    {anchor == null || anchor.answered === 0
                      ? <span className="text-muted-foreground">ยังไม่ระบุ / not asked</span>
                      : `${anchor.ambiguous}/${anchor.answered}`}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {/* Per auditor, so one rater flattening the scale is distinguishable from everyone doing it. */}
      <div>
        <h3 className="text-sm font-medium mb-2">รายผู้ตรวจ / Per auditor</h3>
        <Table label="รายผู้ตรวจ / Per auditor">
          <TableHeader>
            <TableRow className="border-border text-left">
              <TableHead className="h-auto py-2 pr-4 pl-0">ผู้ตรวจ</TableHead>
              <TableHead className="h-auto py-2 pr-4 pl-0">n</TableHead>
              <TableHead className="h-auto py-2 pr-4 pl-0">เฉลี่ย / Mean</TableHead>
              <TableHead className="h-auto py-2 pr-4 pl-0">SD</TableHead>
              <TableHead className="h-auto py-2 pl-0">ช่วง / Range</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.per_auditor.map((a) => (
              <TableRow key={a.auditor_id} className="border-border/50">
                <TableHead scope="row" className="h-auto py-2 pr-4 pl-0 font-mono text-xs">{a.auditor_id.slice(0, 8)}</TableHead>
                <TableCell className="py-2 pr-4 pl-0 tabular-nums">{a.n}</TableCell>
                <TableCell className="py-2 pr-4 pl-0 tabular-nums">{a.mean ?? '—'}</TableCell>
                {/* SD 0 across more than one episode is one rater giving everything the same score. */}
                <TableCell className={`py-2 pr-4 pl-0 tabular-nums ${a.sd === 0 && a.n > 1 ? 'text-danger' : ''}`}>{a.sd ?? '—'}</TableCell>
                <TableCell className="py-2 pl-0 tabular-nums">{a.min ?? '—'}–{a.max ?? '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <p className="text-xs text-muted-foreground">
        ทุกตัวเลขเป็นสถิติเชิงพรรณนา ไม่ใช่การอนุมาน และ n ยังน้อยมาก / Every figure here is descriptive,
        not inferential, and n is small — read them with the counts beside them.
      </p>
    </div>
  );
}
