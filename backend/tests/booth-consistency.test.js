jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());

const fs = require('fs');
const path = require('path');
const { BOOTH_SETTINGS, SAFE_EVENT_CODE } = require('../src/services/booth');
const { schemaFromSql } = require('./helpers/sql-schema');

const MIGRATION = fs.readFileSync(path.join(__dirname, '../../db/migration-booth-plays.sql'), 'utf8');
const SQL = MIGRATION.replace(/--[^\n]*/g, '');

test('booth_plays has exactly the allowed columns', () => {
  expect([...(schemaFromSql().booth_plays ?? [])].sort()).toEqual(['id', 'event_code', 'tag', 'status', 'spend_usd',
    'composite', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'created_at', 'scored_at', 'ranked'].sort());
});

test('the case-file name guard is the booth_plays.event_code CHECK', () => {
  const check = /check \(event_code ~ '([^']+)'\)/.exec(SQL);
  expect(check).not.toBeNull();
  expect(SAFE_EVENT_CODE.source).toBe(check[1]);
});

test('the migration seeds exactly the BOOTH_SETTINGS keys, switched off, for an event that has a case file', () => {
  const insert = /insert into public\.app_settings \(key, value, value_text\) values([\s\S]*?)on conflict/.exec(SQL);
  expect(insert).not.toBeNull();
  const seeds = Object.fromEntries([...insert[1].matchAll(/\('([a-z_]+)',\s*([0-9.]+),\s*(null|'[^']*')\)/g)]
    .map(([, key, value, text]) => [key, { value: Number(value), text: text === 'null' ? null : text.slice(1, -1) }]));
  expect(Object.keys(seeds).sort()).toEqual(Object.values(BOOTH_SETTINGS).sort());
  expect(seeds[BOOTH_SETTINGS.enabled].value).toBe(0);
  expect(seeds[BOOTH_SETTINGS.ceilingUsd].value).toBe(3);
  const code = seeds[BOOTH_SETTINGS.code].text;
  expect(code).toBe('NFCME-2026');
  expect(fs.existsSync(path.join(__dirname, '../src/booth-cases', `${code}.json`))).toBe(true);
});

test('the purge function locks the switch rows the backend reads and the advisory key booth_start_play takes', () => {
  const purge = fs.readFileSync(path.join(__dirname, '../../db/migration-booth-purge.sql'), 'utf8').replace(/--[^\n]*/g, '');
  const locked = /where key in \(([^)]*)\) order by key for update/.exec(purge);
  expect(locked).not.toBeNull();
  expect([...locked[1].matchAll(/'([a-z_]+)'/g)].map(([, k]) => k).sort())
    .toEqual([BOOTH_SETTINGS.code, BOOTH_SETTINGS.enabled].sort());
  const lockKey = (sql) => /pg_advisory_xact_lock\(([^;]+)\);/.exec(sql)?.[1];
  expect(lockKey(purge)).toBe(lockKey(SQL));
  expect(lockKey(purge)).toBeDefined();
});

test('booth_start_play is defined only in the plays migration, and starts a play only while booth_enabled = 1', () => {
  const purge = fs.readFileSync(path.join(__dirname, '../../db/migration-booth-purge.sql'), 'utf8').replace(/--[^\n]*/g, '');
  expect(purge).not.toMatch(/function\s+public\.booth_start_play/);
  const body = /function public\.booth_start_play\(p_event text\)[\s\S]*?\$\$([\s\S]*?)\$\$/.exec(SQL)?.[1];
  expect(body).toBeDefined();
  expect(body).toContain(`key = '${BOOTH_SETTINGS.enabled}' and value = 1`);
});

test('booth_event_purges holds aggregates only, under the booth_plays event-code CHECK', () => {
  expect([...(schemaFromSql().booth_event_purges ?? [])].sort()).toEqual(['attempt_id', 'event_code', 'id', 'purged_at', 'summary']);
  const purge = fs.readFileSync(path.join(__dirname, '../../db/migration-booth-purge.sql'), 'utf8').replace(/--[^\n]*/g, '');
  const check = (sql) => /check \(event_code ~ '([^']+)'\)/.exec(sql)?.[1];
  expect(check(purge)).toBe(check(SQL));
  expect(check(purge)).toBeDefined();
});
