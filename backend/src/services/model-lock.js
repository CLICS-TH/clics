// The Primary Evaluator Model Lock, bound to the model manifest (CCME R2; GitHub #75).
//
// A lock used to be a declaration plus a weights digest. What it could not say is WHICH BUILD of the
// scoring stack it froze: the prompt, rubric, decoding defaults and provider policy live in rimpl's
// code, and nothing tied the lock row to them. rimpl now publishes a content-addressed model manifest
// (rimpl/src/model-manifest.json, served at GET /manifest behind the internal token). This module is the
// backend's side of that contract:
//
//   manifestForLock()      fetch it and decide whether it is good enough to freeze — failing CLOSED
//   expectedFor()          what the manifest says a given evaluator provider is stamped with
//   manifestDiff()         declared / measured vs expected, field by field
//   evaluatorDigest()      THE scope of the lock: a digest over the evaluator part of the manifest only
//   evaluatorDriftKeys()   which of rimpl's LIVE drift keys fall in that scope (an env override the
//                          expected-half digest cannot see): blocks a lock, degrades one in force
//   lockSchemaStatus()     whether db/migration-evaluator-lock-manifest.sql has been applied
//   lockInForce()          the lock the flag points at, and what was frozen on it
//   lockDeclarationDigest() a digest over a lock record's DECLARED fields, carried by every post-lock score
//                          (read back for each evaluation by services/ple-evaluation.js evaluationLockStamp)
//   modelLockCheck()       /health/deep's verdict on the lock in force (also relayed by /admin/ai-readiness)
//
// WHAT THE LOCK FREEZES: THE SCORING INSTRUMENT, NOT THE WHOLE BUILD (owner's decision, 2026-10-15).
// The row keeps the whole-manifest sha256 for the record, but the binding is evaluatorDigest(): a
// tutor, router or chat change after a lock is allowed and shows as a note; a change to any key in
// EVALUATOR_SCOPE needs a re-declaration (REPLACE THE LOCK).
//
// The manifest contract (rimpl/src/routes/manifest.js, merged in #156; tests mock it):
//   200 { manifest: { schema, expected: { code, declared }, sha256 }, sha256, claimed_sha256, file,
//         code_match, live, drift }
//   `sha256` is null unless `file === 'present'` and the content verified. Only `manifest.expected` is
//   ever frozen. `live` carries operator- and server-supplied strings and is never stored.
//
// Error bodies follow the repo's bilingual shape: { error: 'ไทย / English', code, ...detail }.
const crypto = require('crypto');
const { supabase } = require('../lib/supabase');
const { getTextSettingStrict } = require('../lib/settings');
const { fetchRimplManifest } = require('./rimpl-client');
const { isMissingRelation } = require('./agreement');

const SHA256 = /^[0-9a-f]{64}$/;
// A frozen copy larger than this is not a manifest anyone wrote by hand or by build.mjs. Refusing it
// keeps a misbehaving rimpl from writing an arbitrarily large blob into the study record.
const MAX_EXPECTED_BYTES = 256 * 1024;

const LOCK_MIGRATION = 'db/migration-evaluator-model-lock.sql';
const MANIFEST_MIGRATION = 'db/migration-evaluator-lock-manifest.sql';
// The columns migration-evaluator-lock-manifest.sql adds. Probed before a lock is written, so an
// unmigrated database answers with what to apply instead of a 500 halfway through.
const MANIFEST_COLS = 'id, manifest_sha256, manifest, evaluator_sha256';

// ---- error bodies ------------------------------------------------------------------------------
const LOCK_STATE_UNREADABLE = Object.freeze({
  error: 'อ่านสถานะการล็อกผู้ให้คะแนนไม่ได้ในขณะนี้ จึงยังไม่ได้เปลี่ยนแปลงสิ่งใด กรุณาลองใหม่อีกครั้ง / '
    + 'The evaluator lock state could not be read, so nothing was changed. Please try again.',
  code: 'lock_state_unreadable',
});

const USE_MODEL_LOCK = Object.freeze({
  error: 'การล็อกผู้ให้คะแนนต้องทำผ่านหน้า Model Lock (/admin/evaluator-lock) ซึ่งบันทึกค่าที่ล็อก ผลความสอดคล้องกับผู้ตรวจ '
    + 'และ model manifest ไว้ด้วยกัน ปุ่มนี้ใช้ปลดล็อกได้อย่างเดียว / '
    + 'Lock the evaluator through the Model Lock declaration (/admin/evaluator-lock), which records the frozen '
    + 'configuration, the agreement verdict and the model manifest together. This switch can only unlock.',
  code: 'use_model_lock',
  lock_endpoint: 'POST /admin/evaluator-lock',
});

// A write that succeeded, followed by a read-back that did not: the change is in, the screen cannot say so.
const SAVED_STATE_UNREADABLE = Object.freeze({
  error: 'บันทึกแล้ว แต่อ่านสถานะการล็อกกลับมาไม่ได้ กรุณาโหลดหน้าใหม่ / '
    + 'Saved, but the evaluator lock state could not be read back. Reload the page to see it.',
  code: 'saved_state_unreadable',
});

const INVALID_DECLARATION_ERROR = 'ข้อมูลที่ประกาศไม่ครบหรือไม่ถูกต้อง ดูรายละเอียดใน details / '
  + 'The declaration is incomplete or malformed; see details.';

