"""Exercise idle -> working -> done -> idle in the actual watch terminal."""
import datetime
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
marker = b'\x1b[2J\x1b[H'
for width, height in [(18, 3), (30, 3), (47, 2)]:
    with tempfile.TemporaryDirectory(prefix='atris-idle-transition-') as folder:
        root = pathlib.Path(folder)
        progress = root / 'progress'
        progress.mkdir()
        log = progress / 'builder.log'
        old = '2000-01-01T00:00:00Z m-old started: old job\n2000-01-01T00:00:01Z m-old finished: ok\n'
        log.write_text(old)
        master, slave = pty.openpty()
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', height, width, 0, 0))
        child = subprocess.Popen([sys.argv[1] if len(sys.argv) > 1 else 'node', str(cli), 'member', 'board', '--watch'],
            cwd=root, env={**os.environ, 'ATRIS_PROGRESS_DIR': str(progress)}, stdout=slave, stderr=slave)
        os.close(slave)
        output = b''

        def read_for(seconds):
            global output
            end = time.monotonic() + seconds
            while time.monotonic() < end:
                if select.select([master], [], [], min(0.05, max(0, end - time.monotonic())))[0]:
                    output += os.read(master, 65536)
                assert child.poll() is None, output

        def frames():
            return [part.decode().replace('\r', '') for part in output.split(marker)[1:] if part]

        def check_size():
            for frame in frames():
                lines = frame.split('\n')
                assert len(lines) <= height, (width, height, frame)
                assert all(len(line) <= width for line in lines), (width, height, frame)
                assert not frame.endswith('\n'), frame

        def wait_for(previous, predicate):
            end = time.monotonic() + 8
            while time.monotonic() < end:
                read_for(0.05)
                if len(frames()) > previous and predicate(frames()[-1]):
                    read_for(0.1)
                    check_size()
                    assert predicate(frames()[-1]), frames()
                    return frames()[-1]
            raise AssertionError(f'no expected frame: {output!r}')

        def append(text):
            with log.open('a') as stream:
                stream.write(text)

        try:
            print(f'command: node bin/atris.js member board --watch ({width}x{height})')
            idle = wait_for(0, lambda frame: 'idle' in frame or 'nobody' in frame)
            print(f'idle: {idle}')
            previous = len(frames())
            now = datetime.datetime.now(datetime.timezone.utc).isoformat()
            append(f'{now} m-new started: keep the board readable')
            # Wait beyond the folder-watch delay; the partial start must stay idle.
            wait_for(previous, lambda frame: frame == idle)
            assert all(frame == idle for frame in frames()), frames()
            print('partial start: still idle')
            previous = len(frames())
            append('\n')
            working = wait_for(previous, lambda frame: 'working' in frame)
            assert 'builder' in working, working
            assert 'idle' not in working and 'older' not in working, working
            print(f'working: {working!r}')
            previous = len(frames())
            append(f'{now} m-new finished: ok\n')
            done = wait_for(previous, lambda frame: 'ok' in frame and 'working' not in frame)
            assert 'working' not in done, done
            print(f'finished: {done!r}')
            previous = len(frames())
            log.write_text(old)
            restored = wait_for(previous, lambda frame: frame == idle)
            print(f'idle again: {restored}')
            child.send_signal(signal.SIGINT)
            code = child.wait(timeout=5)
            assert code == 0, code
            print(f'exit: {code}')
        finally:
            if child.poll() is None:
                child.terminate()
                child.wait(timeout=5)
            os.close(master)
print('three small layouts keep complete states within the screen through live transitions')
