"""Validate experiments for structure and context hygiene."""

from __future__ import annotations

import argparse
import re
from pathlib import Path


REQUIRED_FILES = ("program.md", "measure.py", "loop.py", "results.tsv")
MAX_PROGRAM_CHARS = 1200
MAX_RESULTS_BYTES = 64_000
SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def find_experiments(root: Path) -> list[Path]:
    return sorted(
        path
        for path in root.iterdir()
        if path.is_dir() and not path.name.startswith((".", "_"))
    )


def resolve_experiments(root: Path) -> list[Path]:
    if not root.exists() or not root.is_dir():
        return []

    # Allow validating a single pack directly, not just a parent directory.
    if any((root / filename).exists() for filename in REQUIRED_FILES):
        return [root]

    return find_experiments(root)


def validate_experiment(path: Path) -> list[str]:
    issues: list[str] = []

    if not SLUG_RE.match(path.name):
        issues.append(f"{path.name}: invalid folder name, use lowercase-hyphen slug")

    for filename in REQUIRED_FILES:
        if not (path / filename).exists():
            issues.append(f"{path.name}: missing required file {filename}")

    program_path = path / "program.md"
    if program_path.exists():
        size = len(program_path.read_text(encoding="utf-8"))
        if size > MAX_PROGRAM_CHARS:
            issues.append(
                f"{path.name}: program.md too long ({size} chars > {MAX_PROGRAM_CHARS})"
            )

    results_path = path / "results.tsv"
    if results_path.exists():
        size = results_path.stat().st_size
        if size > MAX_RESULTS_BYTES:
            issues.append(
                f"{path.name}: results.tsv too large ({size} bytes > {MAX_RESULTS_BYTES})"
            )

    return issues


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate experiment packs.")
    parser.add_argument("root", nargs="?", default=".", help="Directory containing experiment packs")
    args = parser.parse_args()

    root = Path(args.root).resolve()
    experiments = resolve_experiments(root)
    if not experiments:
        print("FAIL: no experiments found")
        return 1

    all_issues: list[str] = []
    for path in experiments:
        all_issues.extend(validate_experiment(path))

    if all_issues:
        print("FAIL")
        for issue in all_issues:
            print(f"- {issue}")
        return 1

    print(f"PASS: {len(experiments)} experiment(s) valid")
    for path in experiments:
        print(f"- {path.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
