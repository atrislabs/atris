'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

// hermetic: nothing here may touch the real ~/.atris
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-bet-home-'));
process.env.HOME = HOME;
process.env.ATRIS_HOME = path.join(HOME, '.atris');

const gmBet = require('../lib/gm-bet');
const phone = require('../lib/gm-phone');
const { phonePage } = require('../lib/gm-phone-page');

const TODAY = '2026-10-21';
const NOW = new Date(2026, 9, 21, 12, 0, 0).getTime();

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
  for (const m of ['builder', 'launcher']) {
    fs.mkdirSync(path.join(root, 'atris', 'team', m), { recursive: true });
    fs.writeFileSync(path.join(root, 'atris', 'team', m, 'MEMBER.md'), `---\nname: ${m}\n---\n`);
  }
  return root;
}

function npmBody() {
  const downloads = [];
  for (let i = 0; i < 30; i += 1) downloads.push({ day: `2026-09-${String(i + 1).padStart(2, '0')}`, downloads: i >= 23 ? 200 : 100 });
  return { downloads };
}

const fixtureDeps = {
  seasonFacts: () => ({ landed: 4, target: { landed: 4, goal: 6, verdict: 'behind' }, record: { won: 2, lost: 1 }, waiting_on_review: 3, stuck: 0 }),
  gitLanded: () => ['gm phone: decision cards', 'bench: agy engine', 'second review runs joined checks', 'scoped token fix'],
  fetchJson: async () => npmBody(),
  packageName: 'atris',
};

function goodBet(over = {}) {
  return {
    title: 'Write a getting started page for atris gm phone with a 30 second screen recording',
    why_now: 'installs last week were 1,400 and the phone page just landed, so new installs have nothing to try first.',
    expect: '150 more npm installs in the week after it goes up',
    check_date: '2026-10-30',
    metric_source: 'npm installs for atris',
    cost: 'about 4 hours of agent time, $0',
    steps: [
      { text: 'draft the getting started page in docs/gm-phone.md', who: 'team', public: false },
      { text: 'record a 30 second screen capture of the phone page', who: 'team', public: false },
      { text: 'publish the page and post the recording on x', who: 'you', public: true },
    ],
    ...over,
  };
}

async function bundleFor(root, deps = fixtureDeps) {
  const events = [];
  const bundle = await gmBet.readBundle(root, { deps, emit: e => events.push(e), ledgerFile: path.join(root, 'bets.jsonl') });
  return { bundle, events };
}

// ---- the context bundle ---------------------------------------------------------

test('bundle: every source is read in order, each event carries a real fact', async () => {
  const root = workspace();
  const { bundle, events } = await bundleFor(root);
  assert.deepEqual(events.map(e => e.key), ['now', 'season', 'landed', 'installs', 'briefs', 'ledger']);
  assert.ok(events.every(e => e.kind === 'source'));
  assert.equal(events[0].line, 'read now.md, last updated 2026-10-20 at 09:00 local time');
  assert.equal(events[1].line, 'this week: 4 of 6 landed, behind, season 2 won 1 lost, 3 waiting on review, 0 stuck');
  assert.equal(events[2].line, 'landed this week: 4 changes');
  assert.equal(events[3].line, 'installs last week: 1,400 (week before: 700)');
  assert.equal(events[4].line, 'read 3 research briefs, newest: brief newest');
  assert.equal(events[5].line, 'past bets: none yet');
  assert.equal(bundle.sources.briefs.briefs.length, 3);
  assert.ok(!bundle.sources.briefs.briefs.some(b => b.name === 'old.md'));
  assert.match(gmBet.bundleText(bundle), /scoped token fix/);
});

test('bundle: missing sources are left out, never invented', async () => {
  const root = workspace({ now: false, briefs: false });
  const { bundle, events } = await bundleFor(root, {
    seasonFacts: () => null,
    gitLanded: () => null,
    fetchJson: async () => { throw new Error('offline'); },
    packageName: 'atris',
  });
  assert.deepEqual(events.map(e => `${e.kind}:${e.key}`), ['skip:now', 'skip:season', 'skip:landed', 'skip:installs', 'skip:briefs', 'source:ledger']);
  assert.deepEqual(Object.keys(bundle.sources), ['ledger']);
  assert.deepEqual(bundle.facts, ['past bets: none yet']);
  const text = gmBet.bundleText(bundle);
  assert.doesNotMatch(text, /now\.md|installs|landed on master|research brief/);
});

