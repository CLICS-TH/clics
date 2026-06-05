# Key Constraints

- **On-premise mandate:** All PII and audit-trail data must remain on-premise. Only stripped JSON reaches cloud APIs. (As-built: PII stripping is regex-based — see [MIDDLEWARE-KNOWN-GAPS.md](MIDDLEWARE-KNOWN-GAPS.md).)
- **Provider randomization:** L4 selects the AI provider per session using `hashSessionId()`. One provider per PLE. `provider_used` is logged for audit. *(Planned — not yet implemented; runs Claude-only.)*
- **Pseudonymization:** Physicians mapped P-001…P-075; CLEs mapped CLE-001…CLE-150. Lookup table is encrypted and access-gated. *(Planned — current de-identification is regex masking, no stable pseudonyms.)*
- **Reproducibility:** All CCME LLM evaluation runs tagged with model version (`CCME_LLM_v8.0`). If the model updates mid-study, re-evaluate the Tier-2 sample for drift. (The Claude model is pinned in `rimpl/src/services/claude.js`.)
- **ICC gate:** The Calibration Workshop must achieve ICC ≥ 0.75 before Tier-2 audit begins.

## Security

- Live credentials live **only** in gitignored `backend/.env` / `rimpl/.env` and platform env vars (Railway/Vercel dashboards) — never in committed files. `.claude/`, `*.rtf`, `*.env` are gitignored.
- `INTERNAL_TOKEN` is the shared secret between backend and RIMPL; it must match byte-for-byte on both services. RIMPL refuses to boot in production if it is unset.
- Anything sent to the manager (creds + URLs) must contain **zero** secrets.