const relockRequired = (lockedAt) => ({
  error: `ผู้ให้คะแนนถูกล็อกไว้แล้วเมื่อ ${lockedAt} การแทนที่การล็อกต้องหยุดการให้คะแนนและแยกข้อมูลก่อนและหลังการเปลี่ยน / `
    + `The evaluator was locked on ${lockedAt}. Replacing that lock means stopping scoring and separating the data either side of the change.`,
});

const unlockRequired = (lockedAt) => ({
  error: `ผู้ให้คะแนนถูกล็อกอยู่ (ตั้งแต่ ${lockedAt}) การปลดล็อกจะเปลี่ยนเครื่องมือที่เกณฑ์ ICC ใช้วัด / `
    + `The evaluator is locked (since ${lockedAt}). Unlocking changes the instrument the ICC credit gate is defined against.`,
});

const evaluatorLocked = (lockedAt) => ({
  error: `ผู้ให้คะแนน PIS-7 ถูกล็อกไว้เมื่อ ${lockedAt} จึงเปลี่ยนระหว่าง pilot ไม่ได้ ถ้าตั้งใจเปลี่ยนจริงต้องปลดล็อกก่อน / `
    + `The PIS-7 evaluator was locked on ${lockedAt} and cannot be changed while the pilot is running. Unlock it first if this is deliberate.`,
});

function gateNotPassed(verdict, { promptVersion, noCandidate }) {
  const none = noCandidate
    ? { th: ` ไม่มีคะแนนของผู้ท้าชิงที่ใช้ prompt_version "${promptVersion}"`, en: ` No candidate scores were recorded under prompt_version "${promptVersion}".` }
    : { th: '', en: '' };
  return {
    error: `โมเดลผู้ท้าชิงยังไม่ผ่านเกณฑ์ตัดสินเทียบกับผู้ตรวจ (${verdict.state}) จึงยังล็อกไม่ได้${none.th} / `
      + `The candidate has not cleared the decisive threshold (${verdict.state}): ${verdict.why}.${none.en}`,
  };
}

const candidateNotEvaluator = (provider) => ({
  error: `ผู้ให้บริการ "${provider ?? 'none'}" ใช้เป็นผู้ให้คะแนน PIS-7 ไม่ได้ / `
    + `The candidate provider "${provider ?? 'none'}" cannot serve as the PIS-7 evaluator.`,
});

const candidateNotServing = (candidate, serving) => ({
  error: `โมเดลผู้ท้าชิง (${candidate}) ไม่ใช่ผู้ให้บริการที่ให้คะแนนอยู่ตอนนี้ (${serving}) ต้องสลับการให้คะแนนไปที่ ${candidate} ก่อน แล้วจึงล็อก / `
    + `The candidate (${candidate}) is not the provider serving evaluate (${serving}). Switch evaluate to ${candidate} first, then lock: `
    + 'a lock freezes the instrument that is actually scoring.',
  code: 'candidate_not_serving',
  candidate_provider: candidate,
  serving_provider: serving,
});

function migrationRequired({ tableMissing }) {
  const files = tableMissing ? [LOCK_MIGRATION, MANIFEST_MIGRATION] : [MANIFEST_MIGRATION];
  return {
    error: `ฐานข้อมูลยังไม่พร้อมสำหรับการล็อกที่ผูกกับ model manifest ต้องรัน ${files.join(' แล้ว ')} ก่อน / `
      + `The database is not ready for a manifest-bound lock: apply ${files.join(', then ')} first.`,
    code: 'migration_required',
    migrations: files,
  };
}

const MANIFEST_REASONS = {
  unreachable: ['ติดต่อ RIMPL เพื่ออ่าน model manifest ไม่ได้', 'Could not read the model manifest from RIMPL'],
  file_not_present: ['RIMPL ไม่มี model manifest ที่ใช้งานได้', 'RIMPL has no usable model manifest'],
  unverified: ['model manifest ไม่ผ่านการตรวจ sha256', 'The model manifest did not verify against its sha256'],
  code_mismatch: ['model manifest ไม่ตรงกับโค้ดที่ RIMPL รันอยู่ ต้องสร้างไฟล์ใหม่ก่อน (scripts/manifest/build.mjs)',
    'The committed model manifest is not what the running RIMPL code generates; regenerate it (scripts/manifest/build.mjs)'],
  malformed: ['model manifest ที่ได้รับมีรูปแบบไม่ถูกต้อง', 'The model manifest RIMPL returned is malformed'],
};

function manifestUnavailable(reason, detail, extra = {}) {
  const [th, en] = MANIFEST_REASONS[reason];
  return {
    ok: false,
    reason,
    body: {
      error: `${th} จึงยังล็อกผู้ให้คะแนนไม่ได้ / ${en}, so the evaluator cannot be locked${detail ? ` (${detail})` : ''}.`,
      code: 'manifest_unavailable',
      reason,
      ...extra,
    },
  };
}

// ---- the manifest ------------------------------------------------------------------------------

/**
 * Judge a GET /manifest body. The same rules at lock time and at health time, so "good enough to
 * freeze" and "good enough to compare against what was frozen" cannot drift apart. `code_match` must be
 * exactly true; null ("missing") is not a pass.
 */
