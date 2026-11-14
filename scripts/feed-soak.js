#!/usr/bin/env node
'use strict';

// Soak the local feed: many rounds of ping, propose, pass, talk, approve,
// result and dismiss against a stand-in model that sometimes fails and is
// sometimes slow, with a restart in the middle. Ends by checking that no idea
// was made twice, nothing is stuck, the state files read, and the line is
// empty. Runs in a scratch project with its own task store.
//
//   node scripts/feed-soak.js [--rounds 200] [--seed 7] [--json]

const fs = require('fs');
const os = require('os');
const path = require('path');

const TITLES = [
  'Call the warm leads today', 'Write the spring price note', 'Ask three owners for a quote',
  'Thank the first ten buyers', 'Check every price on the shop page', 'Send a short welcome note',
  'Fix the opening hours line', 'Add a photo to the soap page', 'Answer the oldest customer email',
  'Make the candle sizes clear', 'Call back the two missed buyers', 'Write a one line shop summary',
];

function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
}

async function runSoak({ rounds = 200, seed = 7, log = () => {} } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'feed-soak-')));
  const root = path.join(dir, 'proj');
  const members = ['scout', 'writer', 'closer'];
  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris', 'atris.md'), '# atris\n');
  for (const name of members) {
    fs.mkdirSync(path.join(root, 'atris', 'team', name), { recursive: true });
    fs.writeFileSync(path.join(root, 'atris', 'team', name, 'MEMBER.md'), `---\nname: ${name}\nrole: ${name}\n---\n`);
  }
  fs.writeFileSync(path.join(root, 'atris', '.config'), JSON.stringify({ feed: { default_engine: 'atris-fast' } }));
  const saved = { db: process.env.ATRIS_TASKS_DB, board: process.env.ATRIS_FEED_BOARD, token: process.env.ATRIS_TOKEN };
  process.env.ATRIS_TASKS_DB = path.join(dir, 'tasks.db');
  process.env.ATRIS_FEED_BOARD = '0';
  process.env.ATRIS_TOKEN = 'soak-stand-in';
  const tasks = require('../lib/task-db');
  const feed = require('../lib/feed-core');
  const team = require('../lib/feed-team');
  tasks.open(process.env.ATRIS_TASKS_DB);
  const env = { ...process.env, USER: 'owner', ATRIS_FEED_PINGS_PER_DAY: '100000', ATRIS_FEED_CLOUD_PINGS_PER_DAY: '100000', ATRIS_FEED_MEMBER_GAP_SECONDS: '0', ATRIS_FEED_EMITS_PER_MEMBER_PER_DAY: '100000' };
  for (const marker of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'ATRIS_DISPATCH_DEPTH', 'ATRIS_AGENT_PROOF_ONLY', 'CURSOR_AGENT', 'DEVIN_SESSION_ID']) delete env[marker];
  for (const name of members) require('../lib/member-switches').setMemberAwake(name, true, root);
  feed.setTheme(root, 'Sell more soap and candles this month', { env });

  const random = rng(seed);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const alive = new Set();
  let nextPid = 900000;
  const counts = { ping: 0, propose: 0, pass: 0, talk: 0, approve: 0, result: 0, dismiss: 0, refused: 0, failedTurns: 0, restarts: 0 };
  const turn = async ({ prompt, onText }) => {
    if (random() < 0.15) await new Promise((r) => setTimeout(r, 5 + Math.floor(random() * 20))); // slow
    if (/thinking up ideas for the owner's feed/.test(prompt)) {
      let text = '';
      for (let i = 0; i < 1 + Math.floor(random() * 2); i += 1) text += `IDEA\nTITLE: ${pick(TITLES)}\nWHY: More people buy\nEND\n`;
      // Sometimes the stream is cut off in the middle of a card.
      if (random() < 0.15) { counts.failedTurns += 1; text = text.slice(0, Math.floor(text.length * 0.6)); }
      for (const piece of text.match(/.{1,7}/gs) || []) onText(piece);
      return text.endsWith('END\n') ? { ok: true, text } : { ok: false, text, error: 'stream cut off' };
    }
    if (random() < 0.15) { counts.failedTurns += 1; return { ok: false, error: 'stand-in model failed' }; }
    const text = random() < 0.2 ? 'Sure.\nREVISE {"why": "It brings back buyers"}' : 'Yes, I can do that this week.';
    onText(text);
    void prompt;
    return { ok: true, text };
  };
  const deps = {
    turn,
    lowPower: () => false,
    isAlive: (pid) => alive.has(pid),
    spawnRunner: () => { nextPid += 1; alive.add(nextPid); return nextPid; },
    spawnThinker: () => null,
    memberStillWorking: () => false,
    accept: () => ({ ok: true }),
  };
  const workRun = (entry) => () => {
    const roll = random();
    if (roll < 0.6) {
      try {
        team.emit(root, { as: entry.member, type: 'result', card: entry.card_id, proof: 'Did it and checked it.', env });
      } catch { counts.refused += 1; }
      return { status: 0 };
    }
    if (roll < 0.8) return { status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' } };
    return { status: 1 };
  };
  const runOne = async () => {
    const running = feed.readRuns(root).filter((e) => e.status === 'running');
    if (!running.length) return false;
    const entry = pick(running);
    await feed.runEntry(root, entry.id, { ...deps, spawnSync: workRun(entry) });
    alive.delete(entry.pid);
    if (entry.kind !== 'ping') counts.result += 1;
    return true;
  };
  const cards = (filter = 'all') => feed.listCards(root, { filter, limit: 100, env }).cards;
  const waiting = () => cards('needs_decision').filter((c) => c.kind === 'proposal');
  const failures = [];
  const made = new Set();
  const check = (round) => {
    const file = path.join(root, '.atris', 'state', 'feed', 'runs.json');
    if (fs.existsSync(file)) {
      try { JSON.parse(fs.readFileSync(file, 'utf8')); } catch { failures.push(`round ${round}: the run list does not read`); }
    }
    const titles = waiting().map((c) => c.title.toLowerCase());
    const dupes = titles.filter((t, i) => titles.indexOf(t) !== i);
    if (dupes.length) failures.push(`round ${round}: the same idea twice: ${dupes[0]}`);
    const live = feed.readRuns(root).filter((e) => e.status === 'running');
    if (live.length > feed.FEED_MAX_RUNNING) failures.push(`round ${round}: ${live.length} running at once`);
  };

  for (let round = 1; round <= rounds; round += 1) {
    const action = pick(['ping', 'propose', 'pass', 'talk', 'approve', 'result', 'result', 'dismiss']);
    try {
      if (action === 'ping') {
        counts.ping += 1;
        await team.pingStream(root, { reason: pick(['scroll', 'event']), env, deps, onEvent: (e) => { if (e.type === 'card_done') made.add(e.card.id); } });
      } else if (action === 'propose') {
        counts.propose += 1;
        try { feed.proposeCard(root, { as: pick(members), title: pick(TITLES), why: 'More people buy', env }); } catch { counts.refused += 1; }
      } else if (action === 'pass') {
        const list = waiting();
        if (list.length) { counts.pass += 1; feed.passCards(root, [pick(list).id], { env, now: Date.now() + 11000 }); }
      } else if (action === 'talk') {
        const list = waiting();
        if (list.length) { counts.talk += 1; await feed.talk(root, pick(list).id, 'Can it be smaller?', { env, deps }); }
      } else if (action === 'approve') {
        const list = waiting();
        if (list.length) {
          counts.approve += 1;
          try { feed.decide(root, pick(list).id, 'approve', { env, deps }); } catch { counts.refused += 1; }
        }
      } else if (action === 'result') {
        await runOne();
      } else if (action === 'dismiss') {
        const list = waiting();
        if (list.length) { counts.dismiss += 1; feed.decide(root, pick(list).id, 'dismiss', { env, deps }); }
      }
    } catch (error) {
      failures.push(`round ${round}: ${action} threw: ${error.message}`);
    }
    if (round === Math.floor(rounds / 2)) {
      // The machine restarts: every running process is gone. The next command reconciles.
      counts.restarts += 1;
      alive.clear();
      const fixed = team.repair(root, { env, deps });
      log(`restart at round ${round}: repair fixed ${fixed.fixed.length} thing(s)`);
    }
    check(round);
  }
  // Let everything in line finish.
  for (let i = 0; i < 500; i += 1) {
    feed.pump(root, deps);
    if (!(await runOne())) break;
  }
  feed.pump(root, deps);
  const left = feed.readRuns(root).filter((e) => e.status === 'queued' || e.status === 'running');
  if (left.length) failures.push(`the line is not empty at the end: ${left.length} left`);
  const doctor = await team.doctor(root, { env, deps });
  const stuck = doctor.checks.find((c) => c.name === 'nothing stuck');
  if (!stuck.ok) failures.push(`stuck at the end: ${stuck.detail}`);
  const pendingReplies = team.tasteLines(root).rows.filter((row) => row.metadata.feed && row.metadata.feed.thread && row.metadata.feed.thread.reply_pending);
  if (pendingReplies.length) failures.push(`${pendingReplies.length} reply still shown as coming`);
  for (const name of fs.readdirSync(path.join(root, '.atris', 'state', 'feed'))) {
    if (!name.endsWith('.json')) continue;
    try { JSON.parse(fs.readFileSync(path.join(root, '.atris', 'state', 'feed', name), 'utf8')); } catch { failures.push(`${name} does not read`); }
  }
  // Every finished card is a real task a fresh process reads back.
  const seen = new Set();
  let cursor = null;
  for (let page = 0; page < 20; page += 1) {
    const fresh = require('child_process').spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'atris.js'), 'feed', 'cards', '--since', '0', '--limit', '100', '--json', ...(cursor ? ['--cursor', cursor] : [])],
      { cwd: root, env: { ...env, NODE_NO_WARNINGS: '1' }, encoding: 'utf8' });
    let out = null;
    try { out = JSON.parse(fresh.stdout); } catch { failures.push('a fresh process could not read the feed'); break; }
    for (const card of out.cards) seen.add(card.id);
    cursor = out.next_cursor;
    if (!cursor) break;
  }
  const lost = [...made].filter((id) => !seen.has(id));
  if (lost.length) failures.push(`${lost.length} finished card(s) not read back by a fresh process`);
  const all = feed.listCards(root, { env, since: 0, limit: 100 });
  const summary = {
    rounds,
    seed,
    ok: failures.length === 0,
    failures,
    counts,
    cards: { waiting: all.counts.needs_decision, working: all.counts.working, parked: all.counts.parked, total_changed: all.cards.length },
    ideas_made: team.tasteLines(root).rows.length,
    cards_read_back: `${made.size - lost.length} of ${made.size}`,
  };
  tasks.close();
  for (const [key, name] of [['db', 'ATRIS_TASKS_DB'], ['board', 'ATRIS_FEED_BOARD'], ['token', 'ATRIS_TOKEN']]) {
    if (saved[key] === undefined) delete process.env[name]; else process.env[name] = saved[key];
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return summary;
}

module.exports = { runSoak };

if (require.main === module) {
  const args = process.argv.slice(2);
  const value = (flag, fallback) => (args.includes(flag) ? Number(args[args.indexOf(flag) + 1]) : fallback);
  runSoak({ rounds: value('--rounds', 200), seed: value('--seed', 7), log: (line) => console.error(line) }).then((summary) => {
    if (args.includes('--json')) console.log(JSON.stringify(summary, null, 2));
    else {
      console.log(`${summary.ok ? 'pass' : 'FAIL'}: ${summary.rounds} rounds, seed ${summary.seed}`);
      console.log(`did: ${Object.entries(summary.counts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
      for (const failure of summary.failures) console.log(`  ${failure}`);
    }
    process.exitCode = summary.ok ? 0 : 1;
  });
}
