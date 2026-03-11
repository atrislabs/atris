"""Bounded mutation target for the smoke experiment."""


def count_words(text: str) -> int:
    cleaned = text.strip()
    if not cleaned:
        return 0
    return len(cleaned.split())
