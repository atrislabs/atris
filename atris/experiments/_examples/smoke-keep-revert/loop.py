"""Shared keep/revert loop for a bounded local experiment."""

from __future__ import annotations

import argparse
import csv
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from datetime import datetime, timezone


EXPERIMENT_DIR = Path(__file__).resolve().parent
DEFAULT_TARGET = EXPERIMENT_DIR / "candidate.py"
DEFAULT_MEASURE = EXPERIMENT_DIR / "measure.py"
DEFAULT_RESULTS = EXPERIMENT_DIR / "results.tsv"


def run_measure(measure_path: Path) -> dict:
    proc = subprocess.run(
        [sys.executable, str(measure_path)],
        cwd=str(EXPERIMENT_DIR),
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(proc.stdout.strip())


def append_result(results_path: Path, row: dict) -> None:
    write_header = not results_path.exists() or results_path.stat().st_size == 0
    with results_path.open("a", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=[
                "timestamp",
                "trial",
                "status",
                "old_score",
                "new_score",
                "proposal",
                "description",
            ],
            delimiter="\t",
        )
        if write_header:
            writer.writeheader()
        writer.writerow(row)


def restore_backup(backup_path: Path, target_path: Path) -> None:
    shutil.copy2(backup_path, target_path)
    backup_path.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Run a bounded keep/revert experiment.")
    parser.add_argument("--proposal", action="append", default=[])
    args = parser.parse_args()

    target_path = DEFAULT_TARGET.resolve()
    measure_path = DEFAULT_MEASURE.resolve()
    results_path = DEFAULT_RESULTS.resolve()

    baseline = run_measure(measure_path)
    current_score = float(baseline["score"])
    print(f"BASELINE {current_score:.4f}")

    for trial_index, proposal in enumerate(args.proposal, start=1):
        proposal_path = Path(proposal).resolve()
        backup_path = target_path.with_suffix(target_path.suffix + f".trial{trial_index}.bak")
        shutil.copy2(target_path, backup_path)

        status = "error"
        old_score = current_score
        new_score = current_score
        description = ""

        try:
            proc = subprocess.run(
                [sys.executable, str(proposal_path)],
                cwd=str(EXPERIMENT_DIR),
                capture_output=True,
                text=True,
                check=True,
                env={**os.environ, "EXPERIMENT_TARGET": str(target_path)},
            )
            if proc.stdout.strip():
                description = proc.stdout.strip().splitlines()[-1][:200]

            measured = run_measure(measure_path)
            new_score = float(measured["score"])
            if new_score > current_score:
                status = "kept"
                current_score = new_score
                backup_path.unlink(missing_ok=True)
            else:
                status = "reverted"
                restore_backup(backup_path, target_path)
        except subprocess.CalledProcessError as exc:
            restore_backup(backup_path, target_path)
            stderr = (exc.stderr or exc.stdout or "").strip()
            description = (stderr.splitlines()[-1] if stderr else "proposal failed")[:200]
            status = "error"

        append_result(
            results_path,
            {
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "trial": trial_index,
                "status": status,
                "old_score": f"{old_score:.4f}",
                "new_score": f"{new_score:.4f}",
                "proposal": proposal_path.name,
                "description": description,
            },
        )
        print(f"TRIAL {trial_index} {status.upper()} score={new_score:.4f} proposal={proposal_path.name}")

    final_measure = run_measure(measure_path)
    print(f"FINAL {final_measure['score']:.4f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
