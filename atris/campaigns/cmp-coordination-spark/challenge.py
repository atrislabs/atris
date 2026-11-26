"""Lose a real Fleet acknowledgement after Swarlo has committed the result."""

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
from threading import Thread
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from judge import Fixture, require


def check(f):
    f.start()
    f.register("coordinator")
    f.register("reviewer", "coordinator")
    channel = "/api/trial/channels/general"
    claim = f.setup_api(channel + "/claim", {"task_key": "challenge", "content": "Check delivery"}, "reviewer")
    require(claim["claimed"], "scratch task could not be claimed")
    deliveries = []

    class DropFirstAcknowledgement(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def forward(self):
            size = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(size) if size else None
            if self.headers.get("Transfer-Encoding") == "chunked":
                chunks = []
                while length := int(self.rfile.readline().split(b";", 1)[0].strip(), 16):
                    chunks.append(self.rfile.read(length))
                    self.rfile.readline()
                self.rfile.readline()
                body = b"".join(chunks)
            headers = {"Content-Type": "application/json"}
            if self.headers.get("Authorization"):
                headers["Authorization"] = self.headers["Authorization"]
            req = Request(f.url + self.path, data=body, headers=headers, method=self.command)
            try:
                upstream = urlopen(req, timeout=5)
            except HTTPError as error:
                upstream = error
            with upstream:
                data = upstream.read()
                status = upstream.status
            if self.command == "POST":
                deliveries.append((self.path, status, json.loads(data)))
                if len(deliveries) == 1:
                    self.close_connection = True
                    return
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        do_GET = do_POST = forward

    with ThreadingHTTPServer(("127.0.0.1", 0), DropFirstAcknowledgement) as proxy:
        thread = Thread(target=proxy.serve_forever, daemon=True)
        thread.start()
        try:
            address = f"http://127.0.0.1:{proxy.server_port}"
            identity = {"hub_url": address, "hub_id": "trial", "member_id": "reviewer", "api_key": f.keys["reviewer"]}
            state = Path(f.env["HOME"]) / ".swarlo/fleet-state.json"
            state.parent.mkdir(exist_ok=True)
            state.write_text(json.dumps(identity))
            f.env.update(SWARLO_SERVER=address, SWARLO_HUB="trial")
            command = [str(f.bin), "fleet", "done", "challenge", "The two projects agree.",
                       "--global", "--json", "--idempotency-key", "one-campaign-result"]
            first = f.run(command)
            require(first.returncode != 0 and len(deliveries) == 1 and deliveries[0][1] == 201,
                    f"first call must lose a committed acknowledgement: exit {first.returncode}, HTTP {[r[1] for r in deliveries]}")
            f.start()
            second = f.run(command)
            require(second.returncode == 0, f"retry failed: {second.stderr}")
            require([r[1] for r in deliveries] == [201, 200], "unexpected write count or replay response")
            require(deliveries[0][2]["post_id"] == json.loads(second.stdout)["post_id"], "retry changed the result ID")
            posts = f.setup_api(channel + "/posts?limit=50", actor="coordinator")["posts"]
            results = [p for p in posts if p.get("task_key") == "challenge" and p.get("kind") == "result"]
            require(len(results) == 1 and results[0]["member_id"] == "reviewer", "receiver recorded the wrong result")
        finally:
            proxy.shutdown()
            thread.join()
    print("first acknowledgement lost after commit; restarted receiver returned original ID; one visible Fleet result")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--atris-root", type=Path, default=Path(__file__).resolve().parents[3])
    parser.add_argument("--swarlo-root", type=Path, default=os.getenv("SWARLO_ROOT"))
    args = parser.parse_args()
    atris = args.atris_root.resolve()
    common = subprocess.check_output(["git", "-C", str(atris), "rev-parse", "--path-format=absolute",
                                      "--git-common-dir"], text=True).strip()
    swarlo = (args.swarlo_root or Path(common).parent.parent / "swarlo").resolve()
    with TemporaryDirectory(prefix="atris-fleet-challenge-") as scratch:
        fixture = Fixture(Path(scratch), atris, swarlo)
        try:
            check(fixture)
        finally:
            fixture.stop()


if __name__ == "__main__":
    main()
