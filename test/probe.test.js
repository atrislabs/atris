'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizePath,
  normalizeBash,
  fileOpCommand,
  atrisCliCommand,
  atrisCliResult,
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
