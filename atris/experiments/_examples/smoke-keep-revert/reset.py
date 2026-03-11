"""Restore the smoke example to its baseline."""

from pathlib import Path


TARGET = Path(__file__).resolve().parent / "candidate.py"

TARGET.write_text(
    '''"""Bounded mutation target for the smoke experiment."""


def count_words(text: str) -> int:
    cleaned = text.strip()
    if not cleaned:
        return 0
    return len(cleaned)
''',
    encoding="utf-8",
)

print("reset smoke-keep-revert to baseline")
