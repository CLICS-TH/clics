// Deterministic integrity signals — detecting agent-delegated or gamed PLE sessions.
//
// Runs beside services/ple-gate.js (the C1–C3 tier-1 gate) on the same principle: cheap, server-side,
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
// backend/src/routes/ples.js stores `content: message`, the RAW physician text. rimpl strips PII only
// for the outbound cloud call; the database deliberately keeps the original as the evidentiary
// transcript. So this detector — especially F2, which compares a physician's OTHER PLEs — processes
// PII BY DESIGN. That is acceptable only while it stays inside the backend and never reaches a model.
// Do not "improve" this file with an LLM pass. Doing so would breach the one boundary the
// architecture's strongest claim rests on, and it would do it quietly.
//
// ============================================================================================
// SEVERITY IS A ROUTING DECISION, NOT A VERDICT.
// A flag sends a PLE to a human. It never penalises, never reaches the physician, and never changes
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
// Measured 2026-08-26 over prod: 398 messages across 33 PLEs, 27 of them with usable inter-turn
// timing. The numbers each rule cites below are from that run. Re-run the calibration before
// changing any of them — a threshold nobody has checked against data is a threshold that will
// eventually accuse a physician of something they did not do.
const SIGNALS = {
  // Physician turns that repeat each other within ONE session. A person exploring a case does not
  // send the same paragraph twice; a script padding turn count to clear C2 (>= 4 turns) does.
  // MEASURED: 2 real sessions contain an exact within-session repeat. Low enough to act on.
  F1_NEAR_DUPLICATE: { threshold: 0.92, min_chars: 40, enabled: true },

  // The same physician's turns reappearing across their OWN other PLEs.
  // Reads raw PII by design — see the constraint at the top of this file.
  // MEASURED: 8 exact-duplicate groups across sessions, and every one of them sits in the pilot's
  // TEST sessions, where the team pasted the same scripted prompt repeatedly. That makes the real
  // false-positive rate unknown rather than low, so the caller must exclude test PLEs from the
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
  // MEASURED: at min_turns 5 this fired on 1 real PLE that had only 4 gaps — a coefficient of
  // variation over 4 samples is noise, not rhythm. At min_turns 7 (>= 6 gaps) it fires on ZERO of
  // the 27 real sessions, which is the calibration target.
  F5_LATENCY_UNIFORMITY: { min_turns: 7, max_cv: 0.08, enabled: true },

  // One turn that does not write like the rest of this physician's own turns.
  //
  // WHY WITHIN-SUBJECT. Every "does this read like a machine" test applied to a POPULATION punishes
  // whoever writes most formally, and there is no way to argue with it. Comparing a physician only
  // against themselves removes that: the claim is not "you write like a machine", it is "this turn
  // does not write like your other forty". A physician who always writes in polished paragraphs has
  // a baseline of polished paragraphs and never fires.
  //
  // DEFAULT OFF, and it must stay off until it is measured the way F1 and F5 were — against real
  // non-test sessions, with the false-positive rate written down here. scripts/integrity/
  // calibrate-f6.mjs produces exactly that table. A threshold nobody has checked against data is a
  // threshold that will eventually accuse a physician of something they did not do.
  F6_REGISTER_DISCONTINUITY: {
    min_chars: 400,        // only substantial turns; a one-liner has no style to measure
    min_baseline: 8,       // fewer of the physician's own turns than this and there is no baseline
    z: 3.5,                // robust (MAD-based) deviations before a feature counts as shifted
    min_features: 2,       // one shifted feature is noise; two independent ones is a pattern
    enabled: false,
  },
};

/* ==============================================================================================
 * GENRE COUNTERS — what a pasted turn LOOKS LIKE, reported as evidence and never as a verdict.
 *
 * THE PROBLEM THEY ADDRESS. F3 fires on "a large turn arrived too fast to have been typed" and
 * stops there, so the reader of a flag cannot tell the two very different things that produce it:
 * a physician pasting clinical DATA, and a physician pasting REASONING they did not do. PIS-7
 * scores reasoning, so only the second is misconduct — and F3 currently describes them identically.
 *
 * WHY THIS IS TRACTABLE AT ALL. The two genres do not resemble each other. A case note is dense in
 * numbers, units and lab tokens and carries almost no discourse structure. Generated prose is the
 * reverse: enumerators, balancing connectives, summary markers, and — the highest-precision tell of
 * all — Markdown, which a person typing into a plain <textarea> essentially never produces.
 *
 * A NOTE ON THE SCHEMA, because it changes how F3 should be read. The case presentation is NOT a
 * message: it is `ples.chief_complaint`, written once at creation (routes/ples.js), and no message
 * row is inserted then. So the single most common legitimate paste never passes through the stream
 * F3 watches. What remains in-stream is supplementary data (a lab that just returned) or reasoning.
 *
 * WHY COUNTERS AND NOT A CLASSIFIER. A threshold here would be a threshold nobody has calibrated,
 * which this file's own rules forbid. These numbers are printed beside the flag so a human can see
 * which genre they are looking at. Nothing branches on them, no severity moves, no new flag is
 * raised. If they are ever promoted to a signal, they go through the same measurement F1 and F5
 * went through, and default to off until they pass it.
 * ============================================================================================== */

