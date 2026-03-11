"""A deliberately bad mutation that should be reverted."""

from pathlib import Path
import os


TARGET = Path(os.environ["EXPERIMENT_TARGET"])

TARGET.write_text(
    '''"""Bounded mutation target for the smoke experiment."""


def count_words(text: str) -> int:
    return 0
''',
    encoding="utf-8",
)

print("applied bad proposal")
