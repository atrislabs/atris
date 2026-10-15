import re, signal, time, json, datetime, fcntl, os, pathlib, pty, select, struct, subprocess, tempfile, termios
cli = pathlib.Path.cwd() / 'bin/atris.js'
with tempfile.TemporaryDirectory(prefix='atris-board-proof-') as folder:
    root = pathlib.Path(folder)
    progress = root / 'progress'
    progress.mkdir()
    now = datetime.datetime.now(datetime.timezone.utc)
    stamp = lambda s: (now - datetime.timedelta(seconds=s)).isoformat()
    lines = {
        'busy': f'{stamp(10)} m-1 started: [pid {os.getpid()} engine claude] check the board layout',
        'also': f'{stamp(20)} m-5 started: [pid {os.getpid()} engine claude] check the footer',
        'scout': f'{stamp(400)} m-6 started: [pid {os.getpid()} engine claude] read the logs',
        'f1': f'{stamp(80)} m-2 finished: failed (timed out)',
        'f2': f'{stamp(90)} m-3 finished: failed (bad exit 2)',
        'halt': f'{stamp(110)} m-4 finished: stopped',
    }
    for member, line in lines.items():
        (root / 'atris/team' / member).mkdir(parents=True)
        (progress / f'{member}.log').write_text(line + '\n')
    for width in [100, 80, 60, 50]:
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 7, width, 0, 0))
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
            print(f'command: node bin/atris.js member board --watch ({width} columns, 7 rows)')
            print(frame, end='')
            print(f'exit: {code}')
            assert code == 0
            assert all(len(line) <= width for line in frame.splitlines()), repr(frame)
            expected = {
                100: '5 more not shown (1 failed, bad exit 2, 1 stopped, busy working, also working, scout quiet)',
                80: '5 more not shown (1 failed, bad exit 2, 1 stopped, 3 running)',
                60: '5 hidden (1 failed, bad exit 2, 1 stopped, 3 running)',
                50: '5 more not shown (1 failed, bad exit 2, 1 stopped)',
            }[width]
            assert frame.splitlines()[3] == expected, repr(frame)
            assert len(frame.splitlines()) <= 7, repr(frame)
        finally:
            if child.poll() is None:
                child.terminate()
                child.wait(timeout=10)
            os.close(master)
