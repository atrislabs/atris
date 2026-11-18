'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// hermetic: nothing here may touch the real ~/.atris
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-bet-home-'));
process.env.HOME = HOME;
process.env.ATRIS_HOME = path.join(HOME, '.atris');

const gmBet = require('../../lib/gm-bet');
const NOW = new Date(2026, 9, 21, 12, 0, 0).getTime();

const TEAM = [
  ['builder', 'Builder', 'Writes and tests the code'],
  ['launcher', 'Launcher', 'Writes posts, pages, and launch copy'],
  ['researcher', 'Deep Researcher', 'Finds ground truth on any topic'],
];

function workspace({ now = true, briefs = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-bet-ws-'));
  fs.mkdirSync(path.join(root, 'atris', 'wiki', 'briefs'), { recursive: true });
  if (now) fs.writeFileSync(path.join(root, 'atris', 'now.md'), '# now\n\nLast updated: 2026-10-20 at 09:00 local time\n\n- the phone page is live\n');
  if (briefs) {
    for (const [i, name] of ['old.md', 'mid.md', 'new.md', 'newest.md'].entries()) {
      const file = path.join(root, 'atris', 'wiki', 'briefs', name);
      fs.writeFileSync(file, `# brief ${name.replace('.md', '')}\n\nagents that pay for themselves win the week\n`);
      fs.utimesSync(file, new Date(NOW - (10 - i) * 1000), new Date(NOW - (10 - i) * 1000));
    }
  }
  for (const [m, role, description] of TEAM) {
    fs.mkdirSync(path.join(root, 'atris', 'team', m), { recursive: true });
    fs.writeFileSync(path.join(root, 'atris', 'team', m, 'MEMBER.md'), `---\nname: ${m}\nrole: ${role}\ndescription: ${description}\n---\n\n# ${m}\n`);
  }
  return root;
}

function goodBet(over = {}) {
  return {
    title: 'Write a getting started page for atris gm phone with a 30 second screen recording',
    why_now: 'installs last week were 1,400 and the phone page just went live, so new installs have nothing to try first.',
    expect: '300 more npm installs in the week before nov 1',
    target: { metric: 'installs', baseline: 1400, goal: 1700 },
    check_in_days: 9,
    metric_source: 'npm installs for atris',
    verify: 'test -s docs/gm-phone.md',
    cost: 'about 4 hours of agent time, $0',
    steps: [
      { text: 'draft the getting started page', detail: 'docs/gm-phone.md, about 300 words', who: 'team', member: 'builder', public: false },
      { text: 'record a 30 second screen capture of the phone page', who: 'team', member: 'launcher', public: false },
      { text: 'publish the page and post the recording on x', who: 'you', public: true },
    ],
    ...over,
  };
}

// ---- gate three: what works (score bets, feed results back) ------------------------

let rowClock = 0;
function ledgerRow(file, root, id, over) {
  rowClock += 1;
  fs.appendFileSync(file, `${JSON.stringify({ id, workspace: root, created_at: new Date(Date.UTC(2026, 9, 1) + rowClock * 1000).toISOString(), ...over })}\n`);
}

// ---- the desk: the queue, taps, skip, do it, ledger ---------------------------------------

const TITLES = [
  'Write a getting started page for atris gm phone with a 30 second screen recording',
  'Record a two minute demo video of the phone front office for the readme',
  'Add a pricing comparison table for teams to the landing page footer',
  'Email ten recent installers a three question survey about their first hour',
  'Draft a changelog digest of merged pull requests for the weekly newsletter',
  'Build a sample workspace template that new users can clone in one command',
];

// A generator stub that hands out the titles in order. Each call waits on a
// gate the test opens, so in-flight work can be counted.
function stubGenerator({ fail = () => false, bundle = null, reason = 'the model gave an empty answer' } = {}) {
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const gates = [];
  const generate = (opts) => {
    calls.push(opts);
    active += 1;
    maxActive = Math.max(maxActive, active);
    opts.emit({ kind: 'source', key: 'now', line: 'read now.md' });
    if (bundle && opts.onBundle) opts.onBundle(bundle);
    const n = calls.length - 1;
    return new Promise((resolve) => { gates.push(resolve); }).then(() => {
      active -= 1;
      if (fail(n)) return { ok: false, reason };
      return { ok: true, bet: { ...goodBet({ title: TITLES[n % TITLES.length] }), check_date: '2026-10-30' } };
    });
  };
  return {
    generate,
    calls,
    get maxActive() { return maxActive; },
    get active() { return active; },
    // open every gate handed out so far, and let the follow-on work start
    async release() {
      while (gates.length) {
        gates.shift()();
        for (let i = 0; i < 5; i += 1) await new Promise(r => setImmediate(r));
      }
    },
    async releaseOne() {
      gates.shift()();
      for (let i = 0; i < 5; i += 1) await new Promise(r => setImmediate(r));
    },
  };
}

function desk(root, over = {}) {
  const ledgerFile = over.ledgerFile || path.join(root, 'gm-bets.jsonl');
  const cli = [];
  const logs = [];
  let clock = over.start || NOW;
  const gen = over.gen || stubGenerator();
  if (over.answered) answerEveryQuestion(ledgerFile, root, clock);
  const known = over.bundle === undefined ? QBUNDLE : over.bundle;
  const qgen = over.qgen || stubQuestions({ never: Boolean(over.answered) || over.questions === false });
  const d = gmBet.createBetDesk({
    workspaceRoot: root,
    ledgerFile,
    now: () => clock,
    log: row => logs.push(row),
    generate: over.generate || gen.generate,
    ...(over.warm ? {} : { warmOnCreate: false }),
    ...(over.setTimer ? { setTimer: over.setTimer } : {}),
    ...(known ? { bundle: known } : {}),
    generateQuestion: qgen.generateQuestion,
    // most tests read one idea per tap; the choice card has its own tests
    choices: Boolean(over.choices),
    scoreboard: Boolean(over.scoreboard),
    suggestScoreboard: over.suggest || (() => new Promise(() => {})),
    readSaid: over.readSaid || READ_PLAIN,
    ...(over.sayTimeoutMs ? { sayTimeoutMs: over.sayTimeoutMs } : {}),
    runCli: over.runCli || (async (args) => {
      cli.push(args);
      if (args[1] === 'start') return { code: 0, stdout: JSON.stringify({ ok: true, action: 'mission_started', mission: { id: 'mission-2026-10-21-write-a-getting-abc', owner: 'launcher', status: 'planning' } }, null, 2), stderr: '' };
      return { code: 0, stdout: JSON.stringify({ ok: true, action: 'mission_run_detached', mission_id: 'mission-2026-10-21-write-a-getting-abc', pid: 42 }), stderr: '' };
    }),
  });
  const ledger = () => gmBet.readLedger(ledgerFile, root);
  return { d, gen, qgen, cli, logs, ledger, ledgerFile, tick: (ms) => { clock += ms; } };
}

// Questions the stub question writer hands out, in order, each drawn from this
// repo's own files; after the list it says it has no more.
const QLIST = [
  { ask: 'who uses the phone page most right now?', fact: 'the phone page just went live this week.', choices: ['solo founders', 'small teams', 'nobody yet'] },
  { ask: 'what would make a small team pay for it?', fact: 'installs dropped to 1,511 last week.', choices: ['saving them hours', 'fewer mistakes'] },
  { ask: 'what annoys small teams most when they try it?', fact: 'the first run takes a few minutes.', choices: ['setup', 'speed', 'unclear results'] },
  { ask: 'what would a small team tell a friend about it?', fact: null, choices: ['it saves hours', 'it is easy to start'] },
];

function stubQuestions({ list = QLIST, never = false } = {}) {
  const calls = [];
  let n = 0;
  const generateQuestion = (opts) => {
    calls.push(opts);
    if (never) return new Promise(() => {});
    const q = list[n];
    n += 1;
    return Promise.resolve(q ? { ok: true, question: q } : { ok: false, reason: 'no more questions in this stub' });
  };
  return { generateQuestion, calls };
}

const tick = () => new Promise(r => setImmediate(r));

// the installs the question cards stand on: 1,400 last week, 1,300 the week before, best 1,550
const QBUNDLE = { sources: { installs: { data: { last_week: 1400, week_before: 1300 }, best: { best: 1550, weeks: 8 } } } };

// the owner answered every question card this week
function answerEveryQuestion(ledgerFile, root, at) {
  const file = gmBet.focusPath(path.dirname(ledgerFile));
  for (const q of [gmBet.FALLBACK_QUESTION]) fs.appendFileSync(file, `${JSON.stringify({ workspace: root, key: q.key, answer: q.choices[0].id, label: q.choices[0].label, ask: q.ask, at: new Date(at).toISOString() })}\n`);
}

// fill the queue to 3 with the stub, one generation at a time
async function filled(root, over) {
  const h = desk(root, over);
  h.d.warm();
  for (let i = 0; i < 3; i += 1) await h.gen.releaseOne();
  return h;
}

const READ_PLAIN = async ({ card }) => ({ ok: true, kind: card.kind === 'question' ? 'answer' : 'instruction', reply: '' });
const RECEIPT = { result: { passed: true, landing: { changed: 'added the getting started page and a 30 second clip.', proof: 'Receipt saved at atris/runs/r1.json.' } } };

function jobDesk(root, missions, over = {}) {
  const ledgerFile = path.join(root, 'gm-bets.jsonl');
  const cli = [];
  const logs = [];
  let clock = NOW;
  const gen = stubGenerator();
  const d = gmBet.createBetDesk({
    workspaceRoot: root,
    ledgerFile,
    now: () => clock,
    log: row => logs.push(row),
    generate: gen.generate,
    readMissions: () => new Map(Object.entries(missions)),
    readReceipt: m => (m.receipt_path ? RECEIPT : null),
    readHandoffs: () => over.handoffs || [],
    ...(over.engineChoices ? { engineChoices: over.engineChoices } : {}),
    ...(over.swapFromCard ? { swapFromCard: over.swapFromCard } : {}),
    loadSeason: over.loadSeason || (() => ({ outcomes: [], error: null })),
    ...(over.resolveEngine ? { resolveEngine: over.resolveEngine } : {}),
    reviewer: () => (over.reviewer === undefined ? 'codex' : over.reviewer),
    warmOnCreate: false,
    choices: Boolean(over.choices),
    driverAlive: over.driverAlive || (() => false),
    readSaid: over.readSaid || READ_PLAIN,
    runCli: over.runCli || (async (args) => {
      cli.push(args);
      // member steer: --no-ignite only reaches a live run; --detach starts one in the background
      if (args[0] === 'member' && args[1] === 'steer') {
        const name = args[2];
        if (args.includes('--no-ignite')) return (over.live || []).includes(name) ? { code: 0, stdout: JSON.stringify({ ok: true, action: 'member_steered', member: name }) } : { code: 3, stdout: JSON.stringify({ ok: false, action: 'member_not_running', member: name }) };
        if (args.includes('--detach')) return over.detach || { code: 0, stdout: JSON.stringify({ ok: true, action: 'member_run_detached', member: name, pid: 4242 }) };
      }
      if (args[0] === 'engine' && args[1] === 'ask') {
        const review = over.review || { verdict: 'pass', reason: 'the page is there and the clip plays.' };
        if (review.code) return { code: review.code, stdout: '', stderr: 'codex is out of credits' };
        return { code: 0, stdout: JSON.stringify({ schema: 'atris.engine_ask.v1', answers: [{ engine: 'codex', ok: true, stdout: JSON.stringify(review) }] }) };
      }
      if (args[0] === 'decide' && args[1] === '--json') return { code: 0, stdout: JSON.stringify({ ok: true, decisions: over.decisions || [{ number: 1, mission_id: 'other', ask_index: 0 }, { number: 2, mission_id: 'm-ask', ask_index: 0 }] }) };
      if (args[0] === 'decide') return { code: 0, stdout: '{"ok":true}' };
      if (args[1] === 'start') return { code: 0, stdout: JSON.stringify({ mission: { id: 'm-new', owner: 'builder' } }) };
      return { code: 0, stdout: JSON.stringify({ action: 'mission_run_detached', mission_id: 'm-new' }) };
    }),
  });
  return { d, gen, cli, logs, ledgerFile, ledger: () => gmBet.readLedger(ledgerFile, root), tick: (ms) => { clock += ms; } };
}

function doingRow(file, root, id, missionId, title) {
  ledgerRow(file, root, id, { status: 'doing', mission_id: missionId, owner: 'builder', bet: { ...goodBet({ title }), check_date: '2026-10-30' } });
}

// three jobs, each waiting on one yes; m-a moved last, so it leads the job deck
function threeAsks(root) {
  const file = path.join(root, 'gm-bets.jsonl');
  doingRow(file, root, 'b-a', 'm-a', 'Write the launch thread for the phone page');
  // titles unlike the ideas the stub writes: one too close to a started job is never shown
  doingRow(file, root, 'b-b', 'm-b', 'Film the welcome clip for the pricing page');
  doingRow(file, root, 'b-c', 'm-c', 'Write the getting started page');
  const ask = (id, owner, mins, text) => ({ id, owner, status: 'blocked', created_at: new Date(NOW - mins * 60000).toISOString(), human_asks: [text] });
  return {
    'm-a': ask('m-a', 'launcher', 1, 'post the thread on x now?'),
    'm-b': ask('m-b', 'launcher', 5, 'post the video on x now?'),
    'm-c': ask('m-c', 'builder', 9, 'publish the page now?'),
  };
}

// a swap list as lib/roster-swap.js gives it: the Atris model, the owner's
// pick, then more models with the full list
const SWAP_CHOICES = {
  member: 'builder',
  job: 'build',
  line: 'builder runs on tool one m-one.',
  scopes: [{ id: 'member', label: 'just builder' }, { id: 'job', label: 'for every build job' }],
  options: [
    { engine: 'atris', tool: 'atris', model: 'fast', label: 'atris fast', atris: true, current: false, record: null },
    { engine: 'one', tool: 'tool one', model: 'm-one', label: 'm-one', pick: true, current: true, record: '3 of 4 finished this week' },
    { more: true, label: 'more models', options: [
      { engine: 'atris', tool: 'atris', model: 'fast', label: 'atris fast', current: false, record: null },
      { engine: 'one', tool: 'tool one', model: 'm-one', label: 'm-one', current: true, record: '3 of 4 finished this week' },
      { engine: 'two', tool: 'tool two', model: 'm-two', label: 'm-two', current: false, record: null },
    ] },
  ],
};
const TEAM_DEPS = { loadSeason: () => ({ outcomes: [], error: null }), resolveEngine: () => ({ engine: { id: 'one' }, model: 'm-one' }), engineChoices: () => SWAP_CHOICES };
const ASKS_BACK = async () => ({ ok: true, kind: 'question', reply: 'no problem. does the overnight run feel like it is helping you, or is it still hard to tell?', suggestions: ['it is still hard to tell', 'it is helping', 'show me last night\'s changes'] });
const EXPLAINS = async () => ({ ok: true, kind: 'question', reply: 'it is the one number you check each week to see if this is going well.' });

// what the desk serves now, as it keeps it (with what it checks) and as the page gets it
async function served(d) {
  const out = d.card();
  return { card: d.state.served, wire: out.card, out };
}
async function acted(d, body) {
  const out = await d.act(body);
  return { card: d.state.served, wire: out.body.card, out };
}

// Every kind of card, each reached the way the owner reaches it.
async function everyCard() {
  const cards = [];
  const keep = (name, got) => { cards.push({ name, ...got }); return got; };
  // an idea, a choice, a started idea
  const ideas = await filled(workspace());
  ideas.d.next();
  keep('idea', await served(ideas.d));
  await ideas.d.doIt();
  keep('started', await served(ideas.d));
  const picks = await filled(workspace(), { choices: true });
  picks.d.next();
  keep('choice', await served(picks.d));
  // a question with its own answers, then the scoreboard question with something else
  const asked = desk(workspace());
  asked.d.next();
  keep('question', await served(asked.d));
  const board = desk(workspace(), { scoreboard: true, questions: false, answered: true, readSaid: ASKS_BACK });
  board.d.next();
  const scoreQ = keep('question with something else', await served(board.d));
  // a reply that asks its own question, then a reply that only explains
  keep('reply that asks', await acted(board.d, { card_id: scoreQ.card.id, option_id: 'other', text: 'the overnight run' }));
  const board2 = desk(workspace(), { scoreboard: true, questions: false, answered: true, readSaid: EXPLAINS });
  board2.d.next();
  const q2 = await served(board2.d);
  keep('reply that explains', await acted(board2.d, { card_id: q2.card.id, option_id: 'other', text: 'what do you mean?' }));
  // the weekly number
  const weekly = desk(workspace(), { scoreboard: true, questions: false, answered: true });
  weekly.d.next();
  weekly.d.answer({ choice: 'other', text: 'paying schools' });
  weekly.d.next();
  keep('report', await served(weekly.d));
  // the calm line
  const calm = desk(workspace(), { answered: true });
  calm.d.next();
  keep('wait', await served(calm.d));
  // a wait that ended with nothing usable
  const miss = desk(workspace(), { answered: true, gen: stubGenerator({ fail: () => true }) });
  miss.d.next();
  await miss.gen.releaseOne();
  keep('missed', await served(miss.d));
  // the best draft when none passed in time, with the worry on it
  let worries = 0;
  const worried = desk(workspace(), { answered: true, generate: async () => ({ ok: true, checked: false, bet: { ...goodBet({ title: TITLES[worries++ % TITLES.length] }), check_date: '2026-10-30', concern: 'one worry: a page alone reaches nobody new.' } }) });
  worried.d.next();
  await tick();
  worried.d.next();
  keep('idea with a worry', await served(worried.d));
  // a yes on a plain ask, and a yes on a held command
  const root = workspace();
  const jobs = jobDesk(root, threeAsks(root), TEAM_DEPS);
  jobs.d.next();
  const ask = keep('yes', await served(jobs.d));
  keep('reply that needs a second tap', await acted(jobs.d, { card_id: ask.card.id, text: 'hold off until monday' }));
  const lockRoot = workspace();
  const yesLock = require('../../lib/yes-lock');
  const seal = yesLock.handoffSeal();
  yesLock.writeYesLocks(lockRoot, 'm-child', { seal });
  fs.mkdirSync(path.join(lockRoot, 'a'), { recursive: true });
  fs.writeFileSync(path.join(lockRoot, 'a', 'package.json'), JSON.stringify({ name: 'alpha' }));
  yesLock.check({ stateDir: lockRoot, missionId: 'm-child', seal, tool: 'npm', args: ['publish', './a'], cwd: lockRoot });
  const held = jobDesk(lockRoot, {});
  held.d.pollJobs();
  held.d.next();
  keep('yes on a held command', await served(held.d));
  // a finished job
  const doneRoot = workspace();
  doingRow(path.join(doneRoot, 'gm-bets.jsonl'), doneRoot, 'b-ok', 'm-ok', 'Write the getting started page');
  const fin = jobDesk(doneRoot, { 'm-ok': { id: 'm-ok', owner: 'builder', status: 'complete', receipt_path: 'r', human_asks: [] } });
  await fin.d.settle();
  fin.d.next();
  keep('done', await served(fin.d));
  // the team, a member, a swap card and its full list, the job deck
  const teamRoot = workspace();
  const crew = jobDesk(teamRoot, threeAsks(teamRoot), TEAM_DEPS);
  crew.d.next();
  const under = await served(crew.d);
  const t = keep('team', await acted(crew.d, { card_id: under.card.id, open: 'team' }));
  const m = keep('member', await acted(crew.d, { card_id: t.card.id, option_id: 'talk:builder' }));
  const back = await acted(crew.d, { card_id: m.card.id, option_id: 'back' });
  const sw = keep('swap', await acted(crew.d, { card_id: back.card.id, option_id: 'swap:builder' }));
  keep('swap with more models', await acted(crew.d, { card_id: sw.card.id, option_id: 'more' }));
  const d1 = keep('deck with a yes', await acted(crew.d, { card_id: crew.d.state.served.id, open: 'deck' }));
  assert.equal(d1.card.kind, 'deck');
  const runRoot = workspace();
  const running = jobDesk(runRoot, { 'm1': { id: 'm1', owner: 'builder', status: 'running', created_at: new Date(NOW - 60000).toISOString(), last_tick_at: new Date(NOW - 30000).toISOString(), objective: 'Write the try page.', human_asks: [] } }, { ...TEAM_DEPS, driverAlive: () => true });
  keep('deck with no yes', await acted(running.d, { card_id: null, open: 'deck' }));
  return cards;
}

module.exports = {
  NOW,
  workspace,
  goodBet,
  ledgerRow,
  TITLES,
  stubGenerator,
  desk,
  QLIST,
  stubQuestions,
  tick,
  filled,
  RECEIPT,
  jobDesk,
  doingRow,
  threeAsks,
  TEAM_DEPS,
  ASKS_BACK,
  everyCard,
  HOME,
};
