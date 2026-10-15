import json, datetime, fcntl, os, pathlib, pty, select, struct, subprocess, tempfile, termios
cli = pathlib.Path.cwd() / 'bin/atris.js'
with tempfile.TemporaryDirectory(prefix='atris-board-proof-') as folder:
    root = pathlib.Path(folder)
    progress = root / 'progress'
    progress.mkdir()
    for member, reason in [('builder', 'timed out'), ('chat-experience-lead', 'engine error'), ('breaker', 'bad exit 2'), ('scout', '')]:
        (root / 'atris/team' / member).mkdir(parents=True)
        at = datetime.datetime.now(datetime.timezone.utc).isoformat()
        log = f'{at} m-1 started: check the board layout\n'
        if reason:
            log += f'{at} m-1 finished: failed ({reason})\n'
        (progress / f'{member}.log').write_text(log)
    (root / '.atris/state').mkdir(parents=True)
    (root / '.atris/state/member-switches.json').write_text(json.dumps({'members': {'scout': {'awake': False}}}))
    for width in [30, 31, 32, 38]:
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 12, width, 0, 0))
        child = subprocess.Popen(['node', str(cli), 'member', 'board'], cwd=root,
                                 env={**os.environ, 'ATRIS_PROGRESS_DIR': str(progress)}, stdout=slave, stderr=slave)
        os.close(slave)
        output = b''
        try:
            while select.select([master], [], [], 10)[0]:
                try:
                    part = os.read(master, 65536)
                except OSError:
                    break
                if not part:
                    break
                output += part
            code = child.wait(timeout=10)
            frame = output.decode().replace('\r', '')
            print(f'command: node bin/atris.js member board ({width} columns, 12 rows)')
            print(frame, end='')
            print(f'exit: {code}')
            assert code == 0
            assert all(len(line) <= width for line in frame.splitlines()), repr(frame)
            assert frame.count('failed') == 3, repr(frame)
            assert 'last result' in frame, repr(frame)
            assert 'finishing' in frame, repr(frame)
            for reason in ['timed out', 'engine error', 'bad exit 2']:
                assert reason in frame, repr(frame)
        finally:
            if child.poll() is None:
                child.terminate()
                child.wait(timeout=10)
            os.close(master)
