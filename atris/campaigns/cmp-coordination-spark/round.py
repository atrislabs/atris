"""Run the coordination regressions and a reproducible, newly ordered workload."""

import argparse
import json
from collections import Counter
import os
from pathlib import Path
import random
import secrets
import sqlite3
import subprocess
import sys
from tempfile import TemporaryDirectory

from counterexamples import Mismatch, evaluate, load_case
from judge import Fixture, require


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]


def workload(seed):
    rng = random.Random(seed)
    members = ("reviewer", "second")
    intents = [[who, f"intent-{i}"] for who in members for i in range(4)]
    deliveries = intents * 3
    rng.shuffle(deliveries)
    return {
        "version": 1, "seed": seed, "deliveries": deliveries,
        "restart_before": sorted(rng.sample(range(1, len(deliveries)), 2)),
        "conflict": rng.choice(intents), "body": "Reviewed the same statement",
        "changed_body": "Changed statement", "thread": "Review the same statement independently",
    }


def observe(swarlo, manifest):
    require(manifest["version"] == 1, "unsupported workload version")
    body = manifest["body"]
    deliveries = manifest["deliveries"]
    intended = {tuple(intent) for intent in deliveries}
    violations = []

    def expect(condition, code, detail):
        if not condition:
            violations.append((code, detail))

    with TemporaryDirectory(prefix="atris-coordination-discovery-") as scratch:
        f = Fixture(Path(scratch), ROOT, swarlo)
        try:
            f.start()
            api = f.setup_api("/openapi.json")
            require("/api/{hub_id}/posts/{post_id}/replies/once" in api["paths"],
                    "receiver lacks the keyed reply route")
            f.register("coordinator")
            thread = f.thread(manifest["thread"])
            post_id = thread.split("/")[-2]
            for member in sorted({who for who, _ in intended}):
                f.register(member, "coordinator")
                require(f.setup_api(thread, actor=member)["replies"] == [],
                        "authenticated thread control failed")
            receipts = {}
            attempted = set()
            for index, (member, key) in enumerate(deliveries):
                intent = (member, key)
                if index in manifest["restart_before"]:
                    f.start()
                status, reply = f.http(thread + "/once", {"content": body, "idempotency_key": key}, member)
                require(status < 500, f"receiver unavailable at step {index}: HTTP {status}")
                expected_status = 200 if intent in attempted else 201
                attempted.add(intent)
                expect(status == expected_status, "delivery_status",
                       f"step {index} expected HTTP {expected_status}, received {status}")
                if status not in (200, 201):
                    continue
                for field, value in (("member_id", member), ("content", body), ("post_id", post_id)):
                    expect(reply.get(field) == value, "receipt_" + field, f"step {index} returned wrong {field}")
                receipt = reply.get("reply_id")
                expect(isinstance(receipt, str) and bool(receipt), "receipt_id", f"step {index} lacks a receipt")
                if isinstance(receipt, str) and receipt:
                    original = receipts.setdefault(intent, receipt)
                    expect(receipt == original, "receipt_changed", f"step {index} changed the receipt")
            actor, used_key = manifest["conflict"]
            status, _ = f.http(thread + "/once", {"content": manifest["changed_body"],
                                                  "idempotency_key": used_key}, actor)
            require(status < 500, f"receiver unavailable during conflict check: HTTP {status}")
            expect(status == 409, "conflict_accepted", f"changed request under a used key returned HTTP {status}")
            rows = f.replies(thread)
            expect(len(set(receipts.values())) == len(intended), "intent_identity",
                   "distinct intended messages did not receive distinct receipts")
            expected = Counter((post_id, member, body, receipt) for (member, _), receipt in receipts.items())
            authors = {receipt: member for (member, _), receipt in receipts.items()}
            for row in rows:
                if row.get("reply_id") in authors:
                    for field, value in (("post_id", post_id), ("content", body),
                                         ("member_id", authors[row["reply_id"]])):
                        expect(row.get(field) == value, "persisted_" + field, f"receiver stored wrong {field}")
            visible = Counter((r.get("post_id"), r.get("member_id"), r.get("content"), r.get("reply_id")) for r in rows)
            extras = sum((visible - expected).values())
            missing = sum((expected - visible).values())
            expect(not extras, "unexpected_delivery", f"unexpected effects {extras}")
            expect(not missing, "missing_delivery", f"missing effects {missing}")
            if violations:
                raise Mismatch(*violations[0])
            print(f"seed {manifest['seed']}: {len(deliveries)} attempts, {len(intended)} intended replies, "
                  f"{len(rows)} visible, unexpected {extras}, missing {missing}", flush=True)
        finally:
            f.stop()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    replay = parser.add_mutually_exclusive_group()
    replay.add_argument("--seed", type=int, help="repeat the ordering of a previous round")
    replay.add_argument("--replay-case", help="exercise the original saved operations of one confirmed case")
    parser.add_argument("--swarlo-root", type=Path, default=os.getenv("SWARLO_ROOT"))
    parser.add_argument("--corpus", type=Path, help="store and replay confirmed failing workloads")
    args = parser.parse_args()
    common = subprocess.check_output(["git", "-C", str(ROOT), "rev-parse", "--path-format=absolute",
                                      "--git-common-dir"], text=True).strip()
    swarlo = (args.swarlo_root or Path(common).parent.parent / "swarlo").resolve()
    database = args.corpus or ROOT / ".atris/state/coordination-watch/counterexamples.sqlite3"
    if args.replay_case:
        try:
            manifest = load_case(database, args.replay_case)
        except (OSError, ValueError, sqlite3.Error) as exc:
            parser.error(str(exc))
        if manifest is None:
            parser.error("no confirmed workload has that case identifier")
    else:
        manifest = workload(args.seed if args.seed is not None else secrets.randbits(32))
    seed = manifest["seed"]
    print(f"replay this workload with --seed {seed}", flush=True)
    passed = 0
    commands = (
        [sys.executable, "-B", str(HERE / "judge.py"), "--swarlo-root", str(swarlo)],
        [sys.executable, "-B", str(HERE / "challenge.py"), "--swarlo-root", str(swarlo)],
        ["node", "--test", "test/element-complete-replay.test.js", "test/fleet-keyed-report.test.js"],
        [sys.executable, "-B", str(HERE / "join.py")],
    )
    for cmd in commands:
        passed += subprocess.run(cmd, cwd=ROOT).returncode == 0
    corpus = database if not args.replay_case and (args.corpus or args.seed is None) else None
    results = evaluate(manifest, lambda case: observe(swarlo, case), database=corpus)
    issues = [result for result in results if result["kind"] != "pass"]
    for result in issues:
        print(f"{result['source']} seed {result['seed']}: {result['kind']}: {result['detail']}", flush=True)
    passed += not issues
    print("coordination issues " + json.dumps([{k: result[k] for k in ("seed", "kind", "source", "case_id") if k in result}
                                              for result in issues]))
    print(f"replay this workload with --seed {seed}")
    # The campaign reads the final TAP summary and an explicit overall score.
    # Inner test runners also report counts, which describe a single group.
    total = len(commands) + 1
    print(f"reading: {passed / total}")
    print(f"# pass {passed}")
    print(f"# fail {total - passed}")
    return int(passed < total)


if __name__ == "__main__":
    sys.exit(main())
