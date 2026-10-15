"""Prove a real watch terminal recovers after its progress folder appears."""
import datetime
import fcntl
import os
import pathlib
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time

cli = pathlib.Path(__file__).resolve().parents[2] / 'bin/atris.js'
with tempfile.TemporaryDirectory(prefix='atris-wr-', dir='/tmp') as folder:
    root = pathlib.Path(folder)
    (root / 'atris/team/builder').mkdir(parents=True)
    progress = root / 'progress'
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 3, 80, 0, 0))
    child = subprocess.Popen(
        [sys.argv[1] if len(sys.argv) > 1 else 'node', str(cli), 'member', 'board', '--watch'],
        cwd=root, env={**os.environ, 'ATRIS_PROGRESS_DIR': str(progress)},
        stdout=slave, stderr=slave,
    )
    os.close(slave)
    output = b''
    marker = b'\x1b[2J\x1b[H'

    def receive(text, seconds, frames=1):
        global output
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if select.select([master], [], [], 0.05)[0]:
                output += os.read(master, 65536)
            latest = output.split(marker)[-1]
            if text in latest and output.count(marker) >= frames:
                return latest.decode().replace('\r', '')
            assert child.poll() is None, output
        raise AssertionError(f'timed out waiting for {text!r}: {output!r}')

    def check(frame):
        assert len(frame.split('\n')) <= 3, frame
        assert all(len(line) <= 80 for line in frame.split('\n')), frame
        assert not frame.endswith('\n'), frame
        print(frame)

    try:
        print('command: node bin/atris.js member board --watch (80 columns, 3 rows)')
        # Wait through a timed retry with no folder, not just the opening draw.
        empty = receive(b'no member progress yet', 10, frames=2)
        assert not progress.exists(), 'the first frame must precede the folder'
        check(empty)
        progress.mkdir()
        log = progress / 'builder.log'
        stamp = datetime.datetime.now(datetime.timezone.utc).isoformat()
        log.write_text(f'{stamp} m-1 started: recover board\n')
        recovered = receive(b'recover board', 5)
        assert re.search(r'builder\s+working', recovered), recovered
        check(recovered)
        # This write occurs just after the recovery timer drew the board.
        # A later frame within two seconds therefore requires a live folder watch.
        with log.open('a') as stream:
            stream.write(f'{stamp} m-1 finished: failed (timed out)\n')
        finished = receive(b'timed out', 2)
        assert re.search(r'builder\s+done failed', finished), finished
        check(finished)
        child.send_signal(signal.SIGINT)
        code = child.wait(timeout=5)
        print(f'exit: {code}')
        assert code == 0
        print('late folder recovered; later write arrived before the next timed redraw')
    finally:
        if child.poll() is None:
            child.terminate()
            child.wait(timeout=5)
        os.close(master)
