"""Score whether the taught check is present in the product fixture."""

from __future__ import annotations

import json
import os
from pathlib import Path


EXPERIMENT_DIR = Path(__file__).resolve().parent
CHECK = "what is the search method?"
NEEDLES = ["search method"]
DEFAULT_TARGET = "atris/wiki/briefs/learn-simple-memory.apply.md"


def repo_root() -> Path:
    env = os.environ.get("ATRIS_REPO_ROOT")
    if env:
        return Path(env).resolve()
    return EXPERIMENT_DIR.parents[2]


def fixture_path():
    env = os.environ.get("ATRIS_TEACH_MEASURE_FIXTURE")
    if env:
        return Path(env).resolve()
    target = repo_root() / DEFAULT_TARGET
    return target if target.is_file() else None


def fail_payload(reason: str) -> dict:
    return {
        "score": 0,
        "passed": 0,
        "total": 1,
        "status": "fail",
        "reason": reason,
        "check": CHECK,
    }


def score_text(text: str) -> dict:
    blob = text.lower()
    found = bool(NEEDLES) and all(needle.lower() in blob for needle in NEEDLES)
    score = 1 if found else 0
    return {
        "score": score,
        "passed": score,
        "total": 1,
        "status": "pass" if score == 1 else "fail",
        "check": CHECK,
    }


def main() -> int:
    path = fixture_path()
    if path is None or not path.is_file():
        payload = fail_payload("fixture missing")
    else:
        payload = score_text(path.read_text(encoding="utf-8"))
    print(json.dumps(payload))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
