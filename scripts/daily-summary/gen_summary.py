#!/usr/bin/env python3
"""
Self-contained data.json generator for the CLICS daily-summary email.

WHY DETERMINISTIC (no LLM):  the original design generated the plain-Thai summary
with an LLM *inside* an Anthropic cloud /schedule routine, then dispatched this
GitHub workflow to send it. Every failure that email ever had was a cloud-sandbox
quirk (jq missing, urllib UA, Python <3.12 f-string, the Resend egress block, and
finally — 2026-06-21 — ``gh`` not present in the sandbox so the dispatch silently
fell back to a Gmail draft). The sandbox is the unreliable component.

This script removes it: it builds the WHOLE report from the git checkout that the
GitHub Actions runner already has — git metrics + a rule-based Thai humanization
of the commits and backlog — with no network and no LLM. GitHub Actions then runs
``send.py`` to render + email it. This mirrors the sibling jjnnaappaatt/lidar-hpe
``daily_update.py``, which has run reliably this way for weeks.

The output is the data.json shape ``send.py`` consumes:
    {date, branch, metrics{commits,files,added,removed}, updates[], remaining[], summary[]}

Plain-Thai quality is necessarily below an LLM's (it cannot freely translate an
arbitrary commit message), but it is sandbox-independent and never silently
degrades to a draft. Prints data.json to stdout.
"""
import json
import re
import subprocess
from datetime import datetime, timezone, timedelta
from pathlib import Path

# Repo root = two levels up from scripts/daily-summary/.
REPO = Path(__file__).resolve().parents[2]
MAX_UPDATES = 10
MAX_REMAINING = 8

# Conventional-commit type -> plain-Thai outcome verb (manager-readable).
PREFIX_TH = {
    "feat":     "เพิ่มความสามารถใหม่",
    "fix":      "แก้ไขข้อบกพร่อง",
    "docs":     "ปรับปรุงเอกสาร/คู่มือ",
    "test":     "เพิ่ม/ปรับการทดสอบระบบ",
    "refactor": "ปรับโครงสร้างภายในให้ดีขึ้น",
    "perf":     "ปรับให้ระบบทำงานเร็วขึ้น",
    "chore":    "งานดูแลระบบทั่วไป",
    "seed":     "เตรียมข้อมูลเริ่มต้นของระบบ",
    "style":    "ปรับรูปแบบการแสดงผล",
    "ci":       "ปรับระบบทดสอบ/ติดตั้งอัตโนมัติ",
    "build":    "ปรับระบบสร้างตัวโปรแกรม",
    "revert":   "ย้อนการเปลี่ยนแปลงก่อนหน้า",
}

# Curated plain-Thai rewrites for the slow-moving standing backlog (trigger -> Thai
# sentence). Keeps "remaining" non-technical; edit here when the backlog shifts.
# Mirrors lidar-hpe daily_update.py's _CURATED approach.
CURATED = [
    (("anthropic_api_key", "rotate", "key rotation", "หมุนกุญแจ", "rotate the"),
     "หมุนเปลี่ยนรหัสกุญแจของระบบ (API key) ก่อนเปิดนำร่องจริง"),
    (("demo password", "throwaway demo", "seed-users", "real per-user cred"),
     "เปลี่ยนรหัสผ่านทดลองเป็นรหัสผู้ใช้จริงก่อนเปิดใช้งาน"),
    (("sending domain", "resend", "invite email", "mail_from", "verify a sending"),
     "ยืนยันโดเมนอีเมล เพื่อให้ส่งคำเชิญถึงผู้ใช้ได้ทุกคน (ตอนนี้ส่งได้เฉพาะเจ้าของบัญชี)"),
    (("pre-filter", "4 signals", "four signals", "l3"),
     "พัฒนาสัญญาณคัดกรองอัตโนมัติให้ครบตามสเปก"),
    (("pilot test mode", "test mode", "is_test"),
     "ปิดโหมดทดสอบก่อนรับผู้เข้าร่วมจริง"),
    (("consent", "informed consent", "pi "),
     "สรุปข้อความขอความยินยอมฉบับสุดท้ายจากหัวหน้าโครงการ"),
    (("icc", "calibration", "inter-rater"),
     "เตรียมเวิร์กช็อปปรับมาตรฐานผู้ประเมิน (เป้าหมายความสอดคล้อง ICC ≥ 0.75)"),
]


def _git(args):
    """Run a git command in the repo; return stripped stdout ('' on any error)."""
    try:
        r = subprocess.run(["git", "-C", str(REPO), *args],
                           capture_output=True, text=True)
        return r.stdout.strip() if r.returncode == 0 else ""
    except (OSError, ValueError):
        return ""


def git_metrics():
    """(subjects[list[str]], files, added, removed) for the last 24h, no merges."""
    log = _git(["log", "--since=24 hours ago", "--no-merges", "--pretty=format:%s"])
    subjects = [s for s in log.splitlines() if s.strip()]

    numstat = _git(["log", "--since=24 hours ago", "--no-merges",
                    "--numstat", "--pretty=tformat:"])
    files, added, removed = set(), 0, 0
    for line in numstat.splitlines():
        parts = line.split("\t")
        if len(parts) == 3:
            a, d, path = parts
            files.add(path)
            added += int(a) if a.isdigit() else 0
            removed += int(d) if d.isdigit() else 0
    return subjects, len(files), added, removed


