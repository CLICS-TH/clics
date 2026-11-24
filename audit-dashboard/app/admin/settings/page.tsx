'use client';
// Superadmin Settings: the controls that sat on the overview, moved here (owner, 2026-11-24) so the overview reads
// without a stray tap changing anything. Booth Mode has its own page (/admin/booth).
//   AI      which model serves each purpose (AiProviderPanel; Model Lock links to #ai-provider) and the local
//           model's capacity (LocalAiCapacityCard)
//   Rules   the minimum auditors per PLE, then the five on/off rules as one list
//   Export  the pilot XLSX workbook
//
// LOADING. apiFetch never rejects: a failed GET of /admin/usage-settings resolves to {error}, which is truthy. The
// overview used to test `!usage` and so enabled every switch over an object holding no values, showing OFF while
// the server might hold ON, one tap from writing the wrong value. Here only a response without `error` counts as
// loaded; until one arrives every control backed by these settings is disabled and the page says what failed.
//
// SAVING. See lib/settings-patch.ts: a write is trusted only when the API echoes it back, and the echo, not the
// request, goes into state. A control whose save is in flight is aria-disabled, never `disabled` (that would blur
// the control a keyboard user just pressed), and a second write to the same key waits for the first to land.
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiDownload, apiFetch } from '@/lib/api';
import { getUser } from '@/lib/auth';
import { patchUsageSetting } from '@/lib/settings-patch';
import { radioKeys } from '@/lib/radio-keys';
import { type ApiResult, type UsageSettings, formatApiError } from '@/lib/types';
import { PageIntro } from '@/components/PageIntro';
import { BiLabel } from '@/components/BiLabel';
import { AiProviderPanel } from '@/components/AiProviderPanel';
import { LocalAiCapacityCard } from '@/components/LocalAiCapacityCard';
import { toast } from '@/components/Overlays';
import { StateMessage } from '@/components/ui/state-message';
import { Switch } from '@/components/ui/switch';

type RuleKey = 'pilot_test_mode' | 'clinical_artifacts_enabled' | 'peer_calibration_enabled' | 'hold_result_until_audited' | 'calibration_reveal_locked';

// One line each; the longer reasoning lives in the docs (HANDOFF, G0.5-HUMAN-RATER-PREP).
const RULES: { key: RuleKey; th: string; en: string; desc: string }[] = [
  { key: 'pilot_test_mode', th: 'โหมดทดสอบ Pilot', en: 'Pilot test mode',
    desc: 'PLE ใหม่เป็นเซสชันทดสอบ ไม่นับในข้อมูลจริง ข้ามลิมิต 3 PLE และแพทย์เลือก Natural หรือ Socratic เองได้ • New PLEs are test sessions outside the real data, skip the 3-PLE cap, and let the physician pick Natural or Socratic.' },
  { key: 'clinical_artifacts_enabled', th: 'รายงานคลินิกแบบ artifact', en: 'Clinical artifacts',
    // ผังการตัดสินใจ, not อัลกอริทึม or ผังขั้นตอน: Chromium splits the loanword mid-word (อัลกอริ / ทึม) and the
    // compound at the line end (ผังขั้น / ตอน), which reads as a different word.
    desc: 'AI แสดงตาราง DDx แผนการรักษา และผังการตัดสินใจในแผงด้านข้าง ซึ่งเปลี่ยนสิ่งที่แพทย์ทุกคนเห็น • The AI puts differential tables, care plans and decision flowcharts in a side panel, which changes what every physician sees.' },
  { key: 'peer_calibration_enabled', th: 'การปรับเทียบระหว่างผู้ประเมิน', en: 'Peer calibration',
    desc: 'มอบหมาย PLE เดียวกันให้ผู้ประเมินหลายคน และหลังส่งคะแนนแต่ละคนเห็นเรดาร์เทียบกับค่าเฉลี่ยของผู้ประเมิน • A PLE can go to several auditors, and after submitting each one sees a radar against the auditors’ average.' },
  { key: 'hold_result_until_audited', th: 'ระงับผลจนกว่าผู้ตรวจจะให้คะแนน', en: 'Hold result until audited',
    desc: 'แพทย์ไม่เห็นคะแนน PIS-7 จนกว่าผู้ตรวจจะส่งคะแนนของ PLE นั้น เปิดเฉพาะช่วงรอบทดสอบแบบปิดบัง • Physicians see no PIS-7 score until an auditor has scored that PLE. Keep it on only for a blinded test round.' },
  { key: 'calibration_reveal_locked', th: 'ปิดการเผยคะแนน AI ตลอดรอบสอบเทียบ', en: 'Lock AI reveal for the round',
    desc: 'ผู้ตรวจไม่เห็นคะแนน AI การสนทนากับ AI ค่าเฉลี่ยเพื่อน และค่าความสอดคล้องกับ AI จนกว่าจะปิดสวิตช์ เปิดก่อนเริ่มรอบ ไม่ใช่ระหว่างรอบ • Auditors see no AI score, AI discussion, peer average or AI agreement until it is switched off. Turn it on before the round starts, not during it.' },
];

