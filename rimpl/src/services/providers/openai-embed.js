// OpenAI embeddings provider — the transport that RAG retrieval has always used, moved behind the
// provider interface in services/ai.js.
//
// WHY IT MOVED. services/rag.js used to call api.openai.com directly. That made one claim in the
// architecture false: no configuration could stop physician text from reaching a third cloud vendor,
// so "all AI calls can be moved on-premise" was true of chat and scoring but not of retrieval.
// Behind the seam, `app_settings.ai_provider_embed = local` moves it with everything else.
//
// PII: the caller de-identifies BEFORE calling (routes/chat.js strips once, up front, and passes the
// clean string to ragLookup). This module is a transport and must never become the place that strips.
const MODEL = () => String(process.env.OPENAI_EMBED_MODEL || 'text-embedding-3-small');

async function embed(text) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: MODEL(), input: text }),
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error?.message ?? `Embedding failed (${res.status})`);
  const vector = json.data?.[0]?.embedding;
  if (!Array.isArray(vector)) throw new Error('Embedding response carried no vector');
  return vector; // float[] — 1536 for text-embedding-3-small
}

// Cheap, generation-free readiness: a key is either configured or it is not. Deliberately does NOT
// call the API — /health/deep must not spend money or add latency to prove a key exists.
function ready() {
  return process.env.OPENAI_API_KEY
    ? { checks: { openai_embeddings: { status: 'up', model: MODEL() } } }
    : { checks: { openai_embeddings: { status: 'down', error: 'OPENAI_API_KEY not set (RAG retrieval disabled)' } } };
}

module.exports = { name: 'openai', embed, embedModel: MODEL, model: MODEL, ready };
