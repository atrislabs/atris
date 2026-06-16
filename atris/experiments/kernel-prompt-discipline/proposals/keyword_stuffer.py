"""Adversarial proposal: a keyword salad that name-checks every spine marker
in one line. Before the substance gate it scored 1.0 (reward hacking). After
the gate it must REVERT. Kept as a permanent regression case.
"""

import os
import shutil
from pathlib import Path


SRC = Path(__file__).resolve().parent / "keyword_stuffer.md"
TARGET = Path(os.environ["EXPERIMENT_TARGET"])
shutil.copy2(SRC, TARGET)
print("applied keyword stuffer: all markers, no substance (should revert post-gate)")
