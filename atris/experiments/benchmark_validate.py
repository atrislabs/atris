"""Benchmark the validator against fixed good/bad fixtures."""

from __future__ import annotations

from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from validate import validate_experiment


FIXTURES_DIR = ROOT / "_fixtures"

CASES = [
    {
        "path": FIXTURES_DIR / "valid" / "good-experiment",
        "expect_ok": True,
        "must_contain": [],
    },
    {
        "path": FIXTURES_DIR / "invalid" / "BadName",
        "expect_ok": False,
        "must_contain": ["invalid folder name", "missing required file measure.py"],
    },
    {
        "path": FIXTURES_DIR / "invalid" / "bloated-context",
        "expect_ok": False,
        "must_contain": ["program.md too long"],
    },
]


def main() -> int:
    passed = 0
    failures = []

    for case in CASES:
        issues = validate_experiment(case["path"])
        is_ok = not issues

        if case["expect_ok"] != is_ok:
            failures.append(f"{case['path'].name}: expected ok={case['expect_ok']} got ok={is_ok}")
            continue

        missing = [needle for needle in case["must_contain"] if not any(needle in issue for issue in issues)]
        if missing:
            failures.append(f"{case['path'].name}: missing expected issue(s): {', '.join(missing)}")
            continue

        passed += 1

    total = len(CASES)
    score = passed / total if total else 0.0
    print(f"SCORE {score:.4f} ({passed}/{total})")

    if failures:
        for failure in failures:
            print(f"FAIL {failure}")
        return 1

    print("PASS benchmark_validate")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
