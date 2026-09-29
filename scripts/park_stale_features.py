#!/usr/bin/env python3
"""Park inactive feature ideas using file modification times, not prose dates.

Run with --dry-run to print the plan without writing. This maintenance pass is
anchored to 2026-09-15. Only existing atris/features/<name>/idea.md files may
change; missing idea files are reported. Symlinks are never followed.
"""

from __future__ import annotations

import argparse
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
FEATURES = REPO_ROOT / "atris" / "features"
AS_OF = datetime(2026, 9, 15, tzinfo=timezone.utc)
CUTOFF = (AS_OF - timedelta(days=60)).timestamp()
EXEMPT = re.compile(r"complete|shipped|live|archived|parked|retired|superseded", re.I)
STATUS = re.compile(
    r"^[ \t]*(?:>[ \t]*)?(?:[-*][ \t]+)?(?:\*\*)?Status(?:\*\*)?"
    r"[ \t]*:[ \t]*(?:\*\*)?[ \t]*(?P<value>[^\r\n]*)",
    re.I | re.M,
)


def newest_file(folder: Path) -> tuple[Path, float]:
    """Find the newest regular file recursively without leaving the folder."""
    newest: tuple[Path, float] | None = None
    for directory, dirs, files in os.walk(folder, followlinks=False):
        dirs[:] = sorted(d for d in dirs if not (Path(directory) / d).is_symlink())
        for name in sorted(files):
            path = Path(directory) / name
            if path.is_symlink() or not path.is_file():
                continue
            mtime = path.stat().st_mtime
            if newest is None or mtime > newest[1]:
                newest = (path, mtime)
    if newest is None:
        raise ValueError(f"No regular files in {folder}")
    return newest


def parked_text(text: str, last_activity: str) -> str:
    """Replace the first status line, or add one after the title if absent."""
    match = STATUS.search(text)
    previous = match.group("value").strip() if match else "(missing)"
    previous = previous.replace("\u2014", "-")
    line = (
        f"> **Status:** parked (no activity since {last_activity}, "
        f"auto-parked {AS_OF.date().isoformat()}; previous: {previous})"
    )
    if match:
        return text[:match.start()] + line + text[match.end():]
    newline = "\r\n" if "\r\n" in text else "\n"
    title = re.search(r"^# [^\r\n]*(?:\r?\n|$)", text, re.M)
    if title:
        end = title.end()
        separator = "" if text[:end].endswith(newline) else newline
        return text[:end] + separator + newline + line + newline + text[end:]
    return line + newline + newline + text


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="Print changes without writing")
    args = parser.parse_args()
    planned = 0
    missing: list[str] = []
    for folder in sorted(FEATURES.iterdir()):
        if folder.name in {"_archive", "_templates"}:
            continue
        if folder.is_symlink():
            print(f"SKIP symlink: {folder.relative_to(REPO_ROOT)}")
            continue
        if not folder.is_dir():
            continue
        idea = folder / "idea.md"
        if idea.is_symlink():
            print(f"SKIP symlink: {idea.relative_to(REPO_ROOT)}")
            continue
        if not idea.is_file():
            missing.append(str(folder.relative_to(REPO_ROOT)))
            continue
        text = idea.read_bytes().decode("utf-8")
        status = STATUS.search(text)
        if status and EXEMPT.search(status.group("value")):
            continue
        newest, mtime = newest_file(folder)
        if mtime >= CUTOFF:
            continue
        date = datetime.fromtimestamp(mtime, timezone.utc).date().isoformat()
        updated = parked_text(text, date)
        label = "WOULD PARK" if args.dry_run else "PARK"
        print(f"{label}: {idea.relative_to(REPO_ROOT)}")
        print(f"  newest file: {newest.relative_to(REPO_ROOT)} ({date})")
        print(f"  {STATUS.search(updated).group(0)}")
        if not args.dry_run:
            # Refuse to overwrite a concurrent edit to the idea file.
            if idea.read_bytes().decode("utf-8") != text:
                raise RuntimeError(f"File changed during scan: {idea}")
            idea.write_bytes(updated.encode("utf-8"))
        planned += 1
    for folder in missing:
        print(f"NO IDEA: {folder}")
    action = "Would park" if args.dry_run else "Parked"
    print(f"{action} {planned} feature(s); {len(missing)} folder(s) have no idea.md.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
