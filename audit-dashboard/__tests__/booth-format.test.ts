// lib/booth.ts: how the Booth Mode page writes a player, a score, a time and the export's file name. The player
// and the score must read as the kiosk shows them (physician-ui/public/js/booth-copy.js tagText, scoreText), and
// the file name as the backend names it (backend/src/services/booth-monitor.js exportPlays).
import path from 'path';
import { bangkokDayKey, bangkokDayLabel, bangkokDayTime, bangkokTime, boothDays, boothExportFilename, playerTag, playerTagTh, rawScore, rowScore, shownScore, TIER_POINTS, TIER_STEPS, tierScore } from '@/lib/booth';

// The backend's scale, read as the backend runs it: the dashboard's copy must agree on every path.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const backend = require(path.join(__dirname, '..', '..', 'backend', 'src', 'booth-cases', 'display-score.js')) as {
  TIER_SCALE: { steps: number; points: Record<string, number> };
  tierScore: (p: unknown) => number | null;
};
const allPaths = (n: number): string[] => (n === 0 ? [''] : allPaths(n - 1).flatMap((p) => ['B', 'R', 'W'].map((l) => p + l)));

describe('booth formatting', () => {
  it('pads the participant number to three digits, in both languages, and never cuts a longer one', () => {
    expect(playerTag(42, 'th')).toBe('หมายเลขผู้เข้าร่วม 042');
    expect(playerTagTh(1234)).toEqual(['หมายเลข', 'ผู้เข้าร่วม 1234']);
    expect(playerTag(42, 'en')).toBe('Participant #042');
    expect(playerTag(7, 'en')).toBe('Participant #007');
    expect(playerTag(1234, 'en')).toBe('Participant #1234');
  });

  it('shows the shown score rounded, as the kiosk does, and the raw composite to one decimal', () => {
    expect(shownScore(87.4)).toBe('87');
    expect(shownScore(87.5)).toBe('88');
    expect(shownScore(0)).toBe('0');
    expect(rawScore(61.24)).toBe('61.2');
    expect(rawScore(40)).toBe('40.0');
    expect(rawScore(Number.NaN)).toBe('—');
  });

  it('scores a five-step tier path as the backend does (ADR 0016): best 20, reasonable 10, weaker 0', () => {
    expect(TIER_STEPS).toBe(backend.TIER_SCALE.steps);
    expect(TIER_POINTS).toEqual(backend.TIER_SCALE.points);
    const paths = allPaths(5);
    expect(paths).toHaveLength(243);
    for (const p of paths) expect(tierScore(p)).toBe(backend.tierScore(p));
    expect(tierScore('BBBBB')).toBe(100);
    expect(tierScore('WWWWW')).toBe(0);
    for (const odd of [null, undefined, '', 'BBBB', 'BBBBBB', 'BBBBX', 'toStr']) expect(tierScore(odd)).toBe(backend.tierScore(odd) ?? null);
    expect(tierScore('BBBBX')).toBeNull();
  });

  it('shows a five-step row its tier score, and any other row the score the server sent', () => {
    expect(rowScore({ score: 63, tier_path: 'BBBBB' }, 5)).toBe(100);
    expect(rowScore({ score: 63, tier_path: null }, 5)).toBe(63);
    expect(rowScore({ score: 63 }, 5)).toBe(63);
    expect(rowScore({ score: 72.4, tier_path: 'BBB' }, 3)).toBe(72.4);
  });

  it('writes times as Bangkok wall-clock, whatever zone the machine is in', () => {
    // 07:05 UTC is 14:05 in Bangkok (UTC+7, no daylight saving).
    expect(bangkokDayTime('2026-11-24T07:05:00Z')).toBe('24 พ.ย. 14:05');
    expect(bangkokTime('2026-11-24T07:05:00Z')).toBe('14:05');
    // Past 17:00 UTC it is already the next day in Bangkok.
    expect(bangkokDayTime('2026-11-24T17:30:00Z')).toBe('25 พ.ย. 00:30');
    expect(bangkokDayTime('not a date')).toBe('—');
    expect(bangkokTime('not a date')).toBe('—');
  });

  it('names the export as the server does: the event code made safe, and the Bangkok date', () => {
    const lateEvening = new Date('2026-11-24T20:00:00Z');   // 03:00 on the 25th in Bangkok
    expect(boothExportFilename('NFCME-2026', lateEvening)).toBe('clics-booth-NFCME-2026-2026-11-25.json');
    expect(boothExportFilename('NFCME 2026/บ', lateEvening)).toBe('clics-booth-NFCME_2026__-2026-11-25.json');
    expect(boothExportFilename(null, lateEvening)).toBe('clics-booth-none-2026-11-25.json');
    expect(boothExportFilename(undefined, new Date('2026-11-24T10:00:00Z'))).toBe('clics-booth-none-2026-11-24.json');
  });

  it('a booth day is the Bangkok calendar day, as the kiosk\'s "today" board counts it', () => {
    expect(bangkokDayKey('2026-11-24T16:59:59Z')).toBe('2026-11-24');   // 23:59:59 in Bangkok
    expect(bangkokDayKey('2026-11-24T17:00:00Z')).toBe('2026-11-25');   // midnight in Bangkok
    expect(bangkokDayKey('not a time')).toBeNull();
    expect(bangkokDayLabel('2026-11-24', 'th')).toBe('อังคาร 24 พ.ย.');
    expect(bangkokDayLabel('2026-11-24', 'en')).toBe('Tue 24 Nov');
    expect(bangkokDayLabel('garbled', 'th')).toBe('garbled');   // never a throw from an unreadable key
  });

  it('splits the board by day, newest day first, each day in the server\'s order and ranked from 1', () => {
    const r = (rank: number, tag: number, scored_at: string) => ({ rank, tag, scored_at });
    const days = boothDays([
      r(1, 42, '2026-11-24T07:05:00Z'), r(2, 120, '2026-11-25T02:40:00Z'), r(3, 7, '2026-11-25T03:52:00Z'),
      r(4, 9, '2026-11-24T16:59:00Z'), r(5, 11, '2026-11-24T17:00:00Z'), r(6, 5, 'garbled'),
    ]);
    expect(days.map((d) => d.day)).toEqual(['2026-11-25', '2026-11-24']);
    expect(days[0].rows.map((x) => [x.rank, x.tag])).toEqual([[1, 120], [2, 7], [3, 11]]);
    expect(days[1].rows.map((x) => [x.rank, x.tag])).toEqual([[1, 42], [2, 9]]);
    expect(boothDays([])).toEqual([]);
  });
});
