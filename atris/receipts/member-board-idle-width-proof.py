"""Check idle-board messages through the real command in a resized terminal."""
import fcntl
import os
import pathlib
import pty
import select
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time
import unicodedata

cli = pathlib.Path(__file__).resolve().parents[2] / 'bin/atris.js'
with tempfile.TemporaryDirectory(prefix='atris-idle-', dir='/tmp') as folder:
    root = pathlib.Path(folder)
    progress = root / ('進捗' * 30)
    progress.mkdir()
    for name in ['builder', 'scout', 'navigator']:
        (progress / f'{name}.log').write_text('2000-01-01T00:00:00.000Z m-old started: old job\n2000-01-01T00:00:01.000Z m-old finished: ok\n')
    master, slave = pty.openpty()
    def resize(width, height):
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', height, width, 0, 0))
    resize(18, 1)
    command = [sys.argv[1] if len(sys.argv) > 1 else 'node', str(cli), 'member', 'board', '--watch']
    child = subprocess.Popen(command, cwd=root, env={**os.environ, 'ATRIS_PROGRESS_DIR': str(progress)}, stdout=slave, stderr=slave)
    os.close(slave)
    marker = b'\x1b[2J\x1b[H'
    output = b''
    def frame_after(previous):
        global output
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            if select.select([master], [], [], 0.05)[0]:
                output += os.read(master, 65536)
            if output.count(marker) > previous and output.split(marker)[-1]:
                return output.split(marker)[-1].decode().replace('\r', '')
            assert child.poll() is None, output
        raise AssertionError(f'no redraw: {output!r}')
    try:
        for index, (width, height) in enumerate([(18, 1), (4, 2), (30, 3), (60, 3), (120, 3)]):
            previous = output.count(marker)
            if index:
                resize(width, height)
                child.send_signal(signal.SIGWINCH)
            frame = frame_after(previous)
            cells = sum(2 if unicodedata.east_asian_width(ch) in ('W', 'F') else 1 for ch in frame)
            assert '\n' not in frame, frame
            assert cells <= width, (width, cells, frame)
            expected = {
                18: 'idle. 3 older',
                4: 'idle',
                30: 'idle. 3 older runs hidden',
                60: 'nobody is working. 3 older runs hidden. --all shows them',
                120: 'nobody is working right now. 3 finished over an hour ago, hidden. --all shows them',
            }
            assert frame == expected[width], frame
            print(f'{width}x{height}: {frame}')
        child.send_signal(signal.SIGINT)
        code = child.wait(timeout=5)
        assert code == 0, code
        print(f'exit: {code}')
        print('idle board fits; older-run count and full detail return after resize')
    finally:
        if child.poll() is None:
            child.terminate()
            child.wait(timeout=5)
        os.close(master)
