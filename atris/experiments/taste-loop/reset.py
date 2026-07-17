"""Restore the taste experiment target without erasing the append-only results."""

from pathlib import Path
import shutil


EXPERIMENT_DIR = Path(__file__).resolve().parent
shutil.copy2(EXPERIMENT_DIR / "baseline.json", EXPERIMENT_DIR / "candidate.json")
print("reset taste-loop candidate to baseline")
