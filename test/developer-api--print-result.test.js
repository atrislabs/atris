'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { printResult } = require('../lib/developer-api');

function capture() {
  const logs = [];
  const errs = [];
  return {
    logs,
    errs,
    io: {
      log: (...args) => logs.push(args),
      err: (...args) => errs.push(args),
    },
  };
}

test('printResult logs text to stdout on success', () => {
  const { logs, errs, io } = capture();
  printResult({ json: false, ok: true, text: 'balance: $12.50' }, io);
  assert.deepEqual(logs, [['balance: $12.50']]);
  assert.deepEqual(errs, []);
});

test('printResult sends failures to stderr, preferring error over text', () => {
  const { logs, errs, io } = capture();
  printResult({ json: false, ok: false, error: 'not logged in', text: 'ignored' }, io);
  assert.deepEqual(errs, [['not logged in']]);
  assert.deepEqual(logs, []);
});

test('printResult falls back to text, then to a generic message, on failure', () => {
  const first = capture();
  printResult({ json: false, ok: false, text: 'only text' }, first.io);
  assert.deepEqual(first.errs, [['only text']]);

  const second = capture();
  printResult({ json: false, ok: false }, second.io);
  assert.deepEqual(second.errs, [['request failed']]);

  const third = capture();
  printResult({ json: false, ok: false, error: '', text: '' }, third.io);
  assert.deepEqual(third.errs, [['request failed']]);
  assert.deepEqual(third.logs, []);
});

test('printResult in json mode logs the payload as one line of JSON, even on failure', () => {
  const okRun = capture();
  printResult({ json: true, ok: true, text: 'human text', payload: { ok: true, balance: 42 } }, okRun.io);
  assert.equal(okRun.logs.length, 1);
  assert.equal(okRun.logs[0].length, 1);
  assert.deepEqual(JSON.parse(okRun.logs[0][0]), { ok: true, balance: 42 });
  assert.equal(okRun.logs[0][0], '{"ok":true,"balance":42}');
  assert.deepEqual(okRun.errs, []);

  const failRun = capture();
  printResult(
    { json: true, ok: false, error: 'boom', payload: { ok: false, error: 'boom', status: 500 } },
    failRun.io
  );
  assert.deepEqual(failRun.logs, [['{"ok":false,"error":"boom","status":500}']]);
  assert.deepEqual(failRun.errs, []);
});

test('printResult in json mode builds an error payload when none is given', () => {
  const withError = capture();
  printResult({ json: true, ok: false, error: 'bad amount', text: 'other' }, withError.io);
  assert.deepEqual(withError.logs, [['{"ok":false,"error":"bad amount"}']]);

  const withText = capture();
  printResult({ json: true, ok: false, text: 'from text' }, withText.io);
  assert.deepEqual(withText.logs, [['{"ok":false,"error":"from text"}']]);

  const bare = capture();
  printResult({ json: true }, bare.io);
  assert.deepEqual(bare.logs, [['{"ok":false,"error":"request failed"}']]);

  const nullPayload = capture();
  printResult({ json: true, payload: null, error: 'null payload' }, nullPayload.io);
  assert.deepEqual(nullPayload.logs, [['{"ok":false,"error":"null payload"}']]);
});

test('printResult keeps falsy but non-null payloads as given', () => {
  for (const [payload, expected] of [[0, '0'], [false, 'false'], ['', '""'], [[], '[]']]) {
    const { logs, errs, io } = capture();
    printResult({ json: true, ok: true, payload }, io);
    assert.deepEqual(logs, [[expected]]);
    assert.deepEqual(errs, []);
  }
});

test('printResult writes to the console when no io is passed', () => {
  const realLog = console.log;
  const realErr = console.error;
  const logs = [];
  const errs = [];
  console.log = (...args) => logs.push(args);
  console.error = (...args) => errs.push(args);
  try {
    printResult({ json: false, ok: true, text: 'hello' });
    printResult({ json: false, ok: false, error: 'nope' });
    printResult({ json: true, payload: { ok: true } }, {});
  } finally {
    console.log = realLog;
    console.error = realErr;
  }
  assert.deepEqual(logs, [['hello'], ['{"ok":true}']]);
  assert.deepEqual(errs, [['nope']]);
});

test('printResult uses a custom log for output but falls back to console for the missing channel', () => {
  const realErr = console.error;
  const errs = [];
  console.error = (...args) => errs.push(args);
  const logs = [];
  try {
    printResult({ json: false, ok: true, text: 'fine' }, { log: (line) => logs.push(line) });
    printResult({ json: false, ok: false, error: 'broken' }, { log: (line) => logs.push(line) });
  } finally {
    console.error = realErr;
  }
  assert.deepEqual(logs, ['fine']);
  assert.deepEqual(errs, [['broken']]);
});