function judgeManifest(r) {
  const file = typeof r?.file === 'string' ? r.file : null;
  if (file !== 'present') return manifestUnavailable('file_not_present', `file: ${file ?? 'unknown'}`, { file });
  const sha = typeof r.sha256 === 'string' ? r.sha256.toLowerCase() : null;
  if (!sha || !SHA256.test(sha)) return manifestUnavailable('unverified', 'sha256 is null', { file });
  if (r.claimed_sha256 != null && String(r.claimed_sha256).toLowerCase() !== sha) {
    return manifestUnavailable('unverified', 'claimed_sha256 differs from the verified sha256', { file });
  }
  if (r.code_match !== true) return manifestUnavailable('code_mismatch', `code_match: ${r.code_match ?? null}`, { file, code_match: r.code_match ?? null });
  const expected = r.manifest?.expected;
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
    return manifestUnavailable('malformed', 'no manifest.expected object', { file });
  }
  let bytes;
  try { bytes = JSON.stringify(expected).length; } catch { bytes = Infinity; }
  if (bytes > MAX_EXPECTED_BYTES) return manifestUnavailable('malformed', `manifest.expected is ${bytes} bytes`, { file });
  // The live drift's KEYS only (`code.decoding.evaluate.temperature`, `declared.local.model`, ...): which
  // values differ, never what they are. The values can be operator- or server-supplied strings. A key
  // that is not a plain dotted name is kept as a placeholder (driftKeysOf), so it still counts.
  const drift_keys = driftKeysOf(r.drift);
  return { ok: true, sha256: sha, expected, file, code_match: true, drift_keys };
}

/**
 * Fetch rimpl's model manifest and decide whether it may be frozen onto a lock. FAILS CLOSED: an
 * unreachable rimpl (or one that predates the manifest and answers 404), a missing or invalid file, an
 * unverified sha256, or a manifest that is not what the running code generates all refuse.
 *
 * @returns {Promise<{ok: true, sha256, expected, file, code_match: true, drift_keys}
 *   | {ok: false, reason, body}>} `body` is the 503 response.
 */
async function manifestForLock({ timeoutMs } = {}) {
  let r;
  try {
    r = await fetchRimplManifest(timeoutMs ? { timeoutMs } : undefined);
  } catch (e) {
    return manifestUnavailable('unreachable', e?.status ? `HTTP ${e.status}` : e?.message);
  }
  return judgeManifest(r);
}

// /health/deep asks for the live manifest only while a lock is in force, and at most once a minute:
// health is polled, and GET /manifest makes rimpl warm its settings cache. A failed fetch is cached for
// the same window, so a down rimpl is not hammered. Never longer than 60 s.
const MANIFEST_CACHE_MS = Math.min(60_000, Math.max(0, parseInt(process.env.HEALTH_MANIFEST_CACHE_MS || '60000', 10) || 0));
let manifestCache = null;   // { at, value }
async function cachedLiveManifest({ timeoutMs, now = Date.now() } = {}) {
  if (manifestCache && now - manifestCache.at < MANIFEST_CACHE_MS) return manifestCache.value;
  const value = await manifestForLock({ timeoutMs });
  manifestCache = { at: now, value };
  return value;
}
function resetManifestCache() { manifestCache = null; }

const str = (v) => (typeof v === 'string' && v ? v : null);

/**
 * What the manifest says an evaluator provider is stamped with. Null where the manifest names
 * nothing, which a diff reads as a mismatch — an expectation the manifest does not state cannot be met.
 *
 *   prompt_version     expected.code.evaluator.prompt_version[provider]
 *   rubric_version     expected.code.evaluator.rubric_version
 *   model_version      anthropic: expected.code.anthropic.model_version
 *                      on-prem:   expected.code.model_version_prefix + expected.declared[provider].model
 *                      (rimpl versions.js modelVersion; the on-prem model id is DECLARED, not in code)
 *   provider_declared  expected.declared.providers.evaluate — the provider the target deployment scores with
 *   decoding           expected.code.decoding.evaluate — what the evaluator SENDS (temperature, max_tokens)
 *   declared           { engine, model } from expected.declared[provider], the build-validated declaration.
 *                      Never its system_fingerprint: that is a server's own string.
 */
function expectedFor(expected, provider) {
  const code = expected?.code ?? {};
  const prompt_version = str(code.evaluator?.prompt_version?.[provider]);
  const rubric_version = str(code.evaluator?.rubric_version);
  let model_version = null, model_path;
  if (provider === 'anthropic') {
    model_version = str(code.anthropic?.model_version);
    model_path = 'expected.code.anthropic.model_version';
  } else {
    const model = str(expected?.declared?.[provider]?.model);
    const prefix = typeof code.model_version_prefix === 'string' ? code.model_version_prefix : null;
    model_version = model && prefix != null ? `${prefix}${model}` : null;
    model_path = `expected.code.model_version_prefix + expected.declared.${provider}.model`;
  }
  const decl = expected?.declared?.[provider];
  const decoding = code.decoding?.evaluate && typeof code.decoding.evaluate === 'object' ? code.decoding.evaluate : null;
  return {
    prompt_version, rubric_version, model_version,
    provider_declared: str(expected?.declared?.providers?.evaluate),
    decoding,
    declared: decl && typeof decl === 'object' ? { engine: str(decl.engine), model: str(decl.model) } : null,
    paths: {
      prompt_version: `expected.code.evaluator.prompt_version.${provider}`,
      rubric_version: 'expected.code.evaluator.rubric_version',
      model_version: model_path,
      provider: 'expected.declared.providers.evaluate',
      decoding: 'expected.code.decoding.evaluate',
    },
  };
}

// The comparable form of a manifest decoding value: a number, or the `default` of { default, env, min }.
const decodingValue = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v.default ?? null : v ?? null);