// Units and lab tokens that appear in charted data and almost nowhere else. Case-insensitive.
const CLINICAL_TOKENS = new RegExp(
  '\\b(?:mg|mcg|ug|ml|l|kg|g|mmhg|mmol|mEq|meq|iu|bpm|dl|mg/dl|g/dl|mmol/l|meq/l)\\b'
  + '|\\b(?:hb|hct|wbc|plt|cr|bun|na|k|cl|hco3|egfr|ldl|hdl|tg|hba1c|ef|bp|hr|rr|spo2|o2sat'
  + '|cbc|lft|ast|alt|inr|ptt|trop|bnp|cxr|ekg|ecg|ua|abg)\\b'
  + '|\\b\\d+\\s*(?:%|°c|celsius)', 'gi');

/*
 * Discourse markers chosen for SKEW, not frequency. Ordinary Thai clinical writing uses ดังนั้น and
 * เนื่องจาก freely, so those are deliberately absent: including them would count normal prose.
 * What is here is the scaffolding of an essay — enumeration, explicit balancing, summing up, and
 * meta-commentary about the answer being given.
 */
const DISCOURSE_MARKERS = new RegExp(
  'ประการแรก|ประการที่สอง|ประการที่สาม|ประการสุดท้าย'
  + '|อย่างไรก็ตาม|ในทางกลับกัน|ในทางตรงกันข้าม'
  + '|โดยสรุป|สรุปได้ว่า|กล่าวโดยสรุป'
  + '|สิ่งสำคัญคือ|ข้อควรระวังคือ|ควรพิจารณา(?:ว่า|ถึง)|จำเป็นต้องคำนึงถึง'
  + '|นอกจากนี้|อีกทั้ง|ยิ่งไปกว่านั้น'
  + '|\\b(?:first|second|third|finally|however|additionally|moreover|furthermore'
  + '|in summary|in conclusion|overall|on the other hand|that said)\\b'
  + "|\\bit(?:'s| is) important to\\b|\\bkeep in mind\\b|\\bit(?:'s| is) worth noting\\b", 'gi');

/**
 * Counters over one turn. Densities are per 100 characters so long and short turns compare.
 * Reported verbatim in F3's evidence; nothing in this file branches on them.
 */
