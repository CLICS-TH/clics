#!/usr/bin/env python3
"""
Fallback data.json generator for the CLICS daily summary.

The PRIMARY path is the claude.ai routine: it computes the 24h git metrics AND
writes a plain-Thai, non-technical summary (its LLM is good at that and needs no
API key), then dispatches the GitHub workflow with that data.json as the payload.

This script is the SECONDARY path — used only when the workflow is run with no
payload (e.g. a manual ``gh workflow run`` smoke test). It computes the same git
metrics but, having no LLM, fills ``updates`` with the RAW commit subjects (not
translated). Good enough to prove the render+send pipeline; not the polished
manager-facing summary the routine produces.

Prints the data.json to stdout.
"""
import json
import subprocess
from datetime import datetime, timezone, timedelta


def _run(args):
    return subprocess.run(args, capture_output=True, text=True).stdout.strip()


def main():
    # Bangkok-local date (UTC+7) regardless of the runner's TZ.
    bkk = timezone(timedelta(hours=7))
    date = datetime.now(bkk).strftime("%d/%m/%Y")
    branch = _run(["git", "rev-parse", "--abbrev-ref", "HEAD"]) or "master"

    log = _run(["git", "log", "--since=24 hours ago", "--no-merges", "--pretty=format:%s"])
    subjects = [s for s in log.splitlines() if s.strip()]
    commits = len(subjects)

    numstat = _run(["git", "log", "--since=24 hours ago", "--numstat", "--pretty=tformat:"])
    files, added, removed = set(), 0, 0
    for line in numstat.splitlines():
        parts = line.split("\t")
        if len(parts) == 3:
            a, d, path = parts
            files.add(path)
            added += int(a) if a.isdigit() else 0
            removed += int(d) if d.isdigit() else 0

    data = {
        "date": date,
        "branch": branch,
        "metrics": {"commits": commits, "files": len(files), "added": added, "removed": removed},
        # Raw (untranslated) commit subjects — fallback only. Capped to keep the email readable.
        "updates": subjects[:12],
        "remaining": [],
        "summary": ["(สรุปอัตโนมัติแบบสำรอง — ไม่มีการแปลเป็นภาษาทั่วไป เพราะรันแบบไม่มีข้อมูลจากระบบสรุป)"] if commits else [],
    }
    print(json.dumps(data, ensure_ascii=False))


if __name__ == "__main__":
    main()
