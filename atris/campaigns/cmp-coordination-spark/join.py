#!/usr/bin/env python3
"""Judge a pinned two-repository Fleet verification using disposable Git repositories."""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
from tempfile import TemporaryDirectory


ROOT = Path(__file__).resolve().parents[2].parent


def require(condition, reason):
    if not condition:
        raise AssertionError(reason)


def git(repo, env, *args):
    return subprocess.run(["git", "-C", str(repo), *args], check=True, env=env,
                          capture_output=True, text=True, timeout=15).stdout.strip()


def commit_contract(repo, env, field, label):
    (repo / "contract.json").write_text(json.dumps({"field": field, "label": label}))
    git(repo, env, "add", ".")
    git(repo, env, "commit", "-qm", label)
    return git(repo, env, "rev-parse", "HEAD")


def prepare_repos(base, env, witness):
    # The witness is independent of the CLI's reported exit codes and cache flags.
    # Each invoked check appends one small row, including the bytes it actually read.
    read_and_record = (
        "const fs = require('node:fs');\n"
        "const path = require('node:path');\n"
        "const read = dir => JSON.parse(fs.readFileSync(path.join(dir, 'contract.json'), 'utf8'));\n"
        f"const record = row => fs.appendFileSync({json.dumps(str(witness))}, JSON.stringify(row) + '\\n');\n"
    )
    for name in ("cli", "backend"):
        repo = base / name
        repo.mkdir()
        git(repo, env, "init", "-q")
        git(repo, env, "config", "user.name", "Fleet fixture")
        git(repo, env, "config", "user.email", "fixture@example.invalid")
        (repo / "check.js").write_text(
            read_and_record + f"const contract = read(process.cwd());\nrecord(['{name}', contract]);\n"
            "process.exit(typeof contract.field === 'string' && contract.field.length > 0 ? 0 : 19);\n"
        )
    (base / "cli/joint.js").write_text(
        read_and_record + "const client = read(process.cwd());\nconst server = read(process.argv[2]);\n"
        "record(['joint', client, server]);\nprocess.exit(client.field === server.field ? 0 : 23);\n"
    )
    client = commit_contract(base / "cli", env, "receipt_id", "client-pinned")
    old = commit_contract(base / "backend", env, "id", "server-incompatible")
    return client, old


def receipt_rows(witness):
    if not witness.exists():
        return []
    return [json.loads(line) for line in witness.read_text().splitlines()]


def check_observed(rows, client, server, *, targets):
    expected = {"joint": [client, server]}
    if targets:
        expected.update(cli=[client], backend=[server])
    require(len(rows) == len(expected), f"expected executions {list(expected)}, saw {rows}")
    require({r[0]: r[1:] for r in rows} == expected, f"executed checks read different pinned inputs: {rows}")


def run_cli(binary, manifest, coordinator, env, pins, joint_exit, *, retry=False):
    cmd = [str(binary), "fleet", "verify", str(manifest), "--json"]
    if retry:
        cmd.append("--retry-failed")
    run = subprocess.run(cmd, cwd=coordinator, env=env, capture_output=True, text=True, timeout=90)
    try:
        result = json.loads(run.stdout)
    except ValueError:
        clue = (run.stderr.strip() or run.stdout.strip() or "no output").splitlines()[0]
        raise AssertionError(f"fleet verify returned no JSON receipt (exit {run.returncode}): {clue}") from None
    require(isinstance(result, dict) and result.get("ok") is (joint_exit == 0), "wrong overall receipt")
    require((run.returncode == 0) == (joint_exit == 0), f"wrong command exit {run.returncode}")
    require(isinstance(result.get("manifest_id"), str) and result["manifest_id"], "missing manifest identity")
    targets = result.get("targets", [])
    require(len(targets) == len(pins) and {t["name"] for t in targets} == set(pins), "missing target receipts")
    for t in targets:
        require(t["revision"] == pins[t["name"]] and t["state"] == "passed" and t["exit_code"] == 0,
                f"incorrect target revision or exit: {t['name']}")
    joint = result["joint"]
    require(joint["state"] == ("passed" if not joint_exit else "failed") and joint["exit_code"] == joint_exit,
            f"joint did not preserve the contract exit {joint_exit}")
    return result


