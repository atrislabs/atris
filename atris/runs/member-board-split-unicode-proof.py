import datetime, json, os, pathlib, select, signal, subprocess, tempfile, time

cli = pathlib.Path.cwd() / "bin/atris.js"
with tempfile.TemporaryDirectory(prefix="atris-split-unicode-") as folder:
    root = pathlib.Path(folder)
    log = root / "builder.log"
    stamp = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    text = "reading café 🧭 notes"
    line = f"{stamp} m-proof {text}\n".encode()
    split = line.index("🧭".encode()) + 2
    log.write_bytes(f"{stamp} m-proof started: check text\n".encode() + line[:split])
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
        assert [(m["member"], m["state"], m["last_result"]) for m in snapshot["members"]] == [("builder", "working", "")], snapshot
        print(json.dumps(snapshot))
        assert not pending and not select.select([child.stdout], [], [], 1.2)[0], "partial event emitted"
        print("incomplete character: no event after 1.2 seconds")
        with log.open("ab") as stream:
            stream.write(line[split:])
        event = record()
        assert event == {"member": "builder", "mission": "m-proof", "at": stamp,
            "kind": "step", "text": text}, event
        print(json.dumps(event))
        assert not pending and not select.select([child.stdout], [], [], 1.2)[0], "duplicate event emitted"
        print("completed text: exactly one event")
        with log.open("a") as stream:
            stream.write(f"{stamp} m-proof finished: ok\n")
        finished = record()
        assert finished["kind"] == "finished" and finished["ok"] is True, finished
        print(json.dumps(finished))
        child.send_signal(signal.SIGINT)
        code = child.wait(timeout=10)
        print(f"exit: {code}")
        assert code == 0, child.stderr.read().decode()
    finally:
        if child.poll() is None:
            child.terminate()
            child.wait(timeout=10)
