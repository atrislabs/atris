#!/usr/bin/env node
'use strict';

// The made-up world the orb walk runs in: a small workspace with a team, a
// roster, two running jobs, and writers that answer at once. It is the same
// world test/gm-bet.test.js and test/gm-phone.test.js build, so the walk sees
// what the tests see. Nothing here reads or writes the real home: the walk
// starts this file as its own process with HOME pointed at a temp folder.
//
//   node scripts/orb-walk-fixture.js <workspace> <token>
//     serves the real phone handler, desk, and page on 127.0.0.1 (a free
//     port) and prints one json line: { "port": N }
//
// The walk changes this world only through files in <workspace>/.walk:
//   scoreboard-on   the desk starts asking for the owner's weekly number
//   missions.json   the jobs the desk reads (addYesJobs adds two yes asks)

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const TEAM = [
  ['builder', 'Builder', 'Writes and tests the code'],
  ['launcher', 'Launcher', 'Writes posts, pages, and launch copy'],
  ['researcher', 'Researcher', 'Finds ground truth on any topic'],
  ['navigator', 'Navigator', 'Plans the next few moves'],
];

const ROSTER = '# roster\n\n## search\n- claude code, model: haiku 5.5\n\n## build\n- claude code, model: opus 5.5\n\n## review\n- codex, model: gpt-6.1-sol\n\n## team\n- launcher: codex, model: gpt-6.1-sol\n';

const IDEAS = [
  'Write a getting started page for the phone with a 30 second screen recording',
  'Record a two minute demo video of the phone for the readme',
  'Email ten recent installers a three question survey about their first hour',
  'Add a pricing table for small teams to the landing page',
  'Draft a weekly digest of what the team finished for the newsletter',
  'Build a sample workspace new people can copy in one step',
];

const NUMBERS = [
  { name: 'weekly installs', up: true },
  { name: 'people who finished their first run', up: true },
  { name: 'money that came in this month', up: true },
];

// two running jobs from the start: the job deck has two cards to flip
const RUNNING = {
  m1: { owner: 'builder', status: 'running', objective: 'Write the getting started page.', created_min: 50, tick_min: 1, max_wall_seconds: 4 * 3600 },
  m2: { owner: 'launcher', status: 'running', objective: 'Record the screen capture for the page.', created_min: 30, tick_min: 2 },
};

// two jobs waiting on the owner's yes, added when the walk reaches the yes card
const YES_JOBS = {
  'm-yes1': { owner: 'navigator', status: 'blocked', objective: 'Plan the pricing page.', created_min: 90, tick_min: 20, ask: 'ship the pricing page now?', bet: 'b-yes1', title: 'Add a pricing table for small teams to the landing page' },
  'm-yes2': { owner: 'researcher', status: 'blocked', objective: 'Survey ten recent installers.', created_min: 70, tick_min: 15, ask: 'ok to email the survey to ten recent installers?', bet: 'b-yes2', title: 'Email ten recent installers a three question survey about their first hour' },
};

function idea(title) {
  return {
    title,
    why_now: 'installs last week were 1,400 and the phone page just went live, so new people have nothing to try first.',
    expect: '300 more npm installs in the week before nov 1',
    target: { metric: 'installs', baseline: 1400, goal: 1700 },
    check_in_days: 9,
    check_date: '2026-11-01',
    metric_source: 'npm installs for atris',
    verify: 'test -s docs/gm-phone.md',
    cost: 'about 4 hours of agent time, $0',
    steps: [
      { text: 'draft the getting started page', who: 'team', member: 'builder', public: false },
      { text: 'record a 30 second screen capture of the phone', who: 'team', member: 'launcher', public: false },
      { text: 'publish the page and post the recording', who: 'you', public: true },
    ],
  };
}

const walkDir = ws => path.join(ws, '.walk');

