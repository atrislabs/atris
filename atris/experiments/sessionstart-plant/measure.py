"""Score SessionStart plant attempts through the live pack hook path."""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess


EXPERIMENT_DIR = Path(__file__).resolve().parent
REPO_ROOT = EXPERIMENT_DIR.parents[2]
PROBE = EXPERIMENT_DIR / "probe.js"


def fail_payload(reason: str) -> dict:
    return {
        "score": 0,
        "passed": 0,
        "total": 1,
        "status": "fail",
        "reason": reason,
    }


def run_probe() -> dict:
    if not PROBE.exists():
        return fail_payload("probe.js missing")

    node = os.environ.get("ATRIS_EXPERIMENTS_NODE") or "node"
    proc = subprocess.run(
        [node, str(PROBE)],
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
        env={**os.environ, "ATRIS_REPO_ROOT": str(REPO_ROOT)},
    )
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "probe failed").strip().splitlines()
        return fail_payload(detail[-1] if detail else "probe failed")

    line = (proc.stdout or "").strip().splitlines()
    if not line:
        return fail_payload("probe printed no json")
    payload = json.loads(line[-1])
    score = 1 if payload.get("score") == 1 else 0
    payload["score"] = score
    payload["passed"] = score
    payload["total"] = 1
    payload["status"] = "pass" if score == 1 else "fail"
    return payload


def main() -> int:
    try:
        payload = run_probe()
    except (OSError, json.JSONDecodeError) as exc:
        payload = fail_payload(str(exc))
    print(json.dumps(payload))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
