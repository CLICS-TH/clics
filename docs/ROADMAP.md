# CLICS Roadmap

Next steps, ordered by priority.

> **The July/Aug–Sep schedule this file used to be framed against is superseded.** Neither milestone
> started: the calibration workshop did not happen and CREC approval — which data collection is
> defined relative to — has not been granted. See [pilot-timeline.md](pilot-timeline.md) for what
> replaced it and why no month is named. Priorities below still hold; the dates around them do not.

The prototype is feature-complete and live (4 roles, folders, chat, PLE gate, PIS-7 scoring, auditor blind-scoring, ICC). These items take it from prototype → pilot-grade → full spec.

**Recently shipped (2026-06-17/18):** the **CREC/NRCT protocol-alignment** cycle (8 phases, merged to
`master` `d84595a`…`b49c370`, live in prod) — built the **CLE1/2/3 Socratic experiment** (episode
sequencing + per-episode mode toggle + 3×-Tier-1-fail remediation), Pilot Test Mode, the PLE→PLE
rename, study pseudonyms (`PLE-`/`EXP-`), an append-only audit log, evaluator version provenance,
structured physician + auditor (confidentiality/COI) consent, Tier-3 analyst / Tier-4 ethics oversight
roles, a compensation report, and **`/health/deep` readiness checks** on RIMPL + the backend. See
[HANDOFF.md](HANDOFF.md).

**Earlier (2026-06-13/14):** the Claude Design UX/UI audit + a simplify pass (commit `bf9d5f8`,
deployed to Vercel) — flat-coral AA contrast, the rubric-anchored `DomainScorer`, themed dialogs,
line-icons, bilingual label hierarchy, chart-token centralization; and the developer-onboarding docs
(root `README.md`, `CONTRIBUTING.md`, per-layer READMEs, `docs/HANDOFF.md`). See [HANDOFF.md](HANDOFF.md).

---

## P1 — Pilot-readiness (do next)

The smallest set that makes the prototype safe and credible for real physicians in July.

- **Thread the chief complaint into the AI context.** *(done in the simplification pass)* The case the physician enters at session creation now reaches the model, so a vague first question no longer gets "please give me patient details."
- **`db/reset-demo.js` — one-command clean demo.** *(done)* Wipes accumulated **real** activity (`is_test=false`) while preserving test sessions + config; protocol-aware (consents/audit_log cascade). Run before any walkthrough.
- **Security before pilot.** *(org task — not code)* Rotate the `ANTHROPIC_API_KEY` (RIMPL Railway env) and replace the throwaway demo passwords (`db/seed-users.js`) with real per-user credentials. Secrets stay out of git (already enforced).
- **Automated test pipeline.** *(done — 2026-06-15)* Hermetic suites cover folder CRUD, PLE lifecycle, `/end` gate transitions, admin→auditor assignment, auditor blind-score / double-submit 409, role-access + council isolation, and an end-to-end role-chain. GitHub Actions CI runs the **whole hermetic set** on every push/PR — backend + rimpl (all 8 suites now hermetic) + license-verifier + audit-dashboard (jest **component tests**, typecheck, and **blocking ESLint**). Plus a one-command local stack (`npm run dev` at the repo root), **coverage-threshold gates** (jest `--coverage` in CI), and a **manual staging-smoke workflow** for the live role-chain (enable via `SMOKE_*` secrets). The four cleanly-fitting older suites were DRY'd onto the shared test helper; the rest keep bespoke mocks by design. See [TESTING.md](TESTING.md).
- **Cross-pause active-time.** *(done)* The client accumulates `active_seconds` incrementally (engaged-time counter, paused on idle/hidden) and the server clamps it to wall-clock at `/end` before the C1 ≥600s gate — so a paused-and-resumed session accumulates engagement time, anti-gaming-protected.
- **`/health/deep` on RIMPL** + a backend pre-routing check. *(done 2026-06-18)* Both layers expose `GET /health/deep` (deep readiness: Anthropic key/SDK + Supabase on RIMPL; Supabase + RIMPL's deep check aggregated on the backend; 200/503 + per-dependency map). The shallow `/health` stays a liveness ping; a RIMPL outage now surfaces as a clean readiness signal and a stable `code: 'rimpl_unavailable'` on the chat 502.
- **Invite email to any recipient — verify a sending domain in Resend.** The mailer is live (Resend HTTPS API) but the sandbox only delivers to the account owner's own address; everyone else gets the copy-link fallback (decision 2026-06-11: ship with manual link-sharing for now). To lift it: own/obtain a domain (or have the licensing body's IT delegate a subdomain, e.g. `clics.tmc.or.th`), add Resend's 3 DNS records at resend.com/domains, then set `MAIL_FROM` to that domain on the backend Railway service.

