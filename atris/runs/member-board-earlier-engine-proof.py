import re, signal, time, json, datetime, fcntl, os, pathlib, pty, select, struct, subprocess, tempfile, termios
cli = pathlib.Path.cwd() / 'bin/atris.js'
with tempfile.TemporaryDirectory(prefix='atris-board-proof-') as folder:
    root = pathlib.Path(folder)
    progress = root / 'progress'
    progress.mkdir()
    for member in ['builder', 'scout']:
        (root / 'atris/team' / member).mkdir(parents=True)
        now = datetime.datetime.now(datetime.timezone.utc)
        at = lambda seconds: (now - datetime.timedelta(seconds=seconds)).isoformat()
        text = (f'{at(90)} m-1 started: [pid 1 engine claude] first job\n'
                f'{at(80)} m-1 finished: failed (signed out)\n'
                f'{at(5)} m-2 started: [pid {os.getpid()} engine codex] try again\n') if member == 'builder' else f'{at(5)} m-3 started: [pid {os.getpid()} engine codex] another job\n'
        (progress / f'{member}.log').write_text(text)
    for width in [80, 70, 40, 18]:
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 5, width, 0, 0))
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
            print(f'command: node bin/atris.js member board --watch ({width} columns, 5 rows)')
            print(frame, end='')
            print(f'exit: {code}')
            assert code == 0
            assert all(len(line) <= width for line in frame.splitlines()), repr(frame)
            expected = {
                80: '2 more not shown (1 with earlier failure, signed out of claude, scout working)',
                70: '2 more not shown (1 with earlier failure, signed out, scout working)',
                40: '2 hidden (1 earlier failure, signed out)',
                18: '2 hidden',
            }[width]
            assert expected in frame.splitlines(), repr(frame)
            assert len(frame.splitlines()) <= 5, repr(frame)
        finally:
            if child.poll() is None:
                child.terminate()
                child.wait(timeout=10)
            os.close(master)
