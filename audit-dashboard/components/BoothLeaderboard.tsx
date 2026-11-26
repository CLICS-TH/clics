'use client';
// The Booth Mode page's leaderboard (GET /admin/booth/standings): every scored play of the event, overall, per Bangkok
// day (owner, 2026-11-26: a prize for each day's top player) and per case, in the kiosk's own order. The server sends each list ranked; nothing here re-sorts, so a rank on this page is
// the rank the visitor was told. Every row is shown (the kiosk shows ten), with the count.
//
// It refreshes itself every 60 s while the tab is visible, and once on coming back to a tab left longer than that.
// A refresh that fails keeps the last board on screen and says so; only a board that never loaded shows the error.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { apiFetch } from '@/lib/api';
import { BiLabel } from '@/components/BiLabel';
import { useIsMobile } from '@/components/ViewportProvider';
import { StateMessage } from '@/components/ui/state-message';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { radioKeys } from '@/lib/radio-keys';
import { bangkokDayKey, bangkokDayLabel, bangkokDayTime, bangkokTime, boothDays, playerTag, playerTagTh, rawScore, shownScore } from '@/lib/booth';
import { type ApiResult, type BoothStanding, type BoothStandings, type BoothStandingsCase, formatApiError } from '@/lib/types';

export const REFRESH_MS = 60_000;
const LOAD_ERROR = 'โหลดกระดานคะแนนไม่สำเร็จ / Could not load the leaderboard.';

type View = 'overall' | 'day' | 'case';
const VIEWS: { key: View; th: string; en: string }[] = [
  { key: 'overall', th: 'รวมทุกเคส', en: 'Overall' },
  { key: 'day', th: 'รายวัน', en: 'By day' },
  { key: 'case', th: 'รายเคส', en: 'By case' },
];

const rowCount = (n: number) => `${n.toLocaleString('en-US')} แถว / ${n.toLocaleString('en-US')} ${n === 1 ? 'row' : 'rows'}`;

// BiLabel's markup, with the line free to break only between the halves or after หมายเลข: a break before the number
// left it on the next line beside the English ("หมายเลขผู้เข้าร่วม" / "120 Participant #120"). A 320px phone sets a
// four-digit number as หมายเลข / ผู้เข้าร่วม 1234.
function Player({ tag }: { tag: number }) {
  const [word, rest] = playerTagTh(tag);
  return (
    <span>
      <span className="whitespace-nowrap">{word}</span><wbr />
      <span className="whitespace-nowrap">{rest}</span>{' '}
      <span className="whitespace-nowrap text-[length:max(0.8em,12px)] font-normal">{playerTag(tag, 'en')}</span>
    </span>
  );
}

// The display score is the number the visitor saw, so it carries the row; the raw composite the ranking uses sits
// small beside it for the operator who needs to break a tie by eye. lining-nums: Cormorant sets old-style figures by
// default, where a 0 reads as a lowercase o and a 9 drops below the line.
function Score({ row }: { row: BoothStanding }) {
  return (
    <span className="inline-flex items-baseline gap-2 tabular-nums">
      <span className="font-heading text-2xl font-semibold leading-none text-foreground lining-nums tabular-nums">{shownScore(row.score)}</span>
      <span className="text-xs text-muted-foreground"><span className="sr-only">ดิบ / raw </span>{rawScore(row.raw)}</span>
    </span>
  );
}

