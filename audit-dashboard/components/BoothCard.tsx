'use client';
// Superadmin card for the Booth Mode event (#214): the switch, the window, the per-play ceiling, and the
// event's plays, scored plays and spend. It reads and writes GET/PATCH /admin/booth, and after every write
// it shows the server's echo, not the draft.
//
// Times are Bangkok wall-clock in the inputs and travel with an explicit +07:00 offset. The backend refuses
// a bare local time because the server runs in UTC, which would put the window seven hours off.
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { BiLabel } from '@/components/BiLabel';
import { Skeleton } from '@/components/Skeleton';
import { toast } from '@/components/Overlays';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { type ApiResult, type BoothSettings, type BoothState, formatApiError } from '@/lib/types';

// Thailand has no daylight saving, so a fixed offset is exact.
const BANGKOK_OFFSET = '+07:00';
const BANGKOK_MS = 7 * 3_600_000;
// Mirrors BoothSettingsPatch in backend/src/services/booth.js.
const CEILING_MAX_USD = 20;

/** Stored offset time -> the Bangkok wall-clock a datetime-local input shows. */
export function toBangkokInput(text: string | null): string {
  const ms = text ? Date.parse(text) : NaN;
  return Number.isNaN(ms) ? '' : new Date(ms + BANGKOK_MS).toISOString().slice(0, 16);
}

/** A datetime-local value (Bangkok wall-clock) -> the offset time the backend stores. '' clears it. */
export function fromBangkokInput(value: string): string | null {
  return value ? `${value}:00${BANGKOK_OFFSET}` : null;
}

const STATE_LABEL: Record<BoothState, { th: string; en: string; variant: 'ok' | 'secondary' | 'notice' | 'error' }> = {
  open: { th: 'เปิดรับผู้เล่น', en: 'Open', variant: 'ok' },
  off: { th: 'ปิดอยู่', en: 'Off', variant: 'secondary' },
  not_yet: { th: 'ยังไม่ถึงเวลาเปิด', en: 'Not open yet', variant: 'notice' },
  ended: { th: 'หมดเวลาแล้ว', en: 'Ended', variant: 'secondary' },
  misconfigured: { th: 'ตั้งค่าไม่ครบ', en: 'Misconfigured', variant: 'error' },
};

const count = (n: number | null) => (n == null ? '—' : n.toLocaleString('en-US'));
const money = (n: number | null) => (n == null ? '—' : `$${n.toFixed(2)}`);

type Draft = { opens?: string; closes?: string; ceiling?: string };

