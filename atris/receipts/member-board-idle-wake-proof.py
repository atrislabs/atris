"""Check a one-row idle board wakes and restores headings through the real command."""
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
        print('command: ' + ' '.join(command))
        frame = frame_after(0)
        assert frame == 'idle. 3 older', frame
        print(f'18x1 idle: {frame}')

        # The same process must notice a new log while still one row tall.
        previous = output.count(marker)
        stamp = time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime())
        (progress / 'builder.log').write_text(f'{stamp} m-new started: resume work\n')
        frame = frame_after(previous)
        assert frame == '1 hidden. 2 older', frame
        print(f'18x1 working: {frame}')

        previous = output.count(marker)
        resize(18, 3)
        child.send_signal(signal.SIGWINCH)
        frame = frame_after(previous)
        lines = frame.split('\n')
        assert lines == ['member   state', 'builder  working', '2 older hidden'], lines
        assert all(len(line) <= 18 for line in lines), lines
        print('18x3 working: ' + ' | '.join(lines))

        previous = output.count(marker)
        resize(18, 1)
        child.send_signal(signal.SIGWINCH)
        frame = frame_after(previous)
        assert frame == '1 hidden. 2 older', frame
        print(f'18x1 working again: {frame}')
        child.send_signal(signal.SIGINT)
        code = child.wait(timeout=5)
        assert code == 0, code
        print(f'exit: {code}')
        print('one-row idle board wakes; headings return after resize')
    finally:
        if child.poll() is None:
            child.terminate()
            child.wait(timeout=5)
        os.close(master)
