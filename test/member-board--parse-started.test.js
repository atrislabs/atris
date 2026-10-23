'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseStarted } = require('../lib/member-board');

test('parseStarted extracts process, engine, run token, and job', () => {
  assert.deepStrictEqual(
    parseStarted('started: [pid 4242 engine codex run 0123456789abcdef] build the board'),
    { pid: 4242, engine: 'codex', run: '0123456789abcdef', job: 'build the board' }
  );
  // Stream events pass the body without the started prefix.
  assert.deepStrictEqual(
    parseStarted('[pid 123 engine claude] review the change'),
    { pid: 123, engine: 'claude', run: '', job: 'review the change' }
  );
});

test('parseStarted supports older lines and optional metadata', () => {
  assert.deepStrictEqual(parseStarted('started: legacy job'), {
    pid: null, engine: '', run: '', job: 'legacy job',
  });
  assert.deepStrictEqual(parseStarted('started:\t[pid 42]   job with trailing spaces  '), {
    pid: 42, engine: '', run: '', job: 'job with trailing spaces  ',
  });
  assert.deepStrictEqual(parseStarted('started: [pid 42 run abcdef0123456789]'), {
    pid: 42, engine: '', run: 'abcdef0123456789', job: '',
  });
});

test('parseStarted leaves malformed tags as job text', () => {
  for (const body of [
    '[pid nope engine codex] job',
    '[pid 42 run short] job',
    'job mentions [pid 42 engine codex]',
  ]) {
    assert.deepStrictEqual(parseStarted(`started: ${body}`), {
      pid: null, engine: '', run: '', job: body,
    });
  }
});

test('parseStarted returns empty metadata for missing or empty input', () => {
  for (const input of [undefined, null, '', 'started:', 'started:   ']) {
    assert.deepStrictEqual(parseStarted(input), {
      pid: null, engine: '', run: '', job: '',
    });
  }
});
