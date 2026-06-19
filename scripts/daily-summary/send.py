#!/usr/bin/env python3
"""
CLICS daily-summary email: render + send via the Resend HTTPS API.

Reads a ``data.json`` (the 24h git metrics + plain-Thai summary produced by the
"CLICS Daily Summary Email" claude.ai routine), renders an email-safe HTML
dashboard + a plain-text fallback, and POSTs it to Resend.

WHY THIS LIVES IN GITHUB ACTIONS, NOT THE CLAUDE CLOUD SANDBOX
    The original sender POSTed to api.resend.com from inside the Anthropic cloud
    sandbox. On 2026-06-19 the sandbox's network egress allowlist began blocking
    that host ("HOST not in allowlist"), so the send failed and fell back to a
    Gmail draft. GitHub-hosted runners have open egress, so the send works here.
    (Mirrors the jjnnaappaatt/lidar-hpe "Daily Update Email" workflow.)

SECRETS COME FROM THE ENVIRONMENT — never hardcode them:
    RESEND_API_KEY  (required)  Resend API key (a GitHub Actions encrypted secret)
    DAILY_TO        (optional)  recipient, default napat72235@gmail.com
    DATA_FILE       (optional)  path to data.json, default ./data.json

Prints ``SENT <body>`` and exits 0 on success; prints ``ERROR ...`` and exits 1
on any failure (so the GitHub Actions job goes red and the miss is visible).
"""
import html
import json
import os
import sys
import urllib.error
import urllib.request

# --- Anthropic-brand palette (must match the original renderer exactly) ---
CORAL, INK, BG, CARD = "#cc785c", "#141413", "#faf9f5", "#ffffff"
GREEN, RED, AMBER, MUTED, BORDER = "#5db872", "#c64545", "#e8a55a", "#73726c", "#e7e4dc"
TGT = "\U0001F3AF"  # 🎯 — hoisted to a const so it never sits inside an f-string {} expression
F = "-apple-system,'Segoe UI',Inter,'Noto Sans Thai','Sukhumvit Set',Tahoma,sans-serif"

# Constant subject + threading headers so every day collapses into ONE Gmail thread.
THREAD = "<clics-daily-bot-thread@clics.napat>"
SUBJECT = "\U0001F4CB CLICS — สรุปความคืบหน้ารายวัน"  # 📋

e = lambda s: html.escape(str(s))


def _kpi(n, l, c=INK):
    return (f'<td align="center" style="padding:14px 4px;border:1px solid {BORDER};background:{CARD};">'
            f'<div style="font:700 22px {F};color:{c};">{e(n)}</div>'
            f'<div style="font:400 11px {F};color:{MUTED};">{e(l)}</div></td>')


def _sec(icon, title, items, accent, ordered=False):
    if not items:
        return ''
    rows = ''.join(f'<div style="font:400 13px/1.6 {F};color:{INK};margin:1px 0;">'
                   f'{(str(i+1)+". ") if ordered else "&bull;&nbsp;"}{e(x)}</div>' for i, x in enumerate(items))
    return (f'<tr><td style="padding:6px 18px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">'
            f'<tr><td style="background:{CARD};border:1px solid {BORDER};border-left:4px solid {accent};border-radius:8px;'
            f'padding:12px 14px;"><div style="font:700 14px {F};color:{INK};margin-bottom:6px;">{icon} {e(title)}</div>'
            f'{rows}</td></tr></table></td></tr>')