test('installWeeks sums the newest 7 days and the 7 before', () => {
  assert.deepEqual(gmBet.installWeeks(npmBody()), { last_week: 1400, week_before: 700, through: '2026-09-30' });
  assert.equal(gmBet.installWeeks({ downloads: [] }), null);
});

// ---- validation -----------------------------------------------------------------

test('validate: a good bet passes', async () => {
  const { bundle } = await bundleFor(workspace());
  const out = gmBet.validateBet(goodBet(), { bundle, today: TODAY });
  assert.deepEqual(out, { ok: true, reasons: [] });
});

test('validate: vague title, bad date, all-you steps, uncited why_now, and a posting team step are turned down', async () => {
  const { bundle } = await bundleFor(workspace());
  const check = over => gmBet.validateBet(goodBet(over), { bundle, today: TODAY }).reasons.join(' | ');
  assert.match(check({ title: 'Improve onboarding for new users of the product' }), /vague verb "improve"/);
  assert.match(check({ title: 'Ship it' }), /too short/);
  assert.match(check({ title: 'Make things better for growth and engagement' }), /no concrete deliverable/);
  assert.match(check({ check_date: '2026-11-20' }), /within 14 days/);
  assert.match(check({ check_date: '2026-10-21' }), /after 2026-10-21/);
  assert.match(check({ check_date: '2026-02-31' }), /not a real/);
  assert.match(check({ steps: goodBet().steps.map(s => ({ ...s, who: 'you' })) }), /no step is for the team/);
  assert.match(check({ why_now: 'people would probably like a nicer first run experience overall.' }), /does not quote a fact/);
  assert.match(check({ steps: [{ text: 'post the thread on x', who: 'team', public: false }, goodBet().steps[0]] }), /step 1 reaches the outside world/);
  assert.match(check({ steps: [{ text: 'draft and send the email to 20 users', who: 'team', public: false }, goodBet().steps[0]] }), /step 1 reaches the outside world/);
  assert.doesNotMatch(check({ steps: [{ text: 'draft the launch post for review', who: 'team', public: false }, goodBet().steps[2]] }), /step 1/);
  assert.match(check({ expect: 'more installs' }), /number and a metric/);
  assert.match(check({ metric_source: 'how people feel' }), /not a source we can read/);
  assert.match(check({ why_now: '' }), /why_now is missing/);
  assert.equal(gmBet.validateBet(goodBet(), { bundle, today: TODAY, previousTitle: goodBet().title.toUpperCase() }).ok, false);
});

test('why_now may cite four words in a row from a source instead of a number', async () => {
  const { bundle } = await bundleFor(workspace());
  assert.equal(gmBet.citesBundle('the brief says agents that pay for themselves win.', bundle), true);
  assert.equal(gmBet.citesBundle('everyone wants this right now.', bundle), false);
});

// ---- generation: retry once, then fail honestly ---------------------------------------

test('generate: a turned-down answer is retried once with the reasons, then fails honestly', async () => {
  const root = workspace();
  const prompts = [];
  const bad = JSON.stringify(goodBet({ title: 'Optimize the onboarding flow for new users this week' }));
  const events = [];
  const out = await gmBet.generateBet({
    workspaceRoot: root,
    today: TODAY,
    ledgerFile: path.join(root, 'bets.jsonl'),
    emit: e => events.push(e),
    deps: { ...fixtureDeps, runModel: async (prompt) => { prompts.push(prompt); return { ok: true, text: bad }; } },
  });
  assert.equal(out.ok, false);
  assert.equal(prompts.length, 2);
  assert.doesNotMatch(prompts[0], /was rejected/);
  assert.match(prompts[1], /Your last answer was rejected: .*vague verb "optimize"/);
  assert.match(out.reason, /broke the rules twice/);
  assert.deepEqual(events.slice(6).map(e => e.kind), ['model', 'reject', 'model', 'reject']);
});

