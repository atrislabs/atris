#!/usr/bin/env node
'use strict';

// The owner's way of reading the feed, scripted: two awake members, press
// refresh again and again, scroll past every idea without deciding. Every
// press must bring at least one new card. (Reaching the end of the feed is
// not a press: by itself the feed asks only when something changed, see
// AUTO_RUNS_PER_HOUR in lib/feed-team.js.) Stand-in model; the
// wait between asks of one member is counted, not slept.
//
//   node scripts/feed-scroll-check.js [--asks 30] [--json]

const fs = require('fs');
const os = require('os');
const path = require('path');

const WORDS = ['soap', 'candle', 'buyer', 'gift', 'price', 'shelf', 'photo', 'note', 'bundle', 'label', 'scent', 'ribbon', 'window', 'basket'];

async function runScrollCheck({ asks = 30 } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'feed-scroll-')));
  const root = path.join(dir, 'proj');
  for (const m of ['scout', 'writer']) {
    fs.mkdirSync(path.join(root, 'atris', 'team', m), { recursive: true });
    fs.writeFileSync(path.join(root, 'atris', 'team', m, 'MEMBER.md'), `---\nname: ${m}\nrole: ${m}\n---\n`);
  }
  fs.writeFileSync(path.join(root, 'atris', 'atris.md'), '# atris\n');
  fs.writeFileSync(path.join(root, 'atris', '.config'), JSON.stringify({ feed: { default_engine: 'atris-fast' } }));
  const saved = { db: process.env.ATRIS_TASKS_DB, token: process.env.ATRIS_TOKEN, board: process.env.ATRIS_FEED_BOARD };
  process.env.ATRIS_TASKS_DB = path.join(dir, 'tasks.db');
  process.env.ATRIS_TOKEN = 'scroll-check-stand-in';
  process.env.ATRIS_FEED_BOARD = '0';
  const tasks = require('../lib/task-db');
  const feed = require('../lib/feed-core');
  const team = require('../lib/feed-team');
  tasks.open(process.env.ATRIS_TASKS_DB);
  const env = { ...process.env, USER: 'owner' };
  for (const marker of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CODEX_THREAD_ID', 'ATRIS_AGENT_PROOF_ONLY']) delete env[marker];
  for (const m of ['scout', 'writer']) require('../lib/member-switches').setMemberAwake(m, true, root);
  feed.setTheme(root, 'Sell more soap and candles this month', { env });
  let n = 0;
  let waited = 0;
  const deps = {
    lowPower: () => false,
    spawnThinker: () => null,
    sleep: async (ms) => { waited += ms; },
    turn: async ({ onText }) => {
      let text = '';
      for (let i = 0; i < 2; i += 1) {
        n += 1;
        text += `IDEA\nTITLE: ${WORDS[n % WORDS.length]} and ${WORDS[(n * 3 + 1) % WORDS.length]} idea ${n}\nWHY: More people buy\nSOURCE: From the notes\nEND\n`;
      }
      onText(text);
      return { ok: true, text };
    },
  };
  const rounds = [];
  for (let i = 1; i <= asks; i += 1) {
    const events = [];
    const out = await team.pingStream(root, { reason: 'refresh', env, deps, onEvent: (e) => events.push(e) });
    const made = events.filter((e) => e.type === 'card_done' && !e.merged).length;
    rounds.push({ ask: i, made, reason: out.reason });
    const shown = feed.listCards(root, { env, limit: 100 }).cards.filter((c) => c.needs_decision).map((c) => c.id);
    if (shown.length) feed.passCards(root, shown, { env, now: Date.now() + 11000 });
  }
  tasks.close();
  for (const [key, name] of [['db', 'ATRIS_TASKS_DB'], ['token', 'ATRIS_TOKEN'], ['board', 'ATRIS_FEED_BOARD']]) {
    if (saved[key] === undefined) delete process.env[name]; else process.env[name] = saved[key];
  }
  fs.rmSync(dir, { recursive: true, force: true });
  const empty = rounds.filter((r) => r.made < 1);
  return { asks, ok: empty.length === 0, empty, rounds, waited_ms: waited };
}

module.exports = { runScrollCheck };

if (require.main === module) {
  const args = process.argv.slice(2);
  const asks = args.includes('--asks') ? Number(args[args.indexOf('--asks') + 1]) : 30;
  runScrollCheck({ asks }).then((out) => {
    if (args.includes('--json')) console.log(JSON.stringify(out, null, 2));
    else {
      console.log(`${out.ok ? 'pass' : 'FAIL'}: ${out.asks} asks, ${out.asks - out.empty.length} brought new cards`);
      for (const r of out.empty) console.log(`  ask ${r.ask} brought nothing: ${r.reason}`);
    }
    process.exitCode = out.ok ? 0 : 1;
  });
}