// The API accepts 1-10; the control offers 1-3. A value set elsewhere (e.g. 5) checks no option.
const MIN_AUDITOR_CHOICES = [1, 2, 3];
const LOAD_ERROR = 'โหลดการตั้งค่าไม่สำเร็จ / Could not load the settings.';

// While a control's save runs it stays focusable (aria-disabled). The dimming skips the keyboard-focused control,
// because opacity would fade its focus ring too.
const BUSY = 'aria-disabled:cursor-wait aria-disabled:opacity-50 aria-disabled:focus-visible:opacity-100';

function SectionHeading({ id, th, en }: { id: string; th: string; en?: string }) {
  return (
    <h2 id={id} className="font-heading text-2xl font-semibold text-foreground">
      <BiLabel th={th} en={en} />
    </h2>
  );
}

export default function SettingsPage() {
  const router = useRouter();
  const uid = useId();
  const [usage, setUsage] = useState<UsageSettings | null>(null);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState<Partial<Record<keyof UsageSettings, true>>>({});
  // The in-flight guard reads a ref, not state: two presses inside one render would both see stale state.
  const inflight = useRef(new Set<keyof UsageSettings>());

  const fetchUsage = useCallback(() => apiFetch<ApiResult<UsageSettings>>('/admin/usage-settings').then((r) => {
    if (!r) return;   // 401: the page is on its way to the sign-in
    if (r.error) { setLoadError(formatApiError(r.error, LOAD_ERROR)); return; }
    setLoadError('');
    setUsage(r as UsageSettings);
  }), []);

  useEffect(() => {
    // Settings are superadmin-only; everyone else lands back on /home.
    if (getUser()?.role !== 'superadmin') { router.push('/home'); return; }
    void fetchUsage();
  }, [router, fetchUsage]);

  function retry() {
    setLoadError('');
    void fetchUsage();
  }

  const loaded = usage !== null;

  async function patchSetting<K extends keyof UsageSettings>(key: K, value: UsageSettings[K]) {
    if (!usage || inflight.current.has(key)) return;
    inflight.current.add(key);
    setSaving((s) => ({ ...s, [key]: true }));
    try {
      const r = await patchUsageSetting(key, value);
      if (r.status === 'failed') {
        const why = r.reason ? ` (${r.reason})` : '';
        toast(`บันทึกไม่สำเร็จ การตั้งค่าไม่เปลี่ยนแปลง / Could not save — the setting was not changed.${why}`, 'error');
        return;
      }
      setUsage((u) => (u ? { ...u, [key]: r.value } : u));
      if (r.status === 'mismatch') {
        toast('บันทึกแล้ว แต่เซิร์ฟเวอร์รายงานค่าที่ต่างจากที่ตั้ง กรุณารีโหลดหน้า / Saved, but the server reports a different value than the one you set. Reload the page to check.', 'error');
      }
    } finally {
      inflight.current.delete(key);
      setSaving((s) => { const n = { ...s }; delete n[key]; return n; });
    }
  }

  // ---- Minimum auditors per PLE ----
  // A TARGET, not a gate. The manuscript describes >= 3 blinded auditors per PLE, but some specialties have no
  // eligible auditor, so a blocking rule would strand their credit. Raising it badges PLEs below target in the
  // queue and states the rater distribution in the ICC report; it never withholds a score.
  // Not loaded: nothing is checked, so the screen claims no value it has not read.
  const minAuditors = usage ? (usage.min_auditors_per_cle ?? 1) : null;
  const minAudStop = minAuditors != null && MIN_AUDITOR_CHOICES.includes(minAuditors) ? minAuditors : MIN_AUDITOR_CHOICES[0];
  const minAudSaving = !!saving.min_auditors_per_cle;
  function setMinAuditors(n: number) {
    if (n === minAuditors || n < 1 || n > 10) return;
    void patchSetting('min_auditors_per_cle', n);
  }

  // ---- Export ----
  const [exporting, setExporting] = useState(false);
  const [exportErr, setExportErr] = useState('');
  async function exportXlsx() {
    setExporting(true); setExportErr('');
    const res = await apiDownload('/admin/export.xlsx', 'clics-export.xlsx');
    if (res.error) setExportErr(res.error);
    setExporting(false);
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-12 p-6 md:p-10">
      <PageIntro
        eyebrow="Superadmin · Settings"
        title="การตั้งค่า / Settings"
        subtitle="AI กติกา และการส่งออกข้อมูลของ pilot แต่ละสวิตช์บันทึกทันทีที่แตะ / The pilot's AI, its rules and the data export. Each switch saves the moment it is used."
      />

      {loadError && (
        <StateMessage kind="error" title={LOAD_ERROR} onRetry={retry} data-testid="settings-load-error">
          {loadError !== LOAD_ERROR && <p>{loadError}</p>}
          <p>สวิตช์และตัวเลือกด้านล่างจะกดไม่ได้และยังไม่แสดงค่าที่บันทึกไว้ จนกว่าจะโหลดสำเร็จ • The switches and choices below stay locked, and do not show the saved values, until the settings load.</p>
        </StateMessage>
      )}

      {/* ---- AI ---- */}
      <section aria-labelledby={`${uid}-ai`} className="space-y-8">
        <SectionHeading id={`${uid}-ai`} th="AI" />
        <AiProviderPanel />
        {/* It saves through the same PATCH and hands the re-read settings back, so the rules below stay in step. */}
        <LocalAiCapacityCard usage={usage} onChange={setUsage} />
      </section>

      {/* ---- Rules ---- */}
      <section aria-labelledby={`${uid}-rules`} className="space-y-4">
        <SectionHeading id={`${uid}-rules`} th="กติกา" en="Rules" />
        <ul className="divide-y rounded-xl border">
          {/* The description keeps a 24rem basis: where it cannot have that much room beside the choices they wrap
              below it, rather than squeezing Thai into a narrow column. */}
          <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 px-5 py-4">
            <div className="min-w-0 flex-[1_1_24rem]">
              <p id={`${uid}-min-title`} className="text-sm font-medium text-foreground">
                <BiLabel th="ผู้ตรวจขั้นต่ำต่อ PLE" en="Minimum auditors per PLE" />
              </p>
              <p id={`${uid}-min-desc`} className="mt-0.5 text-sm text-muted-foreground">
                เป้าหมาย ไม่ใช่เงื่อนไข: PLE ที่มีผู้ตรวจน้อยกว่านี้ถูกทำเครื่องหมายในคิว แต่ผลยังปล่อยตามปกติ •
                A target, not a gate: PLEs below it are badged in the queue, and their score still releases.
              </p>
            </div>
            {/* One tab stop (the checked option) and arrows to move, the radiogroup contract; an arrow selects and
                saves, as a radio does. Separate bordered options: a joined segment's overflow-hidden clipped the
                focus outline. */}
            <div
              role="radiogroup"
              aria-label="Minimum auditors per PLE"
              aria-describedby={`${uid}-min-desc`}
              className="flex shrink-0 flex-wrap gap-2"
              // Built inside the handler, not during render: setMinAuditors reaches the in-flight ref.
              onKeyDown={(e) => radioKeys(MIN_AUDITOR_CHOICES, minAuditors, setMinAuditors)(e)}
            >
              {MIN_AUDITOR_CHOICES.map((n) => {
                const on = n === minAuditors;
                return (
                  <button
                    key={n}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    tabIndex={n === minAudStop ? 0 : -1}
                    disabled={!loaded}
                    aria-disabled={minAudSaving || undefined}
                    onClick={() => setMinAuditors(n)}
                    className={`min-w-11 rounded-lg border px-4 py-2 text-sm tabular-nums transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${BUSY}
                      ${on ? 'border-primary bg-primary/15 font-semibold text-foreground ring-2 ring-inset ring-primary' : 'border-field text-muted-foreground hover:bg-muted hover:text-foreground'}`}
                  >
                    {n}
                  </button>
                );
              })}
            </div>
          </li>

          {RULES.map((rule) => {
            const titleId = `${uid}-${rule.key}-title`;
            const descId = `${uid}-${rule.key}-desc`;
            return (
              // Title and switch share the first row; the description runs full width under them on a phone and
              // beside the switch once there is room. The switch's -my-2.5 lets its 44px target overhang the
              // row's padding instead of pushing the description down.
              <li key={rule.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-1 px-5 py-4">
                <p id={titleId} className="text-sm font-medium text-foreground">
                  <BiLabel th={rule.th} en={rule.en} />
                </p>
                <Switch
                  checked={usage?.[rule.key] === true}
                  onCheckedChange={(next) => void patchSetting(rule.key, next)}
                  busy={!!saving[rule.key]}
                  disabled={!loaded}
                  aria-labelledby={titleId}
                  aria-describedby={descId}
                  className="-my-2.5 @min-[640px]:row-span-2 @min-[640px]:my-0 @min-[640px]:self-center"
                />
                <p id={descId} className="col-span-2 text-sm text-muted-foreground @min-[640px]:col-span-1">{rule.desc}</p>
              </li>
            );
          })}
        </ul>
      </section>

      {/* ---- Export ---- */}
      {/* One XLSX workbook, a sheet per category. Pseudonymized (no names), so it honours the PII boundary. */}
      <section aria-labelledby={`${uid}-export`} className="space-y-4">
        <SectionHeading id={`${uid}-export`} th="ส่งออก" en="Export" />
        {/* Stacks below a 480px container: side by side, the shrink-0 button ran to 347px on a 320px phone. */}
        <div className="flex flex-col items-start gap-4 rounded-xl border px-5 py-4 @min-[480px]:flex-row @min-[480px]:items-center @min-[480px]:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground"><BiLabel th="ข้อมูล pilot (XLSX)" en="Pilot data (XLSX)" /></p>
            <p className="mt-0.5 text-sm text-muted-foreground">
              สมุดงาน Excel หนึ่งไฟล์ แยกชีตตามหมวด ใช้รหัสแทนชื่อ (P-NNN / EXP-NNN) •
              One workbook, a sheet per category (PLEs, AI evaluations, auditor scores, compensation, participants). Pseudonymized: no names leave the system.
            </p>
            {exportErr && <p role="alert" className="mt-1 text-sm text-danger">{exportErr}</p>}
          </div>
          {/* bg-coral-active, the button-fill token: white on bright --primary measures 3.28:1. */}
          <button
            type="button"
            onClick={exportXlsx}
            disabled={exporting}
            className="shrink-0 whitespace-nowrap rounded-md bg-coral-active px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity disabled:opacity-50"
          >
            {exporting ? 'กำลังสร้าง… / Building…' : 'ดาวน์โหลด / Download'}
          </button>
        </div>
      </section>
    </div>
  );
}
