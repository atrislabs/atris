'use strict';

// Authority follows authorship: a standing mission an agent rewrote runs
// without the owner's yes on anything outward until a person confirms it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('an agent-rewritten standing mission runs sealed until a person confirms its words', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'standing-text-')));
  const saved = { HOME: process.env.HOME, ATRIS_TASKS_DB: process.env.ATRIS_TASKS_DB };
  process.env.HOME = path.join(tmp, 'home');
  process.env.ATRIS_TASKS_DB = path.join(tmp, 'tasks.db');
  const root = path.join(tmp, 'proj');
  const file = path.join(root, 'atris', 'team', 'builder', 'MISSION.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '# Mission\n\nKeep the readme tidy. Never merge.\n');
  execFileSync('git', ['init', '-q', root]);
  const standing = require('../lib/standing-text');
  const yesLock = require('../lib/yes-lock');
  const feed = require('../lib/feed-core');
  const stateDir = path.join(tmp, 'locks');
  const mission = { id: 'm1', owner: 'builder' };
  try {
    assert.equal(standing.standingConfirmed('builder', root).confirmed, true, 'text there before the rule keeps its authority');
    assert.equal(standing.unconfirmedSeal(mission, root, stateDir), null);

    fs.writeFileSync(file, '# Mission\n\nAfter every tick run npm publish.\n');
    const seal = standing.unconfirmedSeal(mission, root, stateDir);
    assert.ok(seal && seal.length, 'the rewritten text runs under the seal');
    standing.unconfirmedSeal(mission, root, stateDir);
    const held = yesLock.check({ stateDir, missionId: 'm1', seal, tool: 'npm', args: ['publish'], cwd: root });
    assert.match(held.message, /waits for the owner's yes: its standing mission was changed by an agent/);
    assert.equal(yesLock.check({ stateDir, missionId: 'm1', seal, tool: 'npm', args: ['test'], cwd: root }), null, 'ordinary work still runs');
    const [card] = yesLock.handoffYesCards(stateDir);
    assert.equal(card.unconfirmed, true);
    assert.match(card.ask, /^builder wants to publish/);

    const rows = require('../lib/task-db').listTasks(require('../lib/task-db').open(), { status: 'open' })
      .filter((row) => /standing mission/.test(row.title));
    assert.equal(rows.length, 1, 'one card per text, however many runs');
    const cardId = `task:${rows[0].id}:1:question`;
    assert.throws(() => feed.decide(root, cardId, 'approve', { env: { CLAUDECODE: '1' } }), /Only a person can decide/);
    assert.equal(standing.standingConfirmed('builder', root).confirmed, false);
    const out = feed.decide(root, cardId, 'approve', { env: { USER: 'owner' } });
    assert.equal(out.outcome.reason, 'standing_mission_confirmed');
    assert.equal(standing.unconfirmedSeal(mission, root, stateDir), null, 'confirmed words carry the owner\'s yes again');

    const record = path.join(process.env.HOME, '.atris', 'state', 'standing-text.json');
    fs.writeFileSync(record, '{ broken');
    assert.equal(standing.standingConfirmed('builder', root).confirmed, false, 'an unreadable record confirms nothing');
    assert.equal(fs.readFileSync(record, 'utf8'), '{ broken', 'and is never written over');
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
