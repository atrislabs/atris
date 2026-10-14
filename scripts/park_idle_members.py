#!/usr/bin/env python3
"""Park team members with no member log in the last 30 days.

Reads `atris doc-health --json`, and for every member the checker flags as
stale, adds `status: parked` (plus a dated note) to the MEMBER.md frontmatter.
Nothing is fabricated: a parked member is one with no logged work lately.
Unpark by deleting the two lines. Members that already carry a status are skipped.

Usage: python3 scripts/park_idle_members.py [--root DIR] [--dry-run]
"""
import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys

TODAY = dt.date.today().isoformat()


def stale_members(root):
    out = subprocess.run(["atris", "doc-health", "--json"], cwd=root, capture_output=True, text=True)
    data = json.loads(out.stdout)
    return [m for m in data["staleness"]["members"]["items"] if m.get("stale")]


def park(root, member, dry_run):
    path = os.path.join(root, member["path"], "MEMBER.md")
    if not os.path.exists(path):
        return f"skip {member['name']}: no MEMBER.md"
    text = open(path, encoding="utf-8").read()
    age = "no member log" if member.get("age_days") is None else f"last member log {member['age_days']} days ago"
    note = f"parked_note: auto-parked {TODAY}, {age}; delete the status line to unpark"
    fm = re.match(r"^﻿?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)", text)
    if fm:
        body = fm.group(1)
        if re.search(r"^status:", body, re.M):
            return f"skip {member['name']}: already has a status"
        new_body = re.sub(r"^(name:[^\n]*\n)", rf"\1status: parked\n{note}\n", body, count=1, flags=re.M)
        if new_body == body:
            new_body = f"status: parked\n{note}\n" + body
        new_text = text[: fm.start(1)] + new_body + text[fm.end(1):]
    else:
        new_text = f"---\nname: {member['name']}\nstatus: parked\n{note}\n---\n" + text
    if not dry_run:
        open(path, "w", encoding="utf-8").write(new_text)
    return f"parked {member['name']} ({age})"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=".")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    root = os.path.abspath(args.root)
    for member in stale_members(root):
        print(park(root, member, args.dry_run))


if __name__ == "__main__":
    sys.exit(main())
