import datetime, fcntl, os, pathlib, pty, re, select, signal, struct, subprocess, sys, tempfile, termios, time

# A real 5-row watch screen with seven members hides three, among them one
# that signed out of claude and now runs on codex. The hidden-row summary
# names the old engine where it fits, for LF and CRLF logs alike.
node = sys.argv[1] if len(sys.argv) > 1 else 'node'
cli = pathlib.Path(__file__).resolve().parents[2] / 'bin/atris.js'
CLEAR = b'\x1b[2J\x1b[H'
expected = {
    80: '3 more not shown (1 with earlier failure, signed out of claude)',
    70: '3 more not shown (1 with earlier failure, signed out of claude)',
    40: '3 hidden (1 earlier failure, signed out)',
    18: '3 hidden',
}

def logs(eol):
    now = datetime.datetime.now(datetime.timezone.utc)
    at = lambda seconds: (now - datetime.timedelta(seconds=seconds)).isoformat()
    pid = os.getpid()
    out = {
        'builder': [f'{at(900)} m-1 started: [pid 1 engine claude] first job',
                    f'{at(800)} m-1 finished: failed (signed out)',
                    f'{at(60)} m-2 started: [pid {pid} engine codex] try again'],
        'scout': [f'{at(5)} m-3 started: [pid {pid} engine codex] another job'],
    }
    for i in range(1, 5):
        out[f'ok{i}'] = [f'{at(15 + i)} m-{3 + i} finished: ok']
    return {name: ''.join(line + eol for line in lines) for name, lines in out.items()}

def first_frame(root, progress, width):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 5, width, 0, 0))
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
            print(f'command: {node} bin/atris.js member board --watch ({name} logs, {width} columns, 5 rows)')
            print(frame)
            print(f'exit: {code}')
            lines = frame.splitlines()
            assert code == 0, code
            assert len(lines) <= 5, repr(frame)
            assert all(len(line) <= width for line in lines), repr(frame)
            assert lines[-1] == expected[width], repr(frame)
            assert not re.search(r'^builder\s', frame, re.M), repr(frame)

print('hidden sign-in failure names its old engine where it fits, for LF and CRLF logs')
