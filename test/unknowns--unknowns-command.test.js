'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { unknownsCommand } = require('../commands/unknowns');
const taskDb = require('../lib/task-db');

const ORIGINAL_CWD = process.cwd();
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_ENV = { ...process.env };
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-unknowns-cmd-'));

function clearAtrisEnv() {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) delete process.env[key];
  }
}

// Each test gets its own home, db file, and workspace folder, all under TMP_ROOT.
function makeSandbox(label) {
  const base = fs.mkdtempSync(path.join(TMP_ROOT, `${label}-`));
  const home = path.join(base, 'home');
  fs.mkdirSync(home, { recursive: true });
  clearAtrisEnv();
  process.env.HOME = home;
  process.env.ATRIS_TASKS_DB = path.join(base, 'tasks.db');
  process.env.ATRIS_RUNNER_BIN = 'definitely-not-an-atris-runner';
  return { base, workspace: makeWorkspace(base, 'ws') };
}

// atris/atris.md marks the folder as its own workspace, so the root lookup
// stops here and never walks up into some other checkout.
function makeWorkspace(base, name) {
  const dir = path.join(base, name);
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'atris', 'atris.md'), '# protocol\n');
  fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), '# map\n');
  return dir;
}

function teardown() {
  taskDb.close();
  process.chdir(ORIGINAL_CWD);
}

// Runs unknownsCommand with console output captured.
async function run(args) {
  const out = [];
  const err = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...parts) => out.push(parts.join(' '));
  console.error = (...parts) => err.push(parts.join(' '));
  try {
    const code = await unknownsCommand(args);
    return { code, out: out.join('\n'), err: err.join('\n') };
  } finally {
    console.log = realLog;
    console.error = realError;
  }
}

function listedIds(stdout) {
  return [...stdout.matchAll(/^([0-9A-Z]{26}) /gm)].map(match => match[1]);
}

