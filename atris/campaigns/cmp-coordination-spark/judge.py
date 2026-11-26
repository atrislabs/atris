#!/usr/bin/env python3
"""Exercise the public local handoff in scratch stores; never contact a configured hub."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
from tempfile import TemporaryDirectory
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def require(condition, detail):
    if not condition:
        raise RuntimeError(detail)


class Score:
    def __init__(self):
        self.passed = self.false_accepts = self.misses = self.errors = 0

    def check(self, name, ok, observed, unsafe=False):
        if ok:
            self.passed += 1
            label = "pass"
        elif unsafe:
            self.false_accepts += 1
            label = "false accept"
        else:
            self.misses += 1
            label = "miss"
        print(f"{label} | {name} | {observed}", flush=True)

    def error(self, error):
        self.errors += 1
        print(f"setup or observation error | {error}", flush=True)

    def finish(self):
        failed = self.false_accepts + self.misses + self.errors
        print(f"false accepts {self.false_accepts}, misses {self.misses}, setup errors {self.errors}")
        print(f"pass {self.passed}, fail {failed}")
        return 1 if failed else 0


class Fixture:
    def __init__(self, base, atris, swarlo):
        self.base = base
        self.project = base / "project"
        self.project.mkdir()
        (self.project / "atris").mkdir()
        (self.project / "atris/atris.md").write_text("# Scratch workspace\n")
        self.bin = atris / "bin/atris"
        require(self.bin.is_file(), f"missing CLI under {atris}")
        require((swarlo / "swarlo/server.py").is_file(), f"missing Swarlo checkout under {swarlo}")
        private = base / "test-home"
        private.mkdir()
        self.env = {
            "PATH": os.environ["PATH"], "HOME": str(private), "USER": "fixture",
            "PYTHONPATH": str(swarlo), "PYTHONDONTWRITEBYTECODE": "1",
            "ATRIS_TASKS_DB": str(base / "tasks.db"), "ATRIS_FEED_BOARD": "0",
            "ATRIS_SKIP_UPDATE_CHECK": "1", "ATRIS_NO_INTERACTIVE": "1",
            "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1",
        }
        subprocess.run(["git", "init", "-q"], env=self.env, cwd=self.project, check=True)
        candidates = [os.getenv("SWARLO_PYTHON") or sys.executable]
        if shutil.which("pyenv") and not os.getenv("SWARLO_PYTHON"):
            found = subprocess.run(["pyenv", "which", "swarlo"], cwd=swarlo, text=True,
                                   capture_output=True, timeout=5)
            if found.returncode == 0:
                candidates.append(str(Path(found.stdout.strip()).parent / "python3"))
        self.python = None
        for executable in candidates:
            probe = self.run([executable, "-c", "import fastapi, uvicorn, swarlo; print(swarlo.__file__)"])
            if probe.returncode == 0 and Path(probe.stdout.strip()).resolve() == swarlo / "swarlo/__init__.py":
                self.python = executable
                break
        require(self.python, "Set SWARLO_PYTHON to Python with the Swarlo server dependencies")
        self.server = None
        self.keys = {}

    def run(self, args):
        return subprocess.run(args, env=self.env, cwd=self.project, capture_output=True,
                              text=True, timeout=30)

    def element(self, *args):
        result = self.run([str(self.bin), "element", *args, "--json"])
        require(result.stdout.strip(), f"Element {args[0]} emitted no JSON: {result.stderr[:200]}")
        return result.returncode, json.loads(result.stdout)

    def must_element(self, *args):
        code, value = self.element(*args)
        require(code == 0, f"Element {args[0]} returned {code}: {value}")
        return value

    def start(self):
        self.stop()
        boot = ("import sys, uvicorn; from swarlo.server import app,set_backend; "
                "from swarlo.sqlite_backend import SQLiteBackend; "
                "set_backend(SQLiteBackend(sys.argv[1])); "
                "uvicorn.run(app,fd=int(sys.argv[2]),log_level='error')")
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            self.url = f"http://127.0.0.1:{listener.getsockname()[1]}"
            self.server = subprocess.Popen([self.python, "-c", boot, str(self.base / "hub.db"),
                                            str(listener.fileno())], cwd=self.project, env=self.env,
                                           pass_fds=(listener.fileno(),), stdout=subprocess.DEVNULL,
                                           stderr=subprocess.DEVNULL)
        for _ in range(120):
            require(self.server.poll() is None, "Swarlo could not start")
            try:
                if self.http("/api/health", timeout=0.15)[0] == 200:
                    return
            except (URLError, TimeoutError, socket.timeout, ConnectionResetError):
                pass
            time.sleep(.05)
        raise RuntimeError("scratch Swarlo did not become healthy")

    def stop(self):
        if self.server is not None:
            self.server.terminate()
            try:
                self.server.wait(timeout=4)
            except subprocess.TimeoutExpired:
                self.server.kill()
                self.server.wait()
            self.server = None

    def http(self, path, data=None, actor=None, timeout=5):
        headers = {"Content-Type": "application/json"}
        if actor:
            headers["Authorization"] = f"Bearer {self.keys[actor]}"
        request = Request(self.url + path, headers=headers,
                          data=None if data is None else json.dumps(data).encode())
        try:
            response = urlopen(request, timeout=timeout)
        except HTTPError as error:
            response = error
        with response:
            return response.status, json.loads(response.read())

    def setup_api(self, path, data=None, actor=None):
        status, body = self.http(path, data, actor)
        require(status in (200, 201), f"fixture {path} returned {status}: {body}")
        return body

    def register(self, name, sponsor=None):
        body = self.setup_api("/api/register", {
            "hub_id": "trial", "member_id": name, "member_name": name,
            "member_type": "human" if sponsor is None else "agent",
        }, sponsor)
        self.keys[name] = body["api_key"]

    def thread(self, text):
        body = self.setup_api("/api/trial/channels/general/posts", {"content": text}, "coordinator")
        return f"/api/trial/posts/{body['post_id']}/replies"

    def replies(self, path):
        return self.setup_api(path, actor="reviewer")["replies"]

    def reply_cli(self, path, text, key=None):
        args = [self.python, "-m", "swarlo", "reply", path.split("/")[-2], text,
                "--server", self.url, "--hub", "trial", "--api-key", self.keys["reviewer"]]
        if key:
            args += ["--idempotency-key", key]
        return self.run(args)

    def events(self, card):
        result = self.run([str(self.bin), "element", "tail", "--limit", "100", "--json"])
        require(result.returncode == 0, "Element event reader failed")
        rows = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
        return [row for row in rows if row.get("type") == "result" and row.get("card_id") == card]

    def card(self, name):
        posted = self.must_element("task", name, "--as", "coordinator", "--to", "reviewer")
        card = posted["card_id"]
        claimed = self.must_element("claim", card, "--as", "reviewer")
        require(claimed["claimed"] and claimed["card"]["id"] == card, "claim bound the wrong card")
        return card

    def complete(self, card, actor="reviewer", proof="checked the repair"):
        return self.element("complete", card, "--as", actor, "--proof", proof,
                            "--verify", "sh verify.sh", "--lesson", "Check both destinations",
                            "Verified the repair")

    def visible_card(self, card):
        return self.must_element("receipt", card)


def keyed(f, route, key, body, actor="reviewer"):
    status, result = f.http(route + "/once", {**body, "idempotency_key": key}, actor)
    require(status in (200, 201, 403, 404, 409), f"unexpected HTTP {status} from {route}/once: {result}")
    return status, result


def reply_cases(f, score):
    control = f.thread("Independent thread for the CLI control")
    result = f.reply_cli(control, "Normal public CLI reply")
    require(result.returncode == 0, f"unkeyed public CLI failed: {result.stderr}")
    require([r["content"] for r in f.replies(control)] == ["Normal public CLI reply"],
            "normal public reply did not land on original thread")
    score.check("public unkeyed reply", True, "one reply by public CLI")
    repeated = f.reply_cli(control, "Normal public CLI reply")
    require(repeated.returncode == 0, "unkeyed repetition failed to reach Swarlo")
    print(f"legacy observation | two unkeyed sends | visible replies {len(f.replies(control))}")

    path = f.thread("Original repair request")
    data = {"content": "Verified the repair"}
    first_status, first = keyed(f, path, "receipt-A", data)
    f.start()
    replay_status, replay = keyed(f, path, "receipt-A", data)
    rows = f.replies(path)
    score.check("keyed reply survives a service restart", first_status == 201 and replay_status == 200
                and first.get("reply_id") == replay.get("reply_id") and len(rows) == 1
                and rows[0]["member_id"] == "reviewer" and rows[0]["post_id"] == path.split("/")[-2],
                f"HTTP {first_status}/{replay_status}, visible replies {len(rows)}", len(rows) > 1)
    changed, _ = keyed(f, path, "receipt-A", {"content": "Changed repair"})
    wrong, _ = keyed(f, path, "receipt-A", {**data, "member_id": "reviewer"}, "other")
    now = f.replies(path)
    score.check("changed payload and stale author cannot alter prior reply",
                first_status == 201 and changed == 409 and wrong == 403 and now == rows,
                f"HTTP {changed}/{wrong}, visible replies {len(now)}",
                changed in (200, 201) or wrong in (200, 201) or now != rows)

    same = f.thread("Two deliberate replies")
    commands = [f.reply_cli(same, "Same deliberate text", key) for key in ("one", "two", "one")]
    rows = f.replies(same)
    score.check("two independent keys are two messages through public CLI",
                all(p.returncode == 0 for p in commands) and len(rows) == 2
                and len({r["reply_id"] for r in rows}) == 2
                and all(r["content"] == "Same deliberate text" and r["member_id"] == "reviewer" for r in rows),
                f"CLI exits {[p.returncode for p in commands]}, visible replies {len(rows)}",
                len(rows) > 2)

    channel = "/api/trial/channels/general"
    legacy = f.setup_api(channel + "/claim", {"task_key": "legacy-report", "content": "Check original behavior"}, "reviewer")
    require(legacy["claimed"], "legacy report setup failed")
    legacy_body = {"task_key": "legacy-report", "status": "done", "content": "Original report"}
    f.setup_api(channel + "/report", legacy_body, "reviewer")
    f.setup_api(channel + "/report", legacy_body, "reviewer")
    legacy_posts = f.setup_api(channel + "/posts?limit=50", actor="reviewer")["posts"]
    legacy_count = sum(p["kind"] == "result" and p["task_key"] == "legacy-report" for p in legacy_posts)
    print(f"legacy observation | two unkeyed reports on one claim | visible results {legacy_count}")
    claim = f.setup_api(channel + "/claim", {"task_key": "report-demo", "content": "Check sample"}, "reviewer")
    require(claim["claimed"], "test report claim was refused")
    report = {"task_key": "report-demo", "status": "done", "content": "Finished"}
    first_status, first = keyed(f, channel + "/report", "report-A", report)
    f.start()
    second_status, second = keyed(f, channel + "/report", "report-A", report)
    conflict, _ = keyed(f, channel + "/report", "report-A", {**report, "content": "Different"})
    posts = f.setup_api(channel + "/posts?limit=50", actor="reviewer")["posts"]
    results = [r for r in posts if r["kind"] == "result" and r["task_key"] == "report-demo"]
    score.check("claimed task report replays its one visible result",
                (first_status, second_status, conflict) == (201, 200, 409)
                and len(results) == 1 and results[0]["member_id"] == "reviewer"
                and first.get("post_id") == second.get("post_id") == results[0]["post_id"],
                f"HTTP {first_status}/{second_status}/{conflict}, visible result posts {len(results)}",
                len(results) > 1 or conflict in (200, 201))


def element_cases(f, score):
    (f.project / "verify.sh").write_text("echo verified >> checks.log\nsleep .15\n")
    for member in ("coordinator", "reviewer", "other"):
        f.must_element("connect", "--as", member)

    def runs():
        return len((f.project / "checks.log").read_text().splitlines())

    card = f.card("Verify initial repair")
    code, _ = f.complete(card)
    require(code == 0, "control: first Element completion failed")
    receipt = f.visible_card(card)
    events = f.events(card)
    require(receipt["complete"] and receipt["owner"] == "reviewer" and len(events) == 1 and runs() == 1,
            f"control receipt, events or verifier failed: {receipt['complete']}, {len(events)}, {runs()}")
    score.check("public Element completion", True, "one result and one verification on original card")

    code, _ = f.complete(card)
    events = f.events(card)
    score.check("same completion retried from new CLI process",
                code == 0 and len(events) == 1 and f.visible_card(card) == receipt and runs() == 1,
                f"CLI exit {code}, visible events {len(events)}, check invocations {runs()}",
                len(events) > 1 or runs() > 1)
    before = len(f.events(card)), runs(), f.visible_card(card)
    changed, _ = f.complete(card, proof="different evidence")
    wrong, _ = f.complete(card, actor="other")
    after = len(f.events(card)), runs(), f.visible_card(card)
    score.check("altered evidence or replacement author is refused",
                changed != 0 and wrong != 0 and before == after,
                f"CLI exits {changed}/{wrong}, new results {after[0] - before[0]}",
                changed == 0 or wrong == 0 or before != after)

    concurrent = f.card("Concurrent completion")
    initial = runs()
    with ThreadPoolExecutor(2) as pool:
        responses = list(pool.map(f.complete, [concurrent, concurrent]))
    count = len(f.events(concurrent))
    score.check("two simultaneous CLI processes finishing one card",
                all(code == 0 for code, _ in responses) and count == 1 and runs() == initial + 1,
                f"CLI exits {[code for code, _ in responses]}, visible results {count}, checks {runs()-initial}",
                count > 1 or runs() > initial + 1)
    a, b = f.card("Check first independent card"), f.card("Check second independent card")
    initial = runs()
    with ThreadPoolExecutor(2) as pool:
        responses = list(pool.map(f.complete, [a, b]))
    counts = [len(f.events(c)) for c in (a, b)]
    score.check("independent cards survive identical results",
                a != b and all(code == 0 for code, _ in responses) and counts == [1, 1]
                and all(f.visible_card(c)["complete"] for c in (a, b)) and runs() == initial + 2,
                f"results per card {counts}, checks {runs()-initial}", max(counts) > 1)

    both = f.card("Return checked repair on the original card and thread")
    path = f.thread("Team request for " + both)
    initial = runs()
    code, _ = f.complete(both)
    require(code == 0, "combined handoff could not complete the card")
    original = f.visible_card(both)
    intent = "Card " + both + ": " + original["proof"]
    first = f.reply_cli(path, intent, "joint-repair")
    f.start()
    retry, _ = f.complete(both)
    second = f.reply_cli(path, intent, "joint-repair")
    rows, events = f.replies(path), f.events(both)
    score.check("after restart the linked handoff has one result on each original destination",
                first.returncode == second.returncode == retry == 0 and len(rows) == len(events) == 1
                and rows[0]["content"] == intent and rows[0]["member_id"] == original["owner"]
                and rows[0]["post_id"] == path.split("/")[-2] and f.visible_card(both) == original
                and runs() == initial + 1, f"thread replies {len(rows)}, card results {len(events)}, "
                f"checks {runs() - initial}", len(rows) > 1 or len(events) > 1 or runs() > initial + 1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--atris-root", type=Path, default=Path(__file__).resolve().parents[3])
    parser.add_argument("--swarlo-root", type=Path, default=os.getenv("SWARLO_ROOT"))
    args = parser.parse_args()
    score = Score()
    try:
        atris = args.atris_root.resolve()
        common = subprocess.check_output(["git", "-C", str(atris), "rev-parse", "--path-format=absolute",
                                          "--git-common-dir"], text=True).strip()
        swarlo = (args.swarlo_root or Path(common).parent.parent / "swarlo").resolve()
        print(f"atris={atris} swarlo={swarlo}", flush=True)
        with TemporaryDirectory(prefix="atris-coordination-check-") as scratch:
            f = Fixture(Path(scratch), atris, swarlo)
            try:
                f.start()
                f.register("coordinator")
                f.register("reviewer", "coordinator")
                f.register("other", "coordinator")
                reply_cases(f, score)
                element_cases(f, score)
            finally:
                f.stop()
    except Exception as error:
        score.error(error)
    return score.finish()


if __name__ == "__main__":
    sys.exit(main())
