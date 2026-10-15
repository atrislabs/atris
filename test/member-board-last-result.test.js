const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { readBoard, renderBoard } = require('../lib/member-board');

const cliPath = path.resolve(__dirname, '..', 'bin', 'atris.js');
const NOW = Date.parse('2026-10-14T12:00:00.000Z');
const at = (secondsAgo, now = NOW) => new Date(now - secondsAgo * 1000).toISOString();

function fakeDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-last-result-'));
  for (const [name, lines] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, `${name}.log`), lines.map((l) => `${l}\n`).join(''));
  }
  return dir;
}

test('each row carries how the member last finished, even mid run', () => {
  const dir = fakeDir({
    // Working now, but the run before this one failed.
    builder: [
      `${at(900)} m-1 started: first job`,
      `${at(840)} m-1 finished: failed`,
      `${at(60)} m-2 started: second job`,
      `${at(10)} m-2 reading lib/a.js`,
    ],
    // Just finished fine.
    shipper: [`${at(400)} m-3 started: land it`, `${at(240)} m-3 finished: ok`],
    // The runner wrote failed after the stop; stopped wins.
    breaker: [
      `${at(300)} m-4 started: risky`,
      `${at(200)} m-4 finished: stopped`,
      `${at(199)} m-4 finished: failed`,
    ],
    // Never finished anything yet.
    rookie: [`${at(30)} m-5 started: first ever job`],
  });
  try {
    const by = Object.fromEntries(readBoard({ dir, now: NOW }).map((r) => [r.member, r]));
    assert.equal(by.builder.state, 'working');
    assert.equal(by.builder.last_result, 'failed');
    assert.equal(by.builder.last_result_ago, '14m ago');
    assert.equal(by.shipper.last_result, 'ok');
    assert.equal(by.shipper.last_result_ago, '4m ago');
    assert.equal(by.breaker.last_result, 'stopped');
    assert.equal(by.rookie.last_result, '');
    assert.equal(by.rookie.last_result_ago, '');

    const screen = renderBoard(readBoard({ dir, now: NOW }), dir);
    assert.match(screen, /^member\s+state\s+last result\s+alive\s+/m);
    // No reason was written, so the board says how long the failed run lasted.
    assert.match(screen, /^builder\s+working\s+failed \(after 1m\) 14m ago\s+-\s+/m);
    assert.match(screen, /^shipper\s+done ok\s+ok 4m ago\s+-\s+/m);
    assert.match(screen, /^breaker\s+stopped\s+stopped 3m ago\s+-\s+/m);
    assert.match(screen, /^rookie\s+working\s+-\s+-\s+/m);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('atris member board prints the last result for real, in text and json', () => {
  const now = Date.now();
  const dir = fakeDir({
    builder: [
      `${at(600, now)} m-1 started: old job`,
      `${at(540, now)} m-1 finished: ok`,
      `${at(20, now)} m-2 started: new job`,
      `${at(5, now)} m-2 editing lib/b.js`,
    ],
  });
  try {
    const env = { ...process.env, ATRIS_PROGRESS_DIR: dir };
    const text = spawnSync(process.execPath, [cliPath, 'member', 'board'], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /^member\s+state\s+last result\s+/m);
    assert.match(text.stdout, /^builder\s+working\s+ok 9m ago\s+/m);

    const json = spawnSync(process.execPath, [cliPath, 'member', 'board', '--json'], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(json.status, 0, json.stderr);
    const [row] = JSON.parse(json.stdout).members;
    assert.equal(row.last_result, 'ok');
    assert.equal(row.last_result_ago, '9m ago');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
