// Deterministic integrity signals — detecting agent-delegated or gamed CLE sessions.
//
// Runs beside services/cle-gate.js (the C1–C3 tier-1 gate) on the same principle: cheap, server-side,
// explainable, and impossible to talk out of via a prompt.
//
// ============================================================================================
// DELIBERATELY NOT AN LLM JUDGE.
// An unvalidated model accusing a physician of cheating is a liability, not a feature. The same
// reasoning that puts the deterministic C1–C3 gate before the model-scored C4–C6 applies here: a
// signal that can be argued with is a signal that will be argued with. Every rule below is
// arithmetic over data we already store, and every flag carries the evidence that produced it.
//
// ============================================================================================
// PII CONSTRAINT — READ BEFORE ADDING ANYTHING HERE.
// backend/src/routes/cles.js stores `content: message`, the RAW physician text. rimpl strips PII only
// for the outbound cloud call; the database deliberately keeps the original as the evidentiary
// transcript. So this detector — especially F2, which compares a physician's OTHER CLEs — processes
// PII BY DESIGN. That is acceptable only while it stays inside the backend and never reaches a model.
// Do not "improve" this file with an LLM pass. Doing so would breach the one boundary the
// architecture's strongest claim rests on, and it would do it quietly.
//
// ============================================================================================
// SEVERITY IS A ROUTING DECISION, NOT A VERDICT.
// A flag sends a CLE to a human. It never penalises, never reaches the physician, and never changes
// a score. Several of these fire on legitimate behaviour — pasting a real de-identified case note
// looks like F3; a cardiologist who always asks about troponin looks like F2 — which is exactly why
// the output is "a person should look at this", not "this person cheated".

// ---------------------------------------------------------------------------------------------
// Character trigrams, not word tokens. Thai has no inter-word spaces, so any word-boundary measure
// silently degrades to "one enormous token" on Thai text and reports 0 similarity between two
// near-identical Thai turns. Trigrams work the same way in both scripts.
function trigrams(text) {
  const s = String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (s.length < 3) return new Set(s ? [s] : []);
  const out = new Set();
  for (let i = 0; i <= s.length - 3; i++) out.add(s.slice(i, i + 3));
  return out;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter++;
  return inter / (a.size + b.size - inter);
}

// ============================================================================================
// THRESHOLDS ARE CALIBRATED AGAINST REAL SESSIONS, NOT GUESSED.
// Measured 2026-08-26 over prod: 398 messages across 33 CLEs, 27 of them with usable inter-turn
// timing. The numbers each rule cites below are from that run. Re-run the calibration before
// changing any of them — a threshold nobody has checked against data is a threshold that will
// eventually accuse a physician of something they did not do.
const SIGNALS = {
  // Physician turns that repeat each other within ONE session. A person exploring a case does not
  // send the same paragraph twice; a script padding turn count to clear C2 (>= 4 turns) does.
  // MEASURED: 2 real sessions contain an exact within-session repeat. Low enough to act on.
  F1_NEAR_DUPLICATE: { threshold: 0.92, min_chars: 40, enabled: true },

  // The same physician's turns reappearing across their OWN other CLEs.
  // Reads raw PII by design — see the constraint at the top of this file.
  // MEASURED: 8 exact-duplicate groups across sessions, and every one of them sits in the pilot's
  // TEST sessions, where the team pasted the same scripted prompt repeatedly. That makes the real
  // false-positive rate unknown rather than low, so the caller must exclude test CLEs from the
  // comparison corpus, and this signal never exceeds 'medium'.
  F2_CROSS_SESSION_REUSE: { threshold: 0.90, min_chars: 60, enabled: true },

  // A large turn arriving too soon after the previous message to have been typed.
  // Stays 'low' forever: pasting a real de-identified case note is legitimate and looks identical.
  F3_PASTE_BURST: { min_tokens: 400, max_gap_seconds: 8, enabled: true },

  // Composition rate above what a person can type.
  //
  // DEFAULT OFF — it did not survive calibration. MEASURED: 7 real physician turns exceed 25
  // chars/sec, and the observed maximum is 937 chars/sec with a 99th percentile of 626. Those are
  // not automation: message timestamps are genuine send times (assistant -> physician gaps have a
  // hard 2.0s floor and a 56.7s median), so a 937 chars/sec turn is a physician PASTING a case
  // note. This signal therefore measures pasting, which F3 already reports at 'low', and it does so
  // while implying automation. Shipping five signals of which one cries wolf is worse than shipping
  // four. Enable only after re-calibrating against non-test sessions.
  F4_COMPOSITION_RATE: { max_chars_per_second: 25, min_chars: 200, enabled: false },

  // Inter-turn gaps that barely vary. A person's rhythm is irregular; a loop's is not.
  // MEASURED: at min_turns 5 this fired on 1 real CLE that had only 4 gaps — a coefficient of
  // variation over 4 samples is noise, not rhythm. At min_turns 7 (>= 6 gaps) it fires on ZERO of
  // the 27 real sessions, which is the calibration target.
  F5_LATENCY_UNIFORMITY: { min_turns: 7, max_cv: 0.08, enabled: true },
};