## P2 — Close documented spec gaps

From [MIDDLEWARE-KNOWN-GAPS.md](MIDDLEWARE-KNOWN-GAPS.md) — narrower-than-flowchart items to revisit before production:

- **Full PII pseudonymization — DONE (2026-06-18).** Participant/session/auditor codes `P-`/`PLE-`/`EXP-` (Phase 2); the **bare-unlabelled-Thai-name leak** is closed (intake-hint scrub of `patient_ref` + a Thai given-name gazetteer); and the **reversible on-prem audit map** is built — at finalization the backend stores one AES-256-GCM-encrypted `[NAME-n]→raw` map per PLE in `ple_pii_map` (RLS deny-all, `IDENTITY_ENC_KEY`), re-identifiable only by the superadmin/PI via the gated, audit-logged `GET /admin/ples/:id/pii-map`. See [MIDDLEWARE-KNOWN-GAPS.md](MIDDLEWARE-KNOWN-GAPS.md). *(Scoped per-PLE, not cross-session patient linkage; a dashboard lookup UI + a dedicated `PII_ENC_KEY` are optional follow-ons.)*
- **The "4 pre-filter signals" (L3).** Define and compute the four signals the flowchart specifies (currently only a single citation/Socratic retry loop exists).
- **ELM.** Define-or-formally-drop the "ELM" injection referenced in the spec but never implemented.

## P3 — Flagship features

Larger build-outs once the pilot is stable:

- **L4 multi-provider rotation.** Route each session across Claude / GPT-4o / Gemini / Mistral via `hashSessionId()`, with failover and real `provider_used` logging (the column is already reserved). Exercises the vendor-rotation privacy/bias rationale.
- **Credit Engine.** Turn PIS-7 composite scores into issued CME/CPD credit (the system's reason for being) — issuance rules, certificates, an audit trail.
- **ICC calibration-workshop tooling.** Support the July workshop: paired AI-vs-auditor scoring views, drift monitoring, the ICC ≥ 0.75 gate that releases Tier-2 auditing.
- **Observability.** Structured logging + error tracking across the 4 layers.
- **Scale beyond pilot.** Pilot scale is benchmarked and passing (100 distinct concurrent users, 0 errors — see [PERFORMANCE-BENCHMARK.md](PERFORMANCE-BENCHMARK.md)). For a larger cohort, execute that doc's scale-up playbook: raise the Anthropic **OTPM** tier (the binding AI limit), add **Railway replicas** + raise the **Supabase pool**, stagger onboarding-day logins, and re-measure raw ceilings with a **multi-IP** load test (single-IP tests now bottom out on the per-IP rate limiters).

---

*Reproducibility note:* AI evaluations are tagged `CCME_LLM_v8.0+<served model>`. The Anthropic model is pinned in `rimpl/src/services/providers/anthropic.js`: `claude-sonnet-5-5` from 2026-10-03 (`claude-sonnet-4-6` before). That change requires re-running the calibration on 5-5 before its scores count as calibrated (pilot protocol; see `scripts/calibration/prompt-versions.md`, 2026-10-03 note).