/**
 * Field-by-field difference between what is about to be frozen and what the manifest expects for the
 * candidate's provider. Empty = consistent.
 *
 * With a `declaration` (POST), the declared evaluator_prompt_version and rubric_version are compared, and
 * so is each declared `decoding` value the manifest states (temperature, max_tokens; a key the manifest
 * does not state, such as top_p or seed, is not compared). Without one (GET, nothing declared yet), the
 * candidate's own prompt_version is. Either way the candidate is MEASURED: its provider must be the one
 * the manifest declares for evaluate, its model_version the expected one, and every row in its group
 * scored under the expected rubric — a group spanning two rubrics is not one instrument.
 * system_prompt_version has no counterpart in the manifest and is not compared.
 */
function manifestDiff({ expected, candidate, declaration = null }) {
  const exp = expectedFor(expected, candidate?.provider);
  const out = [];
  const check = (field, source, value, want, path) => {
    if (want == null || value !== want) out.push({ field, source, value: value ?? null, expected: want ?? null, manifest_path: path });
  };
  check('provider', 'candidate', candidate?.provider ?? null, exp.provider_declared, exp.paths.provider);
  if (declaration) {
    check('evaluator_prompt_version', 'declaration', declaration.evaluator_prompt_version, exp.prompt_version, exp.paths.prompt_version);
    check('rubric_version', 'declaration', declaration.rubric_version, exp.rubric_version, exp.paths.rubric_version);
    for (const [k, v] of Object.entries(declaration.decoding ?? {})) {
      if (v === undefined || !exp.decoding || !(k in exp.decoding)) continue;
      check(`decoding.${k}`, 'declaration', v, decodingValue(exp.decoding[k]), `${exp.paths.decoding}.${k}`);
    }
  } else {
    check('prompt_version', 'candidate', candidate?.prompt_version ?? null, exp.prompt_version, exp.paths.prompt_version);
  }
  check('model_version', 'candidate', candidate?.model_version ?? null, exp.model_version, exp.paths.model_version);
  const rubrics = candidate?.rubric_versions ?? [];
  if (exp.rubric_version == null || rubrics.length !== 1 || rubrics[0] !== exp.rubric_version) {
    out.push({ field: 'candidate_rubric_versions', source: 'candidate', value: rubrics, expected: exp.rubric_version, manifest_path: exp.paths.rubric_version });
  }
  return out;
}

const fmt = (v) => (Array.isArray(v) ? `[${v.map((x) => (x == null ? 'null' : `"${x}"`)).join(', ')}]` : v == null ? 'null' : `"${v}"`);

function manifestMismatch(diff, extra = {}) {
  const lines = diff.map((d) => `${d.field}: ${d.source === 'declaration' ? 'declared' : 'candidate'} ${fmt(d.value)}, manifest expects ${fmt(d.expected)}`);
  return {
    error: `ค่าที่จะล็อกไม่ตรงกับ model manifest ${diff.length} รายการ / The configuration being frozen does not match the model manifest: ${lines.join('; ')}.`,
    code: 'manifest_mismatch',
    diff,
    ...extra,
  };
}

// ---- the evaluator digest: the scope of the lock -------------------------------------------------

// Canonical JSON: object keys sorted recursively, array order kept, undefined → null. Backend-internal:
// the frozen digest and the live one are both computed HERE, by evaluatorDigest, so this does not need to
// match rimpl's canonicalisation (lib/manifest.js), only itself.
function canonical(value) {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = canonical(value[k]);
    return out;
  }
  return value;
}
const canonicalJson = (value) => JSON.stringify(canonical(value));

/**
 * EXACTLY the scoring instrument, for a candidate `provider` — the keys of the manifest's expected half
 * that the lock freezes. Change one and /health/deep degrades (evaluator_changed_since_lock); change
 * anything else (tutor, router, chat or discuss prompts, thinking, another provider's declared block) and
 * it reports a note. Documented the same way in docs/deployment.md.
 *
 *   expected.code.evaluator                  prompt_version / prompt_sha256 per provider, the local
 *                                            addendum sha, rubric_version, weights
 *   expected.code.model_version_prefix       what every score's model_version starts with
 *   expected.code.decoding.evaluate          temperature and max_tokens the evaluator sends
 *   expected.code.decoding.num_ctx[provider] ONLY for an on-prem provider (not anthropic): the context
 *                                            override the local transport sends on every call when > 0,
 *                                            which decides how much of the transcript the model sees
 *   expected.code.consistency                MINUS its `shadow` key, AS IT GOVERNS THIS PROVIDER (see
 *                                            consistencyGoverns): the whole block (agree, evaluate,
 *                                            method, modes, rules) when it governs; otherwise only
 *                                            evaluate.mode.{applies_to, default}, the two values that
 *                                            keep it off this provider's scores
 *   expected.code.providers.allowed.evaluate which providers may evaluate at all
 *   expected.declared.providers.evaluate     the provider the target deployment scores with
 *   expected.declared[provider]              that provider's declared model, engine, fingerprint
 *   expected.code.anthropic                  ONLY when provider is anthropic: the pinned Claude model
 */
// Does the self-consistency rule govern `provider`'s scores? The rule is rimpl's own
// (lib/consistency-config.js consistencyModeFor): EVAL_CONSISTENCY reaches only the provider named by
// code.consistency.evaluate.mode.applies_to, and every other provider runs the code DEFAULT mode. So the
// rule governs the applies_to provider always, and any other provider only while that default is not
// 'off'. A manifest that does not name applies_to is read as governing: kept in scope, failing closed.
// Used for both the digest and the live-drift filter, so the two cannot disagree.
function consistencyGoverns(consistency, provider) {
  const mode = consistency?.evaluate?.mode;
  if (!mode || typeof mode !== 'object' || typeof mode.applies_to !== 'string') return true;
  return provider === mode.applies_to || mode.default !== 'off';
}

