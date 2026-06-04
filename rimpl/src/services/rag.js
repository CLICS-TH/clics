// rimpl/src/services/rag.js
// Requires OPENAI_API_KEY in .env for embeddings. RAG gracefully skips if key is absent.
const { supabase } = require('../lib/supabase');

async function embedText(text) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: text }),
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message ?? 'Embedding failed');
  return json.data[0].embedding; // float[] of length 1536
}

async function ragLookup(query) {
  let embedding;
  try {
    embedding = await embedText(query);
  } catch {
    return []; // fall back gracefully — no RAG, use prompt-cited sources
  }

  const { data, error } = await supabase.rpc('match_documents', {
    query_embedding: embedding,
    match_threshold: 0.75,
    match_count: 3,
  });

  if (error || !data) return [];
  return data; // [{id, title, source, content, similarity}]
}

module.exports = { ragLookup };