test('generate: a second good answer passes, and the order of events is sources, model, check', async () => {
  const root = workspace();
  let n = 0;
  const events = [];
  const out = await gmBet.generateBet({
    workspaceRoot: root,
    today: TODAY,
    ledgerFile: path.join(root, 'bets.jsonl'),
    emit: e => events.push(e),
    deps: {
      ...fixtureDeps,
      now: () => (n += 5000),
      runModel: async (prompt, { onProgress }) => {
        const retry = /was rejected/.test(prompt);
        onProgress({ thinking: 300, chars: 0 });
        onProgress({ thinking: 300, chars: 420 });
        return { ok: true, text: retry ? `\`\`\`json\n${JSON.stringify(goodBet())}\n\`\`\`` : 'not json at all' };
      },
    },
  });
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.attempts, 2);
  assert.equal(out.bet.title, goodBet().title);
  assert.deepEqual(events.map(e => e.kind), ['source', 'source', 'source', 'source', 'source', 'source', 'model', 'thinking', 'writing', 'reject', 'model', 'thinking', 'writing', 'check']);
  assert.equal(events[7].line, 'thinking: about 300 tokens so far');
  assert.equal(events[8].line, 'writing the bet: 420 characters');
});

// ---- the model process ------------------------------------------------------------

function stubScript(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/usr/bin/env node\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

test('model: env has both api keys removed; stream-json progress and the result come through', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-bet-stub-'));
  const bin = stubScript(dir, 'claude-stub', `
const out = o => process.stdout.write(JSON.stringify(o) + '\\n');
out({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 120 });
out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '{"a":' } } });
out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '1}' } } });
const keys = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'].filter(k => k in process.env);
out({ type: 'result', is_error: false, result: JSON.stringify({ keys, prompt: process.argv[process.argv.length - 1] }) });
`);
  const progress = [];
  const res = await gmBet.runModel('the prompt', {
    command: { bin, args: [] },
    env: { ...process.env, ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_AUTH_TOKEN: 'tok-test' },
    onProgress: p => progress.push(p),
  });
  assert.equal(res.ok, true, res.reason);
  assert.deepEqual(JSON.parse(res.text), { keys: [], prompt: 'the prompt' });
  assert.deepEqual(progress, [{ thinking: 120, chars: 0 }, { thinking: 120, chars: 5 }, { thinking: 120, chars: 7 }]);
  const env = gmBet.modelEnv({ ANTHROPIC_API_KEY: 'a', ANTHROPIC_AUTH_TOKEN: 'b', PATH: '/bin' });
  assert.deepEqual(env, { PATH: '/bin' });
  const args = gmBet.claudeArgs('p');
  assert.deepEqual(args.slice(0, 6), ['-p', 'p', '--model', 'opus', '--output-format', 'stream-json']);
  assert.ok(args.includes('--no-session-persistence'));
});

test('model: on timeout the whole process group is killed', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-bet-sleep-'));
  const pidFile = path.join(dir, 'child.pid');
  const bin = stubScript(dir, 'sleepy', `
const { spawn } = require('child_process');
const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(kid.pid));
setInterval(() => {}, 1000);
`);
  const started = Date.now();
  const res = await gmBet.runModel('x', { command: { bin, args: [] }, timeoutMs: 600 });
  assert.equal(res.ok, false);
  assert.equal(res.timed_out, true);
  assert.match(res.reason, /longer than 1 seconds|longer than 0 seconds|was stopped/);
  assert.ok(Date.now() - started < 5000);
  const kid = Number(fs.readFileSync(pidFile, 'utf8'));
  let alive = true;
  for (let i = 0; i < 40 && alive; i += 1) {
    try {
      process.kill(kid, 0);
      await new Promise(r => setTimeout(r, 50));
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, 'the grandchild in the same group is gone');
});

