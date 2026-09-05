// Retrieval used to run on EVERY chat turn with no switch: it embedded the physician's turn through
// the `embed` provider — api.openai.com on this deployment, a different vendor from the one serving
// chat — and then queried a `documents` table holding 0 rows in production. Every one of those calls
// searched nothing.
//
// The text was de-identified first (routes/chat.js strips before calling), so this was a conformance
// gap against CREC082's "no commercial external AI/API for research transcripts", not a PII leak.
// Either way the fix has to be a switch an auditor can read, and the check has to happen BEFORE the
// embedding call — a gate that runs after the request has left the boundary gates nothing.
jest.mock('../src/lib/supabase', () => ({ supabase: { rpc: jest.fn() } }));
jest.mock('../src/services/ai', () => ({ embedText: jest.fn(), ragEnabled: jest.fn() }));

const { supabase } = require('../src/lib/supabase');
const { embedText, ragEnabled } = require('../src/services/ai');
const { ragLookup } = require('../src/services/rag');

beforeEach(() => {
  jest.clearAllMocks();
  supabase.rpc.mockResolvedValue({ data: [{ id: 1, title: 'doc', content: 'x', similarity: 0.9 }], error: null });
  embedText.mockResolvedValue(new Array(1536).fill(0));
});

test('OFF: nothing leaves the boundary — no embedding call at all', async () => {
  ragEnabled.mockResolvedValue(false);
  await expect(ragLookup('a physician question')).resolves.toEqual([]);
  expect(embedText).not.toHaveBeenCalled();   // the whole point
  expect(supabase.rpc).not.toHaveBeenCalled();
});

test('ON: the turn is embedded and the corpus is searched', async () => {
  ragEnabled.mockResolvedValue(true);
  const docs = await ragLookup('a physician question');
  expect(embedText).toHaveBeenCalledWith('a physician question');
  expect(supabase.rpc).toHaveBeenCalledWith('match_documents', expect.objectContaining({ match_count: 3 }));
  expect(docs).toHaveLength(1);
});

test('the OFF notice is logged once per process, not once per turn', async () => {
  // The flag lives at module scope, so this needs a FRESH module — otherwise the test only passes
  // when it happens to run first, which is not a property of the code.
  ragEnabled.mockResolvedValue(false);
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    let fresh;
    jest.isolateModules(() => { fresh = require('../src/services/rag').ragLookup; });
    await fresh('one'); await fresh('two'); await fresh('three');
    expect(warn.mock.calls.filter(([m]) => /retrieval is OFF/.test(m))).toHaveLength(1);
  } finally { warn.mockRestore(); }
});

test('ON but the embedding fails: the turn is degraded, never failed, and the reason is logged', async () => {
  // A chat turn without retrieval is degraded; failing the turn would cost the physician their turn
  // over an enhancement. But a silently disabled corpus must not look identical to an empty one.
  ragEnabled.mockResolvedValue(true);
  embedText.mockRejectedValue(new Error('OPENAI_API_KEY not set'));
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await expect(ragLookup('q')).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/embedding failed.*OPENAI_API_KEY/));
  } finally { warn.mockRestore(); }
});

test('ON but match_documents errors: same contract — [] and a logged reason', async () => {
  ragEnabled.mockResolvedValue(true);
  supabase.rpc.mockResolvedValue({ data: null, error: { message: 'relation does not exist' } });
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await expect(ragLookup('q')).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/match_documents failed/));
  } finally { warn.mockRestore(); }
});
