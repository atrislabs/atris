"""Check empty-board messages through the real command in a resized terminal."""
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
with tempfile.TemporaryDirectory(prefix='atris-empty-', dir='/tmp') as folder:
    root = pathlib.Path(folder)
    progress = root / ('進捗' * 30)
    progress.mkdir()
    master, slave = pty.openpty()
    def resize(width, height):
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', height, width, 0, 0))
    resize(30, 1)
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
        for index, (width, height) in enumerate([(30, 1), (18, 2), (22, 3), (80, 3), (240, 3)]):
            previous = output.count(marker)
            if index:
                resize(width, height)
                child.send_signal(signal.SIGWINCH)
            frame = frame_after(previous)
            cells = sum(2 if unicodedata.east_asian_width(ch) in ('W', 'F') else 1 for ch in frame)
            assert '\n' not in frame, frame
            assert cells <= width, (width, cells, frame)
            if width == 18:
                assert frame == 'no progress yet', frame
            elif width == 22:
                assert frame == 'no member progress yet', frame
            elif width == 240:
                assert frame == f'no member progress yet in {progress}', frame
            else:
                assert frame.startswith('no member progress yet in ') and frame.endswith('...'), frame
            print(f'{width}x{height}: {frame}')
        child.send_signal(signal.SIGINT)
        code = child.wait(timeout=5)
        assert code == 0, code
        print(f'exit: {code}')
        print('empty board fits narrow and short terminals; wide path returns after resize')
    finally:
        if child.poll() is None:
            child.terminate()
            child.wait(timeout=5)
        os.close(master)
