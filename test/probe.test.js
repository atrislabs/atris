'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  normalizePath,
  normalizeBash,
  fileOpCommand,
  atrisCliCommand,
  atrisCliResult,
  runLocalTerminal,
} = require('../commands/probe');

const LABEL = '/workspace/personal';

test('normalizePath: label-absolute paths rewrite root-relative', () => {
  assert.equal(normalizePath('/workspace/personal', LABEL), '.');
  assert.equal(normalizePath('/workspace/personal/', LABEL), '.');
  assert.equal(normalizePath('/workspace/personal/notes/a.md', LABEL), 'notes/a.md');
  assert.equal(normalizePath('notes/a.md', LABEL), 'notes/a.md');
});

test('normalizeBash: strips the label from embedded paths', () => {
  assert.equal(normalizeBash('cat /workspace/personal/a.md', LABEL), 'cat a.md');
  assert.equal(normalizeBash('ls /workspace/personal', LABEL), 'ls .');
});

test('fileOpCommand: blocks .. traversal in args.path, rejects unknown ops', () => {
  assert.equal(fileOpCommand({ type: 'read', path: '../secrets' }, LABEL), null);
  assert.equal(fileOpCommand({ type: 'write', path: 'a.md' }, LABEL), null);
  assert.match(fileOpCommand({ type: 'read', path: 'a.md' }, LABEL), /head -c 12000/);
  assert.match(fileOpCommand({ type: 'list', path: '.' }, LABEL), /find/);
});

test('atrisCliCommand: parameterized ops validate their arguments', () => {
  assert.equal(atrisCliCommand({ type: 'calendar_date', date: 'tomorrow' }), null);
  assert.match(atrisCliCommand({ type: 'calendar_date', date: '2026-06-11' }), /calendar.*2026-06-11/);
  assert.equal(atrisCliCommand({ type: 'task_show' }), null);
  assert.match(atrisCliCommand({ type: 'task_status' }), /task.*status.*--json/);
});

test('atrisCliResult: missing exit_code is an error, never a silent ok', () => {
  // broken terminal endpoint -> {} (CLI-230: used to report ok + empty stdout)
  const broken = atrisCliResult('atris task status', {});
  assert.equal(broken.status, 'error');
  assert.equal(broken.exit_code, -1);
  assert.match(broken.error, /no exit_code/);

  const ok = atrisCliResult('atris task status', { exit_code: 0, stdout: '{"ok":true}' });
  assert.equal(ok.status, 'ok');

  const failed = atrisCliResult('atris task status', { exit_code: 2, stderr: 'boom' });
  assert.equal(failed.status, 'error');
  assert.equal(failed.error, 'boom');
});

// CLI-231: atris2 mission ticks must execute relayed ops in the LOCAL mission
// workspace, not the remote ai-computer. Before this, a mission in
// atris-fundraise read the hosted computer's files and reported the local
// member (atris/team/maze/MEMBER.md) as missing.
test('runLocalTerminal: executes in the given workspace cwd', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-probe-local-'));
  fs.mkdirSync(path.join(dir, 'atris', 'team', 'maze'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'atris', 'team', 'maze', 'MEMBER.md'), '# maze\nlocal member file\n');

  const read = await runLocalTerminal(fileOpCommand({ type: 'read', path: 'atris/team/maze/MEMBER.md' }, LABEL), dir);
  assert.equal(read.exit_code, 0);
  assert.match(read.stdout, /local member file/);

  const pwd = await runLocalTerminal('pwd', dir);
  assert.equal(pwd.exit_code, 0);
  assert.equal(fs.realpathSync(pwd.stdout.trim()), fs.realpathSync(dir));

  const fail = await runLocalTerminal('cat does-not-exist.md', dir);
  assert.notEqual(fail.exit_code, 0);
  assert.match(String(fail.stderr), /does-not-exist/);

  fs.rmSync(dir, { recursive: true, force: true });
});
