// The booth reply cache's embedder (#387): a small multilingual sentence model run in-process, offline, on the
// de-identified typed answer only. It never calls out: remote models are off, so a missing model leaves the cache
// unavailable rather than fetching one (rimpl/scripts/fetch-embed-model.js is the one place that downloads it).
// Not callAI's `embed` purpose, which is the cloud embeddings API behind RAG.
const fs = require('fs');
const path = require('path');

const MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
const REVISION = '2c4055b12046f11709e9df2c122e59ffbdc2f900';
const DTYPE = 'q8';
const MODEL_ID = `${MODEL}@${REVISION.slice(0, 12)}:${DTYPE}`;
// fetch-embed-model.js writes the revision it downloaded here, so MODEL_ID names the weights actually loaded.
const REVISION_FILE = 'clics-revision.txt';

const modelDir = () => process.env.BOOTH_EMBED_MODEL_DIR || path.join(__dirname, '..', '..', 'models');

let loading = null;

async function load() {
  const dir = modelDir();
  const stamped = fs.readFileSync(path.join(dir, MODEL, REVISION_FILE), 'utf8').trim();
  if (stamped !== REVISION) throw new Error(`model revision ${stamped.slice(0, 12)} is not the pinned ${REVISION.slice(0, 12)}`);
  // Required here, not at the top: rimpl modules load in CI jobs with no npm install.
  const { pipeline, env } = require('@huggingface/transformers');
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = dir;
  return pipeline('feature-extraction', MODEL, { revision: REVISION, dtype: DTYPE });
}

/** The loaded model, or null when it cannot load. A failed load is remembered and warned about once. */
function extractor() {
  if (!loading) {
    loading = load().catch((err) => {
      console.warn(`[booth] reply cache embedder unavailable: ${err.code ?? err.message}`);
      return null;
    });
  }
  return loading;
}

/** The unit-length mean-pooled embedding of `text`, or null when the model is unavailable or the run fails.
 *  `text` must already be de-identified. */
async function embed(text) {
  const run = await extractor();
  if (!run) return null;
  try {
    const out = await run(text, { pooling: 'mean', normalize: true });
    return Array.from(out.data);
  } catch (err) {
    console.warn(`[booth] reply cache embedding failed: ${err.name ?? 'error'}`);
    return null;
  }
}

module.exports = { MODEL, REVISION, DTYPE, MODEL_ID, REVISION_FILE, modelDir, embed };
