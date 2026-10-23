const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { stringsCommand } = require('../commands/strings');

// stringsCommand writes .atris/strings.json under process.cwd(), so every
// stateful test runs inside a fresh tmpdir with the cwd restored after.
function inTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-strings-cmd-'));
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    return fn(dir);
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Capture console output so asserts run on the real printed lines, not mocks.
function capture(fn) {
  const lines = [];
  const log = console.log;
  const err = console.error;
  console.log = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  try {
    return { code: fn(), out: lines.join('\n') };
  } finally {
    console.log = log;
    console.error = err;
  }
}

test('stringsCommand with no args prints help and exits 0', () => {
  const { code, out } = capture(() => stringsCommand([]));
  assert.equal(code, 0);
  assert.match(out, /atris strings scan/);
  assert.match(out, /atris strings check/);
});

test('stringsCommand with an unknown subcommand prints help and exits 0', () => {
  const { code, out } = capture(() => stringsCommand(['bogus']));
  assert.equal(code, 0);
  assert.match(out, /atris strings scan/);
});

test('variants on an empty workspace exits 2 with a helpful error', () => {
  inTmp(() => {
    const { code, out } = capture(() => stringsCommand(['variants']));
    assert.equal(code, 2);
    assert.match(out, /no registry yet/);
  });
});

test('term without --prefer is a usage error (exit 2)', () => {
  inTmp(() => {
    const { code, out } = capture(() => stringsCommand(['term', '--ban', 'live']));
    assert.equal(code, 2);
    assert.match(out, /usage: atris strings term/);
  });
});

test('term then check gates banned words in real files', () => {
  inTmp((dir) => {
    fs.writeFileSync(path.join(dir, 'page.md'), 'the site is live now\n');

    const add = capture(() => stringsCommand(['term', '--ban', 'live', '--prefer', 'active', '--why', 'status word']));
    assert.equal(add.code, 0);
    assert.match(add.out, /"live" → "active"/);
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'strings.json')), 'registry written');

    const bad = capture(() => stringsCommand(['check', '.']));
    assert.equal(bad.code, 1, 'banned term present -> exit 1');
    assert.match(bad.out, /page\.md:1/);
    assert.match(bad.out, /"live" → "active"/);

    fs.writeFileSync(path.join(dir, 'page.md'), 'the site is active now\n');
    const good = capture(() => stringsCommand(['check', '.']));
    assert.equal(good.code, 0, 'after fix -> clean');
    assert.match(good.out, /clean/);
  });
});

test('scan then list --json returns a parseable registry', () => {
  inTmp(() => {
    fs.writeFileSync('app.jsx', '<button>Add to cart</button>\n<p>You have unsaved work</p>\n');

    const scanned = capture(() => stringsCommand(['scan', '.', '--json']));
    assert.equal(scanned.code, 0);
    const summary = JSON.parse(scanned.out);
    assert.equal(summary.ok, true);
    assert.equal(summary.scanned, 1);
    assert.ok(summary.strings >= 2);

    const listed = capture(() => stringsCommand(['list', '--json']));
    assert.equal(listed.code, 0);
    const reg = JSON.parse(listed.out);
    const texts = reg.strings.map((s) => s.text);
    assert.ok(texts.includes('Add to cart'));
    assert.ok(texts.includes('You have unsaved work'));
  });
});