function genreProfile(text) {
  const t = String(text ?? '');
  const chars = t.length;
  if (!chars) return { chars: 0, clinical_density: 0, discourse_density: 0, markdown_marks: 0, digit_density: 0 };
  const per100 = (n) => Math.round((n / chars) * 100 * 100) / 100;

  // Markdown is the highest-precision tell here: a plain textarea produces none of it by accident.
  const md = (t.match(/\*\*[^*]+\*\*/g) || []).length
    + (t.match(/^\s*[-*]\s+\S/gm) || []).length
    + (t.match(/^\s*\d+\.\s+\S/gm) || []).length
    + (t.match(/^\s*#{2,}\s+\S/gm) || []).length;

  return {
    chars,
    digit_density: per100((t.match(/\d/g) || []).length),
    clinical_density: per100((t.match(CLINICAL_TOKENS) || []).length),
    discourse_density: per100((t.match(DISCOURSE_MARKERS) || []).length),
    markdown_marks: md,
  };
}

/*
 * A style vector, deliberately CHARACTER-level.
 *
 * Sentence-length statistics are the obvious choice and they are wrong here: Thai does not delimit
 * sentences with periods, so any sentence splitter degrades to "one sentence" on Thai text and the
 * feature silently becomes a constant. Every feature below is a density over characters, which
 * behaves identically in Thai and Latin script.
 *
 * `punct` and `latin` are included because they move for reasons unrelated to the others — pasted
 * generated text tends to carry heavier punctuation and, in this pilot, more English.
 */
function styleVector(text) {
  const t = String(text ?? '');
  const chars = t.length || 1;
  const g = genreProfile(t);
  const per100 = (n) => Math.round((n / chars) * 100 * 100) / 100;
  return {
    discourse: g.discourse_density,
    markdown: per100(g.markdown_marks),
    digits: g.digit_density,
    clinical: g.clinical_density,
    punct: per100((t.match(/[,;:()"'—–]/g) || []).length),
    latin: per100((t.match(/[A-Za-z]/g) || []).length),
  };
}
const STYLE_KEYS = ['discourse', 'markdown', 'digits', 'clinical', 'punct', 'latin'];

const median = (xs) => {
  if (!xs.length) return 0;
  const a = [...xs].sort((p, q) => p - q); const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

/*
 * Robust z: median and MAD, not mean and SD. The whole point is to detect ONE outlier, and an
 * outlier inflates the SD it is being measured against — a mean/SD version hides exactly the turn
 * this signal exists to find.
 *
 * The denominator floor matters as much as the statistic. When a physician has never used Markdown,
 * the MAD of that feature is 0 and any non-zero value divides to Infinity. That is the RIGHT
 * conclusion (twelve Markdown marks from someone who has produced none in forty turns is the
 * signal) but it must not also fire on a rounding artifact, so the floor is a real, per-feature
 * amount rather than an epsilon.
 */
const MAD_FLOOR = { discourse: 0.15, markdown: 0.15, digits: 0.5, clinical: 0.3, punct: 0.5, latin: 1.0 };

function robustZ(value, baseline, key) {
  const med = median(baseline);
  const mad = median(baseline.map((x) => Math.abs(x - med)));
  const scale = Math.max(1.4826 * mad, MAD_FLOOR[key]);
  return Math.abs(value - med) / scale;
}

const seconds = (a, b) => Math.abs(new Date(a) - new Date(b)) / 1000;

/**
 * @param {Array} messages  [{ role, content, created_at, token_count }] for ONE PLE, chronological
 * @param {Array} priorTurns  the physician's turns from their OTHER PLEs: [{ ple_id, content }]
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
  const priorGrams = (priorTurns ?? []).map(p => ({ ple_id: p.ple_id, g: trigrams(p.content), text: p.content }));
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
          evidence: { turn: i + 1, other_ple_id: prior.ple_id, similarity: Math.round(sim * 1000) / 1000,
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
        // The genre counters do not change this verdict — there is none. They let whoever reads
        // the flag see whether they are looking at pasted DATA or pasted REASONING, which is the
        // distinction that decides whether anything is wrong at all.
        evidence: { turn_index: i + 1, token_count: tokens, gap_seconds: Math.round(gap * 10) / 10,
          genre: genreProfile(m.content) },
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

  // --- F6: one turn that does not write like this physician's other turns ----------------------
  // The baseline is the physician's OWN turns — their other sessions plus the rest of this one.
  // Reads raw PII by design, exactly as F2 does; the constraint at the top of this file applies.
  const F6 = C.F6_REGISTER_DISCONTINUITY;
  if (F6 && F6.enabled !== false) {
    const baselineTexts = [
      ...(priorTurns ?? []).map((p) => p.content),
      ...turns.map((t) => t.content),
    ].filter((x) => String(x ?? '').length >= 40);

    if (baselineTexts.length >= F6.min_baseline) {
      const baseVecs = baselineTexts.map(styleVector);
      for (let i = 0; i < turns.length; i++) {
        const text = String(turns[i].content ?? '');
        if (text.length < F6.min_chars) continue;
        const v = styleVector(text);
        // This turn is IN the baseline; leaving it there lets a long enough outlier drag its own
        // median and hide itself. Compare against the others only.
        const others = baseVecs.filter((_, k) => baselineTexts[k] !== text);
        if (others.length < F6.min_baseline) continue;

        const shifted = STYLE_KEYS
          .map((k) => ({ feature: k, z: robustZ(v[k], others.map((o) => o[k]), k), value: v[k] }))
          .filter((f) => f.z >= F6.z);

        if (shifted.length >= F6.min_features) {
          flags.push({
            signal: 'F6_REGISTER_DISCONTINUITY',
            // Never 'high'. A style shift has innocent causes — quoting a guideline, switching to
            // English, pasting a table — and this signal cannot tell those from the one that
            // matters. It buys a human read, nothing more.
            severity: shifted.length >= 4 ? 'medium' : 'low',
            evidence: {
              turn: i + 1,
              baseline_turns: others.length,
              shifted_features: shifted.map((f) => ({
                feature: f.feature, value: f.value, z: Math.round(f.z * 10) / 10,
              })),
              excerpt: text.slice(0, 120),
            },
          });
        }
      }
    }
  }

  // ONE row per signal per PLE. Six identical turns produce fifteen duplicate PAIRS; writing fifteen
  // rows would make the admin queue unreadable and make "how many PLEs are flagged" uncountable
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

module.exports = {
  detectIntegritySignals, trigrams, jaccard, collapse, genreProfile, styleVector, robustZ,
  STYLE_KEYS, SIGNALS,
};
