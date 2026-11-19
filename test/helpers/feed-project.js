'use strict';

// A scratch project for the feed tests: atris/, a team, its own task store,
// a person's environment with no agent markers, members ON, the feed's
// default model set to a tool these tests treat as installed, and stand-in
// runs and turns so nothing real starts.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tasks = require('../../lib/task-db');

const AGENT_MARKERS = [
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CURSOR_AGENT', 'DEVIN_SESSION_ID',
  'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'ATRIS_MISSION_DRIVER_DETACHED', 'ATRIS_MISSION_DRIVER_PARENT_PID',
  'ATRIS_DISPATCH_DEPTH', 'ATRIS_AGENT_PROOF_ONLY',
];

function project(t, members = ['scout', 'writer', 'closer'], { on = true, engine = 'codex' } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'decision-feed-')));
  const root = path.join(dir, 'proj');
  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris', 'atris.md'), '# atris\n');
  for (const name of members) {
    fs.mkdirSync(path.join(root, 'atris', 'team', name), { recursive: true });
    fs.writeFileSync(path.join(root, 'atris', 'team', name, 'MEMBER.md'), `---\nname: ${name}\nrole: ${name} of the team\n---\n# ${name}\n`);
  }
  if (engine) fs.writeFileSync(path.join(root, 'atris', '.config'), JSON.stringify({ feed: { default_engine: engine } }));
  const dbPath = path.join(dir, 'tasks.db');
  const saved = { db: process.env.ATRIS_TASKS_DB, installed: process.env.ATRIS_FEED_INSTALLED, board: process.env.ATRIS_FEED_BOARD };
  process.env.ATRIS_TASKS_DB = dbPath;
  process.env.ATRIS_FEED_INSTALLED = 'codex,claude';
  process.env.ATRIS_FEED_BOARD = '0';
  const db = tasks.open(dbPath);
  const env = { ...process.env, ATRIS_TASKS_DB: dbPath, USER: 'owner' };
  for (const marker of AGENT_MARKERS) delete env[marker];
  if (on) for (const name of members) require('../../lib/member-switches').setMemberAwake(name, true, root);
  const spawned = [];
  const turns = [];
  const thinkers = [];
  const deps = {
    spawnRunner: (_root, entry) => { spawned.push(entry); return process.pid; },
    spawnThinker: (_root, names, reason) => { thinkers.push({ names, reason }); return null; },
    isAlive: () => true,
    lowPower: () => false,
    sleeps: [],
    sleep: async (ms) => { deps.sleeps.push(ms); },
    turn: async ({ engine: used, prompt, onText, kind }) => {
      turns.push({ engine: used.id, prompt, kind });
      const ideas = /thinking up ideas for the owner's feed/.test(prompt);
      const text = deps.answer ? deps.answer(prompt, kind)
        : ideas ? 'IDEA\nTITLE: Thank the first ten buyers\nWHY: Thanked buyers come back\nEND\n' : 'Yes, I can start with the five oldest leads.';
      for (const piece of String(text).match(/.{1,12}/gs) || []) onText(piece);
      return { ok: true, text };
    },
  };
  t.after(() => {
    tasks.close();
    for (const [key, name] of [['db', 'ATRIS_TASKS_DB'], ['installed', 'ATRIS_FEED_INSTALLED'], ['board', 'ATRIS_FEED_BOARD']]) {
      if (saved[key] === undefined) delete process.env[name]; else process.env[name] = saved[key];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, root, db, env, deps, spawned, turns, thinkers, agentEnv: { ...env, CLAUDECODE: '1' } };
}

// Something real changed in the project (a new commit): the one thing, besides the person acting, that lets the
// feed ask the team by itself again.
function changed(ctx) {
  fs.mkdirSync(path.join(ctx.root, '.git'), { recursive: true });
  fs.writeFileSync(path.join(ctx.root, '.git', 'HEAD'), `${require('node:crypto').randomBytes(20).toString('hex')}\n`);
}

module.exports = { AGENT_MARKERS, changed, project };