def _strip_jargon(text):
    """Light de-jargon: drop code spans, parentheticals, file paths, SHAs; heal the gaps."""
    text = re.sub(r"`[^`]*`", "", text)                       # `code` spans
    text = re.sub(r"\((?:[^()]|\([^()]*\))*\)", "", text)     # (parentheticals), 1 nesting level
    text = re.sub(r"\b[\w./-]+\.(js|ts|tsx|jsx|sql|md|json|py|yml|yaml|env)\b", "", text)  # file paths
    text = re.sub(r"\b(?=[0-9a-f]*[0-9])[0-9a-f]{7,40}\b", "", text)  # commit SHAs (require a digit → spare hex-words like "deadbeef")
    # Heal gaps left by the removals so a deleted span never leaves broken punctuation.
    text = re.sub(r"\s+([).,;:!?])", r"\1", text)             # space before punctuation
    text = re.sub(r",\s*,", ",", text)                        # doubled commas
    text = re.sub(r"^[\s,;:]+", "", text)                     # leading orphan punctuation
    text = re.sub(r"\s*[+&/|>→–—-]+\s*$", "", text)           # trailing dangling operators / arrows
    text = re.sub(r"\s+\b(in|to|on|for|with|of|into|from|via|and|the|a|an)\s*$", "", text, flags=re.I)  # trailing dangling connector
    text = re.sub(r"\s{2,}", " ", text).strip(" :;,-—·)( ")
    return text


def humanize_commit(subject):
    """A conventional-commit subject -> a plain-Thai, manager-readable line."""
    m = re.match(r"^(\w+)(?:\([^)]*\))?(!)?:\s*(.*)$", subject)
    if not m:                                                 # non-conventional commit — no prefix to map
        s = _strip_jargon(subject)
        return f"ปรับปรุงระบบ: {s}" if s else "ปรับปรุงระบบ"  # never leak the raw English subject
    prefix, breaking, desc = m.group(1).lower(), m.group(2), m.group(3)
    lead = PREFIX_TH.get(prefix, "ปรับปรุงระบบ")
    desc = _strip_jargon(desc)
    if breaking:
        lead = "⚠️ " + lead + " (มีการเปลี่ยนแปลงสำคัญ)"
    return f"{lead}: {desc}" if desc else lead


def scan_roadmap_pending():
    """
    Pending pre-pilot work as plain-Thai, from docs/ROADMAP.md's "## P1" section.

    Surfaces a bullet ONLY if it maps to a curated Thai sentence (CURATED) — an
    un-mapped bullet would leak raw English jargon ("ELM", "Credit Engine") into a
    manager's email, so it is dropped rather than shown. Bullets marked done are
    skipped, so the list shrinks as ROADMAP P1 items are completed. Best-effort:
    returns [] on any problem. Only the P1 (pilot-readiness) section is read; the
    P2/P3 spec-gap/flagship sections are intentionally ignored.
    """
    fp = REPO / "docs" / "ROADMAP.md"
    if not fp.exists():
        return []
    try:
        text = fp.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return []
    m = re.search(r"^##\s+P1\b.*?$(.*?)(?=^##\s|\Z)", text, re.M | re.S)
    if not m:
        return []
    out = []
    for ln in m.group(1).splitlines():
        b = re.match(r"^\s*-\s+(.*)$", ln)                    # a top-level bullet
        if not b:
            continue
        line = b.group(1)
        if re.search(r"\bdone\b", line, re.I):               # *(done)* / — DONE
            continue
        low = line.lower()
        for triggers, sentence in CURATED:                   # every curated match in the bullet
            if any(t in low for t in triggers):
                out.append(sentence)
    return out


def dedup(items, cap):
    seen, out = set(), []
    for x in items:
        key = x.lower().strip()
        if key and key not in seen:
            seen.add(key)
            out.append(x)
        if len(out) >= cap:
            break
    return out


def main():
    bkk = timezone(timedelta(hours=7))                       # Bangkok date regardless of runner TZ
    date = datetime.now(bkk).strftime("%d/%m/%Y")
    branch = _git(["rev-parse", "--abbrev-ref", "HEAD"]) or "master"

    subjects, files, added, removed = git_metrics()
    commits = len(subjects)

    updates = dedup([humanize_commit(s) for s in subjects], MAX_UPDATES)
    remaining = dedup(scan_roadmap_pending(), MAX_REMAINING)

    summary = []
    if commits:
        summary.append(f"คืบหน้าดี — มี {commits} รอบการอัปเดต แตะ {files} ไฟล์ "
                       f"(เพิ่ม {added} / ลบ {removed} บรรทัด)")
    else:
        summary.append("วันนี้ยังไม่มีความเปลี่ยนแปลงในระบบ")
    if remaining:
        summary.append(f"ควรโฟกัสต่อไป: {remaining[0]}")
    if not commits:
        summary.append("⚠️ ไม่มีความเคลื่อนไหวใน 24 ชม. — งานอาจหยุดนิ่ง หรือยังไม่ได้บันทึก")

    data = {
        "date": date,
        "branch": branch,
        "metrics": {"commits": commits, "files": files, "added": added, "removed": removed},
        "updates": updates,
        "remaining": remaining,
        "summary": summary,
    }
    print(json.dumps(data, ensure_ascii=False))


if __name__ == "__main__":
    main()
