"""Restore the kernel experiment target to the full baseline kernel."""

import shutil
from pathlib import Path


DIR = Path(__file__).resolve().parent
shutil.copy2(DIR / "baseline_kernel.md", DIR / "system_prompt.txt")
print("reset kernel-prompt-discipline to baseline (full 22-section Atris Kernel v1)")
