import json, os, pathlib, select, signal, subprocess, tempfile, time

cli = pathlib.Path.cwd() / "bin/atris.js"
with tempfile.TemporaryDirectory(prefix="atris-split-timeout-") as folder:
    root = pathlib.Path(folder)
    log = root / "builder.log"
    stamp = "2026-10-15T00:00:00.000Z"
    log.write_text(f"{stamp} m-proof started: check timeout\n")
    child = subprocess.Popen(["node", str(cli), "member", "board", "--json", "--follow"],
        cwd=root, env={**os.environ, "ATRIS_PROGRESS_DIR": str(root)},
        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    pending = b""
    def record(timeout=15):
        global pending
        deadline = time.monotonic() + timeout
        while b"\n" not in pending:
            remaining = deadline - time.monotonic()
            assert remaining > 0, "no complete record before deadline"
            assert select.select([child.stdout], [], [], remaining)[0], "no output before deadline"
            chunk = os.read(child.stdout.fileno(), 65536)
            assert chunk, "follower closed before record"
            pending += chunk
        line, pending = pending.split(b"\n", 1)
        return json.loads(line)
    try:
        print("command: node bin/atris.js member board --json --follow")
        snapshot = record()
        assert snapshot["kind"] == "snapshot", snapshot
        print("snapshot received")
        with log.open("a") as stream:
            stream.write(f"{stamp} m-proof finished: failed (timed")
        assert not pending and not select.select([child.stdout], [], [], 1.2)[0], "partial event emitted"
        print("incomplete timeout: no event after 1.2 seconds")
        with log.open("a") as stream:
            stream.write(" out)\n")
        event = record()
        assert event == {"member": "builder", "mission": "m-proof", "at": stamp,
            "kind": "finished", "text": "failed (timed out)", "ok": False}, event
        print(json.dumps(event))
        assert not pending and not select.select([child.stdout], [], [], 1.2)[0], "duplicate event emitted"
        print("completed timeout: exactly one event")
        child.send_signal(signal.SIGINT)
        code = child.wait(timeout=10)
        print(f"exit: {code}")
        assert code == 0, child.stderr.read().decode()
    finally:
        if child.poll() is None:
            child.terminate()
            child.wait(timeout=10)