function Rows({ rows, label, showCase }: { rows: BoothStanding[]; label: string; showCase: boolean }) {
  const mobile = useIsMobile();
  // Phones get a list, not a table: five columns cannot fit 320px, and a sideways-scrolling table on a touch screen
  // is the failure scripts/responsive/mobile-audit.mjs reports.
  if (mobile) {
    return (
      <ol aria-label={label} className="divide-y rounded-xl border">
        {rows.map((r) => (
          <li key={`${r.rank}-${r.tag}`} className="flex items-center gap-3 px-4 py-3">
            <span className="w-8 shrink-0 text-sm font-semibold tabular-nums text-foreground">{r.rank}</span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground"><Player tag={r.tag} /></p>
              <p className="text-sm text-muted-foreground tabular-nums [overflow-wrap:anywhere]">
                {showCase && r.case_id ? `${r.case_id} ` : ''}{bangkokDayTime(r.scored_at)}
              </p>
            </div>
            <Score row={r} />
          </li>
        ))}
      </ol>
    );
  }
  return (
    <div className="rounded-xl border">
      <Table label={label}>
        <TableHeader>
          <TableRow>
            <TableHead num className="w-16 pl-4"><BiLabel th="อันดับ" en="Rank" /></TableHead>
            <TableHead><BiLabel th="ผู้เข้าร่วม" en="Participant" /></TableHead>
            <TableHead><BiLabel th="คะแนน (ดิบ)" en="Score (raw)" /></TableHead>
            {showCase && <TableHead><BiLabel th="เคส" en="Case" /></TableHead>}
            <TableHead className="pr-4"><BiLabel th="เวลาที่ได้คะแนน" en="Scored" /></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={`${r.rank}-${r.tag}`}>
              <TableCell num className="pl-4 font-semibold text-foreground">{r.rank}</TableCell>
              <TableCell className="text-foreground"><Player tag={r.tag} /></TableCell>
              <TableCell><Score row={r} /></TableCell>
              {showCase && <TableCell className="text-muted-foreground [overflow-wrap:anywhere]">{r.case_id ?? '—'}</TableCell>}
              <TableCell className="pr-4 text-muted-foreground tabular-nums">{bangkokDayTime(r.scored_at)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function Board({ rows, label, showCase, empty }: { rows: BoothStanding[]; label: string; showCase: boolean; empty: string }) {
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground tabular-nums" data-testid="booth-row-count">{rowCount(rows.length)}</p>
      {rows.length === 0 ? <StateMessage kind="empty" title={empty} /> : <Rows rows={rows} label={label} showCase={showCase} />}
    </div>
  );
}

interface PickItem { key: string; title: ReactNode; meta: ReactNode[] }

/** A radio list down the side of the board: one tab stop, arrows move the choice. */
function Picker({ label, items, current, onPick }: { label: string; items: PickItem[]; current: string; onPick: (key: string) => void }) {
  const keys = items.map((i) => i.key);
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="flex flex-col gap-2"
      onKeyDown={radioKeys(keys, current, onPick)}
    >
      {items.map((item) => {
        const on = item.key === current;
        return (
          <button
            key={item.key}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onPick(item.key)}
            className={`w-full rounded-lg border px-4 py-3 text-left transition-colors
              ${on ? 'border-primary bg-secondary ring-2 ring-inset ring-primary' : 'border-field hover:bg-muted'}`}
          >
            <span className="block text-sm font-medium text-foreground">{item.title}</span>
            <span className="mt-1 flex flex-wrap gap-x-3 text-sm text-muted-foreground tabular-nums">
              {item.meta.map((m, i) => <span key={i} className="[overflow-wrap:anywhere]">{m}</span>)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function CasePicker({ cases, current, onPick }: { cases: BoothStandingsCase[]; current: string; onPick: (id: string) => void }) {
  return (
    <Picker label="เลือกเคส / Choose a case" current={current} onPick={onPick} items={cases.map((c) => ({
      key: c.case_id,
      title: c.teaser ? c.teaser.th : <BiLabel th="เคสที่ถอดออกจากชุดแล้ว" en="Retired case" />,
      meta: [`${c.case_id}${c.version ? ` ${c.version}` : ''}`, rowCount(c.rows.length)],
    }))} />
  );
}

/** The event's days, newest first; `today` is the Bangkok day of the board's own clock (generated_at). */
function DayPicker({ days, today, current, onPick }: { days: { day: string; rows: BoothStanding[] }[]; today: string | null; current: string; onPick: (day: string) => void }) {
  return (
    <Picker label="เลือกวัน / Choose a day" current={current} onPick={onPick} items={days.map((d) => ({
      key: d.day,
      title: <BiLabel th={`${bangkokDayLabel(d.day, 'th')}${d.day === today ? ' · วันนี้' : ''}`} en={`${bangkokDayLabel(d.day, 'en')}${d.day === today ? ' · Today' : ''}`} />,
      meta: [rowCount(d.rows.length)],
    }))} />
  );
}

export function BoothLeaderboard({ onLoad }: { onLoad?: (s: BoothStandings) => void }) {
  const [data, setData] = useState<BoothStandings | null>(null);
  const [error, setError] = useState('');
  const [view, setView] = useState<View>('overall');
  const [picked, setPicked] = useState<string | null>(null);
  const [pickedDay, setPickedDay] = useState<string | null>(null);
  const inflight = useRef(false);
  const loadedAt = useRef(0);
  const onLoadRef = useRef(onLoad);
  useEffect(() => { onLoadRef.current = onLoad; }, [onLoad]);

  // Promise-chain form: react-hooks/set-state-in-effect does not treat `await` as deferring (LocalAiCapacityCard).
  const load = useCallback(() => {
    if (inflight.current) return Promise.resolve();
    inflight.current = true;
    return apiFetch<ApiResult<BoothStandings>>('/admin/booth/standings').then((r) => {
      inflight.current = false;
      if (!r) return;   // 401: the page is on its way to the sign-in
      if (r.error || !Array.isArray(r.overall) || !Array.isArray(r.cases)) {
        setError(formatApiError(r.error, LOAD_ERROR));
        return;
      }
      const s = r as BoothStandings;
      loadedAt.current = Date.now();
      setError('');
      setData(s);
      onLoadRef.current?.(s);
    });
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - loadedAt.current >= REFRESH_MS) void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [load]);

  const caseId = data && (data.cases.some((c) => c.case_id === picked) ? picked : data.cases[0]?.case_id) || null;
  const current = data?.cases.find((c) => c.case_id === caseId) ?? null;
  // Each day ranks its own plays from 1 (lib/booth boothDays); the newest day is chosen first.
  const days = data ? boothDays(data.overall) : [];
  const today = data ? bangkokDayKey(data.generated_at) : null;
  const day = days.find((d) => d.day === pickedDay) ?? days[0] ?? null;

  // The tablist contract: one tab stop, and Left/Right move to (and show) the neighbouring tab.
  function onTabKey(e: KeyboardEvent<HTMLDivElement>) {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = VIEWS[(VIEWS.findIndex((v) => v.key === view) + step + VIEWS.length) % VIEWS.length].key;
    setView(next);
    e.currentTarget.querySelector<HTMLElement>(`[data-view="${next}"]`)?.focus();
  }

  return (
    <section className="space-y-4" aria-labelledby="booth-board-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <h2 id="booth-board-heading" className="font-heading text-2xl font-semibold text-foreground">
          <BiLabel th="กระดานคะแนน" en="Leaderboard" />
        </h2>
        {data && (
          <p className="text-sm text-muted-foreground tabular-nums" data-testid="booth-updated">
            อัปเดต {bangkokTime(data.generated_at)} น. / Updated {bangkokTime(data.generated_at)}
          </p>
        )}
      </div>

      {!data ? (
        error
          ? <StateMessage kind="error" title={LOAD_ERROR} onRetry={() => void load()}>{error !== LOAD_ERROR ? error : null}</StateMessage>
          : <StateMessage kind="loading" title="กำลังโหลดกระดานคะแนน… / Loading the leaderboard…" />
      ) : (
        <>
          {error && (
            <StateMessage kind="notice" title="รีเฟรชไม่สำเร็จ กระดานด้านล่างเป็นข้อมูลรอบก่อน / Could not refresh. The board below is the last one that loaded."
              onRetry={() => void load()}>{error !== LOAD_ERROR ? error : null}</StateMessage>
          )}

          <div role="tablist" aria-label="มุมมองกระดานคะแนน / Leaderboard view" onKeyDown={onTabKey}
            className="grid grid-cols-3 gap-1 rounded-lg border border-field p-1 sm:inline-flex">
            {VIEWS.map((v) => {
              const on = v.key === view;
              return (
                <button
                  key={v.key}
                  type="button"
                  role="tab"
                  id={`booth-tab-${v.key}`}
                  data-view={v.key}
                  aria-selected={on}
                  aria-controls="booth-board-panel"
                  tabIndex={on ? 0 : -1}
                  onClick={() => setView(v.key)}
                  className={`whitespace-nowrap rounded-md px-1 py-2 text-center text-sm transition-colors sm:px-4
                    ${on ? 'bg-coral-active font-medium text-primary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
                >
                  {/* Three tabs share a phone's width, so there the English sits under the Thai, each half whole. */}
                  <span className="block sm:inline">{v.th}</span>
                  <span className="block text-[length:max(0.8em,12px)] font-normal sm:ml-1 sm:inline">{v.en}</span>
                </button>
              );
            })}
          </div>

          <div role="tabpanel" id="booth-board-panel" aria-labelledby={`booth-tab-${view}`}>
            {view === 'overall' ? (
              <Board rows={data.overall} showCase label="กระดานคะแนนรวม / Overall leaderboard"
                empty="ยังไม่มีการเล่นที่ได้คะแนน / No scored play yet." />
            ) : view === 'day' ? (
              !day ? (
                <StateMessage kind="empty" title="ยังไม่มีการเล่นที่ได้คะแนน / No scored play yet." />
              ) : (
                <div className="grid grid-cols-1 gap-6 @min-[1024px]:grid-cols-[18rem_minmax(0,1fr)]">
                  <DayPicker days={days} today={today} current={day.day} onPick={setPickedDay} />
                  <Board rows={day.rows} showCase
                    label={`กระดานคะแนน ${bangkokDayLabel(day.day, 'th')} / Leaderboard for ${bangkokDayLabel(day.day, 'en')}`}
                    empty="วันนี้ยังไม่มีการเล่นที่ได้คะแนน / No scored play on this day yet." />
                </div>
              )
            ) : data.cases.length === 0 || !current ? (
              <StateMessage kind="empty" title="งานนี้ยังไม่มีเคส / This event has no cases." />
            ) : (
              <div className="grid grid-cols-1 gap-6 @min-[1024px]:grid-cols-[18rem_minmax(0,1fr)]">
                <CasePicker cases={data.cases} current={current.case_id} onPick={setPicked} />
                <Board rows={current.rows} showCase={false}
                  label={`กระดานคะแนนเคส ${current.case_id} / Leaderboard for ${current.case_id}`}
                  empty="เคสนี้ยังไม่มีการเล่นที่ได้คะแนน / No scored play in this case yet." />
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
