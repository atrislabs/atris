"""Proposal: replace the kernel with the compressed spine kernel.

Preserves all 7 behavioral spine markers, adds a precedence rule, drops the
roadmap/poetry/psychoanalysis bloat. Should be KEPT.
"""

import os
import shutil
from pathlib import Path


SRC = Path(__file__).resolve().parent / "spine_kernel.md"
TARGET = Path(os.environ["EXPERIMENT_TARGET"])
shutil.copy2(SRC, TARGET)
print("applied spine kernel: compressed, spine preserved + precedence added")
