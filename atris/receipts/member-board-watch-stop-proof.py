"""Run the real watch command in a narrow, short terminal and interrupt it."""
import datetime
import fcntl
import os
import pathlib
import pty
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time

cli = pathlib.Path(__file__).resolve().parents[2] / 'bin/atris.js'
with tempfile.TemporaryDirectory(prefix='atris-watch-stop-') as folder:
    root = pathlib.Path(folder)
    (root / 'atris/team/builder').mkdir(parents=True)
    progress = root / 'progress'
    progress.mkdir()
    log = progress / 'builder.log'
    stamp = datetime.datetime.now(datetime.timezone.utc).isoformat()
    log.write_text(f'{stamp} m-1 started: check board\n')
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 3, 40, 0, 0))
    child = subprocess.Popen(
        ['node', str(cli), 'member', 'board', '--watch'], cwd=root,
        env={**os.environ, 'ATRIS_PROGRESS_DIR': str(progress)},
        stdout=slave, stderr=slave,
    )
    os.close(slave)
    output = b''
    try:
        deadline = time.monotonic() + 10
        while b'check board' not in output and time.monotonic() < deadline:
            if select.select([master], [], [], 0.1)[0]:
                output += os.read(master, 65536)
        assert b'check board' in output, output
        time.sleep(0.15)  # Let the first draw finish installing its handlers.
        with log.open('a') as stream:
            stream.write(f'{stamp} m-1 running: check shutdown\n')
        child.send_signal(signal.SIGINT)
        code = child.wait(timeout=5)
        while select.select([master], [], [], 0.1)[0]:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                break
            if not chunk:
                break
            output += chunk
        print('command: node bin/atris.js member board --watch (40 columns, 3 rows)')
        print(output.decode().replace('\x1b[2J\x1b[H', '').replace('\r', ''))
        print(f'exit: {code}')
        assert code == 0
        assert output.count(b'\x1b[2J\x1b[H') == 1, output
        print('one frame; clean interrupt with a log change queued')
    finally:
        if child.poll() is None:
            child.terminate()
            child.wait(timeout=5)
        os.close(master)
