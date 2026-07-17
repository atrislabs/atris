"""Keep/revert runner for the cross-modal taste experiment."""

from __future__ import annotations

import argparse
import csv
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from typing import Any


EXPERIMENT_DIR = Path(__file__).resolve().parent
DEFAULT_TARGET = EXPERIMENT_DIR / "candidate.json"
DEFAULT_RESULTS = EXPERIMENT_DIR / "results.tsv"
DEFAULT_SCORECARD = EXPERIMENT_DIR / "scorecard.latest.json"
KEEP_MARGIN = 0.05

if str(EXPERIMENT_DIR) not in sys.path:
    sys.path.insert(0, str(EXPERIMENT_DIR))

from measure import measure


RESULT_FIELDS = [
    "timestamp",
    "run",
    "trial",
    "modality",
    "status",
    "old_score",
    "new_score",
    "proposal",
    "description",
]


def modality_scores(scorecard: dict[str, Any]) -> dict[str, float]:
    return {name: float(item["score"]) for name, item in scorecard["modalities"].items()}


def should_keep(old: dict[str, Any], new: dict[str, Any], margin: float = KEEP_MARGIN) -> bool:
    if float(new["score"]) < float(old["score"]) + margin:
        return False
    old_modalities = modality_scores(old)
    new_modalities = modality_scores(new)
    return all(new_modalities[name] >= old_score + margin for name, old_score in old_modalities.items())


def append_rows(
    results_path: Path,
    run_id: str,
    trial: int,
    status: str,
    old: dict[str, Any] | None,
    new: dict[str, Any],
    proposal: str,
    description: str,
) -> None:
    write_header = not results_path.exists() or results_path.stat().st_size == 0
    old_scores = modality_scores(old) if old else {}
    new_scores = modality_scores(new)
    rows = []
    for modality, new_score in new_scores.items():
        rows.append(
            {
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "run": run_id,
                "trial": trial,
                "modality": modality,
                "status": status,
                "old_score": "" if old is None else f"{old_scores[modality]:.4f}",
                "new_score": f"{new_score:.4f}",
                "proposal": proposal,
                "description": description,
            }
        )
    rows.append(
        {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "run": run_id,
            "trial": trial,
            "modality": "aggregate",
            "status": status,
            "old_score": "" if old is None else f"{float(old['score']):.4f}",
            "new_score": f"{float(new['score']):.4f}",
            "proposal": proposal,
            "description": description,
        }
    )
    with results_path.open("a", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=RESULT_FIELDS,
            delimiter="\t",
            lineterminator="\n",
        )
        if write_header:
            writer.writeheader()
        writer.writerows(rows)


def apply_proposal(proposal_path: Path, target_path: Path) -> str:
    proc = subprocess.run(
        [sys.executable, str(proposal_path)],
        cwd=str(EXPERIMENT_DIR),
        capture_output=True,
        text=True,
        check=True,
        env={**os.environ, "EXPERIMENT_TARGET": str(target_path)},
    )
    return (proc.stdout.strip().splitlines()[-1] if proc.stdout.strip() else proposal_path.name)[:200]


def evaluate_proposal(
    proposal_path: Path,
    target_path: Path,
    current: dict[str, Any],
    dry_run: bool,
) -> tuple[str, dict[str, Any], str]:
    if dry_run:
        with tempfile.TemporaryDirectory(prefix="taste-loop-") as temp_dir:
            trial_target = Path(temp_dir) / target_path.name
            shutil.copy2(target_path, trial_target)
            description = apply_proposal(proposal_path, trial_target)
            measured = measure(trial_target)
            status = "would_keep" if should_keep(current, measured) else "would_revert"
            return status, measured, description

    backup_path = target_path.with_suffix(target_path.suffix + ".bak")
    shutil.copy2(target_path, backup_path)
    try:
        description = apply_proposal(proposal_path, target_path)
        measured = measure(target_path)
        if should_keep(current, measured):
            backup_path.unlink(missing_ok=True)
            return "kept", measured, description
        shutil.copy2(backup_path, target_path)
        backup_path.unlink(missing_ok=True)
        return "reverted", measured, description
    except Exception:
        shutil.copy2(backup_path, target_path)
        backup_path.unlink(missing_ok=True)
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the cross-modal taste keep/revert loop.")
    parser.add_argument("--proposal", action="append", default=[])
    parser.add_argument("--target", default=str(DEFAULT_TARGET))
    parser.add_argument("--results", default=str(DEFAULT_RESULTS))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    target_path = Path(args.target).resolve()
    results_path = Path(args.results).resolve()
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    current = measure(target_path)
    print(f"BASELINE {current['score']:.4f}")
    if not args.dry_run:
        append_rows(results_path, run_id, 0, "baseline", None, current, "", "frozen baseline")

    latest_status = "baseline"
    for trial, proposal in enumerate(args.proposal, start=1):
        proposal_path = Path(proposal).resolve()
        old = current
        try:
            status, measured, description = evaluate_proposal(
                proposal_path, target_path, current, args.dry_run
            )
        except Exception as exc:
            status = "error"
            measured = current
            description = str(exc).splitlines()[-1][:200]
        if status in {"kept", "would_keep"}:
            current = measured
        if not args.dry_run:
            append_rows(
                results_path,
                run_id,
                trial,
                status,
                old,
                measured,
                proposal_path.name,
                description,
            )
        latest_status = status
        print(
            f"TRIAL {trial} {status.upper()} old={old['score']:.4f} "
            f"new={measured['score']:.4f} proposal={proposal_path.name}"
        )

    final_scorecard = measure(target_path) if not args.dry_run else current
    if not args.dry_run:
        payload = {
            **final_scorecard,
            "keep_margin": KEEP_MARGIN,
            "latest_decision": latest_status,
            "run": run_id,
        }
        DEFAULT_SCORECARD.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"FINAL {final_scorecard['score']:.4f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
