// recordSupersededDraft (services/superseded-draft.js): how a failed write of a streamed draft is
// classified. A missing column (the migration not yet applied) is expected during a rollout and logged,
// throttled, as such. Anything else — a CHECK violation in particular — is a real failure and must be
// logged as one: its message names `messages_superseded_reason_check`, which contains the column name,
// and the old bare-name match misreported it as "migration not applied".
let mockUpdateResult;
const mockUpdates = [];
jest.mock('../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      update: (payload) => {
        mockUpdates.push(payload);
        const chain = { eq: () => chain, then: (res, rej) => Promise.resolve(mockUpdateResult).then(res, rej) };
        return chain;
      },
    }),
  },
}));

const { recordSupersededDraft, _resetLogThrottle, isMissingColumn } = require('../src/services/superseded-draft');

let err;
beforeEach(() => {
  mockUpdates.length = 0;
  _resetLogThrottle();
  err = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => err.mockRestore());

const CHECK = { code: '23514', message: 'new row for relation "messages" violates check constraint "messages_superseded_reason_check"' };

test('a CHECK violation is a real failure, not "migration not applied"', async () => {
  mockUpdateResult = { error: CHECK };
  expect(await recordSupersededDraft('m1', 'draft', 'citation')).toBe('error');
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

test('an unknown reason (the evidence marker\'s) is stored as NULL so the draft is kept', async () => {
  mockUpdateResult = { error: null };
  expect(await recordSupersededDraft('m1', 'draft', 'evidence')).toBe('recorded');
  expect(mockUpdates[0]).toEqual({ superseded_draft: 'draft', superseded_reason: null });
  await recordSupersededDraft('m2', 'draft', 'rescue');
  expect(mockUpdates[1].superseded_reason).toBe('rescue');
});
