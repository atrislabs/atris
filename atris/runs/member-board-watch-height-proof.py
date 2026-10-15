import datetime, fcntl, os, pathlib, pty, select, signal, struct, subprocess, tempfile, termios, time
cli = pathlib.Path.cwd() / 'bin/atris.js'
with tempfile.TemporaryDirectory(prefix='atris-board-proof-') as folder:
    root = pathlib.Path(folder)
    progress = root / 'progress'
    progress.mkdir()
    for member in ['f1', 'f2', 'f3', 'halt']:
        (root / 'atris/team' / member).mkdir(parents=True)
    def at(seconds):
        return (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=seconds)).isoformat()
    for i in range(1, 4):
        (progress / f'f{i}.log').write_text(f'{at(90+i)} m-{i} started: job\n{at(80+i)} m-{i} finished: failed (timed out)\n')
    (progress / 'halt.log').write_text(f'{at(110)} m-4 finished: stopped\n')
    for height in [1, 2, 3]:
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', height, 80, 0, 0))
        child = subprocess.Popen(['node', str(cli), 'member', 'board', '--watch'], cwd=root,
                                 env={**os.environ, 'ATRIS_PROGRESS_DIR': str(progress)}, stdout=slave, stderr=slave)
        os.close(slave)
        output = b''
        try:
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                if select.select([master], [], [], 0.2)[0]:
                    output += os.read(master, 65536)
                    if b'member' in output:
                        break
            time.sleep(0.1)  # Let the watch command install its interrupt handler after drawing.
            child.send_signal(signal.SIGINT)
            code = child.wait(timeout=10)
            print(f'command: node bin/atris.js member board --watch (80 columns, {height} rows)')
            print(output.decode())
            print(f'exit: {code}')
            import re
            frame = re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", output.decode()).replace("\r", "")
            assert len(frame.splitlines()) == height, repr(frame)
            assert frame.startswith('member'), repr(frame)
            assert not frame.endswith('\n'), repr(frame)
            assert 'redraws every' not in frame
            assert code == 0
            if height > 1:
                assert b'timed out' in output
        finally:
            if child.poll() is None:
                child.terminate()
                child.wait(timeout=10)
            os.close(master)
