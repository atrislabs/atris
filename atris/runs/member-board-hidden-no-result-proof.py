import re, signal, time, json, datetime, fcntl, os, pathlib, pty, select, struct, subprocess, tempfile, termios
cli = pathlib.Path.cwd() / 'bin/atris.js'
with tempfile.TemporaryDirectory(prefix='atris-board-proof-') as folder:
    root = pathlib.Path(folder)
    progress = root / 'progress'
    progress.mkdir()
    for member in ['a', 'b', 'c', 'd']:
        (root / 'atris/team' / member).mkdir(parents=True)
        at = datetime.datetime.now(datetime.timezone.utc).isoformat()
        (progress / f'{member}.log').write_text(
            f'{at} m-1 started: [pid 999999999 engine claude] check the board layout\n')
    for width in [80, 41, 31, 22]:
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
                80: '3 more not shown (3 ended with no result), the window is too short',
                41: '3 more not shown (3 ended with no result)',
                31: '3 more not shown (3 no result)',
                22: '3 hidden (3 no result)',
            }[width]
            assert frame.splitlines()[3] == expected, repr(frame)
            assert len(frame.splitlines()) <= 7, repr(frame)
        finally:
            if child.poll() is None:
                child.terminate()
                child.wait(timeout=10)
            os.close(master)
