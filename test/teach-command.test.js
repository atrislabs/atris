'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const teach = require('../commands/teach');

function makeTempDir(t, prefix) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  return tmp;
}

function chdir(t, dir) {
  const prev = process.cwd();
  process.chdir(dir);
  t.after(() => process.chdir(prev));
}

function captureOutput(t) {
  const logs = [];
  const errs = [];
  const stdout = [];
  const origLog = console.log;
  const origErr = console.error;
  const origWrite = process.stdout.write;
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => errs.push(args.join(' '));
  process.stdout.write = (chunk) => { stdout.push(String(chunk)); return true; };
  t.after(() => {
    console.log = origLog;
    console.error = origErr;
    process.stdout.write = origWrite;
  });
  return { logs, errs, stdout };
}

test('teach with no atris/teach folder prints a hint and returns 0', (t) => {
  const cwd = makeTempDir(t, 'atris-teach-empty-');
  chdir(t, cwd);
  const { logs, errs } = captureOutput(t);
  const status = teach();
  assert.equal(status, 0);
  assert.deepEqual(logs, ['no atris/teach folder here. add cases under ./atris/teach.']);
  assert.deepEqual(errs, []);
});

test('teach lists sorted case names without extensions', (t) => {
  const cwd = makeTempDir(t, 'atris-teach-list-');
  chdir(t, cwd);
  const dir = path.join(cwd, 'atris', 'teach');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'zebra.md'), 'z');
  fs.writeFileSync(path.join(dir, 'alpha.json'), '{}');
  fs.writeFileSync(path.join(dir, 'ignored.txt'), 'nope');
  const { logs } = captureOutput(t);
  const status = teach('list');
  assert.equal(status, 0);
  assert.deepEqual(logs, ['cases in atris/teach:', '  alpha', '  zebra']);
});

test('teach <id> writes the case body to stdout and returns 0', (t) => {
  const cwd = makeTempDir(t, 'atris-teach-show-');
  chdir(t, cwd);
  const dir = path.join(cwd, 'atris', 'teach');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'demo.md'), 'hello teach');
  const { stdout, errs } = captureOutput(t);
  const status = teach('demo');
  assert.equal(status, 0);
  assert.equal(stdout.join(''), 'hello teach\n');
  assert.deepEqual(errs, []);
});

test('teach <id> also resolves .json cases and strips a passed extension', (t) => {
  const cwd = makeTempDir(t, 'atris-teach-json-');
  chdir(t, cwd);
  const dir = path.join(cwd, 'atris', 'teach');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'notes.json'), '{"a":1}\n');
  const { stdout } = captureOutput(t);
  assert.equal(teach('notes.md'), 0);
  assert.equal(stdout.join(''), '{"a":1}\n');
});

test('teach --help prints usage and returns 0', (t) => {
  const cwd = makeTempDir(t, 'atris-teach-help-');
  chdir(t, cwd);
  const { logs } = captureOutput(t);
  const status = teach('--help');
  assert.equal(status, 0);
  assert.match(logs.join('\n'), /atris teach: local cases/);
  assert.match(logs.join('\n'), /atris teach <id>/);
});

test('disabled backend verbs return 2 on stderr', (t) => {
  const cwd = makeTempDir(t, 'atris-teach-verbs-');
  chdir(t, cwd);
  const { errs, logs } = captureOutput(t);
  for (const verb of ['add', 'run', 'guards', 'mine', 'drafts', 'fix', 'scaffold']) {
    const status = teach(verb);
    assert.equal(status, 2, verb);
  }
  assert.equal(errs.length, 14);
  assert.match(errs[0], /backend teach verbs are disabled/);
  assert.deepEqual(logs, []);
});

test('unknown case returns 1 with a stderr message', (t) => {
  const cwd = makeTempDir(t, 'atris-teach-missing-');
  chdir(t, cwd);
  fs.mkdirSync(path.join(cwd, 'atris', 'teach'), { recursive: true });
  const { errs } = captureOutput(t);
  const status = teach('nope');
  assert.equal(status, 1);
  assert.deepEqual(errs, ['no case "nope" in atris/teach']);
});

test('extra args on an existing case return 2 as an unknown option', (t) => {
  const cwd = makeTempDir(t, 'atris-teach-extra-');
  chdir(t, cwd);
  const dir = path.join(cwd, 'atris', 'teach');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'demo.md'), 'body\n');
  const { errs, stdout } = captureOutput(t);
  const status = teach('demo', '--bogus');
  assert.equal(status, 2);
  assert.deepEqual(errs, ['unknown teach option: --bogus']);
  assert.deepEqual(stdout, []);
});
