# CLICS — How to Use the App (a quick guide)

**CLICS** lets a doctor have a real clinical conversation with an **AI tutor** about a patient case. The system then gives the doctor a score for *how well they reasoned* — designed to replace attendance-based continuing-education credit. This guide shows you how to sign in and use it. No technical knowledge needed.

> **About this first pilot:** this is a **trial run to check the scoring works**. Please use **made-up / de-identified cases only** (no real patient names or numbers), and note that **scores are provisional — they don't count as official CME credit yet**.

---

## Where to sign in

| You are a… | Open this link |
|------------|----------------|
| **Doctor** | https://physician-ui.vercel.app |
| **Admin / Auditor / Superadmin** (reviewers) | https://audit-dashboard-rouge.vercel.app |

## Logins to try each role

| Role | Sign in at | Email | Password |
|------|-----------|-------|----------|
| **Superadmin** (sees everything) | dashboard | `superadmin@clics.th` | `ClicsSuper#2026r2` |
| **Admin** (runs the group) | dashboard | `admin@clics.th` | `ClicsAdmin#2026r2` |
| **Doctor** (sample) | doctor portal | `soakdoc05@example.com` | `SoakPass#2026` |
| **Auditor** (sample) | dashboard | `soakaud1@example.com` | `SoakPass#2026` |

*(These are temporary demo logins for the walkthrough.)*

---

## 👩‍⚕️ How a DOCTOR uses it

1. **Sign in** at the doctor portal (email + password). The first time, you'll read and accept a short **consent notice**.
2. **Start a new conversation** and type the patient's main problem — e.g. *"chest pain in a 58-year-old man"* (a **made-up / de-identified** case — no real patient details).
3. **Talk it through with the AI tutor** — ask questions, suggest a diagnosis, reason out loud. The AI explains its thinking, backs answers with references, gently corrects mistakes (it won't just agree with you), and ends each reply with a question to push you a step further.
4. **Finish the session** when you're done.
5. **See your result** — a score across 7 areas of clinical thinking, plus a chart of your progress over time.

💡 You can keep conversations tidy in **folders** and rename them.

## 🗂️ How an ADMIN uses it

1. **Sign in** at the dashboard.
2. **Requests** — approve people who asked to join, and choose their role.
3. **Sessions** — see all the doctors' conversations and where each one stands.
4. **History** — see who was approved, by whom, and when.

## 🔍 How an AUDITOR uses it

1. **Sign in** at the dashboard.
2. **Open your assigned cases.**
3. **Read the conversation and give your own score.** You won't see the AI's score until *after* you submit yours — this keeps the review fair and independent.
4. **Submit.**

## ⚙️ How the SUPERADMIN uses it

1. **Sign in** at the dashboard.
2. **See everything** — every member, every session, and the overall results.
3. **Manage accounts** — add people, set how many each role can have, turn accounts on/off.

---

## ✨ Just want to try it? (no account needed)

On the doctor portal, click **"Try as guest"** — you get **2 free questions** with the AI, and nothing is saved. A quick way to feel what the AI tutor is like.

## Good to know

- The AI gives substantive, referenced answers — it's a **mentor, not a search box**, and it won't simply agree with you.
- **Patient and doctor information is kept private.** Reviewers see each case under a code name (e.g. *P-001*), never the doctor's real name.
- This is a **validation pilot**: use **de-identified / made-up cases only**, and **scores are provisional** — official credit follows once the scoring is calibrated with expert reviewers.
