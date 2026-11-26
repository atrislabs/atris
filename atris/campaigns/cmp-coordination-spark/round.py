"""Run the coordination regressions and a reproducible, newly ordered workload."""

import argparse
from collections import Counter
import os
from pathlib import Path
import random
import secrets
import subprocess
import sys
from tempfile import TemporaryDirectory

from judge import Fixture, require


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]


def discovery(swarlo, seed):
    rng = random.Random(seed)
    members = ("reviewer", "second")
    intents = [(who, f"intent-{i}") for who in members for i in range(4)]
    deliveries = intents * 3
    rng.shuffle(deliveries)
    restart_at = set(rng.sample(range(1, len(deliveries)), 2))
    with TemporaryDirectory(prefix="atris-coordination-discovery-") as scratch:
        f = Fixture(Path(scratch), ROOT, swarlo)
        try:
            f.start()
            f.register("coordinator")
            for member in members:
                f.register(member, "coordinator")
            thread = f.thread("Review the same statement independently")
            receipts = {}
            for index, intent in enumerate(deliveries):
                member, key = intent
                if index in restart_at:
                    f.start()
                body = {"content": "Reviewed the same statement", "idempotency_key": key}
                code, reply = f.http(thread + "/once", body, member)
                expected_code = 200 if intent in receipts else 201
                require(code == expected_code, f"step {index} expected HTTP {expected_code}, received {code}")
                require(reply["member_id"] == member, f"step {index} changed the author")
                if intent in receipts:
                    require(reply["reply_id"] == receipts[intent], f"step {index} changed the receipt")
                receipts[intent] = reply["reply_id"]
            actor, used_key = rng.choice(intents)
            code, _ = f.http(thread + "/once", {"content": "Changed statement", "idempotency_key": used_key}, actor)
            require(code == 409, f"changed request under a used key returned HTTP {code}")
            rows = f.replies(thread)
            expected = Counter((member, receipt) for (member, _), receipt in receipts.items())
            visible = Counter((row["member_id"], row["reply_id"]) for row in rows)
            extras = sum((visible - expected).values())
            missing = sum((expected - visible).values())
            require(len(set(receipts.values())) == len(intents), "distinct intents received the same ID")
            require(not extras and not missing, f"unexpected effects {extras}, missing effects {missing}")
            print(f"seed {seed}: {len(deliveries)} attempts, {len(intents)} intended replies, "
                  f"{len(rows)} visible, unexpected {extras}, missing {missing}", flush=True)
        finally:
            f.stop()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", type=int, help="repeat the ordering of a previous round")
    parser.add_argument("--swarlo-root", type=Path, default=os.getenv("SWARLO_ROOT"))
    args = parser.parse_args()
    common = subprocess.check_output(["git", "-C", str(ROOT), "rev-parse", "--path-format=absolute",
                                      "--git-common-dir"], text=True).strip()
    swarlo = (args.swarlo_root or Path(common).parent.parent / "swarlo").resolve()
    seed = args.seed if args.seed is not None else secrets.randbits(32)
    print(f"replay this workload with --seed {seed}", flush=True)
    passed = 0
    commands = (
        [sys.executable, "-B", str(HERE / "judge.py"), "--swarlo-root", str(swarlo)],
        [sys.executable, "-B", str(HERE / "challenge.py"), "--swarlo-root", str(swarlo)],
        ["node", "--test", "test/element-complete-replay.test.js", "test/fleet-keyed-report.test.js"],
    )
    for cmd in commands:
        passed += subprocess.run(cmd, cwd=ROOT).returncode == 0
    try:
        discovery(swarlo, seed)
        passed += 1
    except Exception as exc:
        print(f"discovery failed: {exc}", flush=True)
    print(f"replay this workload with --seed {seed}")
    # The campaign reads the final TAP summary and an explicit overall score.
    # Inner test runners also report counts, which describe a single group.
    print(f"reading: {passed / 4}")
    print(f"# pass {passed}")
    print(f"# fail {4 - passed}")
    return int(passed < 4)


if __name__ == "__main__":
    sys.exit(main())
