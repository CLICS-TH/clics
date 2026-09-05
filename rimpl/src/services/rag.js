// rimpl/src/services/rag.js
// Retrieval-augmented lookup over the `documents` corpus.
//
// Embeddings go through services/ai.embedText, NOT a direct fetch to api.openai.com. That direct
// call used to be the one AI path no configuration could move: chat and scoring could both be
// pointed at the on-prem DGX while retrieval still shipped every physician query to a third cloud
// vendor, which quietly made "all AI calls can run on-premise" untrue. Behind the seam, retrieval
// moves with everything else (app_settings.ai_provider_embed).
//
// PII: the caller de-identifies BEFORE calling. routes/chat.js strips once, up front, and passes the
// clean string here — see the comment at its stripPii call. Never add stripping here instead; two
// strip sites is how one of them ends up skipped.
//
// Retrieval is OFF unless app_settings.rag_enabled = 1, and the check happens BEFORE the embedding
// call so that nothing leaves the boundary when it is off. Until 2026-09-05 there was no switch:
// ragLookup ran on every turn against a `documents` table holding 0 rows in production, so each
// chat turn paid an api.openai.com round trip to search an empty corpus. See ai.ragEnabled().
const { supabase } = require('../lib/supabase');
const { embedText, ragEnabled } = require('./ai');

// Logged once per process, not per turn: a per-turn line would be noise nobody reads, and the
// point is that a disabled corpus should not look identical to an empty one.
let announced = false;

async function ragLookup(query) {
  if (!(await ragEnabled())) {
    if (!announced) {
      announced = true;
      console.warn('[rag] retrieval is OFF (app_settings.rag_enabled != 1) — no embedding call is made');
    }
    return [];
  }

  let embedding;
  try {
    embedding = await embedText(query);
  } catch (e) {
    // Retrieval is an ENHANCEMENT: the system prompt already requires cited sources, so a chat turn
    // without RAG is degraded, not broken, and failing the turn would be worse than answering
    // without it. But log the reason — a silently disabled corpus looks identical to an empty one,
    // and "RAG stopped working in August" is not a thing anyone would otherwise notice.
    console.warn(`[rag] retrieval skipped — embedding failed: ${e?.message || e}`);
    return [];
  }

  const { data, error } = await supabase.rpc('match_documents', {
    query_embedding: embedding,
    match_threshold: 0.75,
    match_count: 3,
  });

  if (error) {
    console.warn(`[rag] retrieval skipped — match_documents failed: ${error.message}`);
    return [];
  }
  return data || []; // [{id, title, source, content, similarity}]
}

module.exports = { ragLookup };