test.after(() => {
  taskDb.close();
  process.chdir(ORIGINAL_CWD);
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

test('help flags and the help word print usage and return 0', async () => {
  const sandbox = makeSandbox('help');
  process.chdir(sandbox.workspace);
  try {
    for (const args of [['--help'], ['-h'], ['help'], ['list', '--help']]) {
      const res = await run(args);
      assert.strictEqual(res.code, 0, `args ${JSON.stringify(args)}`);
      assert.match(res.out, /Usage: atris unknowns "<problem statement>"/);
      assert.match(res.out, /atris unknowns list \[--all\]/);
      assert.match(res.out, /atris unknowns resolve <id>/);
      assert.strictEqual(res.err, '');
    }
  } finally {
    teardown();
  }
});

test('no arguments prints usage and returns 1', async () => {
  const sandbox = makeSandbox('noargs');
  process.chdir(sandbox.workspace);
  try {
    const empty = await run([]);
    assert.strictEqual(empty.code, 1);
    assert.match(empty.out, /Usage: atris unknowns/);

    const blank = await run(['   ', '']);
    assert.strictEqual(blank.code, 1);
    assert.match(blank.out, /Usage: atris unknowns/);
  } finally {
    teardown();
  }
});

test('list on a fresh ledger says there are no open unknowns', async () => {
  const sandbox = makeSandbox('listempty');
  process.chdir(sandbox.workspace);
  try {
    const res = await run(['list']);
    assert.strictEqual(res.code, 0);
    assert.strictEqual(res.out, 'No open unknowns.');

    const all = await run(['list', '--all']);
    assert.strictEqual(all.code, 0);
    assert.strictEqual(all.out, 'No open unknowns.');
  } finally {
    teardown();
  }
});

test('resolve rejects missing arguments and unknown ids with exit 1', async () => {
  const sandbox = makeSandbox('resolvebad');
  process.chdir(sandbox.workspace);
  try {
    const noId = await run(['resolve']);
    assert.strictEqual(noId.code, 1);
    assert.match(noId.err, /Usage: atris unknowns resolve <id>/);

    const noText = await run(['resolve', 'ABC123']);
    assert.strictEqual(noText.code, 1);
    assert.match(noText.err, /Usage: atris unknowns resolve <id>/);

    const blankText = await run(['resolve', 'ABC123', '   ']);
    assert.strictEqual(blankText.code, 1);
    assert.match(blankText.err, /Usage: atris unknowns resolve <id>/);

    const missing = await run(['resolve', 'ABC123', 'we looked']);
    assert.strictEqual(missing.code, 1);
    assert.strictEqual(missing.err, 'Unknown not found: ABC123');
    assert.strictEqual(missing.out, '');
  } finally {
    teardown();
  }
});

test('a problem with no runner falls back to a stub row, then lists and resolves it', async () => {
  const sandbox = makeSandbox('roundtrip');
  process.chdir(sandbox.workspace);
  try {
    const created = await run(['Should we ship a blindspot ledger?']);
    assert.strictEqual(created.code, 0, created.err);
    assert.match(created.out, /^Top questions:/);
    assert.match(created.out, /1\. What existing code path already owns "Should we ship a blindspot ledger"\?/);
    assert.match(created.out, /2\. What would make this change costly to reverse after one use\?/);
    assert.match(created.out, /3\. What proof would change the plan before implementation starts\?/);
    assert.strictEqual((created.out.match(/ Confirm: /g) || []).length, 3);
    assert.strictEqual((created.out.match(/ Kill: /g) || []).length, 3);
    assert.match(created.out, /1 unknown written to ledger$/);

    const projection = path.join(fs.realpathSync(sandbox.workspace), '.atris', 'state', 'unknowns.md');
    assert.ok(fs.existsSync(projection), 'ledger file should be rendered');
    const openLedger = fs.readFileSync(projection, 'utf8');
    assert.match(openLedger, /^# Unknowns Ledger/);
    assert.match(openLedger, /## Open\n\n- \*\*[0-9A-Z]{26}\*\* \[unknown_unknown\/costly\] Model unavailable/);
    assert.match(openLedger, /Problem: Should we ship a blindspot ledger\?/);
    assert.match(openLedger, /## Resolved\n\n\(none\)/);

    const listed = await run(['list']);
    assert.strictEqual(listed.code, 0);
    const ids = listedIds(listed.out);
    assert.strictEqual(ids.length, 1, listed.out);
    assert.match(listed.out, /unknown_unknown costly\n  Model unavailable for blindspot pass/);
    assert.match(listed.out, /definitely-not-an-atris-runner CLI not found/);
    assert.ok(!listed.out.includes(fs.realpathSync(sandbox.workspace)), 'plain list hides the workspace path');

    const resolved = await run(['resolve', ids[0], 'No runner installed;', 'stub path verified.']);
    assert.strictEqual(resolved.code, 0, resolved.err);
    assert.strictEqual(resolved.out, `resolved ${ids[0]}`);

    const after = await run(['list']);
    assert.strictEqual(after.code, 0);
    assert.strictEqual(after.out, 'No open unknowns.');

    const resolvedLedger = fs.readFileSync(projection, 'utf8');
    assert.match(resolvedLedger, /## Open\n\n\(none\)/);
    assert.match(resolvedLedger, /## Resolved\n\n- \*\*[0-9A-Z]{26}\*\* \[unknown_unknown\/costly\]/);
    assert.match(resolvedLedger, /Resolution: .+ No runner installed; stub path verified\./);
  } finally {
    teardown();
  }
});

test('resolve accepts an id prefix, and a prefix shared by two rows is ambiguous', async () => {
  const sandbox = makeSandbox('prefix');
  process.chdir(sandbox.workspace);
  try {
    assert.strictEqual((await run(['first problem'])).code, 0);
    assert.strictEqual((await run(['second problem'])).code, 0);

    const listed = await run(['list']);
    const ids = listedIds(listed.out);
    assert.strictEqual(ids.length, 2, listed.out);

    // Ids start with a time prefix, so the first character is shared by both rows.
    const shared = ids[0][0];
    assert.strictEqual(ids[1][0], shared);
    const ambiguous = await run(['resolve', shared, 'which one?']);
    assert.strictEqual(ambiguous.code, 1);
    assert.match(ambiguous.err, new RegExp(`^Ambiguous unknown id "${shared}"\\. Matches: `));
    assert.ok(ambiguous.err.includes(ids[0]) && ambiguous.err.includes(ids[1]));
    assert.strictEqual(listedIds((await run(['list'])).out).length, 2, 'nothing resolved on ambiguity');

    // A longer prefix of one id still points at exactly one row.
    const target = ids[0];
    const resolved = await run(['resolve', target.slice(0, 24), 'found it']);
    assert.strictEqual(resolved.code, 0, resolved.err);
    assert.strictEqual(resolved.out, `resolved ${target}`);
    assert.deepStrictEqual(listedIds((await run(['list'])).out), [ids[1]]);
  } finally {
    teardown();
  }
});

test('a long problem is clipped in the fallback question and trailing punctuation is dropped', async () => {
  const sandbox = makeSandbox('clip');
  process.chdir(sandbox.workspace);
  try {
    const res = await run(['a'.repeat(200)]);
    assert.strictEqual(res.code, 0, res.err);
    assert.ok(
      res.out.includes(`1. What existing code path already owns "${'a'.repeat(87)}"?`),
      res.out
    );
    assert.ok(!res.out.includes('a'.repeat(88)), 'problem text is cut at 87 characters');

    // Extra whitespace between words collapses to single spaces.
    const spaced = await run(['  rotate   the   keys!!  ']);
    assert.strictEqual(spaced.code, 0, spaced.err);
    assert.ok(spaced.out.includes('1. What existing code path already owns "rotate the keys"?'), spaced.out);
  } finally {
    teardown();
  }
});

test('list shows only this workspace unless --all is given', async () => {
  const sandbox = makeSandbox('scope');
  const other = makeWorkspace(sandbox.base, 'other');
  try {
    process.chdir(sandbox.workspace);
    assert.strictEqual((await run(['problem in the first workspace'])).code, 0);

    process.chdir(other);
    const scoped = await run(['list']);
    assert.strictEqual(scoped.code, 0);
    assert.strictEqual(scoped.out, 'No open unknowns.');

    const all = await run(['list', '--all']);
    assert.strictEqual(all.code, 0);
    assert.strictEqual(listedIds(all.out).length, 1, all.out);
    assert.ok(all.out.includes(fs.realpathSync(sandbox.workspace)), 'list --all names the owning workspace');

    // Resolving from the other workspace falls back to a global id lookup.
    const id = listedIds(all.out)[0];
    const resolved = await run(['resolve', id, 'resolved from elsewhere']);
    assert.strictEqual(resolved.code, 0, resolved.err);
    const ledger = path.join(fs.realpathSync(sandbox.workspace), '.atris', 'state', 'unknowns.md');
    assert.match(fs.readFileSync(ledger, 'utf8'), /Resolution: .+ resolved from elsewhere/);
  } finally {
    teardown();
  }
});
