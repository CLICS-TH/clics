# RIMPL Middleware — Known Gaps vs. the Architecture Flowchart

_Status as of the July–September 2026 pilot build. The middleware **works end-to-end as a Claude-only pipeline** (PII masking → anti-sycophancy / citation / Socratic system prompt → Claude → post-checks). The items below are places where the current implementation is **narrower than the printed 4-layer flowchart**. They are documented intentionally; the pilot decision is to run **Claude-only** and revisit before any production rollout._

## L4 — API Randomization Layer (multi-provider) — NOT IMPLEMENTED
- The flowchart shows L4 randomizing the AI provider per session across **Claude / GPT-4o / Gemini / Mistral** via `hashSessionId()`, with failover and `provider_used` logging.
- Reality: `rimpl/src/services/claude.js` hard-codes a single model (`claude-sonnet-4-6`) and is the only provider client. There is **no `hashSessionId()`, no GPT-4o/Gemini/Mistral client, no failover, and no per-session provider selection.**
- `ples.provider_used` exists in `db/schema.sql` but is a static default (`'claude'`), not a logged runtime choice.
- **Impact:** the privacy/bias rationale of vendor rotation is not exercised. All de-identified traffic goes to Claude.

## PII de-identification — REAL BUT MINIMAL
- `rimpl/src/services/pii-filter.js` applies **4 regex patterns over 3 categories**: HN, DATE (two patterns), WARD → literal masks (`[HN]`, `[DATE]`, `[WARD]`).
- The flowchart's **stable pseudonymization** (P-001…P-075, CLE-001…CLE-150 lookup table) is **not implemented** — masks are literal, not reversible identifiers.
- Not covered: patient names, ages, phone numbers, email, MRN variants, Thai-name patterns beyond `ห้อง` (ward).
- **Impact:** PII *is* stripped before the outbound cloud call (the on-premise boundary holds for the covered categories), but coverage is narrow.

## "4 pre-filter signals" — NOT IMPLEMENTED
- The flowchart lists "Pre-filter 4 signals" at L3. No code defines or computes these four signals.
- What exists: a single retry loop in `rimpl/src/routes/chat.js` that re-prompts if the reply is missing a citation or a Socratic question.

## ELM injection — NOT IMPLEMENTED
- "Anti-sycophancy + ELM" appears in the flowchart. **Anti-sycophancy, zero-hallucination/citation, and Socratic-question** directives ARE injected (system prompt in `rimpl/src/lib/prompts.js`). **ELM** is referenced in the spec but never defined or implemented.

## Auth / fail modes (by design, documented)
- RIMPL guards `/chat`, `/evaluate`, `/evaluate-criteria` with an `x-internal-token` shared secret. **Hardened this cycle:** RIMPL now **refuses to boot in production** if `INTERNAL_TOKEN` is unset (`rimpl/src/index.js`), so it can never run unauthenticated on Railway. Local dev with no token still skips the check.
- Backend → RIMPL fail modes are intentionally asymmetric: `POST /ples/:id/message` **fails closed** (502 if RIMPL is down); `POST /ples/:id/end` Tier-2 check **fails open** (flags the session `cle_flag_t2` for manual QA).
- There is **no backend health-check** of RIMPL before routing (`/health/deep` is a possible future add).

## Reproducibility
- AI evaluations are tagged `CCME_LLM_v8.0` (`model_version`), but the underlying Claude model is pinned in code (`claude-sonnet-4-6`). If the model is swapped, re-run the Tier-2 calibration sample for drift (per the pilot protocol).
