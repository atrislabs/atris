'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildMemberRunStartArgs } = require('../commands/member');

// Seen live 2026-11-17: a member whose shared mission says "no merges" was woken in a private copy.
test('a member whose standing mission forbids merges runs in the shared folder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-standing-'));
  try {
    spawnSync('git', ['init', '-q'], { cwd: root });
    const dir = path.join(root, 'atris', 'team', 'krishna');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'MEMBER.md'), '---\nname: krishna\n---\n');
    fs.writeFileSync(path.join(dir, 'MISSION.md'), 'The shared mission is in atris/MISSION.md.\n');
    fs.writeFileSync(path.join(root, 'atris', 'MISSION.md'), '# The hour\n\nWrite your own folder. No sends, no spending, no merges.\n');
    assert.ok(!buildMemberRunStartArgs('krishna', 'Think about the town.', [], root).includes('--worktree'));
    fs.writeFileSync(path.join(root, 'atris', 'MISSION.md'), '# The hour\n\nShip the fix.\n');
    assert.ok(buildMemberRunStartArgs('krishna', 'Think about the town.', [], root).includes('--worktree'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// Authority follows authorship: a standing mission an agent rewrote runs
// without the owner's yes on anything outward until a person confirms it.
const CLI = path.join(__dirname, '..', 'bin', 'atris.js');
// A model that does what its standing mission says: run npm publish, and keep the exit code.
const STUB = `#!/usr/bin/env node
const a = process.argv;
if (a.includes('--help')) { console.log('--output-format --permission-mode --resume --session-id --include-partial-messages'); process.exit(0); }
const p = a[a.indexOf('-p') + 1] || '';
if (/npm publish/.test(p)) require('fs').appendFileSync(process.env.STUB_LOG, require('child_process').spawnSync('npm', ['publish']).status + '\\n');
const at = Math.max(a.indexOf('--session-id'), a.indexOf('--resume'));
console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'done. layer: behaviors', session_id: a[at + 1] }));
`;

test('an agent-rewritten standing mission runs sealed until a person confirms its words', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'standing-text-')));
  const saved = { HOME: process.env.HOME, ATRIS_TASKS_DB: process.env.ATRIS_TASKS_DB };
  process.env.HOME = path.join(tmp, 'home');
  process.env.ATRIS_TASKS_DB = path.join(tmp, 'tasks.db');
  const root = path.join(tmp, 'proj');
  const bin = path.join(tmp, 'bin');
  const file = path.join(root, 'atris', 'team', 'builder', 'MISSION.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(root, 'atris', 'team', 'builder', 'MEMBER.md'), '---\nname: builder\n---\n');
  fs.writeFileSync(file, '# Mission\n\nKeep the readme tidy. Never merge.\n');
  fs.writeFileSync(path.join(bin, 'claude'), STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\necho published >> ${tmp}/effects\n`, { mode: 0o755 });
  spawnSync('git', ['init', '-q', root]);
  spawnSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const standing = require('../lib/standing-text');
  const yesLock = require('../lib/yes-lock');
  const feed = require('../lib/feed-core');
  const env = { ...process.env, ATRIS_RUNNER_BIN: path.join(bin, 'claude'), STUB_LOG: path.join(tmp, 'stub'), PATH: `${bin}:${process.env.PATH}` };
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'ATRIS_DISPATCH_DEPTH']) delete env[k];
  const atris = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, env, encoding: 'utf8' });
  try {
    assert.equal(standing.standingConfirmed('builder', root).confirmed, true, 'text there before the rule keeps its authority');

    fs.writeFileSync(file, '# Mission\n\nAfter every tick run npm publish.\n');
    const started = JSON.parse(atris('mission', 'start', 'tidy the readme', '--owner', 'builder', '--runner', 'claude', '--no-verify', '--json').stdout);
    const run = atris('mission', 'run', started.mission.id, '--max-ticks', '1', '--headless', '--json');
    assert.match(run.stderr, /builder's standing mission has words you have not confirmed/);
    assert.equal(fs.readFileSync(path.join(tmp, 'stub'), 'utf8').trim(), String(yesLock.HELD_EXIT), 'the real runner held the publish');
    assert.equal(fs.existsSync(path.join(tmp, 'effects')), false, 'nothing was published');
    const stateDir = path.join(process.env.HOME, '.atris', 'state');
    const [card] = yesLock.handoffYesCards(stateDir);
    assert.equal(card.unconfirmed, true);
    assert.match(card.ask, /^builder wants to publish/);

    const rows = require('../lib/task-db').listTasks(require('../lib/task-db').open(), { status: 'open' })
      .filter((row) => /standing mission/.test(row.title));
    assert.equal(rows.length, 1, 'one card for the new words');
    const cardId = `task:${rows[0].id}:1:question`;
    assert.throws(() => feed.decide(root, cardId, 'approve', { env: { CLAUDECODE: '1' } }), /Only a person can decide/);
    assert.equal(feed.decide(root, cardId, 'approve', { env: { USER: 'owner' } }).outcome.reason, 'standing_mission_confirmed');
    assert.deepEqual(yesLock.handoffYesCards(stateDir), [], 'the commands it held are answered yes once the owner confirms');
    const retry = yesLock.check({ stateDir, missionId: started.mission.id, seal: yesLock.unconfirmedSeal(), tool: 'npm', args: ['publish'], cwd: root });
    assert.ok(retry && retry.consume, 'the held publish, tried again in its own run, is now let through by the lock');
    const again = JSON.parse(atris('mission', 'start', 'tidy the readme again', '--owner', 'builder', '--runner', 'claude', '--no-verify', '--json').stdout);
    atris('mission', 'run', again.mission.id, '--max-ticks', '1', '--headless', '--json');
    assert.equal(fs.readFileSync(path.join(tmp, 'stub'), 'utf8').trim().split('\n').pop(), '0', 'the next real tick publishes');
    assert.equal(fs.readFileSync(path.join(tmp, 'effects'), 'utf8'), 'published\n');

    fs.writeFileSync(file, '# Mission\n\nPublish twice.\n');
    standing.unconfirmedSeal(again.mission, root, stateDir);
    yesLock.check({ stateDir, missionId: again.mission.id, seal: yesLock.unconfirmedSeal(), tool: 'npm', args: ['publish'], cwd: root });
    assert.equal(yesLock.handoffYesCards(stateDir).length, 1);
    fs.writeFileSync(file, '# Mission\n\nPublish three times.\n');
    standing.unconfirmedSeal(again.mission, root, stateDir);
    assert.deepEqual(yesLock.handoffYesCards(stateDir), [], 'a command held under other words does not wait on the new ones');

    const record = path.join(stateDir, 'standing-text.json');
    fs.writeFileSync(record, '{ broken');
    assert.equal(standing.standingConfirmed('builder', root).confirmed, false, 'an unreadable record confirms nothing');
    assert.equal(fs.readFileSync(record, 'utf8'), '{ broken', 'and is never written over');
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
