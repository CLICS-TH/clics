jest.mock('../src/lib/supabase', () => require('./helpers/supabase-mock').makeSupabaseMock());

const fs = require('fs');
const path = require('path');
const { BOOTH_SETTINGS, SAFE_EVENT_CODE } = require('../src/services/booth');
const { schemaFromSql } = require('./helpers/sql-schema');
const { CaseTreeSchema } = require('../src/booth-cases/tree-schema');
const { LOOK_LANGUAGE } = require('../src/services/booth-dialogue');

const MIGRATION = fs.readFileSync(path.join(__dirname, '../../db/migration-booth-plays.sql'), 'utf8');
const SQL = MIGRATION.replace(/--[^\n]*/g, '');

test('booth_plays has exactly the allowed columns', () => {
  expect([...(schemaFromSql().booth_plays ?? [])].sort()).toEqual(['id', 'event_code', 'tag', 'status', 'spend_usd',
    'composite', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'created_at', 'scored_at', 'ranked', 'case_id', 'case_version',
    'tier_path', 'replied_step', 'steps', 'score_source', 'language_look'].sort());
});

test('language_look holds exactly the looks of LOOK_LANGUAGE (#377)', () => {
  const look = /check \(language_look in \(([^)]*)\)\)/.exec(SQL);
  expect(look).not.toBeNull();
  expect([...look[1].matchAll(/'([a-z+]+)'/g)].map(([, s]) => s).sort()).toEqual(Object.keys(LOOK_LANGUAGE).sort());
});

test('score_source holds exactly the two sources the score writes, and steps only an array (#375)', () => {
  const source = /check \(score_source in \(([^)]*)\)\)/.exec(SQL);
  expect(source).not.toBeNull();
  expect([...source[1].matchAll(/'([a-z]+)'/g)].map(([, s]) => s).sort()).toEqual(['live', 'table']);
  expect(SQL).toContain("check (jsonb_typeof(steps) = 'array')");
});

test('the case-file name guard is the booth_plays.event_code CHECK', () => {
  const check = /check \(event_code ~ '([^']+)'\)/.exec(SQL);
  expect(check).not.toBeNull();
  expect(SAFE_EVENT_CODE.source).toBe(check[1]);
});

test('the booth_plays.case_id CHECK is the case-file case_id rule, and tier_path holds up to three tier letters', () => {
  const caseId = CaseTreeSchema.shape.case_id._def.checks.find((c) => c.kind === 'regex').regex;
  expect(/check \(case_id ~ '([^']+)'\)/.exec(SQL)?.[1]).toBe(caseId.source);
  expect(/check \(tier_path ~ '([^']+)'\)/.exec(SQL)?.[1]).toBe('^[BRW]{0,3}$');
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
  const folder = path.join(__dirname, '../src/booth-cases', code);
  expect(fs.readdirSync(folder).filter((f) => f.endsWith('.json')).length).toBeGreaterThan(0);
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
  const body = /function public\.booth_start_play\(p_event text, p_case text, p_version text\)[\s\S]*?\$\$([\s\S]*?)\$\$/.exec(SQL)?.[1];
  expect(body).toBeDefined();
  expect(body).toContain(`key = '${BOOTH_SETTINGS.enabled}' and value = 1`);
  expect(SQL).toContain('drop function if exists public.booth_start_play(text);');
  const access = [...SQL.matchAll(/(?:revoke all|grant execute) on function public\.booth_start_play\(([^)]*)\)/g)];
  expect(access.map(([, args]) => args)).toEqual(['text, text, text', 'text, text, text']);
});

test('booth_sort_memos holds a key, a tier letter and a time: no text column, RLS on, reached only through its function', () => {
  expect([...(schemaFromSql().booth_sort_memos ?? [])].sort()).toEqual(['created_at', 'key', 'tier']);
  const memo = fs.readFileSync(path.join(__dirname, '../../db/migration-booth-sort-memo.sql'), 'utf8').replace(/--[^\n]*/g, '');
  expect(memo).toContain("check (key ~ '^[0-9a-f]{64}$')");
  expect(memo).toContain("check (tier in ('B', 'R', 'W'))");
  expect(memo).toContain('alter table public.booth_sort_memos enable row level security;');
  expect(memo).toContain('revoke all on table public.booth_sort_memos from public, anon, authenticated;');
  expect(memo).not.toMatch(/create policy/i);
  expect(memo).toContain('revoke all on function public.booth_sort_memo(text, text) from public, anon, authenticated;');
  expect(memo).toContain('grant execute on function public.booth_sort_memo(text, text) to service_role;');
  expect(memo).not.toMatch(/grant [^;]* on (table )?public\.booth_sort_memos/i);
});

test('booth_event_purges holds aggregates only, under the booth_plays event-code CHECK', () => {
  expect([...(schemaFromSql().booth_event_purges ?? [])].sort()).toEqual(['attempt_id', 'event_code', 'id', 'purged_at', 'summary']);
  const purge = fs.readFileSync(path.join(__dirname, '../../db/migration-booth-purge.sql'), 'utf8').replace(/--[^\n]*/g, '');
  const check = (sql) => /check \(event_code ~ '([^']+)'\)/.exec(sql)?.[1];
  expect(check(purge)).toBe(check(SQL));
  expect(check(purge)).toBeDefined();
});
