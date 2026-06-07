# CLICS — Prototype Summary (for non-technical readers)

**CLICS** = *Clinical Learning & Intelligence Credit System*
A pilot platform for a Thai medical licensing body, July–September 2026.

**Live links**

| | |
|---|---|
| Physician portal | https://physician-ui.vercel.app |
| Audit dashboard (Admin / Auditor / Superadmin) | https://audit-dashboard-rouge.vercel.app |
| Backend API | https://backend-production-c12e4.up.railway.app |

> **To review the pilot:** sign in to the **audit dashboard** as **Superadmin** (sees everything) or **Admin** (sees the cohort + onboarding history). Logins are in **`LOGIN-ACCOUNTS.txt`** and summarised in §10 below.

---

## 1. What problem does it solve?

Today, doctors earn continuing-education (CME/CPD) credit largely by **attending** lectures — which proves they showed up, not that they learned. CLICS changes the basis of credit from *attendance* to **the quality of a doctor's clinical thinking.**

A doctor has a real clinical conversation with an AI tutor about a patient case. The system then scores **how well the doctor reasoned** — the questions they asked, how they weighed evidence, whether they challenged the AI — and awards credit on that basis.

---

## 2. Who uses it? (four roles)

| Role | In plain terms | What they do |
|------|----------------|--------------|
| **Physician** (แพทย์อาสา) | The doctor earning credit | Has AI case discussions, gets scored, tracks progress |
| **Admin** | The pilot coordinator | Approves new members, oversees cases, sees statistics + onboarding history |
| **Expert Auditor** | A senior doctor checking quality | Independently re-scores cases "blind" to confirm the AI is fair |
| **Superadmin** | The system owner | Manages all accounts + role capacity, oversees the whole programme |

---

## 3. What does a doctor actually experience?

1. **Get an account** — request access (or sign in), then an admin approves them into the programme.
2. **Log in** to the physician portal.
3. **Start a case** ("Clinical Learning Episode") and type the patient's main problem.
4. **Discuss it with the AI tutor** — ask questions, propose a diagnosis, think it through. The AI is a **mentor, not an answer machine**: it explains its reasoning, **backs claims with references**, **politely corrects mistakes** instead of just agreeing, and **ends every reply with a question** that pushes the doctor to think one level deeper.
5. **Finish the session.** The system checks it was a genuine learning episode, then scores the doctor's reasoning.
6. **See the result** — a 7-part score and a personal progress chart over time.

Doctors can also **organise their conversations into folders**, name/rename each one, and move them around — all on a tidy dashboard.

---

## 4. How is "quality of thinking" measured?

- **PIS-7** — every session is scored on **7 dimensions** of clinical reasoning (quality of questions, depth of reasoning, use of evidence, self-reflection, and more), shown as an easy-to-read radar chart.
- **Fairness check (ICC)** — human expert auditors re-score a sample of cases *without seeing the AI's score*. We then measure how closely the AI and the human experts agree. The programme only proceeds to full scale once that agreement is high enough (target **0.75**). This is what makes the AI scoring **trustworthy**, not a black box.

---

## 5. Who can join, and how (new: membership & access)

The platform now manages a **real cohort safely**:

- **Request access** — a clinician applies from the portal (by email, or Google/LINE sign-in). The request waits as **pending**.
- **Approval into a capped slot** — a superadmin/admin approves them into an available place for their role (each role has a set capacity). On approval they get a stable **pseudonym** (e.g. *P-001*) — the only identifier used in any review or export.
- **Guest mode** — a curious clinician can **"Try as guest"**: 2 AI prompts, then it ends, with **nothing saved at all**.
- **Private by design** — real names/emails (incl. social-login identity) are kept in an **encrypted, on-premise vault** and never reach the cloud AI; only the pseudonym is ever visible downstream.

---

## 6. The 1-week pilot dry run (soak test) — results

Before opening to real users, we ran a **full simulated week on the live system** to prove the whole lifecycle and stress-test the fairness check.

**Setup (all on a clean database, fully traceable by superadmin/admin):**
- **16 accounts** onboarded through the real flows: 1 superadmin, 2 admins, **10 physicians** (spanning weak → excellent reasoning), 3 expert auditors.
- The 10 physicians ran **15 case sessions** with the real AI tutor over a backdated week (May 31 – Jun 6); the 3 auditors then blind-scored the credit-eligible sessions.

