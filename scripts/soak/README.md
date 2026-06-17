# CLICS soak harness

Reproducible end-to-end "1-week pilot" dry run: clean slate → onboard a cohort → drive physician–AI
sessions across the competence spectrum → CLE gate + PIS-7 AI scoring → 3-auditor blind scoring → ICC
→ backdated week → superadmin review numbers. Produced [`docs/SOAK-REVIEW-2026-06.md`](../../docs/SOAK-REVIEW-2026-06.md).

These target the **live** backend and read `backend/.env` for the Supabase service-role key. Run each from
the `backend/` directory so `dotenv` + `node_modules` resolve:

```bash
cd backend && NODE_PATH="$PWD/node_modules" node ../scripts/soak/<script>.js
```

## Pipeline (in order)

| # | Script | What it does |
|---|--------|--------------|
| 0 | `../../db/reset-demo.js` | Full clean slate — wipe all activity + non-superadmin accounts, reset slot pools. |
| 1 | `soak-onboard.js` | Superadmin creates 2 admins + 3 auditors; 10 physicians self-register; admins approve → P-001…P-010. Writes `/tmp/soak-personas.json`. |
| 2 | `soak-drive.js` | Deterministic driver — each physician runs tier-appropriate multi-turn sessions (single process holds token + CLE id; no lost state). Writes `/tmp/soak-results.json`. |
| 3 | `soak-recover2.js` | Recover any session whose fire-and-forget evaluation was dropped (admin `approve` / `reevaluate`). |
| 4 | `soak-fetch-transcripts.js` | Export the evaluated CLEs' **blind** transcripts (AI scores stripped) → `/tmp/soak-transcripts.json`. |
| 5 | `gen-auditor-wf.js` | Generate the auditor Workflow script with the blind transcripts embedded → `/tmp/soak-auditor-wf.js`. Run it with the Claude Code `Workflow` tool; save its `result` array to `/tmp/soak-audit-scores.json`. |
| 6 | `soak-audit-post.js` | Post the 3 auditors' blind scores, assign CLEs round-robin, compute ICC → `/tmp/soak-icc.json`. |
| 7 | `soak-assign-fix.js` | (If assignment needs redoing) assign evaluated CLEs round-robin to the 3 auditors. |
| 8 | `soak-backdate.js` | Spread activity across a realistic 7-day window; auditor scoring "after the week". |
| 9 | `soak-report-data.js` | Assemble every number for the review (CLE funnel, AI-vs-human deltas, ICC, LPDP, budgets). |

Diagnostics: `soak-diag.js` (full DB snapshot), `soak-wipe-activity.js` (wipe activity, keep accounts).

> Demo credentials in these scripts (`SoakPass#2026`, the superadmin password) are throwaway pilot
> creds, consistent with `db/seed-users.js` / `LOGIN-ACCOUNTS.txt`. No live API keys appear here.
