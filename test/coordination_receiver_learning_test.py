"""Check the daily campaign's retained evidence against a disposable Swarlo receiver."""
from contextlib import closing
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
CAMPAIGN = ROOT / "atris/campaigns/cmp-coordination-spark"
sys.path.insert(0, str(CAMPAIGN))
import round as campaign
from counterexamples import evaluate, load_case


def swarlo_root():
    if path := os.environ.get("SWARLO_ROOT"):
        return Path(path).resolve()
    common = subprocess.check_output(
        ["git", "-C", str(ROOT), "rev-parse", "--path-format=absolute", "--git-common-dir"], text=True
    ).strip()
    return Path(common).parent.parent / "swarlo"


class ReceiverLearningTests(unittest.TestCase):
    def test_persisted_content_failure_is_confirmed_and_replayed_before_new_work(self):
        receiver = swarlo_root()
        original, new, unavailable = [campaign.workload(seed) for seed in (730281, 730282, 730283)]
        fault_databases = []

        class WrongStoredContent(campaign.Fixture):
            def register(self, name, sponsor=None):
                super().register(name, sponsor)
                if name == "coordinator":
                    path = self.base / "hub.db"
                    # Mutation lives only in this fixture's receiver. Leave its actual
                    # acknowledgement and saved delivery receipt intact for the oracle.
                    with closing(sqlite3.connect(path)) as db:
                        db.executescript("""
                            CREATE TRIGGER wrong_stored_reply AFTER INSERT ON replies BEGIN
                                UPDATE replies SET content='Different stored text' WHERE reply_id=NEW.reply_id;
                            END;
                        """)
                    fault_databases.append(path)

        with TemporaryDirectory() as scratch:
            corpus = Path(scratch) / "cases.sqlite3"
            attempts = []

            def observe(manifest):
                attempts.append(manifest)
                campaign.observe(receiver, manifest)

            with patch.object(campaign, "Fixture", WrongStoredContent):
                failures = evaluate(original, observe, database=corpus)
            self.assertEqual(attempts, [original, original])
            self.assertEqual(len(set(fault_databases)), 2)
            self.assertEqual([(r["kind"], r.get("code")) for r in failures], [("mismatch", "persisted_content")])
            case_id = failures[0]["case_id"]
            self.assertEqual(load_case(corpus, case_id), original)

            attempts.clear()
            recovered = evaluate(new, observe, database=corpus)
            self.assertEqual(attempts, [original, new])
            self.assertEqual([(r["source"], r["kind"]) for r in recovered], [("retained", "pass"), ("candidate", "pass")])
            self.assertEqual(recovered[0]["case_id"], case_id)
            self.assertNotIn("case_id", recovered[1])

            def observe_with_missing_checkout(manifest):
                checkout = Path(scratch) / "absent-swarlo" if manifest == unavailable else receiver
                campaign.observe(checkout, manifest)

            results = evaluate(unavailable, observe_with_missing_checkout, database=corpus)
            self.assertEqual([r["kind"] for r in results], ["pass", "setup"])
            with closing(sqlite3.connect(corpus)) as db:
                saved = db.execute("SELECT case_id, code FROM counterexamples").fetchall()
            self.assertEqual(saved, [(case_id, "persisted_content")])


if __name__ == "__main__":
    unittest.main()
