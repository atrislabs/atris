"""Objective metric for the smoke keep/revert example."""

from __future__ import annotations

import json
from pathlib import Path
import sys


EXPERIMENT_DIR = Path(__file__).resolve().parent
if str(EXPERIMENT_DIR) not in sys.path:
    sys.path.insert(0, str(EXPERIMENT_DIR))

from candidate import count_words


CASES = [
    ("", 0),
    ("one", 1),
    ("two words", 2),
    ("  three   spaced   words ", 3),
    ("punctuation, still counts", 3),
]


def main() -> int:
    passed = 0

    for text, expected in CASES:
        actual = count_words(text)
        if actual == expected:
            passed += 1

    total = len(CASES)
    score = passed / total if total else 0.0
    payload = {
        "score": round(score, 4),
        "passed": passed,
        "total": total,
        "status": "pass" if passed == total else "fail",
    }
    print(json.dumps(payload))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