const seconds = (a, b) => Math.abs(new Date(a) - new Date(b)) / 1000;

/**
 * @param {Array} messages  [{ role, content, created_at, token_count }] for ONE CLE, chronological
 * @param {Array} priorTurns  the physician's turns from their OTHER CLEs: [{ cle_id, content }]
 * @param {object} [cfg]  per-signal overrides (for tuning against real data)
 * @returns {Array<{signal, severity, evidence}>}
 *
 * PURE — no database, no clock. The caller supplies the data; this decides.
 */
function detectIntegritySignals(messages, priorTurns = [], cfg = {}) {
  const C = { ...SIGNALS, ...cfg };
  const turns = (messages ?? []).filter(m => m.role === 'user' || m.role === 'physician');
  const flags = [];
  if (!turns.length) return flags;

  const grams = turns.map(t => trigrams(t.content));

  // --- F1: near-duplicate turns within the session ---------------------------------------------
  for (let i = 0; i < turns.length; i++) {
    for (let j = i + 1; j < turns.length; j++) {
      const len = Math.min(String(turns[i].content ?? '').length, String(turns[j].content ?? '').length);
      if (len < C.F1_NEAR_DUPLICATE.min_chars) continue;
      const sim = jaccard(grams[i], grams[j]);
      if (C.F1_NEAR_DUPLICATE.enabled !== false && sim >= C.F1_NEAR_DUPLICATE.threshold) {
        flags.push({
          signal: 'F1_NEAR_DUPLICATE',
          severity: sim >= 0.99 ? 'high' : 'medium',
          evidence: { turn_a: i + 1, turn_b: j + 1, similarity: Math.round(sim * 1000) / 1000,
            excerpt: String(turns[i].content).slice(0, 120) },
        });
      }
    }
  }

  // --- F2: reuse across the physician's own other sessions -------------------------------------
  const priorGrams = (priorTurns ?? []).map(p => ({ cle_id: p.cle_id, g: trigrams(p.content), text: p.content }));
  for (let i = 0; i < turns.length; i++) {
    if (String(turns[i].content ?? '').length < C.F2_CROSS_SESSION_REUSE.min_chars) continue;
    for (const prior of priorGrams) {
      if (String(prior.text ?? '').length < C.F2_CROSS_SESSION_REUSE.min_chars) continue;
      const sim = jaccard(grams[i], prior.g);
      if (C.F2_CROSS_SESSION_REUSE.enabled !== false && sim >= C.F2_CROSS_SESSION_REUSE.threshold) {
        flags.push({
          signal: 'F2_CROSS_SESSION_REUSE',
          // Never 'high': see the calibration note on F2 — every observed cross-session
          // duplicate came from the pilot's own test sessions, so the real rate is unknown.
          severity: 'medium',
          evidence: { turn: i + 1, other_cle_id: prior.cle_id, similarity: Math.round(sim * 1000) / 1000,
            excerpt: String(turns[i].content).slice(0, 120) },
        });
        break; // one flag per turn — N near-identical priors is one finding, not N
      }
    }
  }

  // --- F3 / F4: arrival timing against size ----------------------------------------------------
  const all = (messages ?? []).slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  for (let i = 0; i < all.length; i++) {
    const m = all[i];
    if (!(m.role === 'user' || m.role === 'physician')) continue;
    const prev = all[i - 1];
    if (!prev?.created_at || !m.created_at) continue;
    const gap = seconds(m.created_at, prev.created_at);
    const chars = String(m.content ?? '').length;
    const tokens = Number(m.token_count ?? 0);

    if (C.F3_PASTE_BURST.enabled !== false && tokens >= C.F3_PASTE_BURST.min_tokens && gap <= C.F3_PASTE_BURST.max_gap_seconds) {
      flags.push({
        signal: 'F3_PASTE_BURST',
        // Pasting a real (de-identified) case note looks exactly like this, so it is never 'high'
        // on its own. It is a reason to read the transcript, not a conclusion about the physician.
        severity: 'low',
        evidence: { turn_index: i + 1, token_count: tokens, gap_seconds: Math.round(gap * 10) / 10 },
      });
    }

    if (C.F4_COMPOSITION_RATE.enabled !== false && chars >= C.F4_COMPOSITION_RATE.min_chars && gap > 0) {
      const rate = chars / gap;
      if (rate > C.F4_COMPOSITION_RATE.max_chars_per_second) {
        flags.push({
          signal: 'F4_COMPOSITION_RATE',
          severity: rate > C.F4_COMPOSITION_RATE.max_chars_per_second * 3 ? 'medium' : 'low',
          evidence: { turn_index: i + 1, chars, gap_seconds: Math.round(gap * 10) / 10,
            chars_per_second: Math.round(rate * 10) / 10 },
        });
      }
    }
  }

  // --- F5: machine-regular rhythm ---------------------------------------------------------------
  const gaps = [];
  for (let i = 1; i < turns.length; i++) {
    if (turns[i].created_at && turns[i - 1].created_at) gaps.push(seconds(turns[i].created_at, turns[i - 1].created_at));
  }
  if (C.F5_LATENCY_UNIFORMITY.enabled !== false && gaps.length >= C.F5_LATENCY_UNIFORMITY.min_turns - 1) {
    const mean = gaps.reduce((a, x) => a + x, 0) / gaps.length;
    if (mean > 0) {
      const sd = Math.sqrt(gaps.reduce((a, x) => a + (x - mean) ** 2, 0) / gaps.length);
      const cv = sd / mean;  // coefficient of variation — scale-free, so a slow script and a fast
                             // one are judged the same way
      if (cv <= C.F5_LATENCY_UNIFORMITY.max_cv) {
        flags.push({
          signal: 'F5_LATENCY_UNIFORMITY',
          severity: cv <= 0.02 ? 'high' : 'medium',
          evidence: { turns: turns.length, mean_gap_seconds: Math.round(mean * 10) / 10,
            coefficient_of_variation: Math.round(cv * 1000) / 1000 },
        });
      }
    }
  }

  // ONE row per signal per CLE. Six identical turns produce fifteen duplicate PAIRS; writing fifteen
  // rows would make the admin queue unreadable and make "how many CLEs are flagged" uncountable
  // without a DISTINCT. Collapse to a finding per signal, carrying the count and the worst instance —
  // an auditor needs to know "this session repeats itself, badly", not every pairing that proves it.
  return collapse(flags);
}

const SEVERITY_RANK = { low: 1, medium: 2, high: 3 };

function collapse(flags) {
  const bySignal = new Map();
  for (const f of flags) {
    const prev = bySignal.get(f.signal);
    if (!prev) {
      bySignal.set(f.signal, { ...f, evidence: { ...f.evidence, occurrences: 1 } });
      continue;
    }
    prev.evidence.occurrences++;
    // Keep the WORST instance as the representative evidence, and the highest severity seen.
    if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[prev.severity]) {
      prev.severity = f.severity;
      prev.evidence = { ...f.evidence, occurrences: prev.evidence.occurrences };
    }
  }
  // Most severe first, so the admin queue's first row is the one worth opening.
  return [...bySignal.values()].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
}

module.exports = { detectIntegritySignals, trigrams, jaccard, collapse, SIGNALS };
