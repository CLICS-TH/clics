# CCME architecture proposal ↔ CLICS as built

Maps the two documents CCME circulated in 2026-10 — *ข้อเสนอสถาปัตยกรรมระบบ CLICS* (v0.1) and
*ข้อกำหนดการติดตั้ง CLICS Tutor & Evaluator* (v1.0) — against the system that is deployed and running.

**Why this file exists.** The proposal designs a Phase 0 built on Open WebUI with Pipe-function
middleware, an on-prem Postgres, a scoring worker and a blind rater UI. Four of those five layers are
already built, deployed and under test here, and the proposal's own §9 plans to replace the Open WebUI
front with a "CLICS app เฉพาะทาง" at P1 — which is what `physician-ui` is. This file records what
overlaps, what genuinely does not, and what we need from CCME.

Scope note: **8 of the proposal's 10 requirements are already present.** The two real gaps (R1, R3) are
both about *which model runs where*, not about missing machinery.

A Thai-language reply built from this file was sent to CCME on 2026-10-14.

---

## 1. Requirement mapping (R1–R10)

| # | Requirement | Status here | |
|---|---|---|---|
| **R1** | Local open-weight evaluator; transcripts never reach an external AI API | Provider is selectable **per purpose** (`chat` / `evaluate` / `criteria` / `discuss`) through `app_settings`, switchable with no deploy — see [`rimpl/src/services/ai.js`](../rimpl/src/services/ai.js). **Production currently runs Claude**, because the local evaluator has not passed calibration (ICC 0.59 vs target). | partial |
| **R2** | Lock model / prompt / rubric / config before the first PLE | `PROMPT_VERSION` = sha256 of the prompt, `RUBRIC_VERSION` = sha256 of the weights ([`rimpl/src/lib/versions.js`](../rimpl/src/lib/versions.js)). Provider, model and prompt version are recorded **per turn** on `messages`. The served engine and build are read from vLLM's `system_fingerprint`. **Missing:** a signed `model_manifest.json`. | partial |
| **R3** | The evaluator must be distinct from the tutor | Prompts and routing are already separate per purpose, but **both purposes currently resolve to the same model** (Claude for both, or DeepSeek for both). Not satisfied at the artifact level. | **gap** |
| **R4** | Socratic rescue after 4 exchanges that do not qualify | **Exact match** — `RESCUE_AFTER_EXCHANGES = 4` ([`rimpl/src/services/rescue.js`](../rimpl/src/services/rescue.js)). Goes further than the proposal: a per-session round cap, a post-check that the reply really asks 1–2 questions and gives no diagnosis, and one corrective retry when it does not (PR #144: final replies breaking the rules fell 6/12 → 1/18, Fisher p = 0.009). | present |
| **R5** | Evidence-based protocol: citation + evidence-level marker | `hasCitation` / `extractReferences` plus one enforced retry when a citation or the closing ❓ is missing ([`rimpl/src/services/post-filter.js`](../rimpl/src/services/post-filter.js)). Also a language guard the proposal does not cover: a Thai question must get a Thai answer. **Evidence level, as a checkable field:** behind the setting `chat_evidence_marker` (default 0), every non-rescue tutor reply carries one line `ระดับหลักฐานของข้อแนะนำหลัก: … (Evidence for the main recommendation: …)` on a five-level scale (GRADE high / moderate / low, expert opinion, not graded). `extractEvidenceLevel` parses it and the chat response returns it as `evidence_level`. A missing line is requested in the existing single retry and spliced into the reply. The pre-enable checks are in [QUALITY-GATES.md](QUALITY-GATES.md). | built, dormant (`chat_evidence_marker`); measured compliance + clinician review pending |
| **R6** | PLE gating → PIS-7 (7 domains, weights 15/20/15/15/15/10/10) → tier | **Weights match exactly**: `{d1 .15, d2 .20, d3 .15, d4 .15, d5 .15, d6 .10, d7 .10}`. Same composite formula, computed in code, never by the model. **Cut points differ** — ours `[50, 65, 75, 85]` vs the proposal's `[40, 60, 75, 90]`; ours live in `app_settings`, so aligning them is configuration, not code. | present |
| **R7** | Human calibration, ≥3 blinded raters, AI score hidden until done | All present: `hold_result_until_audited`, `min_auditors_per_cle`, `calibration_reveal_locked` (hides the AI score for a whole round), a blind rater UI, and ICC(A,1) with F-based CIs in the product. PLE count and rater count are configuration. | present |
| **R8** | Privacy by design: pseudonymization, RBAC, audit log | Pseudonyms `P-NNN` (the only identifier in exports), 4-role RBAC, `audit_log`, and an AES-256-GCM PII vault per PLE (`ple_pii_map`, RLS deny-all). **Two differences:** our `audit_log` has no hash chain, and we store the transcript **raw**, filtering PII on the way out to the AI, where the proposal redacts before the row is written. | partial |
| **R9** | Anti-gaming: continuity, consistency, credit caps | Integrity scan writing to `ple_integrity_flags`, per-user usage caps, turn and transcript caps, and per-turn idempotency so a retried turn cannot enter the scored transcript twice (PR #141). | present |
| **R10** | Assessment, not surveillance; the user knows when scoring starts | Consent flow, an AI disclaimer in the chat, a "report this reply" control, and visible session state. | present |

---

## 2. What the proposal adds that we should take

1. **A fast/deep complexity router.** The measured numbers are the argument: Qwen with thinking off
   gives TTFT 0.6 s and ~21 tok/s, roughly **2.5× DeepSeek's decode rate**. That is the real fix for
   chat latency, and it composes with the response streaming that went live 2026-10-06.
2. **Two distinct model artifacts** (Qwen = tutor, DeepSeek = evaluator). This closes R3 without an
   architecture change, because provider routing is already per purpose.
3. **A hash-chained audit log and a signed model manifest.** Small to build, and exactly the
   "locked configuration" evidence a reviewer or the ethics committee will ask for.

A fourth, from us: if a router can change tier mid-session, the thinking flag has to be recorded
**per turn**, not only in the manifest — otherwise the record cannot say which mode answered which turn.

---

## 3. Layer-by-layer overlap

| Proposal layer | Already built and deployed |
|---|---|
| Open WebUI (front) | **physician-ui** — Thai/English portal, consent, artifact side panel, streamed replies, per-turn idempotency, responsive gate 320–1920 px |
| Pipe middleware | **rimpl** — PII filter, rescue, citation/language validators, provider routing, two queue lanes so a chat turn never waits behind an evaluation |
| Postgres + worker | **backend** + eval drain — PIS-7 scoring, gating, tier engine, budget caps, audit log |
| Rater UI (blind) | **audit-dashboard** — blind queue, DomainScorer, AI-vs-auditor radar, ICC analysis, payout |

Pointing the existing stack at two CCME endpoints means setting `AI_PROVIDER_CHAT` and
`AI_PROVIDER_EVALUATE` and re-calibrating the evaluator once. No front-end work, and nothing already
measured (rescue, integrity, idempotency, the rater UI) is discarded.

---

## 4. Network reachability from the CLICS tailnet

Checked 2026-10-14. **Neither model endpoint named in the proposal is reachable from here.**

| Target | Role in the proposal | Result |
|---|---|---|
| `100.119.96.52:8888` | Evaluator (DeepSeek 284B) | **unreachable** — `cme-dgx` is not shared into the tailnet we can see; 100% packet loss |
| `192.168.1.178:18300` | Tutor (Qwen3.8-flash-next) | **unreachable** — a LAN address with no subnet route advertised |
| `100.68.210.69` | `cme-dev` (front) | reachable — 22 / 80 / 443 / 3000 open; `:3000` answers 401 (needs a key we do not hold) |
| `100.93.82.105` | `098215-u` (the ccme.or.th host) | reachable — no model port open (8000 / 8888 / 18300 all closed) |
| the public gateway `:3000/api` | what the system uses today | works, 200 in ~0.5 s — and it is **plain HTTP on a public IP** |

### What we need from CCME

1. **Share `cme-dgx` into the tailnet**, or advertise a subnet route to `192.168.1.0/24`. Today we see
   only `cme-dev` and `098215-u`, so neither new endpoint can be tested at all.
2. **Separate API keys per endpoint** (`TUTOR_KEY` / `EVAL_KEY`), out of band.
3. **Confirm the evaluator's model name and version.** If the artifact differs from the
   `deepseek-v4-flash-dspark` we measured, every calibration result has to be re-measured.
4. **HTTPS on the path actually in use.** The de-identified transcript and the API key currently cross
   the internet in plaintext, which does not meet R8.
5. **A GPU that is not shared, or a guaranteed share.** The same prompt minutes apart measured 9.2 and
   5.2 tok/s, so no latency can be promised to physicians yet.

---

## 5. Methodological notes

- **The local evaluator has not passed calibration.** On the 60 held-out anchors: DeepSeek vs the
  designed target ICC 0.59 [0.12, 0.80], while its test–retest is 0.91 — consistent but not accurate.
  The defect is scale compression (weak work scored ~25 points high). Four prompt variants have been
  tried; the best is better on every point estimate and still indistinguishable from chance.
  Full record: [`scripts/calibration/anchors/AUTHORING.md`](../scripts/calibration/anchors/AUTHORING.md) §7 items 20–25.
- **All of it is screening-grade.** The anchors are AI-authored and AI-scored. The decisive test is
  the human auditor round, which is set up and waiting — and it is the single open item that unblocks
  the model decision.
- **Co-location will not raise tok/s.** Generation is GPU-bound. Of a 30–45 s turn, the network is
  ~0.1 s; moving CLICS into GDCC is worth doing for data custody and reliability, not for speed.
