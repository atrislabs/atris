"""Local test protocol, NOT production backend routes or authentication.

Imports the real owned CLI helper from an explicit directory. All spawned children
are sleeps in dedicated process groups; shutdown cancels/reaps every owned child.
"""
import asyncio
import json
import os
from pathlib import Path
import signal
import sys
import tempfile
from urllib.parse import urlsplit, parse_qs

helper_dir = os.environ['ATRIS_TEST_OWNED_CLI_DIR']
sys.path.insert(0, helper_dir)
import owned_cli


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def group_alive(pid):
    try:
        os.killpg(pid, 0)
        return True
    except ProcessLookupError:
        return False


async def main():
    mode = sys.argv[1]
    shutdown = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, shutdown.set)
    temp = tempfile.TemporaryDirectory()
    pid_file = Path(temp.name) / 'owned.pid'
    unrelated = None
    server = None
    jobs = []
    state = {'starts': 0, 'cancels': 0, 'execution_id': 'fixture-run',
             'status': 'running', 'cleanup_status': 'pending', 'outcome': None}
    owned_pid = None
    if mode == 'cleanup-unknown':
        def unknown(_pid):
            raise PermissionError('injected inability to inspect owned process group')
        owned_cli._group_alive = unknown

    async def run():
        try:
            await owned_cli.run_owned_cli(
                [sys.executable, '-c',
                 'import os,sys,time; from pathlib import Path; Path(sys.argv[1]).write_text(str(os.getpid())); time.sleep(60)', str(pid_file)],
                timeout=30, cwd=temp.name, env=dict(os.environ), cleanup_timeout=2)
            state.update(status='completed', cleanup_status='confirmed', outcome='completed')
        except owned_cli.OwnedCliCancelled:
            state.update(status='cancelled', cleanup_status='confirmed', outcome='OwnedCliCancelled')
        except owned_cli.CleanupUnconfirmed:
            state.update(status='failed', cleanup_status='unknown', outcome='CleanupUnconfirmed')
        except BaseException as exc:
            state.update(status='failed', cleanup_status='unknown', outcome=type(exc).__name__)

    async def reply(writer, payload, status=200):
        data = json.dumps(payload).encode()
        writer.write(f'HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {len(data)}\r\nConnection: close\r\n\r\n'.encode() + data)
        await writer.drain()

    async def handle(reader, writer):
        nonlocal owned_pid
        try:
            head = await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), 3)
            lines = head.decode().split('\r\n')
            method, target, _ = lines[0].split(' ')
            headers = dict(line.split(': ', 1) for line in lines[1:] if ': ' in line)
            if any(k.lower() == 'authorization' for k in headers):
                await reply(writer, {'error': 'test must not use credentials'}, 403)
                return
            length = int(headers.get('Content-Length', '0'))
            if length:
                await reader.readexactly(length)
            path = urlsplit(target).path
            if method == 'POST' and path.endswith('/chat/subscription-only'):
                state['starts'] += 1
                jobs.append(asyncio.create_task(run()))
                for _ in range(100):
                    if pid_file.exists():
                        contents = pid_file.read_text().strip()
                        if contents.isdigit():
                            owned_pid = int(contents)
                            break
                    await asyncio.sleep(.01)
                if mode == 'dropped-start':
                    return  # Real TCP response loss after child acceptance.
                await reply(writer, {'execution_id': state['execution_id']})
            elif method == 'GET' and path.endswith('/chat/events'):
                event_state = {**state, 'events': [], 'next_index': 0}
                if state['status'] == 'running':
                    event_state.pop('cleanup_status', None)
                await reply(writer, event_state)
            elif method == 'POST' and path.endswith('/chat/cancel-strict'):
                query = parse_qs(urlsplit(target).query)
                if (query.get('execution_id') != [state['execution_id']]
                        or query.get('workspace_id') != ['fixture-workspace']):
                    await reply(writer, {'error': 'wrong execution scope'}, 404)
                    return
                state['cancels'] += 1
                state['cancel_execution_id'] = query['execution_id'][0]
                state['cancel_workspace_id'] = query['workspace_id'][0]
                if len(jobs) != 1:
                    await reply(writer, {'error': 'fixture supports exactly one owned run'}, 409)
                    return
                jobs[0].cancel()
                await reply(writer, {'execution_id': state['execution_id'], 'status': 'cancel_requested', 'terminal_confirmed': False})
            elif method == 'GET' and path == '/inspect':
                await reply(writer, {**state, 'owned_pid': owned_pid,
                                     'owned_alive': alive(owned_pid) if owned_pid else False,
                                     'owned_group_alive': group_alive(owned_pid) if owned_pid else False,
                                     'unrelated_pid': unrelated.pid, 'unrelated_alive': alive(unrelated.pid)})
            elif method == 'POST' and path == '/shutdown':
                shutdown.set()
                await reply(writer, {'ok': True})
            else:
                await reply(writer, {'error': 'unsupported fixture route'}, 404)
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        finally:
            writer.close()
            await writer.wait_closed()

    try:
        unrelated = await asyncio.create_subprocess_exec(
            sys.executable, '-c', 'import time; time.sleep(60)', start_new_session=True)
        if os.environ.get('ATRIS_TEST_PID_AUDIT'):
            Path(os.environ['ATRIS_TEST_PID_AUDIT']).write_text(str(unrelated.pid))
        server = await asyncio.start_server(handle, '127.0.0.1', int(os.environ.get('ATRIS_TEST_HTTP_PORT', '0')))
        print(json.dumps({'port': server.sockets[0].getsockname()[1], 'unrelated_pid': unrelated.pid}), flush=True)
        await shutdown.wait()
    finally:
        if server is not None:
            server.close()
            await server.wait_closed()
        for job in jobs:
            job.cancel()
        await asyncio.gather(*jobs, return_exceptions=True)
        for owner in list(owned_cli._owners):
            await asyncio.gather(owner, return_exceptions=True)
        # Defensive cleanup also covers failures before the helper reports back.
        for pid in (owned_pid, unrelated.pid if unrelated is not None else None):
            if pid:
                try:
                    os.killpg(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        if unrelated is not None:
            await unrelated.wait()
        temp.cleanup()


asyncio.run(main())
