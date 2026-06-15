# CLICS Roadmap

Next steps, ordered by priority. Framed against the pilot timeline (see [pilot-timeline.md](pilot-timeline.md)):
**July 2026** = calibration workshop, target inter-rater **ICC ≥ 0.75**; **Aug–Sep 2026** = pilot study, 75 physicians × 3 PLEs.

The prototype is feature-complete and live (4 roles, folders, chat, CLE gate, PIS-7 scoring, auditor blind-scoring, ICC). These items take it from prototype → pilot-grade → full spec.

**Recently shipped (2026-06-13/14):** the Claude Design UX/UI audit + a simplify pass (commit `bf9d5f8`,
deployed to Vercel) — flat-coral AA contrast, the rubric-anchored `DomainScorer`, themed dialogs,
line-icons, bilingual label hierarchy, chart-token centralization; and the developer-onboarding docs
(root `README.md`, `CONTRIBUTING.md`, per-layer READMEs, `docs/HANDOFF.md`). See [HANDOFF.md](HANDOFF.md).

---

## P1 — Pilot-readiness (do next)

The smallest set that makes the prototype safe and credible for real physicians in July.

- **Thread the chief complaint into the AI context.** *(done in the simplification pass)* The case the physician enters at session creation now reaches the model, so a vague first question no longer gets "please give me patient details."
- **`db/reset-demo.js` — one-command clean demo.** Wipe accumulated test PLEs and seed a reproducible demo set: a couple of folders, a few sample conversations, and one evaluated **and assigned** PLE so the auditor queue is always demoable. Run before any walkthrough.
- **Security before pilot.** Rotate the `ANTHROPIC_API_KEY` (RIMPL Railway env) and replace the throwaway demo passwords (`db/seed-users.js`) with real per-user credentials. Secrets stay out of git (already enforced).
- **Automated test pipeline.** *(done — 2026-06-15)* Hermetic suites cover folder CRUD, PLE lifecycle, `/end` gate transitions, admin→auditor assignment, auditor blind-score / double-submit 409, role-access + council isolation, and an end-to-end role-chain. GitHub Actions CI runs the **whole hermetic set** on every push/PR — backend + rimpl (all 8 suites now hermetic) + license-verifier + audit-dashboard (jest **component tests**, typecheck, and **blocking ESLint**). Plus a one-command local stack (`npm run dev` at the repo root), **coverage-threshold gates** (jest `--coverage` in CI), and a **manual staging-smoke workflow** for the live role-chain (enable via `SMOKE_*` secrets). The four cleanly-fitting older suites were DRY'd onto the shared test helper; the rest keep bespoke mocks by design. See [TESTING.md](TESTING.md).
- **Cross-pause active-time.** Persist `active_seconds` incrementally (e.g. per turn) so a session the physician pauses and resumes accumulates engagement time for the C1 duration gate, not just the current sitting.
- **`/health/deep` on RIMPL** + a backend pre-routing check, so a RIMPL outage surfaces clearly instead of as a per-message 502.
- **Invite email to any recipient — verify a sending domain in Resend.** The mailer is live (Resend HTTPS API) but the sandbox only delivers to the account owner's own address; everyone else gets the copy-link fallback (decision 2026-06-11: ship with manual link-sharing for now). To lift it: own/obtain a domain (or have the licensing body's IT delegate a subdomain, e.g. `clics.tmc.or.th`), add Resend's 3 DNS records at resend.com/domains, then set `MAIL_FROM` to that domain on the backend Railway service.

## P2 — Close documented spec gaps

From [MIDDLEWARE-KNOWN-GAPS.md](MIDDLEWARE-KNOWN-GAPS.md) — narrower-than-flowchart items to revisit before production:

- **Full PII pseudonymization.** Replace the literal regex masks (`[HN]`, `[DATE]`, `[WARD]`) with a stable, reversible **P-001…/CLE-001…** lookup table, and broaden coverage (names, ages, phone, MRN variants, Thai-name patterns). Keeps the on-premise boundary while preserving longitudinal identity.
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

*Reproducibility note:* AI evaluations are tagged `CCME_LLM_v8.0` while the model is pinned to `claude-sonnet-4-6` in `rimpl/src/services/claude.js`. If the model is changed, re-run the Tier-2 calibration sample for drift (pilot protocol).
