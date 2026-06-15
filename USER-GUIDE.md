# CLICS — How to Use the App

**CLICS** lets a doctor have a real clinical conversation with an **AI tutor** about a patient case. The system then scores *how well the doctor reasoned* — designed to replace attendance-based continuing-education credit. This guide shows how to sign in and use it. No technical knowledge needed.

> **เกี่ยวกับการทดลองนี้ / About this pilot:** นี่คือการทดลองเพื่อตรวจสอบว่าการให้คะแนนทำงานถูกต้อง. กรุณาใช้ **เคสสมมติ / ไม่ระบุตัวตนผู้ป่วยเท่านั้น** (ห้ามใส่ชื่อหรือข้อมูลจริงของผู้ป่วย) และ **คะแนนยังเป็นเบื้องต้น — ยังไม่นับเป็นหน่วยกิต CME**. · This is a trial run to check the scoring works. Use **made-up / de-identified cases only** (no real patient names or numbers); **scores are provisional and do not yet count as official CME credit.**

---

## 1. Where to sign in — one place for everyone

Everyone signs in at the **one portal** below. If you are an admin, auditor, or superadmin, the system recognises you and **sends you to your console automatically**.

> **เข้าสู่ระบบที่ / Sign in at:** https://physician-ui.vercel.app

You can sign in two ways:

- **Sign in with Google** — tap the Google button. Your CLICS account is tied to your Google account, so it's the *same* account every time — no need to register again.
- **Email + password** — type your email and password. Tap the **👁 eye icon** to check what you typed. Forgot it? Tap **"ลืมรหัสผ่าน / Forgot password"** to get a reset link by email.

### Demo logins for the walkthrough

| Role | Email | Password |
|------|-------|----------|
| **Doctor** | `doctor1@clics.th` | `ClicsDoc#2026r2` |
| **Auditor** | `auditor1@clics.th` | `ClicsAudit#2026r2` |
| **Admin** (runs one council) | `admin@clics.th` | `ClicsAdmin#2026r2` |
| **Superadmin** (sees everything) | `superadmin@clics.th` | `ClicsSuper#2026r2` |

*(Temporary demo logins. Tip: to try two roles at once, use a second browser or a private/incognito window — one browser holds one login at a time.)*

---

## 2. 👩‍⚕️ For DOCTORS

1. **Sign in** at the portal (Google or email + password). The first time, read and accept the short **consent notice**.
2. **Start a new conversation (PLE)** and type the patient's main problem — e.g. *"chest pain in a 58-year-old man"* — using a **made-up / de-identified** case (no real patient details).
3. **Talk it through with the AI tutor.** Ask questions, suggest a diagnosis, reason out loud. The AI explains its thinking, backs answers with references, gently corrects mistakes (it won't just agree with you), and ends each reply with a question to push you a step further.
4. **Finish the session** when you're done.
5. **See your result** — a score across **7 areas of clinical thinking**, plus a chart of your progress over time.

💡 **Folders:** keep conversations tidy in folders, and rename them.
🔋 **AI usage allowance:** your home page shows a small bar of how much of your AI budget you've used. If you reach the limit, you can still *finish* an open session but can't start a new one — an admin can top it up.
🩺 **Want to also be a reviewer?** Tap **"ขอสิทธิ์ผู้ตรวจ / Request auditor role"** on your home page. A superadmin approves it; then a shortcut to the auditor console appears.

---

## 3. 🔍 For AUDITORS

1. **Sign in** at the portal — you'll be routed to the **auditor console**.
2. **Open your assigned cases** (use the filter box to find one quickly).
3. **Read the conversation and give your own score.** You **won't** see the AI's score — or the doctor's real identity — until *after* you submit yours. This keeps the review fair and independent.
4. **Submit.** Your score is compared with the AI's to measure how well they agree (the study's reliability check). You can't score the same session twice, and you can't score your own session.

---

## 4. 🛠️ For ADMINS (each runs one council)

1. **Sign in** at the portal — you'll be routed to the **dashboard**. You see and manage **only your own council**.
2. **Invites** — invite a physician, auditor, or "Special" member by email; share the one-time link (or it's emailed, if email sending is enabled).
3. **Users** — search members by name, see their scores, deactivate/reactivate accounts. *(Changing a member's role is a superadmin power.)*
4. **Sessions (PLEs)** — see every session in your council and **assign a finished one to an auditor**.
5. **QA Queue** — sessions the AI flagged for a second look: **Approve** (send for scoring) or **Reject** (won't count).
6. **Auditor requests** — you can *see* who asked for auditor rights; a **superadmin** approves them.

---

## 5. ⚙️ For the SUPERADMIN

1. **Sign in** at the portal — routed to the **executive overview**.
2. **See everything** — every member, every session, the overall results. On the **Stats** page, click any category (Evaluated, Awaiting QA, In progress…) to drill into exactly which sessions are in it.
3. **Manage accounts & roles** — add people, **change anyone's role** (Admin / User / Auditor / Special), set how many of each role a council may have, turn accounts on/off.
4. **Approve auditor-rights requests** — only the superadmin can grant these.
5. **Control AI spend** — set the standard per-doctor limit, override it for an individual, reset a doctor's usage, and watch the **total budget pool** used across everyone.

---

## 6. ✨ Just want to try it? (no account needed)

On the portal, tap **"ลองใช้แบบผู้เยี่ยมชม / Try as guest"** — you get **2 free questions** with the AI, and nothing is saved. A quick way to feel what the AI tutor is like.

---

## 7. Good to know

- The AI gives substantive, referenced answers — it's a **mentor, not a search box**, and it won't simply agree with you.
- **Privacy:** use **de-identified / made-up cases only.** Reviewers see each case under a code name (e.g. *P-001*), never the doctor's real name.
- **Capacity:** everyone can be signed in and working at once — the system handles the pilot group comfortably and answers AI turns in a few seconds even under load.
- **Works on phone & computer:** the screens (including the auditor's scoring page) fit a phone, so you can review and manage on the go.
- **This is a validation pilot:** **scores are provisional** — official credit follows once the scoring is calibrated with expert reviewers.

*หากพบปัญหาการใช้งาน กรุณาแจ้งผู้ดูแลระบบ / If anything misbehaves, tell your administrator.*
