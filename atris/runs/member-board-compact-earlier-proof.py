import datetime, fcntl, os, pathlib, pty, re, select, signal, struct, subprocess, sys, tempfile, termios, time

# A real 7-row watch screen with eight members hides three, among them a busy
# member whose earlier run timed out. As the window narrows, the footer drops
# "with" before the reason, and the reason before the earlier failure label,
# for LF and CRLF logs alike.
node = sys.argv[1] if len(sys.argv) > 1 else 'node'
cli = pathlib.Path(__file__).resolve().parents[2] / 'bin/atris.js'
CLEAR = b'\x1b[2J\x1b[H'
expected = {
    52: '3 more not shown (1 with earlier failure, timed out)',
    47: '3 more not shown (1 earlier failure, timed out)',
    36: '3 more not shown (1 earlier failure)',
}

def logs(eol):
    now = datetime.datetime.now(datetime.timezone.utc)
    at = lambda seconds: (now - datetime.timedelta(seconds=seconds)).isoformat()
    out = {
        'busy': [f'{at(900)} m-1 started: first job',
                 f'{at(800)} m-1 finished: failed (timed out)',
                 f'{at(60)} m-2 started: try again',
                 f'{at(30)} m-2 running: check the fix'],
        'broke': [f'{at(90)} m-3 started: other job', f'{at(80)} m-3 finished: failed (engine error)'],
    }
    # Fresher than the busy member's last step, so it is the one that hides.
    for i in range(1, 7):
        out[f'ok{i}'] = [f'{at(i)} m-{3 + i} finished: ok']
    return {name: ''.join(line + eol for line in lines) for name, lines in out.items()}

def first_frame(root, progress, width):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 7, width, 0, 0))
    child = subprocess.Popen([node, str(cli), 'member', 'board', '--watch'], cwd=root,
                             env={**os.environ, 'ATRIS_PROGRESS_DIR': str(progress)}, stdout=slave, stderr=slave)
    os.close(slave)
    output = b''
    try:
        # A short screen has no hint line, so wait for the summary itself.
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and expected[width].encode() not in output:
            if select.select([master], [], [], 0.2)[0]:
                output += os.read(master, 65536)
        time.sleep(0.15)  # Let the first draw finish installing its handlers.
        child.send_signal(signal.SIGINT)
        code = child.wait(timeout=10)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=10)
        os.close(master)
    # Later redraws repeat the screen; judge the first one alone.
    frame = output.split(CLEAR)[1] if CLEAR in output else output
    return code, re.sub(r'\x1b\[[0-9;]*[A-Za-z]', '', frame.decode()).replace('\r', '')

for name, eol in [('LF', '\n'), ('CRLF', '\r\n')]:
    with tempfile.TemporaryDirectory(prefix='atris-board-proof-') as folder:
        root = pathlib.Path(folder)
        progress = root / 'progress'
        progress.mkdir()
        for member, text in logs(eol).items():
            (root / 'atris/team' / member).mkdir(parents=True)
            (progress / f'{member}.log').write_bytes(text.encode())
        for width in expected:
            code, frame = first_frame(root, progress, width)
            print(f'command: {node} bin/atris.js member board --watch ({name} logs, {width} columns, 7 rows)')
            print(frame)
            print(f'exit: {code}')
            lines = frame.splitlines()
            assert code == 0, code
            assert len(lines) <= 7, repr(frame)
            assert all(len(line) <= width for line in lines), repr(frame)
            assert lines[-1] == expected[width], repr(frame)
            assert re.search(r'^broke\s+(done )?failed\s', frame, re.M), repr(frame)
            assert not re.search(r'^busy\s', frame, re.M), repr(frame)

print('hidden earlier failure footer drops "with", then the reason, for LF and CRLF logs')
