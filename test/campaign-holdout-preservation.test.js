'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { campaignCommand } = require('../commands/campaign');
const { createMemoryStore } = require('../lib/campaign-store');
const { moveHoldoutIn, moveHoldoutBack } = require('../lib/campaign-holdout');

async function fixture(fn) {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'holdout-safe-'));
  const repo = path.join(top, 'repo'); const state = path.join(top, 'state');
  fs.mkdirSync(repo); fs.mkdirSync(state);
  const old = process.cwd(); process.chdir(repo);
  try { await fn(repo, state); } finally { process.chdir(old); fs.rmSync(top, { recursive: true, force: true }); }
}
async function start(state, source, runJudge) {
  const store = createMemoryStore(); let output = '';
  const log = console.log; console.log = (s) => { output += String(s); };
  try {
    const code = await campaignCommand(['start', 'Goal', '--id', 'cmp-test', '--judge', 'test judge', '--budget', '5', '--holdout', source, '--json'], { store, holdoutRoot: state, runJudge, actor: 'human:test' });
    return { code, output, store };
  } finally { console.log = log; }
}
for (const passed of [true, false]) {
  test(`existing holdout prevents ${passed ? 'passing' : 'failing'} judge from running`, async () => fixture(async (repo, state) => {
    const source = path.join(repo, 'new.txt'); const dest = path.join(state, 'campaigns/cmp-test/holdout');
    fs.mkdirSync(dest, { recursive: true }); fs.writeFileSync(source, 'new data'); fs.writeFileSync(path.join(dest, 'old.txt'), 'old data');
    let called = 0;
    const r = await start(state, source, async () => { called++; return { passed, exit: passed ? 0 : 1 }; });
    assert.equal(r.code, 2); assert.match(r.output, /not empty/); assert.equal(called, 0);
    assert.equal(fs.readFileSync(source, 'utf8'), 'new data'); assert.equal(fs.readFileSync(path.join(dest, 'old.txt'), 'utf8'), 'old data');
  }));
}
test('source symlink is refused before the judge runs', async () => fixture(async (repo, state) => {
  fs.writeFileSync(path.join(repo, 'actual'), 'private'); fs.symlinkSync('actual', path.join(repo, 'link'));
  let called = 0; const r = await start(state, 'link', async () => { called++; });
  assert.equal(r.code, 2); assert.equal(called, 0); assert.equal(fs.readFileSync(path.join(repo, 'actual'), 'utf8'), 'private');
  assert.equal(fs.readlinkSync(path.join(repo, 'link')), 'actual');
}));
test('rollback preserves an occupying dangling link and reports the holdout path', async () => fixture(async (repo, state) => {
  const source = path.join(repo, 'held'); fs.writeFileSync(source, 'private');
  const r = await start(state, source, async () => {
    fs.symlinkSync('missing', source);
    return { passed: true, exit: 0, summary: 'pass' };
  });
  assert.equal(r.code, 1); assert.match(r.output, /holdout remains at/); assert.equal(fs.readlinkSync(source), 'missing');
  assert.equal(fs.readFileSync(path.join(state, 'campaigns/cmp-test/holdout/held'), 'utf8'), 'private');
}));
test('a linked holdout directory is refused without writing through it', async () => fixture(async (repo, state) => {
  const source = path.join(repo, 'held'); fs.writeFileSync(source, 'private');
  const other = path.join(repo, 'other'); fs.mkdirSync(other);
  const camp = path.join(state, 'campaigns/cmp-test'); fs.mkdirSync(camp, { recursive: true }); fs.symlinkSync(other, path.join(camp, 'holdout'));
  const r = moveHoldoutIn(state, 'cmp-test', source); assert.match(r.error, /not a real directory/);
  assert.deepEqual(fs.readdirSync(other), []); assert.equal(fs.readFileSync(source, 'utf8'), 'private');
}));
test('rollback refuses an already occupied original path', async () => fixture(async (repo, state) => {
  const source = path.join(repo, 'held'); fs.writeFileSync(source, 'original');
  const moved = moveHoldoutIn(state, 'cmp-test', source); fs.writeFileSync(source, 'replacement');
  assert.equal(moveHoldoutBack(moved).ok, false);
  assert.equal(fs.readFileSync(source, 'utf8'), 'replacement'); assert.equal(fs.readFileSync(moved.path, 'utf8'), 'original');
}));

test('cross-device copy publishes exclusively when a destination appears', async (t) => fixture(async (repo, state) => {
  const source = path.join(repo, 'held'); fs.writeFileSync(source, 'original');
  const dest = path.join(state, 'campaigns/cmp-test/holdout/held');
  const realLink = fs.linkSync;
  t.mock.method(fs, 'linkSync', (from, to) => {
    if (from === source) { const error = new Error('cross device'); error.code = 'EXDEV'; throw error; }
    fs.writeFileSync(dest, 'occupied', { flag: 'wx' });
    return realLink(from, to);
  });
  const result = moveHoldoutIn(state, 'cmp-test', source);
  assert.match(result.error, /could not move/);
  assert.equal(fs.readFileSync(source, 'utf8'), 'original'); assert.equal(fs.readFileSync(dest, 'utf8'), 'occupied');
}));
test('source replacement before removal keeps the replacement and published original', async (t) => fixture(async (repo, state) => {
  const source = path.join(repo, 'held'); fs.writeFileSync(source, 'original');
  const realLink = fs.linkSync;
  t.mock.method(fs, 'linkSync', (from, to) => {
    realLink(from, to);
    fs.unlinkSync(source); fs.writeFileSync(source, 'replacement');
  });
  const r = moveHoldoutIn(state, 'cmp-test', source);
  assert.match(r.error, /source changed/);
  assert.equal(fs.readFileSync(source, 'utf8'), 'replacement');
  assert.equal(fs.readFileSync(path.join(state, 'campaigns/cmp-test/holdout/held'), 'utf8'), 'original');
}));

test('real CLI refuses existing holdouts before running either judge', async () => fixture(async (repo, state) => {
  const { spawnSync } = require('node:child_process');
  const cli = path.resolve(__dirname, '../bin/atris.js');
  for (const judge of ['true', 'false']) {
    const source = path.join(repo, 'held'); const dest = path.join(state, 'campaigns/cmp-test/holdout');
    fs.mkdirSync(dest, { recursive: true }); fs.writeFileSync(source, 'new data'); fs.writeFileSync(path.join(dest, 'held'), 'old data');
    const env = { ...process.env, ATRIS_CAMPAIGN_DB: path.join(state, 'atris.db'), ATRIS_SKIP_UPDATE_CHECK: '1' };
    const result = spawnSync(process.execPath, [cli, 'campaign', 'start', 'Goal', '--id', 'cmp-test', '--judge', judge, '--budget', '5', '--holdout', 'held', '--json'], { cwd: repo, env, encoding: 'utf8' });
    assert.equal(result.status, 2, result.stderr + result.stdout); assert.match(result.stdout, /not empty/);
    assert.equal(fs.readFileSync(source, 'utf8'), 'new data'); assert.equal(fs.readFileSync(path.join(dest, 'held'), 'utf8'), 'old data');
  }
}));
