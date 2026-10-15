// recordSupersededDraft (services/superseded-draft.js): how a failed write of a streamed draft is
// classified. A missing column (the migration not yet applied) is expected during a rollout and logged,
// throttled, as such. Anything else — a CHECK violation in particular — is a real failure and must be
// logged as one: its message names `messages_superseded_reason_check`, which contains the column name,
// and the old bare-name match misreported it as "migration not applied".
// mockUpdateResult: one result for every write, or an array consumed in order (the last one repeats).
let mockUpdateResult;
const mockUpdates = [];
const nextResult = () => (Array.isArray(mockUpdateResult)
  ? (mockUpdateResult.length > 1 ? mockUpdateResult.shift() : mockUpdateResult[0]) : mockUpdateResult);
jest.mock('../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      update: (payload) => {
        mockUpdates.push(payload);
        const chain = { eq: () => chain, then: (res, rej) => Promise.resolve(nextResult()).then(res, rej) };
        return chain;
      },
    }),
  },
}));

const { recordSupersededDraft, _resetLogThrottle, isMissingColumn, knownReason } = require('../src/services/superseded-draft');

let err, warn;
beforeEach(() => {
  mockUpdates.length = 0;
  _resetLogThrottle();
  err = jest.spyOn(console, 'error').mockImplementation(() => {});
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { err.mockRestore(); warn.mockRestore(); });

const CHECK = { code: '23514', message: 'new row for relation "messages" violates check constraint "messages_superseded_reason_check"' };

test('a CHECK violation is a real failure, not "migration not applied"', async () => {
  // Refused even with the reason NULL (so not the reason's fault): the retry fails too, and it is an error.
  mockUpdateResult = { error: CHECK };
  expect(await recordSupersededDraft('m1', 'draft', 'citation')).toBe('error');
  expect(mockUpdates.map((u) => u.superseded_reason)).toEqual(['citation', null]);
  expect(err.mock.calls[0][0]).toMatch(/failed to record a superseded draft on message m1/);
  expect(err.mock.calls[0][0]).not.toMatch(/migration-message-superseded-draft\.sql is applied/);
  // Even without its code, the constraint's name alone is not read as a missing column.
  expect(isMissingColumn({ message: CHECK.message })).toBe(false);
});

test.each([
  ['42703 undefined column', { code: '42703', message: 'column "superseded_draft" of relation "messages" does not exist' }],
  ['PGRST204 schema cache', { code: 'PGRST204', message: "Could not find the 'superseded_reason' column of 'messages' in the schema cache" }],
  ['no code, Postgres wording', { message: 'column "superseded_reason" of relation "messages" does not exist' }],
  ['no code, PostgREST wording', { message: "Could not find the 'superseded_draft' column of 'messages' in the schema cache" }],
])('%s -> unavailable, logged as the missing migration', async (_n, error) => {
  mockUpdateResult = { error };
  expect(await recordSupersededDraft('m1', 'draft', 'language')).toBe('unavailable');
  expect(err.mock.calls[0][0]).toMatch(/migration-message-superseded-draft\.sql is applied/);
});

test('an unknown reason is stored as NULL so the draft is kept; \'evidence\' is now a known reason', async () => {
  mockUpdateResult = { error: null };
  expect(await recordSupersededDraft('m1', 'draft', 'bogus')).toBe('recorded');
  expect(mockUpdates[0]).toEqual({ superseded_draft: 'draft', superseded_reason: null });
  await recordSupersededDraft('m2', 'draft', 'rescue');
  expect(mockUpdates[1].superseded_reason).toBe('rescue');
  await recordSupersededDraft('m3', 'draft', 'evidence');
  expect(mockUpdates[2].superseded_reason).toBe('evidence');
  expect(knownReason('evidence')).toBe('evidence');
  expect(knownReason('nope')).toBeNull();
  expect(knownReason(undefined)).toBeNull();
});

test('23514 on a known reason (the OLD constraint, before migration-chat-turn-flags.sql): retried ONCE with NULL, draft kept', async () => {
  mockUpdateResult = [{ error: CHECK }, { error: null }];
  expect(await recordSupersededDraft('m1', 'the draft', 'evidence')).toBe('recorded');
  expect(mockUpdates).toEqual([
    { superseded_draft: 'the draft', superseded_reason: 'evidence' },
    { superseded_draft: 'the draft', superseded_reason: null },
  ]);
  expect(warn.mock.calls[0][0]).toMatch(/superseded_reason 'evidence' refused by the CHECK constraint.*migration-chat-turn-flags\.sql/);
  expect(err).not.toHaveBeenCalled();
  // Throttled: the next refusal within the minute still retries, but does not log again.
  mockUpdateResult = [{ error: CHECK }, { error: null }];
  expect(await recordSupersededDraft('m2', 'd2', 'evidence')).toBe('recorded');
  expect(warn).toHaveBeenCalledTimes(1);
});

test('23514 with no reason to drop is not retried', async () => {
  mockUpdateResult = { error: CHECK };
  expect(await recordSupersededDraft('m1', 'draft', 'bogus')).toBe('error');
  expect(mockUpdates).toHaveLength(1);
});