// code.consistency without `shadow` (the shadow evaluator's own settings never score a PLE), as it
// governs `provider`. For a provider it does not govern, a change to applies_to or to the default mode
// would put the rule on that provider's scores, so those two values stay in scope.
function consistencyScope(consistency, provider) {
  if (!consistency || typeof consistency !== 'object' || Array.isArray(consistency)) return consistency ?? null;
  const { shadow: _shadow, ...rest } = consistency;
  if (consistencyGoverns(consistency, provider)) return rest;
  const { applies_to, default: dflt } = consistency.evaluate.mode;
  return { evaluate: { mode: { applies_to, default: dflt } } };
}

// num_ctx is sent by the on-prem transport only (services/providers/local-factory.js call()); the
// Anthropic transport has no such option. Every provider other than anthropic is an on-prem instance.
const sendsNumCtx = (provider) => typeof provider === 'string' && !!provider && provider !== 'anthropic';

function evaluatorScope(expected, provider) {
  const code = expected?.code ?? {};
  const declared = expected?.declared ?? {};
  return {
    'code.evaluator': code.evaluator ?? null,
    'code.model_version_prefix': code.model_version_prefix ?? null,
    'code.decoding.evaluate': code.decoding?.evaluate ?? null,
    ...(sendsNumCtx(provider) ? { [`code.decoding.num_ctx.${provider}`]: code.decoding?.num_ctx?.[provider] ?? null } : {}),
    'code.consistency (minus shadow, as it governs this provider)': consistencyScope(code.consistency, provider),
    'code.providers.allowed.evaluate': code.providers?.allowed?.evaluate ?? null,
    'declared.providers.evaluate': declared.providers?.evaluate ?? null,
    [`declared.${provider}`]: declared[provider] ?? null,
    ...(provider === 'anthropic' ? { 'code.anthropic': code.anthropic ?? null } : {}),
  };
}

// The ONE function that computes the evaluator digest: called at lock time (frozen on the row as
// evaluator_sha256) and at health time (on the live manifest), so the two cannot diverge.
// The tag names the scope. v1 froze code.consistency.evaluate alone; v2 widened it to all of
// code.consistency except `shadow`. v3 (2026-10-15) adds the evaluate provider's num_ctx entry for an
// on-prem provider, and keeps consistency only as it governs the provider (consistencyGoverns), so an
// anthropic lock is not moved by the local arm's consistency settings. Changing the scope again means a
// new tag: a frozen digest can only be recomputed by the scope it was taken under. No lock has been
// taken under v1 or v2.
const EVALUATOR_SCOPE_VERSION = 'clics-evaluator-scope/v3';
function evaluatorDigest(expected, provider) {
  const body = canonicalJson({ v: EVALUATOR_SCOPE_VERSION, provider: provider ?? null, scope: evaluatorScope(expected, provider) });
  return crypto.createHash('sha256').update(body, 'utf8').digest('hex');
}

// ---- live drift on the evaluator's keys ----------------------------------------------------------
//
// evaluatorDigest() covers the manifest's EXPECTED half: code defaults plus declared values. An env
// override changes what rimpl RUNS without changing what its manifest says, so the digest cannot see
// it. Examples: EVAL_CONSISTENCY=adaptive, or LOCAL_AI_MODEL naming another model. rimpl reports that
// difference separately, as GET /manifest `drift[]`: one { key, expected, live } for each live value
// that differs (rimpl/src/lib/manifest.js driftOf; tests/evaluator-model-lock.test.js pins this filter
// to the key strings it emits). Drift on one of the keys below means the instrument actually scoring
// is not the one the manifest describes. A lock declared now would freeze a description of a different
// instrument, and a lock already in force no longer holds.
//
// The keys follow the digest's scope (v3) as closely as the drift key names allow:
//   code.decoding.evaluate.*            temperature, max_tokens        -> code.decoding.evaluate
//   code.decoding.num_ctx.<provider>    ONLY for an on-prem provider   -> code.decoding.num_ctx[provider]
//   code.consistency.*, minus shadow_*  evaluate_mode, max_sum_delta,  -> code.consistency minus shadow,
//                                       json_retries; ONLY while the      as it governs this provider
//                                       rule governs this provider
//                                       (consistencyGoverns, on the
//                                       manifest's expected half)
//   declared.providers.evaluate                                        -> declared.providers.evaluate
//   declared.<provider>.*               model, served_model, engine,   -> declared[provider]
//                                       system_fingerprint
//   code.models.anthropic               ONLY for an anthropic lock     -> code.anthropic
// Outside, as they are outside the digest: see DRIFT_OUT. Only the KEYS are read. The values are
// operator- and server-supplied strings, and they never leave this module.
//
// FAILS CLOSED. Every key is classified by an explicit rule: DRIFT_IN (on the instrument) or DRIFT_OUT
// (off it). A key that matches NEITHER is one this code has never classified, such as a knob rimpl adds
// later (code.think_preopened.local, code.evaluator.prompt_override), and it counts as IN until someone
// classifies it. A key that is not a plain dotted name (DRIFT_KEY) counts as IN too, and is reported as
// MALFORMED_DRIFT_KEY, never as the string it carried. tests/evaluator-model-lock.test.js checks that
// IN and OUT partition every key rimpl emits, for every provider that may evaluate.
//
// `expected` is the manifest's expected half (the one the keys came with). Without it, whether
// consistency governs the provider is unknown, and its keys stay in scope (failing closed). Without a
// provider, nothing provider-specific can be ruled OUT.
const DRIFT_KEY = /^[a-z0-9_.-]+$/i;
const MALFORMED_DRIFT_KEY = '(malformed drift key)';
const isConsistencyKey = (k) => k.startsWith('code.consistency.') && !k.startsWith('code.consistency.shadow');