**What we learned:**
- ✅ **The whole lifecycle works end-to-end** — onboarding → AI case discussion → quality gate → 7-part scoring → progress charts → auditor blind-scoring → fairness check.
- ✅ **The quality gate behaves as designed** — weak/short sessions were auto-rejected, average sessions flagged for manual review, only genuine reflective sessions reached scoring (10 of 15).
- ⭐ **The fairness check did its job — the key finding.** The **three auditors agreed with each other almost perfectly (ICC 0.97)**, but the **AI's scores agreed with the human experts only at 0.66 — below the 0.75 bar.** The AI is currently a touch **lenient**, over-rewarding well-structured-but-shallow reasoning. **This is exactly what the safeguard exists to catch:** it tells us to **calibrate the AI against expert judgement** at the **July calibration workshop** before any credit is issued.
- ✅ **Reliability hardened** — the dry run surfaced a case where a brief network hiccup could leave a scored session unrecorded; this was **fixed and re-deployed** during the review (scores now retry and self-recover).

A full written review (with the funnel, per-doctor outcomes and the agreement numbers) is in **`docs/SOAK-REVIEW-2026-06.md`**.

---

## 7. Scale & reliability — can it handle many users at once?

We load-tested the **live** system to confirm it holds up for a real cohort:

- **100+ concurrent users — confirmed.** Everyday use (logging in, dashboards, viewing scores/sessions) ran cleanly at **200 simultaneous requests** and **110 distinct logged-in users** with **zero errors** — comfortably past the 100-user goal.
- **AI tutor under heavy load — hardened.** When many doctors chat with the AI at the *exact same moment*, success at a 40-at-once burst was raised from **33% → 88%** by adding smart **queuing + automatic retry**. Realistic usage (doctors don't all send at the same instant) is effectively **100%**.
- **One remaining lever is a plan upgrade, not code.** Live diagnostics pinpointed the limit precisely — the AI provider's **per-minute output allowance** on our current plan. Raising that tier is the single change needed to handle very large simultaneous AI bursts.
- **Cost-controlled** — all load testing stayed within a tight, pre-agreed API budget.

A full written report (numbers, methods, recommendations) is in **`docs/LOADTEST-2026-06.md`**.

---

## 8. Privacy & safety (important for the pilot)

- **Patient/doctor identifying information stays on-premise.** Only **de-identified** text is ever sent to the cloud AI.
- Real identities (incl. Google/LINE) live in an **encrypted on-premise vault**; only pseudonyms (*P-001…*) appear in reviews/exports. Guest sessions store nothing.
- The AI is built to **avoid making things up** and to **cite evidence** — reducing the risk of confident-but-wrong advice.
- All accounts are role-restricted: each person only sees what their role allows.
- **The superadmin (system owner) account is locked** — it can never be disabled, demoted, deleted, or duplicated, *even by itself*, enforced in both the app and the database (always exactly one superadmin).

---

## 9. What is *not* in this prototype yet (roadmap, not bugs)

- **Calibrating the AI scorer** to the expert consensus — the July workshop's main task (see §6).
- Rotating between **multiple AI providers** (today it runs on a single, high-quality model).
- **Raising the AI provider's per-minute output limit** — to support very large *simultaneous* AI-chat bursts (the binding limit was pinpointed precisely in load testing; see §7). A plan/billing change, not code.
- **Full pseudonymisation** of all free-text identifiers (today: an encrypted identity vault + pattern-based de-identification).
- The automated **credit-issuing engine** (scores are produced; formal credit issuance is a later step).
- Real **Google/LINE sign-in** handshake (the buttons + the private identity vault are built; the live social-login handshake is stubbed pending credentials).

---

## 10. How to try it

**Live links** are at the top of this document. Full credentials (all roles) are in **`LOGIN-ACCOUNTS.txt`**. For a manager review, the two accounts to use are:

| Role | Email | Password | What you'll see |
|------|-------|----------|-----------------|
| **Superadmin** | `superadmin@clics.th` | `ClicsSuper#2026r2` | Everything — all 17 members, role-slot pools, every session, the fairness (ICC) numbers |
| **Admin** | `admin@clics.th` | `ClicsAdmin#2026r2` | The cohort's sessions, the manual-review queue, and the **new onboarding history** (who was approved, by whom, when) |

Both sign in at the **audit dashboard** (`/login`). `LOGIN-ACCOUNTS.txt` also lists a sample physician and auditor login from the live dry-run cohort if you want to see those consoles.

*These are throwaway demo passwords for the walkthrough and will be replaced before the real pilot.*

> This is a **working prototype** for hands-on evaluation — built to demonstrate the concept end-to-end, not the final production system.