// The fixture workspace: members, a roster, the engines this machine "has",
// and the jobs file. Returns the workspace path.
function makeWorkspace(ws) {
  fs.mkdirSync(path.join(ws, 'atris', 'wiki', 'briefs'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'atris', 'now.md'), '# now\n\n- the phone page is live\n');
  for (const [name, role, description] of TEAM) {
    fs.mkdirSync(path.join(ws, 'atris', 'team', name), { recursive: true });
    fs.writeFileSync(path.join(ws, 'atris', 'team', name, 'MEMBER.md'), `---\nname: ${name}\nrole: ${role}\ndescription: ${description}\n---\n\n# ${name}\n`);
  }
  fs.writeFileSync(path.join(ws, 'atris', 'ROSTER.md'), ROSTER);
  // which tools count as installed comes from the workspace's own registry
  // file, as in the tests, so no look at this machine's PATH decides it
  const ids = Object.keys(require('../lib/runner-command').RUNNER_PROFILE_DEFS);
  const checked = new Date().toISOString();
  const engines = ids.map(id => (['claude', 'codex'].includes(id) ? { id, health: { status: 'ready' } } : { id, installed: false, health: { status: 'not_installed', checked_at: checked } }));
  fs.mkdirSync(path.join(ws, '.atris', 'state'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.atris', 'state', 'engines.json'), `${JSON.stringify({ engines })}\n`);
  fs.mkdirSync(walkDir(ws), { recursive: true });
  fs.writeFileSync(path.join(walkDir(ws), 'missions.json'), `${JSON.stringify(RUNNING, null, 2)}\n`);
  return ws;
}

// Turns on the weekly number question (the desk reads this on every card).
function scoreboardOn(ws) {
  fs.writeFileSync(path.join(walkDir(ws), 'scoreboard-on'), '1\n');
}

// Two jobs that wait on the owner's yes: a ledger row for each and its job.
function addYesJobs(ws, stateDir) {
  const gmBet = require('../lib/gm-bet');
  const file = path.join(walkDir(ws), 'missions.json');
  const missions = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ledger = gmBet.ledgerPath(stateDir);
  fs.mkdirSync(path.dirname(ledger), { recursive: true });
  for (const [id, m] of Object.entries(YES_JOBS)) {
    missions[id] = m;
    fs.appendFileSync(ledger, `${JSON.stringify({ id: m.bet, workspace: ws, created_at: new Date(Date.now() - m.created_min * 60000).toISOString(), status: 'doing', mission_id: id, owner: m.owner, bet: idea(m.title) })}\n`);
  }
  fs.writeFileSync(file, `${JSON.stringify(missions, null, 2)}\n`);
}

// the jobs file, with every time read relative to now so nothing goes stale
function readMissions(ws) {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(path.join(walkDir(ws), 'missions.json'), 'utf8')); } catch { raw = {}; }
  const ago = min => new Date(Date.now() - min * 60000).toISOString();
  const out = new Map();
  for (const [id, m] of Object.entries(raw)) {
    out.set(id, {
      id,
      owner: m.owner,
      status: m.status,
      objective: m.objective,
      created_at: ago(m.created_min),
      last_tick_at: ago(m.tick_min),
      updated_at: ago(m.tick_min),
      ...(m.max_wall_seconds ? { max_wall_seconds: m.max_wall_seconds } : {}),
      human_asks: m.ask ? [m.ask] : [],
    });
  }
  return out;
}

// what the quick reader says about typed words: a question back is
// explained, a plain answer is an answer, anything else an instruction
async function readSaid({ text, card }) {
  const said = String(text || '').trim();
  const asking = /^(what|huh|why|how)\b.{0,12}$/i.test(said) || /\?\s*$/.test(said);
  if (asking && card.kind === 'member') return { ok: true, kind: 'question', reply: `${card.title} is on the getting started page and expects to finish in about three hours.`, suggestions: ['sounds good', 'do the readme first'] };
  if (asking && card.kind === 'question') return { ok: true, kind: 'unclear', reply: 'i am asking which one number would tell you this project is going well, like weekly installs or paying customers.', suggestions: ['weekly installs', 'paying customers'] };
  if (asking) return { ok: true, kind: 'question', reply: 'it means the team writes the page and records a short video, and you post it.', suggestions: [] };
  if (card.kind === 'number') return { ok: true, kind: /^[\d,.]+$/.test(said) ? 'answer' : 'instruction', intent: /tomorrow|not now|later/i.test(said) ? 'later' : null, reply: '' };
  return { ok: true, kind: card.kind === 'question' ? 'answer' : 'instruction', reply: '' };
}

// the atris commands the desk would run, answered the way they answer
async function runCli(args) {
  const json = o => ({ code: 0, stdout: JSON.stringify(o), stderr: '' });
  if (args[0] === 'member' && args[1] === 'steer') {
    if (args.includes('--detach')) return json({ ok: true, action: 'member_run_detached', member: args[2], pid: 4242 });
    return ['builder', 'launcher'].includes(args[2]) ? json({ ok: true, action: 'member_steered', member: args[2] }) : { code: 3, stdout: JSON.stringify({ ok: false, action: 'member_not_running', member: args[2] }), stderr: '' };
  }
  if (args[0] === 'decide' && args[1] === '--json') return json({ ok: true, decisions: [{ number: 1, mission_id: 'm-yes1', ask_index: 0 }, { number: 2, mission_id: 'm-yes2', ask_index: 0 }] });
  if (args[0] === 'decide') return json({ ok: true });
  if (args[0] === 'engine' && args[1] === 'ask') return json({ schema: 'atris.engine_ask.v1', answers: [{ engine: 'codex', ok: true, stdout: JSON.stringify({ verdict: 'pass', reason: 'the page is there.' }) }] });
  if (args[0] === 'mission' && args[1] === 'start') return json({ ok: true, action: 'mission_started', mission: { id: 'm-new', owner: 'builder', status: 'planning' } });
  return json({ ok: true, action: 'mission_run_detached', mission_id: 'm-new', pid: 42 });
}

