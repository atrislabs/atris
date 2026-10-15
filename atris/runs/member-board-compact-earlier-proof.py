import datetime, fcntl, os, pathlib, pty, select, signal, struct, subprocess, tempfile, termios, time
cli = pathlib.Path.cwd() / 'bin/atris.js'
with tempfile.TemporaryDirectory(prefix='atris-board-proof-') as folder:
    root = pathlib.Path(folder)
    progress = root / 'progress'
    progress.mkdir()
    for member in ['busy', 'broke', 'ok1', 'ok2']:
        (root / 'atris/team' / member).mkdir(parents=True)
    def at(seconds):
        return (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=seconds)).isoformat()
    (progress / 'busy.log').write_text(f'{at(900)} m-1 started: first job\n{at(800)} m-1 finished: failed (timed out)\n{at(60)} m-2 started: try again\n{at(5)} m-2 running: check the fix\n')
    (progress / 'broke.log').write_text(f'{at(90)} m-3 started: other job\n{at(80)} m-3 finished: failed (engine error)\n')
    for member in ['ok1', 'ok2']:
        (progress / f'{member}.log').write_text(f'{at(70)} m-4 finished: ok\n')
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 7, 47, 0, 0))
    child = subprocess.Popen(['node', str(cli), 'member', 'board', '--watch'], cwd=root,
                             env={**os.environ, 'ATRIS_PROGRESS_DIR': str(progress)}, stdout=slave, stderr=slave)
    os.close(slave)
    output = b''
    try:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if select.select([master], [], [], 0.2)[0]:
                output += os.read(master, 65536)
                if b'earlier failure, timed out' in output:
                    break
        time.sleep(0.1)  # Let the watch command install its interrupt handler after drawing.
        child.send_signal(signal.SIGINT)
        code = child.wait(timeout=10)
        print('command: node bin/atris.js member board --watch (47 columns, 7 rows)')
        print(output.decode())
        print(f'exit: {code}')
        assert code == 0
        assert b'3 more not shown (1 earlier failure, timed out)' in output
    finally:
        if child.poll() is None:
            child.terminate()
            child.wait(timeout=10)
        os.close(master)