def cache_flags(receipt, *, target, joint):
    require(all(t.get("cached") is target for t in receipt["targets"]), "unexpected target cache flags")
    require(receipt["joint"].get("cached") is joint, "unexpected joint cache flag")


def exercise(binary, passed):
    with TemporaryDirectory(prefix="atris-fleet-join-") as directory, socket.socket() as sink:
        tmp = Path(directory)
        home, base, coordinator = (tmp / name for name in ("home", "sources", "coordinator"))
        for folder in (home, base, coordinator):
            folder.mkdir()
        # An older binary might try its default Swarlo handler. Reserve a closed
        # loopback port so it can never reach a configured or running hub.
        sink.bind(("127.0.0.1", 0))
        env = {"HOME": str(home), "PATH": os.environ["PATH"], "GIT_CONFIG_NOSYSTEM": "1",
               "GIT_TERMINAL_PROMPT": "0", "SWARLO_SERVER": f"http://127.0.0.1:{sink.getsockname()[1]}"}
        witness = tmp / "executions.jsonl"
        cli_revision, bad_revision = prepare_repos(base, env, witness)
        manifest = base / "verification.json"
        document = {
            "version": 1, "timeout_seconds": 30, "parallel": 2,
            "targets": [{"name": name, "repo": "./" + name, "revision": pin, "verify": ["node", "check.js"]}
                        for name, pin in (("cli", cli_revision), ("backend", bad_revision))],
            "joint": {"cwd": "cli", "verify": ["node", "joint.js", "{repo:backend}"]},
        }
        manifest.write_text(json.dumps(document))
        pins = {"cli": cli_revision, "backend": bad_revision}
        def contents(repo, pin):
            return json.loads(git(base / repo, env, "show", f"{pin}:contract.json"))

        client, before = contents("cli", cli_revision), contents("backend", bad_revision)
        # The checked-out files differ from the requested inputs.
        commit_contract(base / "cli", env, "decoy", "client-later")
        first = run_cli(binary, manifest, coordinator, env, pins, 23)
        cache_flags(first, target=False, joint=False)
        rows = receipt_rows(witness)
        check_observed(rows, client, before, targets=True)
        passed("two individually passing revisions fail their shared contract")

        again = run_cli(binary, manifest, coordinator, env, pins, 23, retry=True)
        require(again["manifest_id"] == first["manifest_id"], "retry changed manifest identity")
        cache_flags(again, target=True, joint=False)
        check_observed(receipt_rows(witness)[len(rows):], client, before, targets=False)
        passed("retry reuses both passing checks and reruns the failed joint check")

        compatible = commit_contract(base / "backend", env, "receipt_id", "server-compatible")
        commit_contract(base / "backend", env, "decoy", "server-later")
        document["targets"][1]["revision"] = pins["backend"] = compatible
        manifest.write_text(json.dumps(document))
        after = contents("backend", compatible)
        previous = len(receipt_rows(witness))
        repaired = run_cli(binary, manifest, coordinator, env, pins, 0)
        require(repaired["manifest_id"] != first["manifest_id"], "changed revision reused the old manifest identity")
        cache_flags(repaired, target=False, joint=False)
        check_observed(receipt_rows(witness)[previous:], client, after, targets=True)
        passed("new compatible revision passes on the exact two pinned inputs")

        previous = receipt_rows(witness)
        recovered = run_cli(binary, manifest, coordinator, env, pins, 0)
        require(recovered["manifest_id"] == repaired["manifest_id"], "recovery changed the manifest identity")
        cache_flags(recovered, target=True, joint=True)
        require(receipt_rows(witness) == previous, "completed work ran again on recovery")
        passed("reopening verified work returns its receipts without rerunning checks")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--atris-bin", type=Path, default=ROOT / "bin/atris")
    args = parser.parse_args()
    count = 0

    def passed(name):
        nonlocal count
        count += 1
        print(f"pass | {name}", flush=True)

    try:
        exercise(args.atris_bin.resolve(), passed)
    except Exception as error:
        print(f"fail | {error}", flush=True)
    print(f"# pass {count}")
    print(f"# fail {4 - count}")
    return 0 if count == 4 else 1


if __name__ == "__main__":
    sys.exit(main())
