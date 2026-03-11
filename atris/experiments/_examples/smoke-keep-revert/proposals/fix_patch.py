"""A good mutation that should be kept."""

from pathlib import Path
import os


TARGET = Path(os.environ["EXPERIMENT_TARGET"])

TARGET.write_text(
    '''"""Bounded mutation target for the smoke experiment."""


def count_words(text: str) -> int:
    cleaned = text.strip()
    if not cleaned:
        return 0
    return len(cleaned.split())
''',
    encoding="utf-8",
)

print("applied good proposal")
