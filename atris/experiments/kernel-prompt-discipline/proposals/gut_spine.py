"""Proposal: a lean, disciplined rewrite that GUTS the spine.

It is short, lowercase, has a precedence rule, no roadmap, no psychoanalysis --
high discipline -- but it deletes authority tiers, the preflight/falsifiability
rule, failure smells, and the heartbeat contract. Coverage drops, the gate
fires, and it should REVERT. This proves discipline cannot buy its way past a
missing spine.
"""

import os
import shutil
from pathlib import Path


SRC = Path(__file__).resolve().parent / "gut_spine.md"
TARGET = Path(os.environ["EXPERIMENT_TARGET"])
shutil.copy2(SRC, TARGET)
print("applied gut kernel: lean but spine deleted (should revert)")
