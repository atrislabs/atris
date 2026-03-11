"""Runtime benchmark for example experiment packs."""

from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parent
EXAMPLES_DIR = ROOT / "_examples"

CASES = [
    {
        "name": "smoke-keep-revert",
        "baseline_below": 1.0,
        "expected_final": 1.0,
        "proposals": ["proposals/bad_patch.py", "proposals/fix_patch.py"],
    },
]


def run_python(script: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(script), *args],
        cwd=str(script.parent),
        capture_output=True,
        text=True,
        check=True,
    )


def run_measure(exp_dir: Path) -> dict:
    proc = run_python(exp_dir / "measure.py")
    return json.loads(proc.stdout.strip())


def main() -> int:
    passed = 0
    failures = []

    for case in CASES:
        exp_dir = EXAMPLES_DIR / case["name"]
        run_python(exp_dir / "reset.py")
        baseline = run_measure(exp_dir)

        if float(baseline["score"]) >= case["baseline_below"]:
            failures.append(f"{case['name']}: baseline too high ({baseline['score']})")
            continue

        proposal_args: list[str] = []
        for proposal in case["proposals"]:
            proposal_args.extend(["--proposal", str(exp_dir / proposal)])

        run_python(exp_dir / "loop.py", *proposal_args)
        final = run_measure(exp_dir)

        if float(final["score"]) != case["expected_final"]:
            failures.append(
                f"{case['name']}: final score {final['score']} != {case['expected_final']}"
            )
            continue

        passed += 1

    total = len(CASES)
    score = passed / total if total else 0.0
    print(f"SCORE {score:.4f} ({passed}/{total})")

    if failures:
        for failure in failures:
            print(f"FAIL {failure}")
        return 1

    print("PASS benchmark_runtime")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