// Each rule: [name, (key, c) => boolean], c = { provider (null when unknown), numCtx, governs }.
const DRIFT_IN = Object.freeze([
  ['evaluate decoding', (k) => k.startsWith('code.decoding.evaluate.')],
  ['the evaluator\'s num_ctx (on-prem)', (k, c) => c.numCtx && k === `code.decoding.num_ctx.${c.provider}`],
  ['consistency, governing this provider', (k, c) => isConsistencyKey(k) && c.governs],
  ['the evaluate route', (k) => k === 'declared.providers.evaluate'],
  ['the evaluator\'s declared block', (k, c) => c.provider != null && k.startsWith(`declared.${c.provider}.`)],
  ['the pinned Claude model (anthropic lock)', (k, c) => k === 'code.models.anthropic' && c.provider === 'anthropic'],
]);
const DRIFT_OUT = Object.freeze([
  ['chat decoding', (k) => k.startsWith('code.decoding.chat.')],
  ['shadow decoding', (k) => k.startsWith('code.decoding.shadow.')],
  ['criteria decoding', (k) => k.startsWith('code.decoding.criteria.')],
  ['discuss decoding', (k) => k.startsWith('code.decoding.discuss.')],
  ['shadow consistency', (k) => k.startsWith('code.consistency.shadow')],
  ['thinking style (chat turns only)', (k) => k.startsWith('code.thinking_style.')],
  ['another provider\'s num_ctx', (k, c) => c.provider != null && k.startsWith('code.decoding.num_ctx.')
    && k !== `code.decoding.num_ctx.${c.provider}`],
  ['another provider\'s declared block', (k, c) => c.provider != null && /^declared\.[^.]+\./.test(k)
    && !k.startsWith('declared.providers.') && !k.startsWith(`declared.${c.provider}.`)],
  ['another purpose\'s route', (k) => k.startsWith('declared.providers.') && k !== 'declared.providers.evaluate'],
  ['the Claude model (non-anthropic lock)', (k, c) => k === 'code.models.anthropic' && c.provider != null && c.provider !== 'anthropic'],
  ['consistency, not governing this provider', (k, c) => isConsistencyKey(k) && !c.governs],
]);

// Which rules a key matches, by name, for `provider`. 'providers' is the purpose map, never a provider.
function driftKeyRules(key, provider, expected = null) {
  const p = typeof provider === 'string' && provider && provider !== 'providers' ? provider : null;
  const c = { provider: p, numCtx: sendsNumCtx(p), governs: p == null || consistencyGoverns(expected?.code?.consistency, p) };
  const names = (rules) => rules.filter(([, test]) => test(key, c)).map(([name]) => name);
  return { in: names(DRIFT_IN), out: names(DRIFT_OUT) };
}

function isEvaluatorDriftKey(key, provider, expected = null) {
  if (typeof key !== 'string' || !DRIFT_KEY.test(key)) return true;   // unreadable: in, as a placeholder
  const rules = driftKeyRules(key, provider, expected);
  if (rules.in.length) return true;
  if (rules.out.length) return false;
  return true;   // matches no rule: never classified, so part of the instrument until it is
}

// The keys of a drift array (GET /manifest's raw drift, or rimpl's public /health/deep drift, which
// carries the same key strings), in rimpl's order. An entry whose key is missing or not a plain dotted
// name becomes MALFORMED_DRIFT_KEY: kept, so it still counts, but never relayed as the string it carried.
function driftKeysOf(drift) {
  return (Array.isArray(drift) ? drift : []).map((d) => (typeof d?.key === 'string' && DRIFT_KEY.test(d.key) ? d.key : MALFORMED_DRIFT_KEY));
}

// The evaluator-scope subset of a manifest's drift keys, in rimpl's order, for the candidate or locked
// `provider`.
function evaluatorDriftKeys(driftKeys, provider, expected = null) {
  const keys = (Array.isArray(driftKeys) ? driftKeys : [])
    .map((k) => (typeof k === 'string' && DRIFT_KEY.test(k) ? k : MALFORMED_DRIFT_KEY));
  return [...new Set(keys.filter((k) => isEvaluatorDriftKey(k, provider, expected)))];
}

const evaluatorLiveDrift = (keys, provider) => ({
  error: `ค่าที่ RIMPL ใช้งานอยู่จริงไม่ตรงกับ model manifest ในส่วนของผู้ให้คะแนน ${keys.length} รายการ (${keys.join(', ')}) `
    + 'จึงยังล็อกไม่ได้ เพราะเครื่องมือที่กำลังให้คะแนนอยู่ไม่ใช่เครื่องมือที่การล็อกจะบันทึกไว้ ให้ยกเลิกค่าที่ override ไว้ก่อน '
    + 'หรือถ้าตั้งใจเปลี่ยนจริง ให้แก้ค่าในโค้ดหรือไฟล์ declared สร้าง manifest ใหม่ (scripts/manifest/build.mjs) และ deploy RIMPL ใหม่ แล้วจึงล็อก / '
    + `The live RIMPL configuration differs from the model manifest on ${keys.length} evaluator key(s) (${keys.join(', ')}), `
    + 'so the instrument scoring now is not the one a lock would record. Remove the override, or, if the change is intended, '
    + 'make it in the code or the declared file, regenerate the manifest (scripts/manifest/build.mjs) and redeploy RIMPL. Then lock.',
  code: 'evaluator_live_drift',
  keys,
  provider: provider ?? null,
});

