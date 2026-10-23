'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { founderCommand } = require('../commands/founder');

function captureConsole() {
  const out = [];
  const err = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args) => out.push(args.join(' '));
  console.error = (...args) => err.push(args.join(' '));
  return {
    out,
    err,
    text() { return out.join('\n'); },
    errText() { return err.join('\n'); },
    restore() {
      console.log = origLog;
      console.error = origErr;
    },
  };
}

function commitAt(cwd, date, message) {
  execFileSync('git', ['commit', '--allow-empty', '-q', '-m', message], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    },
  });
}

test('founder --help prints usage and returns 0', () => {
  const cap = captureConsole();
  let code;
  try {
    code = founderCommand(['--help']);
  } finally {
    cap.restore();
  }
  assert.strictEqual(code, 0);
  assert.strictEqual(cap.err.length, 0);
  assert.ok(cap.out.some((line) => line.startsWith('usage: atris founder')));
  assert.ok(cap.text().includes('--days'));
  assert.ok(cap.text().includes('--global'));
});

test('founder rejects unknown flags and bad option values with exit 2', () => {
  const cap = captureConsole();
  try {
    assert.strictEqual(founderCommand(['--bogus']), 2);
    assert.strictEqual(founderCommand(['--days', 'nope']), 2);
    assert.strictEqual(founderCommand(['--days', '0']), 2);
    assert.strictEqual(founderCommand(['--root']), 2);
  } finally {
    cap.restore();
  }
  assert.strictEqual(cap.out.length, 0);
  assert.ok(cap.errText().includes('unknown founder option: --bogus'));
  assert.ok(cap.errText().includes('--days must be a positive integer'));
  assert.ok(cap.errText().includes('--root needs a directory'));
});

test('founder --json scores the workspace repo and appends a scorecard receipt', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-founder-cmd-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-founder-cmd-home-'));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'founder@test.invalid'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'founder test'], { cwd: root });
    commitAt(root, '2026-07-29T10:00:00Z', 'last week');
    commitAt(root, '2026-08-08T10:00:00Z', 'this week');
    fs.mkdirSync(path.join(root, 'atris'), { recursive: true });

    const env = { ...process.env, HOME: home, ATRIS_FOUNDER_NOW: '2026-08-10T12:00:00Z' };
    const cap = captureConsole();
    let code;
    try {
      code = founderCommand(['--json'], { cwd: root, env });
    } finally {
      cap.restore();
    }
    assert.strictEqual(code, 0);

    const body = JSON.parse(cap.text());
    assert.strictEqual(body.ts, '2026-08-10T12:00:00.000Z');
    assert.strictEqual(body.days, 28);
    assert.strictEqual(body.commitsThisWeek, 1);
    assert.strictEqual(body.commitsLastWeek, 1);
    assert.strictEqual(body.slopePct, 0);
    assert.strictEqual(body.perRepo.length, 1);
    assert.strictEqual(body.perRepo[0].repo, path.basename(root));
    assert.deepStrictEqual(body.perRepo[0].perDay, {
      '2026-07-29': 1,
      '2026-08-08': 1,
    });

    const receipt = path.join(root, '.atris', 'state', 'founder', 'scorecard.jsonl');
    const rows = fs.readFileSync(receipt, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].ts, body.ts);
    assert.strictEqual(rows[0].commitsThisWeek, 1);
  } finally {
    process.env.HOME = prevHome;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('founder in an empty folder talks first-minute and writes no scorecard', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-founder-cmd-empty-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-founder-cmd-empty-home-'));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const cap = captureConsole();
    let code;
    try {
      code = founderCommand([], { cwd: dir, env: { ...process.env, HOME: home } });
    } finally {
      cap.restore();
    }
    assert.strictEqual(code, 0);
    assert.ok(cap.text().includes('this folder is empty'));
    assert.ok(!cap.text().includes('last 7 days'));
    assert.ok(!fs.existsSync(path.join(dir, '.atris')));
  } finally {
    process.env.HOME = prevHome;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
