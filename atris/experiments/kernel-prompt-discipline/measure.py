"""External metric: prompt discipline + spine coverage for the Atris kernel.

Reads system_prompt.txt and scores it 0..1 (higher is better).

The score is MULTIPLICATIVE: discipline only counts if the behavioral spine is
fully preserved -- you cannot win by deleting the spine to look lean.

HONEST SCOPE (after adversarial review): this is a cheap, GAMEABLE regression
proxy, NOT an unfakeable verifier. It reliably catches the two honest failure
modes -- bloat and spine-gutting -- and resists trivial keyword salads. It does
NOT catch a coherent prompt that name-checks every marker while instructing the
opposite (negation defeats string matching), and it wrongly scores ~0 a good
prompt written in synonyms. Quality certification needs the model-in-the-loop
backend A/B. Use this as the CI pre-filter, not the judge.
"""

from __future__ import annotations

import json
import re
from pathlib import Path


EXPERIMENT_DIR = Path(__file__).resolve().parent
TARGET = EXPERIMENT_DIR / "system_prompt.txt"
WORD_BUDGET = 950

def _tok(t: str, *words: str) -> bool:
    # Whole-token match: kills substring false hits like "unbounded"/"inhuman".
    return all(re.search(r"(?<!\w)" + re.escape(w) + r"(?!\w)", t) for w in words)


# The 7 behavioral spine markers. Each must survive or coverage drops.
SPINE = {
    "core_loop": lambda t: _tok(t, "verification", "receipt", "bounded"),
    "authority_tiers": lambda t: _tok(t, "authority", "agent", "gray", "human"),
    "task_schema": lambda t: _tok(t, "rollback", "exit"),
    "preflight_falsifiable": lambda t: _tok(t, "rubric-not-falsifiable") or _tok(t, "falsifiable"),
    "receipts": lambda t: _tok(t, "receipt"),
    "failure_smells": lambda t: _tok(t, "reward hacking") or _tok(t, "failure smell"),
    "heartbeat": lambda t: _tok(t, "heartbeat_ok"),
}

# Grand aspirational filler that changes zero tokens of behavior on a real task.
ASPIRATION = (
    "kardashev", "civilization", "flourish", "must serve", "compounding agency",
    "infrastructure sovereignty", "network operating intelligence",
)


def clamp(x: float) -> float:
    return max(0.0, min(1.0, x))


def is_caps_line(line: str) -> bool:
    letters = [c for c in line if c.isalpha()]
    if len(letters) < 4:
        return False
    return sum(c.isupper() for c in letters) / len(letters) > 0.8


def main() -> int:
    raw = TARGET.read_text(encoding="utf-8")
    t = raw.lower()
    words = len(raw.split())
    lines = [ln for ln in raw.splitlines() if ln.strip()]

    spine_hits = {k: bool(fn(t)) for k, fn in SPINE.items()}
    coverage = sum(spine_hits.values()) / len(SPINE)

    brevity = clamp(1 - max(0, words - WORD_BUDGET) / WORD_BUDGET)
    aspiration_hits = sum(t.count(a) for a in ASPIRATION)
    low_aspiration = 1.0 / (1.0 + aspiration_hits)
    caps_ratio = sum(is_caps_line(ln) for ln in lines) / max(1, len(lines))
    low_caps = clamp(1 - caps_ratio * 6)
    has_precedence = 1.0 if any(
        p in t for p in ("precedence", "defaults, not laws", "override when the task")
    ) else 0.0
    no_roadmap_bloat = 0.0 if ("kardashev" in t or "roadmap spine" in t) else 1.0
    no_psychoanalysis = 0.0 if "spiraling" in t else 1.0

    discipline_parts = {
        "brevity": round(brevity, 4),
        "low_aspiration": round(low_aspiration, 4),
        "low_caps": round(low_caps, 4),
        "has_precedence": has_precedence,
        "no_roadmap_bloat": no_roadmap_bloat,
        "no_psychoanalysis": no_psychoanalysis,
    }
    discipline = sum(discipline_parts.values()) / len(discipline_parts)

    # Substance gate: block padding/salad WITHOUT punishing genuinely lean
    # prompts. Vocabulary diversity (distinct content words), not raw length,
    # is the signal -- "blah"x270 and one-line salads fail, a tight 150-word
    # kernel passes. Count any markdown header, not just level-2. (This raises
    # the bar on padding; it does not make the metric unfakeable -- see scope.)
    distinct = len({w for w in re.findall(r"[a-z][a-z-]{2,}", t)})
    headers = sum(1 for ln in lines if ln.lstrip().startswith("#"))
    substance_ok = distinct >= 80 and headers >= 5
    gate = 1.0 if (coverage == 1.0 and substance_ok) else 0.2
    score = round(gate * coverage * discipline, 4)

    payload = {
        "score": score,
        "words": words,
        "spine_coverage": round(coverage, 4),
        "spine": spine_hits,
        "discipline": round(discipline, 4),
        "discipline_parts": discipline_parts,
        "headers": headers,
        "distinct_words": distinct,
        "substance_ok": substance_ok,
        "gate": gate,
        "status": "pass" if (coverage == 1.0 and substance_ok) else "incomplete",
    }
    print(json.dumps(payload))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