// ---- schema ------------------------------------------------------------------------------------

/**
 * Has migration-evaluator-lock-manifest.sql been applied? Returns { ok: true }, or
 * { ok: false, missing: true, tableMissing } for an unmigrated database (a known state, not a fault),
 * or { ok: false, error } for anything else.
 */
async function lockSchemaStatus() {
  let error;
  try {
    ({ error } = await supabase.from('evaluator_model_lock').select(MANIFEST_COLS).limit(1));
  } catch (e) {
    return { ok: false, error: { message: e?.message || String(e) } };
  }
  if (!error) return { ok: true };
  if (isMissingColumnOrTable(error)) {
    return { ok: false, missing: true, tableMissing: isMissingTable(error), error };
  }
  return { ok: false, error };
}

// PostgREST: PGRST205 (no such table), PGRST204 (no such column in an insert payload); Postgres:
// 42P01 (relation), 42703 (column). isMissingRelation also matches the "does not exist" / "schema cache"
// wording both families use.
function isMissingTable(error) {
  const code = String(error?.code ?? '');
  if (code === 'PGRST205' || code === '42P01') return true;
  const msg = `${error?.message ?? ''}`.toLowerCase();
  return /relation .* does not exist|could not find the table/.test(msg);
}
function isMissingColumnOrTable(error) {
  const code = String(error?.code ?? '');
  return code === '42703' || code === 'PGRST204' || isMissingRelation(error);
}

// ---- the lock in force -------------------------------------------------------------------------

/**
 * The lock in force: the flag (the single thing the provider switch consults) and the record whose
 * locked_at it carries — POST /admin/evaluator-lock writes both from one timestamp. The frozen shas are
 * null when unlocked, when the record has none (a lock taken before the column existed), or when the
 * record cannot be read. Never throws; an unreadable flag is { error }, never "unlocked".
 */
async function lockInForce() {
  const flag = await getTextSettingStrict('evaluator_locked_at');
  if (flag.error) return { error: flag.error.message ?? String(flag.error) };
  if (!flag.value) return { locked: false, locked_at: null, manifest_sha256: null, evaluator_sha256: null, provider: null, record: null };
  let data = null, error = null;
  try {
    ({ data, error } = await supabase.from('evaluator_model_lock').select('id, locked_at, provider, manifest_sha256, evaluator_sha256')
      .eq('locked_at', flag.value).order('locked_at', { ascending: false }).limit(1).maybeSingle());
  } catch (e) {
    error = { message: e?.message || String(e) };
  }
  if (error) {
    return { locked: true, locked_at: flag.value, manifest_sha256: null, evaluator_sha256: null, provider: null,
      record: isMissingColumnOrTable(error) ? 'migration_pending' : 'unreadable', record_error: error.message ?? String(error) };
  }
  return { locked: true, locked_at: flag.value, provider: data?.provider ?? null,
    manifest_sha256: data?.manifest_sha256 ?? null, evaluator_sha256: data?.evaluator_sha256 ?? null, record: data ? 'found' : 'none' };
}

const lower = (v) => (typeof v === 'string' && v ? v.toLowerCase() : null);

// ---- the declaration every post-lock score carries (#75 acceptance criterion 7) -------------------
//
// rimpl's per-score config_fingerprint (rimpl/src/lib/provenance.js) covers what rimpl can see: provider,
// model, the declared weights digest, prompt and rubric versions, the decoding actually sent, and the
// serving stack WHEN the server reports it. The rest of the declaration exists only on the lock record:
// the declared inference engine, the quantization (vLLM can load the same weights file at fp8 or bf16),
// the environment (library versions), the system prompt version and the declared decoding. Without it,
// two locks over the same weights checksum gave scores with identical fingerprints.
//
// So an evaluation run while a lock is in force carries lockDeclarationDigest() of the record the flag
// points at (services/ple-evaluation.js evaluationLockStamp reads it), and rimpl folds it into the
// fingerprint. ONLY then: unlocked, nothing is sent, and the fingerprint is the one it always was.
//
// IN IT: exactly LOCK_DECLARATION_FIELDS, each the record's value or null when the record lacks it, as
// canonical JSON (canonicalJson above: keys sorted recursively, array order kept) tagged with
// LOCK_DECLARATION_VERSION. Values are taken as stored, so a STATED "no seed" (decoding.seed: null) and
// an undeclared seed (no key) are different declarations, as the lock form treats them.
// NOT IN IT: id, locked_at, locked_by, gate, note and the manifest columns. They say when, by whom and on
// what evidence a lock was taken, not what it froze; with them, re-declaring identical values would give
// a new digest and split one configuration's scores into two groups. The manifest columns describe
// rimpl's build: its evaluator part is what each score already measures (prompt, rubric, decoding,
// consistency) and what /health/deep compares against evaluator_sha256.
// Changing the field set or the payload means a new tag: a digest can only be recomputed by the version
// it was taken under.
const LOCK_DECLARATION_VERSION = 'clics-lock-declaration/v1';
const LOCK_DECLARATION_FIELDS = Object.freeze([
  'weights_sha256', 'inference_engine', 'quantization', 'environment',
  'system_prompt_version', 'evaluator_prompt_version', 'rubric_version', 'decoding',
  'provider', 'model_version',
]);

