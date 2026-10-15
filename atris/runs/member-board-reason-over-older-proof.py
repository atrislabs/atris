import re, signal, time, json, datetime, fcntl, os, pathlib, pty, select, struct, subprocess, tempfile, termios
cli = pathlib.Path.cwd() / 'bin/atris.js'
with tempfile.TemporaryDirectory(prefix='atris-board-proof-') as folder:
    root = pathlib.Path(folder)
    progress = root / 'progress'
    progress.mkdir()
    now = datetime.datetime.now(datetime.timezone.utc)
    stamp = lambda s: (now - datetime.timedelta(seconds=s)).isoformat()
    lines = {
        'f1': f'{stamp(80)} m-1 finished: failed (timed out)',
        'f2': f'{stamp(90)} m-2 finished: failed (bad exit 2)',
        'halt': f'{stamp(110)} m-4 finished: stopped',
        'old1': f'{stamp(5000)} m-6 finished: ok',
        'old2': f'{stamp(6000)} m-7 finished: ok',
    }
    for member, line in lines.items():
        (root / 'atris/team' / member).mkdir(parents=True)
        (progress / f'{member}.log').write_text(line + '\n')
    for width in [100, 80, 60, 44]:
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 6, width, 0, 0))
        child = subprocess.Popen(['node', str(cli), 'member', 'board', '--watch'], cwd=root,
                                 env={**os.environ, 'ATRIS_PROGRESS_DIR': str(progress)}, stdout=slave, stderr=slave)
        os.close(slave)
        output = b''
        try:
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                if select.select([master], [], [], 0.2)[0]:
                    output += os.read(master, 65536)
                    if b'ctrl-c' in output:
                        break
            time.sleep(0.1)
            child.send_signal(signal.SIGINT)
            code = child.wait(timeout=10)
            frame = re.sub(r'\x1b\[[0-9;]*[A-Za-z]', '', output.decode()).replace('\r', '')
            print(f'command: node bin/atris.js member board --watch ({width} columns, 6 rows)')
            print(frame, end='')
            print(f'exit: {code}')
            assert code == 0
            assert all(len(line) <= width for line in frame.splitlines()), repr(frame)
            expected = {
                100: '2 more not shown (1 failed, bad exit 2, 1 stopped). 2 older runs hidden, --all shows them',
                80: '2 hidden (1 failed, bad exit 2, 1 stopped). 2 older, --all shows them',
                60: '2 hidden (1 failed, bad exit 2, 1 stopped). 2 older hidden',
                44: '2 hidden (1 failed, bad exit 2, 1 stopped)',
            }[width]
            assert frame.splitlines()[2] == expected, repr(frame)
            assert len(frame.splitlines()) <= 6, repr(frame)
        finally:
            if child.poll() is None:
                child.terminate()
                child.wait(timeout=10)
            os.close(master)
