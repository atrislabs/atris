'use strict';

// A member folder with a card that exists but cannot be read as a file must
// still be treated as a runnable teammate: the roster view keeps listing it
// and a roster pick still resolves for it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { teamRosterView, memberRosterEngine } = require('../lib/member-engine');
const { readEngineRegistry, setEngineHealth } = require('../lib/engine-registry');

const ROOM_ENV = ['ATRIS_MACHINE_ROSTER_PATH', 'ATRIS_MACHINE_ROSTER_MD_PATH', 'ATRIS_ROUTER_EXPLAIN'];

// A scratch project plus a scratch home, so the real ~/.atris roster files
// are never read.
function withRoom(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mut-l226-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mut-l226-home-'));
  const saved = new Map(ROOM_ENV.map((key) => [key, process.env[key]]));
  process.env.ATRIS_MACHINE_ROSTER_PATH = path.join(home, '.atris', 'roster.json');
  process.env.ATRIS_MACHINE_ROSTER_MD_PATH = path.join(home, '.atris', 'ROSTER.md');
  process.env.ATRIS_ROUTER_EXPLAIN = '0';
  try {
    return fn(root);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('an unreadable member card still counts as runnable', () => withRoom((root) => {
  const card = path.join(root, 'atris', 'team', 'zed', 'MEMBER.md');
  fs.mkdirSync(card, { recursive: true });
  fs.writeFileSync(path.join(root, 'atris', 'ROSTER.md'), '# roster\nbuild: codex\n');
  readEngineRegistry(root);
  setEngineHealth('codex', 'ready', root);

  const view = teamRosterView(root);
  assert.ok(view.rows.some((row) => row.member === 'zed'));
  assert.strictEqual(memberRosterEngine('zed', root, { requireMember: false }).engine.id, 'codex');
}));