function lockDeclarationDigest(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new TypeError('lockDeclarationDigest needs a lock record');
  const declaration = Object.fromEntries(LOCK_DECLARATION_FIELDS.map((k) => [k, record[k] ?? null]));
  return crypto.createHash('sha256').update(canonicalJson({ v: LOCK_DECLARATION_VERSION, declaration }), 'utf8').digest('hex');
}

/**
 * /health/deep's verdict on the lock (and /admin/ai-readiness's relay of it).
 *
 * It DEGRADES only while locked, and only when it cannot show the frozen INSTRUMENT is the one scoring:
 *   evaluator_changed_since_lock  the live manifest's evaluator digest differs from the frozen one
 *   evaluator_live_drift          the digest matches, but rimpl reports live drift on an evaluator key
 *                                 for the locked provider (an env override): `drift_keys`, keys only.
 *                                 Drift on any other key (tutor, chat, router, shadow, another
 *                                 provider) changes nothing here.
 *   live_manifest_unknown         GET /manifest cannot be read, or fails the same rules a lock needs
 *   lock_not_bound_to_manifest    the record has no evaluator digest (locked before it existed, or a
 *                                 flag with no record behind it)
 *   lock_record_unmigrated / lock_record_unreadable
 * A whole-manifest change with the evaluator digest unchanged stays `up`, with
 * note 'tutor_or_router_changed_since_lock' and both shas.
 *
 * UNLOCKED — production today — is `up` and fetches nothing: `live_sha256` is the sha rimpl's own
 * /health/deep already reports (`deep`). An unreadable lock state is `unknown`, not a degrade: the
 * supabase check already fails the verdict when the database is down.
 */
async function modelLockCheck(lock, { deep = null, fetchTimeoutMs } = {}) {
  const deepSha = lower(deep?.manifest?.sha256);
  if (lock?.error) {
    return { status: 'unknown', locked: null, locked_at: null, manifest_sha256: null, live_sha256: deepSha, match: null, error: lock.error };
  }
  if (!lock?.locked) {
    return { status: 'up', locked: false, locked_at: null, manifest_sha256: null, live_sha256: deepSha, match: null };
  }
  const frozen = { manifest: lower(lock.manifest_sha256), evaluator: lower(lock.evaluator_sha256) };
  const out = { status: 'down', locked: true, locked_at: lock.locked_at, provider: lock.provider ?? null,
    manifest_sha256: frozen.manifest, evaluator_sha256: frozen.evaluator, live_sha256: deepSha, live_evaluator_sha256: null, match: false };
  if (lock.record_error) out.record_error = lock.record_error;
  if (lock.record === 'migration_pending') return { ...out, reason: 'lock_record_unmigrated' };
  if (lock.record === 'unreadable') return { ...out, reason: 'lock_record_unreadable' };
  if (!frozen.evaluator || !lock.provider) return { ...out, reason: 'lock_not_bound_to_manifest' };

  const live = await cachedLiveManifest({ timeoutMs: fetchTimeoutMs });
  if (!live.ok) return { ...out, reason: 'live_manifest_unknown', live_manifest: live.reason };
  const liveEvaluator = evaluatorDigest(live.expected, lock.provider);
  const result = { ...out, live_sha256: live.sha256, live_evaluator_sha256: liveEvaluator, match: liveEvaluator === frozen.evaluator };
  // Which evaluator values the running rimpl overrides, by key. Never what the values are.
  const overridden = evaluatorDriftKeys(live.drift_keys, lock.provider, live.expected);
  if (overridden.length) result.drift_keys = overridden;
  if (!result.match) return { ...result, reason: 'evaluator_changed_since_lock' };
  if (overridden.length) return { ...result, reason: 'evaluator_live_drift' };
  result.status = 'up';
  if (live.sha256 !== frozen.manifest) result.note = 'tutor_or_router_changed_since_lock';
  return result;
}

module.exports = {
  manifestForLock, judgeManifest, cachedLiveManifest, resetManifestCache, expectedFor, manifestDiff, manifestMismatch,
  evaluatorScope, evaluatorDigest, canonicalJson, EVALUATOR_SCOPE_VERSION, lockSchemaStatus, lockInForce, modelLockCheck,
  lockDeclarationDigest, LOCK_DECLARATION_VERSION, LOCK_DECLARATION_FIELDS,
  isEvaluatorDriftKey, evaluatorDriftKeys, evaluatorLiveDrift, consistencyGoverns,
  driftKeyRules, driftKeysOf, DRIFT_IN, DRIFT_OUT, MALFORMED_DRIFT_KEY,
  migrationRequired, isMissingColumnOrTable, isMissingTable,
  relockRequired, unlockRequired, evaluatorLocked, gateNotPassed, candidateNotEvaluator, candidateNotServing,
  LOCK_STATE_UNREADABLE, USE_MODEL_LOCK, SAVED_STATE_UNREADABLE, INVALID_DECLARATION_ERROR,
  MANIFEST_COLS, LOCK_MIGRATION, MANIFEST_MIGRATION, MANIFEST_CACHE_MS,
};