// a season the board can rate: builder 4 landed of 5, launcher new
function loadSeason() {
  const outcomes = [];
  const at = i => Date.now() - (i + 1) * 3600000;
  const add = (member, kind, n) => { for (let i = 0; i < n; i += 1) outcomes.push({ event_id: `${member}-${kind}-${i}`, task_id: `T-${member}-${kind}-${i}`, member, title: `job ${i}`, kind, at: at(i), claimed_at: at(i + 1) }); };
  add('builder', 'landed', 4);
  add('builder', 'dropped', 1);
  add('launcher', 'landed', 2);
  return { outcomes, claims: [], missions: [], asleep: [], error: null };
}

function fixtureDesk(ws, stateDir, log) {
  const gmBet = require('../lib/gm-bet');
  let n = 0;
  let q = 0;
  const questions = [
    { ask: 'who uses the phone page most right now?', fact: 'the phone page went live this week.', choices: ['solo founders', 'small teams', 'nobody yet'] },
    { ask: 'what would make a small team pay for it?', fact: 'installs dropped to 1,511 last week.', choices: ['saving them hours', 'fewer mistakes'] },
  ];
  return gmBet.createBetDesk({
    workspaceRoot: ws,
    ledgerFile: gmBet.ledgerPath(stateDir),
    attemptsFile: gmBet.attemptsPath(stateDir),
    log,
    generate: async () => ({ ok: true, bet: idea(IDEAS[n++ % IDEAS.length]) }),
    generateQuestion: async () => { const next = questions[q++]; return next ? { ok: true, question: next } : { ok: false, reason: 'no more questions here' }; },
    bundle: { sources: { installs: { data: { last_week: 1400, week_before: 1300 }, best: { best: 1550, weeks: 8 } } } },
    choices: false,
    get scoreboard() { return fs.existsSync(path.join(walkDir(ws), 'scoreboard-on')); },
    suggestScoreboard: async () => ({ ok: true, choices: NUMBERS }),
    readSaid,
    readMissions: () => readMissions(ws),
    readHandoffs: () => [],
    readReceipt: () => null,
    loadSeason,
    reviewer: () => 'codex',
    driverAlive: m => m.status === 'running',
    runCli,
    reviewCli: runCli,
    pollMs: 400,
  });
}

// The real phone handler and page, with this desk. Listens on 127.0.0.1.
async function serveFixture({ ws, stateDir, token, port = 0 }) {
  const phone = require('../lib/gm-phone');
  const { phonePage } = require('../lib/gm-phone-page');
  const hosts = [];
  const handler = phone.createPhoneHandler({
    workspaceRoot: ws,
    token,
    hosts,
    loadView: () => ({ workspace_name: path.basename(ws), roster: [], reviews: [], stuck: [], outcomes: [], policy: {}, target: { landed: 0 }, error: null }),
    runStep: async () => ({ code: 0, last_line: 'ok' }),
    writeTarget: () => true,
    snapshotTarget: () => () => true,
    logPath: path.join(stateDir, 'gm-phone-actions.jsonl'),
    page: phonePage,
    makeBetDesk: log => fixtureDesk(ws, stateDir, log),
  });
  const server = http.createServer((req, res) => { handler(req, res).catch(() => res.destroy()); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const at = server.address().port;
  hosts.push(`127.0.0.1:${at}`, `localhost:${at}`);
  return { port: at, server };
}

module.exports = { makeWorkspace, scoreboardOn, addYesJobs, serveFixture, IDEAS };

if (require.main === module) {
  const [ws, token] = process.argv.slice(2);
  if (!ws || !token) {
    process.stderr.write('usage: node scripts/orb-walk-fixture.js <workspace> <token>\n');
    process.exit(2);
  }
  // this world never runs against a real home
  const tmp = fs.realpathSync(os.tmpdir());
  const home = fs.realpathSync(os.homedir());
  if (!home.startsWith(tmp + path.sep)) {
    process.stderr.write('the fixture needs HOME set to a temp folder\n');
    process.exit(2);
  }
  const stateDir = path.join(home, '.atris', 'state');
  serveFixture({ ws: path.resolve(ws), stateDir, token }).then(({ port }) => {
    process.stdout.write(`${JSON.stringify({ port })}\n`);
  }, (err) => {
    process.stderr.write(`could not start: ${err.message}\n`);
    process.exit(1);
  });
  const stop = () => process.exit(0);
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