export function BoothCard() {
  const [booth, setBooth] = useState<BoothSettings | null>(null);
  const [loadError, setLoadError] = useState('');
  const [draft, setDraft] = useState<Draft>({});
  const [switching, setSwitching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  useEffect(() => {
    apiFetch<ApiResult<BoothSettings>>('/admin/booth').then((r) => {
      if (!r || r.error) setLoadError(formatApiError(r?.error, 'โหลดไม่สำเร็จ / Could not load the booth settings.'));
      else setBooth(r as BoothSettings);
    });
  }, []);

  async function patch(body: Partial<Record<'enabled' | 'opens_at' | 'closes_at' | 'ceiling_usd', unknown>>) {
    const r = await apiFetch<ApiResult<BoothSettings>>('/admin/booth', { method: 'PATCH', body: JSON.stringify(body) });
    if (!r || r.error || typeof r.enabled !== 'boolean') {
      return formatApiError(r?.error, 'บันทึกไม่สำเร็จ การตั้งค่าไม่เปลี่ยนแปลง / Could not save. The setting was not changed.');
    }
    setBooth(r as BoothSettings);
    return '';
  }

  async function toggle() {
    if (!booth || switching) return;
    setSwitching(true);
    try {
      const err = await patch({ enabled: !booth.enabled });
      if (err) toast(err, 'error');
    } finally {
      setSwitching(false);
    }
  }

  const opensShown = draft.opens ?? toBangkokInput(booth?.opens_at ?? null);
  const closesShown = draft.closes ?? toBangkokInput(booth?.closes_at ?? null);
  const ceilingShown = draft.ceiling ?? (booth?.ceiling_usd != null ? String(booth.ceiling_usd) : '');
  const dirty = Object.keys(draft).length > 0;

  async function save() {
    if (!booth || saving) return;
    const body: Record<string, unknown> = {};
    if (draft.opens !== undefined) body.opens_at = fromBangkokInput(draft.opens);
    if (draft.closes !== undefined) body.closes_at = fromBangkokInput(draft.closes);
    if (draft.ceiling !== undefined) {
      const c = Number(draft.ceiling);
      if (!draft.ceiling || !Number.isFinite(c) || c <= 0 || c > CEILING_MAX_USD) {
        setFormError(`เพดานต้องมากกว่า 0 และไม่เกิน $${CEILING_MAX_USD} / The ceiling must be above 0 and at most $${CEILING_MAX_USD}.`);
        return;
      }
      body.ceiling_usd = c;
    }
    // A half-deleted datetime-local reads as '' and would clear the window, which shuts a running booth.
    if (booth.enabled && (body.opens_at === null || body.closes_at === null)) {
      setFormError('ปิดสวิตช์ก่อนล้างช่วงเวลา / Switch the booth off before clearing its window.');
      return;
    }
    if (opensShown && closesShown && opensShown >= closesShown) {
      setFormError('เวลาปิดต้องอยู่หลังเวลาเปิด / Closes-at must be after opens-at.');
      return;
    }
    setFormError('');
    setSaving(true);
    try {
      const err = await patch(body);
      if (err) setFormError(err);
      else setDraft({});
    } finally {
      setSaving(false);
    }
  }

  const state = booth ? STATE_LABEL[booth.state] : null;

  return (
    <section className="space-y-3">
      <h2 className="font-heading text-xl text-foreground">
        Booth Mode{booth?.event_code ? ` · ${booth.event_code}` : ''}
      </h2>
      <div className="space-y-5 rounded-xl border p-5">
        {loadError ? <p className="text-sm text-danger">{loadError}</p> : !booth ? <Skeleton className="h-40 w-full" /> : (
          <>
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium">🎪 เปิดบูธ / Booth event switch</p>
                <p className="text-sm text-muted-foreground">
                  ตู้เกมรับผู้เล่นเฉพาะเมื่อเปิดสวิตช์และอยู่ในช่วงเวลาเท่านั้น •
                  The kiosk takes plays only while this is on and inside the window.
                </p>
                {state && (
                  <Badge variant={state.variant} className="mt-2 h-auto px-2.5" data-testid="booth-state">
                    {state.th} / {state.en}
                  </Badge>
                )}
              </div>
              <button
                type="button"
                onClick={toggle}
                aria-disabled={switching || undefined}
                aria-pressed={booth.enabled}
                aria-label="Booth event switch"
                className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors aria-disabled:cursor-wait aria-disabled:opacity-50 aria-disabled:focus-visible:opacity-100 ${booth.enabled ? 'bg-primary' : 'bg-muted'}`}
                title={booth.enabled ? 'Booth event is ON' : 'Booth event is OFF'}
              >
                <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${booth.enabled ? 'translate-x-6' : 'translate-x-1'}`} />
              </button>
            </div>

            <div className="grid gap-4 @min-[640px]:grid-cols-3">
              <div className="space-y-1">
                <label htmlFor="booth-opens" className="block text-sm font-medium"><BiLabel th="เวลาเปิด" en="Opens at" /></label>
                <Input id="booth-opens" type="datetime-local"
                  className="tabular-nums"
                  value={opensShown} onChange={(e) => setDraft((d) => ({ ...d, opens: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <label htmlFor="booth-closes" className="block text-sm font-medium"><BiLabel th="เวลาปิด" en="Closes at" /></label>
                <Input id="booth-closes" type="datetime-local"
                  className="tabular-nums"
                  value={closesShown} onChange={(e) => setDraft((d) => ({ ...d, closes: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <label htmlFor="booth-ceiling" className="block text-sm font-medium"><BiLabel th="เพดานต่อการเล่น ($)" en="Per-play ceiling ($)" /></label>
                <Input id="booth-ceiling" type="number" inputMode="decimal" min={0.01} max={CEILING_MAX_USD} step={0.01}
                  className="tabular-nums"
                  value={ceilingShown} onChange={(e) => setDraft((d) => ({ ...d, ceiling: e.target.value }))} />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <p className="min-w-0 flex-[1_1_20rem] text-sm text-muted-foreground">
                เวลาประเทศไทย (UTC+07:00) • Bangkok time, saved with an explicit +07:00 offset.
              </p>
              <button type="button" onClick={save} disabled={!dirty || saving}
                className="shrink-0 rounded-md border border-field px-3 py-1.5 text-sm font-medium text-foreground hover:bg-secondary disabled:opacity-50">
                {saving ? 'กำลังบันทึก… / Saving…' : 'บันทึก / Save'}
              </button>
            </div>
            {formError && <p role="alert" className="text-sm text-danger">{formError}</p>}

            <div role="group" aria-label="Booth totals">
              <dl className="grid grid-cols-1 gap-3 @min-[480px]:grid-cols-3">
                {([['การเล่น', 'Plays', count(booth.plays)], ['ให้คะแนนแล้ว', 'Scored', count(booth.scored)], ['ค่าใช้จ่าย AI', 'Spend', money(booth.spend_usd)]] as const)
                  .map(([th, en, value]) => (
                    <div key={en} className="rounded-lg border p-3">
                      <dt className="text-xs text-muted-foreground"><BiLabel th={th} en={en} /></dt>
                      <dd className="mt-1 text-xl font-bold tabular-nums text-foreground">{value}</dd>
                    </div>
                  ))}
              </dl>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
