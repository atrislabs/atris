import json, datetime, fcntl, os, pathlib, pty, select, struct, subprocess, tempfile, termios
cli = pathlib.Path.cwd() / 'bin/atris.js'
with tempfile.TemporaryDirectory(prefix='atris-board-proof-') as folder:
    root = pathlib.Path(folder)
    progress = root / 'progress'
    progress.mkdir()
    for member, reason in [('chat-experience-lead', None), ('scout', '')]:
        (root / 'atris/team' / member).mkdir(parents=True)
        at = datetime.datetime.now(datetime.timezone.utc).isoformat()
        dead = subprocess.Popen(['node', '-e', 'setInterval(() => {}, 1000)'])
        dead.kill()
        dead.wait()
        tag = f'[pid {dead.pid} engine claude] ' if reason is None else ''
        log = f'{at} m-1 started: {tag}check the board layout\n'
        if reason:
            log += f'{at} m-1 finished: failed ({reason})\n'
        (progress / f'{member}.log').write_text(log)
    (root / '.atris/state').mkdir(parents=True)
    (root / '.atris/state/member-switches.json').write_text(json.dumps({'members': {'scout': {'awake': False}}}))
    for width in [30, 32, 33, 34, 38]:
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
            assert 'stopped' in frame and 'no result' in frame, repr(frame)
            assert ('ended, no result' in frame) == (width >= 33), repr(frame)
            assert 'last result' in frame, repr(frame)
            assert 'finishing' in frame, repr(frame)
        finally:
            if child.poll() is None:
                child.terminate()
                child.wait(timeout=10)
            os.close(master)
