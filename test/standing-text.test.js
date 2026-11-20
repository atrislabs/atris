'use strict';

// Authority follows authorship: a standing mission an agent rewrote runs
// without the owner's yes on anything outward until a person confirms it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

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
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
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
    assert.match(run.stderr, /builder's standing mission was changed by an agent/);
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
    assert.equal(standing.unconfirmedSeal(started.mission, root, stateDir), null, 'confirmed words carry the owner\'s yes again');
    assert.deepEqual(yesLock.handoffYesCards(stateDir), [], 'and the old yes cards are gone');
    const again = JSON.parse(atris('mission', 'start', 'tidy the readme again', '--owner', 'builder', '--runner', 'claude', '--no-verify', '--json').stdout);
    atris('mission', 'run', again.mission.id, '--max-ticks', '1', '--headless', '--json');
    assert.equal(fs.readFileSync(path.join(tmp, 'stub'), 'utf8').trim().split('\n').pop(), '0', 'the next real tick publishes');
    assert.equal(fs.readFileSync(path.join(tmp, 'effects'), 'utf8'), 'published\n');

    const record = path.join(stateDir, 'standing-text.json');
    fs.writeFileSync(record, '{ broken');
    assert.equal(standing.standingConfirmed('builder', root).confirmed, false, 'an unreadable record confirms nothing');
    assert.equal(fs.readFileSync(record, 'utf8'), '{ broken', 'and is never written over');

    const { kind, ...legacy } = yesLock.handoffSeal()[0];
    fs.writeFileSync(path.join(stateDir, 'yes-locks', 'old.json'), JSON.stringify({ mission_id: 'old', owner: 'scout',
      locks: [{ ...legacy, requests: [{ hash: 'h1', key: '{}', command: 'npm publish', asked_at: 'then' }] }] }));
    assert.equal(kind, 'handoff');
    assert.deepEqual(yesLock.handoffYesCards(stateDir).map((c) => c.who), ['scout'], 'a handoff record saved before kinds keeps its card');
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
