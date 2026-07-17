"""Independent deterministic judge for the cross-modal taste experiment."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import re
from typing import Any


EXPERIMENT_DIR = Path(__file__).resolve().parent
DEFAULT_CANDIDATE = EXPERIMENT_DIR / "candidate.json"
DEFAULT_FIXTURES = EXPERIMENT_DIR / "fixtures.json"


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def match_fraction(text: str, terms: list[str]) -> float:
    lowered = text.casefold()
    if not terms:
        return 1.0
    matched = sum(1 for term in terms if term.casefold() in lowered)
    return matched / len(terms)


def pattern_fraction(text: str, patterns: list[str]) -> tuple[float, list[str]]:
    if not patterns:
        return 0.0, []
    hits = [pattern for pattern in patterns if re.search(pattern, text, re.IGNORECASE | re.DOTALL)]
    return len(hits) / len(patterns), hits


def geometric_quality(values: list[float]) -> float:
    if not values or any(value <= 0 for value in values):
        return 0.0
    return math.prod(values) ** (1 / len(values))


def score_artifact(text: str, fixture: dict[str, Any]) -> dict[str, Any]:
    generic_structure, generic_hits = pattern_fraction(text, fixture["generic_patterns"])
    repeated_slop, slop_hits = pattern_fraction(text, fixture["slop_patterns"])
    product_specificity = match_fraction(text, fixture["product_terms"])
    reference_adherence = match_fraction(text, fixture["reference_cues"])
    quality = geometric_quality(
        [
            1 - generic_structure,
            product_specificity,
            reference_adherence,
            1 - repeated_slop,
        ]
    )
    return {
        "score": round(quality, 4),
        "generic_structure": round(generic_structure, 4),
        "product_specificity": round(product_specificity, 4),
        "reference_adherence": round(reference_adherence, 4),
        "repeated_slop": round(repeated_slop, 4),
        "generic_hits": generic_hits,
        "slop_hits": slop_hits,
    }


def measure(candidate_path: Path, fixtures_path: Path = DEFAULT_FIXTURES) -> dict[str, Any]:
    candidate = load_json(candidate_path)
    fixtures = load_json(fixtures_path)
    artifacts = candidate.get("artifacts", {})
    modalities = fixtures["modalities"]
    missing = sorted(set(modalities) - set(artifacts))
    extra = sorted(set(artifacts) - set(modalities))
    if missing or extra:
        raise ValueError(f"candidate modalities mismatch: missing={missing} extra={extra}")

    scores = {
        modality: score_artifact(str(artifacts[modality]), fixture)
        for modality, fixture in modalities.items()
    }
    aggregate = sum(item["score"] for item in scores.values()) / len(scores)
    passed = sum(1 for item in scores.values() if item["score"] >= 0.75)
    return {
        "schema": "atris.taste_scorecard.v1",
        "candidate": candidate_path.name,
        "score": round(aggregate, 4),
        "passed": passed,
        "total": len(scores),
        "status": "pass" if passed == len(scores) else "fail",
        "modalities": scores,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Score one cross-modal taste candidate.")
    parser.add_argument("--candidate", default=str(DEFAULT_CANDIDATE))
    parser.add_argument("--fixtures", default=str(DEFAULT_FIXTURES))
    args = parser.parse_args()
    payload = measure(Path(args.candidate).resolve(), Path(args.fixtures).resolve())
    print(json.dumps(payload, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
