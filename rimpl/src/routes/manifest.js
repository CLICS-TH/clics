// GET /manifest — the model manifest (CCME R2) with the live configuration and the drift between them,
// for the backend's evaluator-lock record (PR 6b). Behind the internal token (mounted after internalAuth
// in src/index.js): unlike /health/deep it returns the WHOLE manifest and the live view. The live view
// still carries no URL, host, IP or key (services/manifest.js): a base URL is present/absent only.
//
//   200 { manifest, sha256, claimed_sha256, file, code_match, live, drift }
//       manifest        the committed rimpl/src/model-manifest.json as loaded at startup (null when missing
//                       or not JSON; the parsed content, unverified, when invalid — `file` says which)
//       sha256          its VERIFIED content address: null when missing or invalid, never the file's own claim
//       claimed_sha256  the hash the file states about itself (= sha256 when present; null if absent or not hex)
//       file            present | missing | invalid
//       code_match      true when its expected.code is this build's; false when not; null when missing
//       live / drift    RAW values (model ids, server fingerprints) — /health/deep prints only their hashes
//       provider_retries the retries each provider makes after a failed attempt (CLAUDE_MAX_RETRIES), each of
//                       which may be billed: the booth table build reserves its spend from it
//
// Reads only: no provider is probed, no model is called.
const { Router } = require('express');
const modelManifest = require('../services/manifest');
const { ensureFreshSettings } = require('../services/ai');
const anthropic = require('../services/providers/anthropic');

const router = Router();

router.get('/', async (_req, res) => {
  try {
    // The provider per purpose is the app_settings toggle over env: warm the cache first, so `live`
    // reports what the next call would use rather than the env fallback of a cold process.
    await ensureFreshSettings();
    const r = modelManifest.report();
    res.json({ manifest: modelManifest.loaded.manifest, sha256: r.sha256, claimed_sha256: r.claimed_sha256,
      file: r.file, code_match: r.code_match, live: r.live, drift: r.drift, provider_retries: { anthropic: anthropic.MAX_RETRIES } });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

module.exports = router;
