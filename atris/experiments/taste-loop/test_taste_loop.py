"""Focused regression tests for the learned taste loop."""

from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest


EXPERIMENT_DIR = Path(__file__).resolve().parent

from loop import KEEP_MARGIN, evaluate_proposal, should_keep
from measure import measure


class TasteLoopTest(unittest.TestCase):
    def setUp(self) -> None:
        self.baseline = measure(EXPERIMENT_DIR / "baseline.json")

    def test_fixtures_have_positive_and_rejected_references(self) -> None:
        fixtures = json.loads((EXPERIMENT_DIR / "fixtures.json").read_text(encoding="utf-8"))
        self.assertEqual(set(fixtures["modalities"]), {"writing", "website", "video_prompt"})
        for fixture in fixtures["modalities"].values():
            self.assertTrue(fixture["positive_reference"])
            self.assertTrue(fixture["rejected_reference"])

    def test_one_modality_improvement_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            target = Path(temp_dir) / "candidate.json"
            target.write_bytes((EXPERIMENT_DIR / "baseline.json").read_bytes())
            status, measured, _ = evaluate_proposal(
                EXPERIMENT_DIR / "proposals" / "regression.py",
                target,
                self.baseline,
                dry_run=True,
            )
        self.assertEqual(status, "would_revert")
        self.assertGreater(measured["modalities"]["writing"]["score"], self.baseline["modalities"]["writing"]["score"])

    def test_reference_first_candidate_clears_every_margin(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            target = Path(temp_dir) / "candidate.json"
            target.write_bytes((EXPERIMENT_DIR / "baseline.json").read_bytes())
            status, measured, _ = evaluate_proposal(
                EXPERIMENT_DIR / "proposals" / "reference_first.py",
                target,
                self.baseline,
                dry_run=True,
            )
        self.assertEqual(status, "would_keep")
        self.assertTrue(should_keep(self.baseline, measured, KEEP_MARGIN))
        self.assertEqual(measured["status"], "pass")


if __name__ == "__main__":
    unittest.main()
