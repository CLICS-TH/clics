// lib/booth.ts: how the Booth Mode page writes a player, a score, a time and the export's file name. The player
// and the score must read as the kiosk shows them (physician-ui/public/js/booth-copy.js tagText, scoreText), and
// the file name as the backend names it (backend/src/services/booth-monitor.js exportPlays).
import { bangkokDayTime, bangkokTime, boothExportFilename, playerTag, rawScore, shownScore } from '@/lib/booth';

describe('booth formatting', () => {
  it('pads the player tag to three digits, in both languages, and never cuts a longer one', () => {
    expect(playerTag(42, 'th')).toBe('ผู้เล่น #042');
    expect(playerTag(42, 'en')).toBe('Player #042');
    expect(playerTag(7, 'en')).toBe('Player #007');
    expect(playerTag(1234, 'en')).toBe('Player #1234');
  });

  it('shows the display score rounded, as the kiosk does, and the raw composite to one decimal', () => {
    expect(shownScore(87.4)).toBe('87');
    expect(shownScore(87.5)).toBe('88');
    expect(shownScore(0)).toBe('0');
    expect(rawScore(61.24)).toBe('61.2');
    expect(rawScore(40)).toBe('40.0');
    expect(rawScore(Number.NaN)).toBe('—');
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
});
