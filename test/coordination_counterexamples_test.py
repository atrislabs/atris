"""Regression checks for the standing coordination watch's retained workloads."""
import json
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
from pathlib import Path
import sqlite3
import subprocess
import sys
from tempfile import TemporaryDirectory
from threading import Barrier
import unittest

CAMPAIGN = Path(__file__).resolve().parents[1] / "atris/campaigns/cmp-coordination-spark"
sys.path.insert(0, str(CAMPAIGN))
from counterexamples import Mismatch, evaluate, load_case


def workload(seed):
    return {"schema": 1, "seed": seed, "deliveries": [["reviewer", "one"], ["reviewer", "one"]]}


def repeatable(manifest):
    raise Mismatch("extra_reply", f"seed {manifest['seed']} had two receiver rows")


class CounterexampleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.database = Path(self.tmp.name) / "cases.sqlite"

    def test_case_is_confirmed_then_replayed_after_process_restart_and_recovery(self):
        first = evaluate(workload(81), repeatable, self.database)
        self.assertEqual([(r["kind"], r["code"]) for r in first], [("mismatch", "extra_reply")])

        program = """
import json, sys
from counterexamples import evaluate
def observe(m):
    return "read " + str(len(m["deliveries"])) + " steps"
print(json.dumps(evaluate({"seed": 82, "deliveries": []}, observe, sys.argv[1])))
"""
        result = subprocess.run([sys.executable, "-B", "-c", program, str(self.database)],
                                cwd=CAMPAIGN, check=True, text=True, capture_output=True)
        replayed = json.loads(result.stdout)
        self.assertEqual([(r["source"], r["seed"], r["kind"], r["detail"]) for r in replayed],
                         [("retained", 81, "pass", "read 2 steps"), ("candidate", 82, "pass", "read 0 steps")])
        later = evaluate(workload(83), repeatable, self.database)
        self.assertEqual([(r["seed"], r["kind"]) for r in later], [(81, "mismatch"), (83, "mismatch")])

    def test_fixture_errors_and_flapping_mismatches_are_never_promoted(self):
        failures = [
            ([OSError("server unavailable")], "setup"),
            ([Mismatch("lost", "first"), OSError("server unavailable")], "setup"),
            ([Mismatch("lost", "first"), None], "inconclusive"),
            ([Mismatch("lost", "first"), Mismatch("wrong_author", "second")], "inconclusive"),
        ]
        for seed, (outcomes, expected) in enumerate(failures):
            def observe(manifest):
                result = outcomes.pop(0)
                if result is not None:
                    raise result
            self.assertEqual([r["kind"] for r in evaluate(workload(seed), observe, self.database)],
                             [expected])
            self.assertEqual(outcomes, [])
        self.assertEqual([r["seed"] for r in evaluate(workload(99), lambda m: None, self.database)], [99])

    def test_each_observation_has_its_own_unmodified_manifest(self):
        original = workload(7)
        observations = []
        def mutate(m):
            observations.append(len(m["deliveries"]))
            m["deliveries"].clear()
            raise Mismatch(" Extra_Reply ", "different receipt identities each time")
        out = evaluate(original, mutate, self.database)
        self.assertEqual(out[0]["code"], "extra_reply")
        self.assertEqual(observations, [2, 2])
        self.assertEqual(original, workload(7))

    def test_concurrent_confirmation_retains_the_canonical_manifest_once(self):
        barrier = Barrier(2)
        def writer(m):
            def observe(_):
                barrier.wait(timeout=5)
                raise Mismatch("lost", "receiver has zero rows")
            return evaluate(m, observe, self.database, replay_limit=0)
        first = workload(13)
        reordered = dict(reversed(list(first.items())))
        with ThreadPoolExecutor(2) as pool:
            outputs = list(pool.map(writer, [first, reordered]))
        self.assertEqual([out[0]["kind"] for out in outputs], ["mismatch", "mismatch"])
        self.assertEqual([r["seed"] for r in evaluate(workload(14), lambda _: None, self.database)], [13, 14])

    def test_bounded_replay_rotates_and_skips_the_current_manifest(self):
        for seed in (1, 2, 3):
            evaluate(workload(seed), repeatable, self.database, replay_limit=0)
        def probe(seed):
            return [r["seed"] for r in evaluate(workload(seed), lambda _: None,
                                                self.database, replay_limit=1)]
        self.assertEqual(probe(10), [1, 10])
        self.assertEqual(probe(11), [2, 11])
        self.assertEqual(probe(3), [1, 3])
        self.assertEqual(probe(12), [2, 12])

    def test_plain_exception_cannot_promote_and_broken_storage_fails_visibly(self):
        def unreadable(_):
            raise KeyError("reply rows")
        out = evaluate({"seed": 12}, unreadable)
        self.assertEqual([r["kind"] for r in out], ["setup"])
        broken = Path(self.tmp.name) / "directory"
        broken.mkdir()
        out = evaluate(workload(10), lambda _: None, broken)
        self.assertEqual([r["kind"] for r in out], ["setup"])

    def test_different_ordered_workloads_with_the_same_seed_remain_distinct(self):
        first = workload(21)
        second = workload(21)
        second["deliveries"][1][1] = "two"
        for m in (first, second):
            evaluate(m, repeatable, self.database, replay_limit=0)
        recovered = evaluate(workload(22), lambda m: m["deliveries"][-1][1], self.database)
        self.assertEqual([(r["seed"], r["detail"]) for r in recovered],
                         [(21, "one"), (21, "two"), (22, "one")])

    def test_exact_id_replays_original_manifest_after_generator_changes(self):
        original = workload(42)
        promoted = evaluate(original, repeatable, self.database)[0]
        encoded = json.dumps(original, separators=(",", ":"), sort_keys=True).encode("utf-8")
        case_id = sha256(encoded).hexdigest()
        self.assertEqual(promoted["case_id"], case_id)
        now_generated = {**original, "deliveries": [["new reviewer", "different action"]]}
        readings = evaluate(now_generated, lambda _: None, self.database)
        self.assertEqual(readings[0]["case_id"], case_id)
        self.assertNotIn("case_id", readings[1])
        exact = load_case(self.database, case_id)
        self.assertEqual(exact, original)
        self.assertNotEqual(exact, now_generated)
        self.assertIsNone(load_case(self.database, case_id[:10]))
        receiver_saw = []
        rechecked = evaluate(exact, receiver_saw.append, self.database)
        self.assertEqual(receiver_saw, [original])
        self.assertEqual(rechecked[0]["case_id"], case_id)

    def test_existing_cases_can_be_read_before_and_after_store_upgrade(self):
        old = workload(8)
        encoded = json.dumps(old, separators=(",", ":"), sort_keys=True)
        case_id = sha256(encoded.encode()).hexdigest()
        db = sqlite3.connect(self.database)
        try:
            db.execute("CREATE TABLE counterexamples(manifest TEXT PRIMARY KEY, code TEXT, detail TEXT, last_exercised INT)")
            db.execute("INSERT INTO counterexamples VALUES(?, 'lost', 'missing receiver row', 1)", (encoded,))
            db.commit()
        finally:
            db.close()
        self.assertEqual(load_case(self.database, case_id), old)
        self.assertEqual(evaluate(workload(9), lambda _: None, self.database)[0]["case_id"], case_id)
        self.assertEqual(load_case(self.database, case_id), old)


if __name__ == "__main__":
    unittest.main()