test('model: a non-zero exit with no answer fails with the reason', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-bet-fail-'));
  const bin = stubScript(dir, 'broken', 'process.stderr.write("not logged in\\n"); process.exit(3);');
  const res = await gmBet.runModel('x', { command: { bin, args: [] } });
  assert.deepEqual(res, { ok: false, reason: 'the model exited with code 3: not logged in' });
});

// ---- the desk: think, sharper, skip, do it, ledger --------------------------------------

function desk(root, over = {}) {
  const ledgerFile = path.join(root, 'gm-bets.jsonl');
  const calls = [];
  const cli = [];
  const logs = [];
  const d = gmBet.createBetDesk({
    workspaceRoot: root,
    ledgerFile,
    now: () => NOW,
    log: row => logs.push(row),
    generate: over.generate || (async (opts) => {
      calls.push(opts);
      opts.emit({ kind: 'source', key: 'now', line: 'read now.md' });
      return { ok: true, bet: goodBet(opts.previousTitle ? { title: 'Record a two minute demo video of gm phone for the readme' } : {}) };
    }),
    runCli: over.runCli || (async (args) => {
      cli.push(args);
      if (args[1] === 'start') return { code: 0, stdout: JSON.stringify({ ok: true, action: 'mission_started', mission: { id: 'mission-2026-10-21-write-a-getting-abc', owner: 'launcher', status: 'planning' } }, null, 2), stderr: '' };
      return { code: 0, stdout: JSON.stringify({ ok: true, action: 'mission_run_detached', mission_id: 'mission-2026-10-21-write-a-getting-abc', pid: 42 }), stderr: '' };
    }),
  });
  const ledger = () => fs.readFileSync(ledgerFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  return { d, calls, cli, logs, ledger, ledgerFile };
}

test('desk: think makes a proposed bet in the ledger; sharper excludes the previous title', async () => {
  const root = workspace();
  const { d, calls, ledger, ledgerFile } = desk(root);
  assert.equal(d.think().ok, true);
  assert.equal(d.think().reason, 'busy');
  await d.state.done;
  const v = d.view();
  assert.equal(v.status, 'ready');
  assert.deepEqual(v.events.map(e => e.kind), ['source', 'done']);
  assert.equal(calls[0].previousTitle, null);
  assert.equal(calls[0].today, TODAY);
  const first = ledger()[0];
  assert.equal(first.status, 'proposed');
  assert.equal(first.workspace, root);
  assert.equal(first.bet.title, goodBet().title);
  assert.match(first.id, /^bet-2026-10-21-[0-9a-f]{8}$/);

  d.think({ sharper: true });
  await d.state.done;
  assert.equal(calls[1].previousTitle, goodBet().title);
  assert.equal(d.view().bet.title, 'Record a two minute demo video of gm phone for the readme');
  const rows = gmBet.readLedger(ledgerFile, root);
  assert.deepEqual(rows.map(r => r.status), ['skipped', 'proposed']);
  assert.equal(gmBet.readLedger(ledgerFile, '/somewhere/else').length, 0);
  const prompt = gmBet.buildPrompt({ facts: [], sources: {} }, { today: TODAY, previousTitle: goodBet().title });
  assert.match(prompt, new RegExp(`different from: ${goodBet().title}`));
});

test('desk: not now marks the bet skipped', async () => {
  const root = workspace();
  const { d, ledger } = desk(root);
  d.think();
  await d.state.done;
  assert.equal(d.skip().ok, true);
  assert.equal(d.view().status, 'skipped');
  assert.deepEqual(ledger().map(r => r.status), ['proposed', 'skipped']);
});

test('desk: a failed generation says what failed in one sentence', async () => {
  const root = workspace();
  const { d } = desk(root, { generate: async () => ({ ok: false, reason: 'the model took longer than 120 seconds and was stopped' }) });
  d.think();
  await d.state.done;
  const v = d.view();
  assert.equal(v.status, 'failed');
  assert.equal(v.error, 'the model took longer than 120 seconds and was stopped');
  assert.equal(v.events[v.events.length - 1].kind, 'failed');
});

test('do it: starts a real mission with every step and the your-yes rule, then runs it', async () => {
  const root = workspace();
  const { d, cli, ledger, logs } = desk(root);
  d.think();
  await d.state.done;
  const out = await d.doIt();
  assert.equal(out.ok, true);
  assert.equal(cli.length, 2);
  const start = cli[0];
  assert.deepEqual(start.slice(0, 2), ['mission', 'start']);
  const objective = start[2];
  assert.match(objective, /^Write a getting started page for atris gm phone/);
  assert.match(objective, /1\. \[team\] draft the getting started page/);
  assert.match(objective, /3\. \[your yes\] publish the page and post the recording on x/);
  assert.ok(objective.includes(gmBet.YES_RULE));
  const flag = name => start[start.indexOf(name) + 1];
  assert.equal(flag('--owner'), 'launcher');
  assert.equal(flag('--lane'), 'launch');
  assert.equal(flag('--runner'), 'claude');
  assert.equal(flag('--verify'), 'git diff --check');
  assert.ok(start.includes('--json'));
  assert.deepEqual(cli[1], ['mission', 'run', 'mission-2026-10-21-write-a-getting-abc', '--detach', '--json']);
  assert.equal(d.view().mission.line, 'launcher has it. the mission is running now.');
  const last = ledger().pop();
  assert.equal(last.status, 'doing');
  assert.equal(last.mission_id, 'mission-2026-10-21-write-a-getting-abc');
  assert.deepEqual(logs.filter(l => l.choice === 'do').map(l => l.command.split(' ').slice(0, 3).join(' ')), ['atris mission start', 'atris mission run']);
  // the your-yes step becomes a decision card that pings the mission
  const cards = d.yesCards();
  assert.equal(cards.length, 1);
  assert.equal(cards[0].text, 'your yes: publish the page and post the recording on x');
  assert.deepEqual(cards[0].choices[0].steps[0].slice(0, 3), ['mission', 'ping', 'mission-2026-10-21-write-a-getting-abc']);
  assert.ok(cards[0].choices[0].steps[0].includes('gm-phone'));
});

test('do it: a mission that will not start leaves the bet ready and says why', async () => {
  const root = workspace();
  const { d, cli } = desk(root, { runCli: async (args) => { cli.push(args); return { code: 2, stdout: '', stderr: 'mission start refused: no verifier' }; } });
  d.think();
  await d.state.done;
  const out = await d.doIt();
  assert.equal(out.ok, false);
  assert.equal(out.message, 'the mission did not start: mission start refused: no verifier');
  assert.equal(d.view().status, 'ready');
  assert.equal(cli.length, 1);
});

test('pickOwner: code bets go to the builder, everything unclear to the mission lead', () => {
  const root = workspace();
  const code = goodBet({ title: 'Add an atris gm phone --demo flag that seeds sample cards', steps: [{ text: 'build the flag and a test', who: 'team', public: false }, { text: 'release it', who: 'you', public: true }] });
  assert.deepEqual(gmBet.pickOwner(code, root), { owner: 'builder', lane: 'code' });
  const post = goodBet({ title: 'Write a launch thread about the phone page for x', steps: [{ text: 'draft the thread', who: 'team', public: false }] });
  assert.deepEqual(gmBet.pickOwner(post, root), { owner: 'launcher', lane: 'launch' });
  const vague = goodBet({ title: 'Call three customers about renewal pricing tiers', steps: [{ text: 'list three customers from the ledger', who: 'team', public: false }] });
  assert.deepEqual(gmBet.pickOwner(vague, root), { owner: 'mission-lead', lane: 'workspace' });
});

// ---- over http: the routes and the deck ----------------------------------------------------

test('over http: think, poll, do it needs a second tap, and your-yes cards lead the deck', async () => {
  const root = workspace();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-bet-http-'));
  const ran = [];
  const hosts = [];
  const TOKEN = 'k'.repeat(43);
  let made = false;
  const handler = phone.createPhoneHandler({
    workspaceRoot: root,
    token: TOKEN,
    hosts,
    tally: () => ({ landed: 0, sent_back: 0, dropped: 0, abandoned: 0 }),
    now: () => NOW,
    loadView: () => ({ workspace_name: 'shop', target: { landed: 1, target: { landed: 2 }, verdict: 'behind' }, roster: [], reviews: [], stuck: [], last_plays: [], outcomes: [] }),
    runStep: async (args) => { ran.push(args); return { code: 0, last_line: 'pinged' }; },
    writeTarget: () => true,
    snapshotTarget: () => () => true,
    logPath: path.join(dir, 'gm-phone-actions.jsonl'),
    page: phonePage,
    makeBetDesk: (log) => {
      made = true;
      return gmBet.createBetDesk({
        workspaceRoot: root,
        ledgerFile: path.join(dir, 'bets.jsonl'),
        now: () => NOW,
        log,
        generate: async () => ({ ok: true, bet: goodBet() }),
        runCli: async args => (args[1] === 'start'
          ? { code: 0, stdout: '{"mission":{"id":"mission-x","owner":"launcher"}}' }
          : { code: 0, stdout: '{"action":"mission_run_detached"}' }),
      });
    },
  });
  const server = http.createServer((q, s) => { handler(q, s); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `127.0.0.1:${server.address().port}`;
  hosts.push(base);
  const call = async (method, p, body) => {
    const res = await fetch(`http://${base}${p}${method === 'GET' ? `?t=${TOKEN}` : ''}`, {
      method,
      headers: { 'x-gm-token': TOKEN, origin: `http://${base}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  try {
    assert.ok(made);
    assert.equal((await call('GET', '/bet')).json.status, 'idle');
    assert.equal((await call('POST', '/bet/think', {})).status, 200);
    await handler.bet.state.done;
    const ready = await call('GET', '/bet');
    assert.equal(ready.json.status, 'ready');
    assert.equal(ready.json.bet.steps.length, 3);
    const once = await call('POST', '/bet/do', {});
    assert.equal(once.status, 409);
    assert.equal(once.json.reason, 'needs_confirm');
    const twice = await call('POST', '/bet/do', { confirm: true });
    assert.equal(twice.status, 200);
    assert.equal(twice.json.mission.line, 'launcher has it. the mission is running now.');
    const state = await call('GET', '/state');
    assert.equal(state.json.bet.status, 'started');
    assert.equal(state.json.card.id, 'yes-2');
    assert.match(state.json.card.choices[0].commands[0], /^atris mission ping mission-x /);
    const tapOnce = await call('POST', '/action', { card: 'yes-2', choice: 'yes' });
    assert.equal(tapOnce.json.reason, 'needs_confirm');
    const yes = await call('POST', '/action', { card: 'yes-2', choice: 'yes', confirm: true });
    assert.equal(yes.status, 200);
    await Promise.all(handler.actions.map(a => a.done));
    assert.equal(ran.length, 1);
    assert.deepEqual(ran[0].slice(0, 3), ['mission', 'ping', 'mission-x']);
    assert.equal((await call('GET', '/state')).json.card, null);
    const rows = gmBet.readLedger(path.join(dir, 'bets.jsonl'), root);
    assert.ok(rows[0].yes && rows[0].yes[2]);
    const log = fs.readFileSync(path.join(dir, 'gm-phone-actions.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(log.map(l => `${l.card}:${l.choice}`), ['bet:think', 'bet:generate', 'bet:do', 'bet:do', 'yes-2:yes']);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('page: the orb, the bet card, and the lava stop once the card is up', () => {
  const html = phonePage('NONCE');
  assert.match(html, /<canvas id="orb"/);
  assert.match(html, /id="lava"/);
  assert.match(html, /id="betcard"/);
  assert.match(html, /id="think"/);
  assert.match(html, /\.lava\.still \.tx, \.lava\.still \.ty, \.lava\.still \.blob \{ animation-play-state: paused; \}/);
  assert.match(html, /prefers-reduced-motion: reduce/);
  assert.match(html, /\/bet\/think/);
  assert.match(html, /\/bet\/do/);
  assert.match(html, /team does it/);
  assert.match(html, /your yes/);
  // the bright point does not breathe
  assert.doesNotMatch(html, /Math\.sin\(boom/);
});