def render_html(d):
    date, branch = d['date'], d['branch']
    m = d['metrics']
    ups, rem, summ = d.get('updates', []), d.get('remaining', []), d.get('summary', [])

    tot = m['added'] + m['removed']
    ap = round(m['added'] * 100 / tot) if tot else 0
    bar = ''
    if tot:
        bar = (f'<tr><td style="padding:14px 18px 4px;"><table role="presentation" width="100%" cellpadding="0" '
               f'cellspacing="0" style="border-collapse:collapse;border-radius:6px;overflow:hidden;">'
               f'<tr style="height:10px;"><td bgcolor="{GREEN}" style="width:{ap}%;font-size:0;line-height:0;">&nbsp;</td>'
               f'<td bgcolor="{RED}" style="width:{100-ap}%;font-size:0;line-height:0;">&nbsp;</td></tr></table>'
               f'<div style="font:400 11px {F};color:{MUTED};margin-top:5px;">เพิ่ม {ap}% &middot; ลบ {100-ap}%</div></td></tr>')

    note = '' if (ups or m['commits']) else (f'<tr><td style="padding:6px 18px;"><div style="background:{CARD};'
           f'border:1px solid {BORDER};border-radius:8px;padding:14px;font:400 13px {F};color:{MUTED};text-align:center;">'
           f'วันนี้ไม่มีความเปลี่ยนแปลงในระบบ</div></td></tr>')

    cont_lines = ["Continue work on the CLICS project in this repo.",
                  "1) Read docs/HANDOFF.md and docs/ROADMAP.md first.",
                  "2) Continue the outstanding tasks (pilot-readiness P1 items + any open TODO/FIXME), highest priority first.",
                  "3) Outline a short plan, then implement one task at a time and run the tests."] if rem else []
    cont = ''
    if cont_lines:
        cont_html = "<br>".join(e(l) for l in cont_lines)
        cont = (f'<tr><td style="padding:2px 18px 8px;">'
                f'<div style="font:700 11px {F};color:{MUTED};margin:2px 0 4px;letter-spacing:.02em;">'
                f'📋 Ready to paste — copy into Claude Code to continue</div>'
                f'<div style="font:400 12px/1.55 ui-monospace,Menlo,Consolas,\'Courier New\',monospace;background:#f1eee7;'
                f'border:1px dashed {CORAL};border-radius:8px;padding:12px 14px;color:{INK};white-space:pre-wrap;'
                f'word-break:break-word;">{cont_html}</div></td></tr>')

    return (f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:{BG};padding:24px 0;">'
            f'<tr><td align="center"><table role="presentation" width="600" cellpadding="0" cellspacing="0" '
            f'style="max-width:600px;width:100%;background:{BG};border-radius:14px;overflow:hidden;border:1px solid {BORDER};">'
            f'<tr><td style="background:{CORAL};padding:20px 22px;"><div style="font:700 20px {F};color:#fff;">'
            f'CLICS &mdash; สรุปความคืบหน้ารายวัน</div><div style="font:400 13px {F};color:#ffe7de;margin-top:3px;">'
            f'\U0001F5D3 {e(date)}</div></td></tr>'
            f'<tr><td style="padding:18px 18px 4px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
            f'style="border-collapse:collapse;border-radius:10px;overflow:hidden;"><tr>'
            f'{_kpi(m["commits"],"รอบที่อัปเดต")}{_kpi(m["files"],"ไฟล์ที่แก้")}'
            f'{_kpi("+"+str(m["added"]),"เพิ่ม",GREEN)}{_kpi("−"+str(m["removed"]),"ลบ",RED)}'
            f'</tr></table></td></tr>{bar}{note}'
            f'{_sec("✅","สิ่งที่ทำวันนี้",ups,GREEN)}'
            f'{_sec("⏳","งานที่ยังเหลือ",rem,AMBER,ordered=True)}{cont}'
            f'{_sec(TGT,"ภาพรวม",summ,CORAL)}'
            f'<tr><td style="padding:14px 18px 20px;font:400 11px {F};color:{MUTED};text-align:center;">'
            f'— สรุปอัตโนมัติโดยระบบ CLICS</td></tr></table></td></tr></table>')


def render_text(d):
    date = d['date']
    m = d['metrics']
    ups, rem, summ = d.get('updates', []), d.get('remaining', []), d.get('summary', [])
    cont_lines = ["Continue work on the CLICS project in this repo.",
                  "1) Read docs/HANDOFF.md and docs/ROADMAP.md first.",
                  "2) Continue the outstanding tasks (pilot-readiness P1 items + any open TODO/FIXME), highest priority first.",
                  "3) Outline a short plan, then implement one task at a time and run the tests."] if rem else []
    tl = [f"CLICS — สรุปความคืบหน้ารายวัน | {date}",
          f"รอบที่อัปเดต {m['commits']} · ไฟล์ที่แก้ {m['files']} · เพิ่ม {m['added']} / ลบ {m['removed']}", ""]
    if ups:
        tl += ["✅ สิ่งที่ทำวันนี้"] + [f"  • {x}" for x in ups]
    elif not m['commits']:
        tl += ["วันนี้ไม่มีความเปลี่ยนแปลงในระบบ"]
    if rem:
        tl += ["", "⏳ งานที่ยังเหลือ"] + [f"  {i+1}. {x}" for i, x in enumerate(rem)]
    if cont_lines:
        tl += ["", "📋 Ready to paste into Claude Code:", "----------"] + cont_lines + ["----------"]
    if summ:
        tl += ["", "🎯 ภาพรวม"] + [f"  • {x}" for x in summ]
    tl += ["", "— สรุปอัตโนมัติโดยระบบ CLICS"]
    return "\n".join(tl)


def main():
    api_key = os.environ.get("RESEND_API_KEY", "").strip()
    if not api_key:
        print("ERROR no RESEND_API_KEY in environment", file=sys.stderr)
        return 1
    to = os.environ.get("DAILY_TO", "napat72235@gmail.com").strip() or "napat72235@gmail.com"
    data_file = os.environ.get("DATA_FILE", "data.json")

    try:
        with open(data_file, encoding="utf-8") as fh:
            d = json.load(fh)
    except (OSError, json.JSONDecodeError) as ex:
        print(f"ERROR could not read {data_file}: {ex}", file=sys.stderr)
        return 1

    payload = json.dumps({
        "from": "CLICS Daily Bot <onboarding@resend.dev>",
        "to": [to],
        "subject": SUBJECT,
        "html": render_html(d),
        "text": render_text(d),
        "headers": {"References": THREAD, "In-Reply-To": THREAD},
    }).encode("utf-8")

    req = urllib.request.Request(
        "https://api.resend.com/emails", data=payload, method="POST",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json",
                 # curl UA: Resend's Cloudflare edge returns 403 1010 to the default urllib UA.
                 "User-Agent": "curl/8.4.0"})
    try:
        r = urllib.request.urlopen(req)
        print("SENT", r.read().decode())
        return 0
    except urllib.error.HTTPError as ex:
        print("ERROR", ex.code, ex.read().decode(), file=sys.stderr)
        return 1
    except urllib.error.URLError as ex:
        print(f"ERROR network {ex}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
