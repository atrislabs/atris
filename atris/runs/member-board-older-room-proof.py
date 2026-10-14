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
        'broke': f'{stamp(80)} m-2 finished: failed (engine error)',
        'old1': f'{stamp(5000)} m-6 finished: ok',
        'old2': f'{stamp(6000)} m-7 finished: ok',
    }
    for member, line in lines.items():
        (root / 'atris/team' / member).mkdir(parents=True)
        (progress / f'{member}.log').write_text(line + '\n')
    width = 80
    for height in [3, 4, 5, 6, 7]:
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', height, width, 0, 0))
        child = subprocess.Popen(['node', str(cli), 'member', 'board', '--watch'], cwd=root,
                                 env={**os.environ, 'ATRIS_PROGRESS_DIR': str(progress)}, stdout=slave, stderr=slave)
        os.close(slave)
        output = b''
        try:
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                if select.select([master], [], [], 0.2)[0]:
                    output += os.read(master, 65536)
                    if b'ctrl-c' in output or (height <= 3 and output.count(b'broke') and output.rstrip().endswith(b'-')):
                        break
            time.sleep(0.1)
            child.send_signal(signal.SIGINT)
            code = child.wait(timeout=10)
            frame = re.sub(r'\x1b\[[0-9;]*[A-Za-z]', '', output.decode()).replace('\r', '')
            print(f'command: node bin/atris.js member board --watch ({width} columns, {height} rows)')
            print(frame, end='')
            print(f'exit: {code}')
            assert code == 0
            assert all(len(line) <= width for line in frame.splitlines()), repr(frame)
            shown = [line.split()[0] for line in frame.splitlines()[1:] if line.split()]
            note = '2 finished over an hour ago, hidden. --all shows them'
            if height in (3, 6, 7):
                assert shown[:2] == ['busy', 'broke'], repr(frame)
            assert (note in frame.splitlines()) == (height == 7), repr(frame)
            assert len(frame.splitlines()) <= height, repr(frame)
        finally:
            if child.poll() is None:
                child.terminate()
                child.wait(timeout=10)
            os.close(master)
