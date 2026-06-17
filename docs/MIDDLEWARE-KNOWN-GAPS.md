# RIMPL Middleware — Known Gaps vs. the Architecture Flowchart

_Status as of the July–September 2026 pilot build. The middleware **works end-to-end as a Claude-only pipeline** (PII masking → anti-sycophancy / citation / Socratic system prompt → Claude → post-checks). The items below are places where the current implementation is **narrower than the printed 4-layer flowchart**. They are documented intentionally; the pilot decision is to run **Claude-only** and revisit before any production rollout._

## L4 — API Randomization Layer (multi-provider) — NOT IMPLEMENTED
- The flowchart shows L4 randomizing the AI provider per session across **Claude / GPT-4o / Gemini / Mistral** via `hashSessionId()`, with failover and `provider_used` logging.
- Reality: `rimpl/src/services/claude.js` hard-codes a single model (`claude-sonnet-4-6`) and is the only provider client. There is **no `hashSessionId()`, no GPT-4o/Gemini/Mistral client, no failover, and no per-session provider selection.**
- `cles.provider_used` exists in `db/schema.sql` but is a static default (`'claude'`), not a logged runtime choice.
- **Impact:** the privacy/bias rationale of vendor rotation is not exercised. All de-identified traffic goes to Claude.

## PII de-identification — BROADENED (2026-06-09); residual free-text-name risk
- `rimpl/src/services/pii-filter.js` is now a **multi-category de-identifier**: NAME (Thai/English title-led, labelled `ชื่อ…นามสกุล…`, nicknames, plus bare re-occurrences of already-seen names), EMAIL, LINE id, Thai national ID, HN, MRN/AN, PHONE (Thai + international), DATE, WARD, ADDR (house no. / หมู่ / ตำบล-อำเภอ-จังหวัด) — with **stable per-category indexed tokens** (`[NAME-1]`, `[HN-1]`, …) so repeated mentions collapse to one referent.
- It is complemented by a **structured patient-identifier intake**: `cle_patient_refs` (`db/migration-patient-intake.sql`) holds the patient identifier in a physically separate, **owner-only** table (deny-all RLS + route-layer physician filter) that is **never** read by the cloud-AI payload, the auditor blind queue, or the export — keeping the case narrative name-free by construction; the filter remains the backstop for anything typed into the narrative.
- The flowchart's **stable pseudonymization** is **partially built now**: `professionals.pseudonym` (P-NNN) is assigned at account creation/approval, and OAuth real identities are AES-256-GCM-encrypted in the deny-all `oauth_identities` vault (see [constraints.md](constraints.md)). Still pending (roadmap P2): the **CLE-001…CLE-150** pseudonyms and a reversible lookup beyond OAuth identities. In-message masks remain literal, not reversible.
- **Known limit:** a **bare free-text name** with no title, label, or prior masked occurrence (e.g. a mid-sentence "สมชายมาด้วยไข้") is not caught — the structured intake plus physician guidance are the mitigation.
- **Impact:** PII *is* stripped before the outbound cloud call across the covered categories; free-text names without an anchor remain the residual risk.

## Social sign-in (Google/LINE OAuth) — GOOGLE LIVE, LINE ABSENT
- The **real Google handshake is now wired via Supabase's native provider** (updated 2026-06-09): the browser completes `signInWithOAuth({provider:'google'})`, the backend validates the session token server-side (`POST /auth/oauth/google/complete`) and writes the identity to the on-prem encrypted vault — the old mock-callback stub is gone. **LINE is still absent**: Supabase has no native LINE provider, so it needs a custom OIDC integration and remains a documented follow-up.

## "4 pre-filter signals" — NOT IMPLEMENTED
- The flowchart lists "Pre-filter 4 signals" at L3. No code defines or computes these four signals.
- What exists: a single retry loop in `rimpl/src/routes/chat.js` that re-prompts if the reply is missing a citation or a Socratic question.

## ELM injection — NOT IMPLEMENTED
- "Anti-sycophancy + ELM" appears in the flowchart. **Anti-sycophancy, zero-hallucination/citation, and Socratic-question** directives ARE injected (system prompt in `rimpl/src/lib/prompts.js`). **ELM** is referenced in the spec but never defined or implemented.

## Auth / fail modes (by design, documented)
- RIMPL guards `/chat`, `/evaluate`, `/evaluate-criteria` with an `x-internal-token` shared secret. **Hardened this cycle:** RIMPL now **refuses to boot in production** if `INTERNAL_TOKEN` is unset (`rimpl/src/index.js`), so it can never run unauthenticated on Railway. Local dev with no token still skips the check.
- Backend → RIMPL fail modes are intentionally asymmetric: `POST /cles/:id/message` **fails closed** (502 if RIMPL is down); `POST /cles/:id/end` Tier-2 check **fails open** (flags the session `cle_flag_t2` for manual QA).
- There is **no backend health-check** of RIMPL before routing (`/health/deep` is a possible future add).

## Reproducibility
- AI evaluations are tagged `CCME_LLM_v8.0` (`model_version`), but the underlying Claude model is pinned in code (`claude-sonnet-4-6`). If the model is swapped, re-run the Tier-2 calibration sample for drift (per the pilot protocol).
