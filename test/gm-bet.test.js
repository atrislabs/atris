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

// 60 days ending 2026-09-30: 4 days before the first full week, then 8 full
// weeks. Last week is 1,400 (200 a day), the fourth week back is the best at
// 1,550, and every other week is 1,300.
function npmBody() {
  const downloads = [];
  const n = 60;
  for (let i = 0; i < n; i += 1) {
    const d = new Date(Date.UTC(2026, 8, 30 - (n - 1 - i)));
    const back = n - 1 - i;
    const week = Math.floor(back / 7);
    const value = week === 0 ? 200 : week === 3 ? (back % 7 === 6 ? 230 : 220) : (back % 7 === 6 ? 160 : 190);
    downloads.push({ day: d.toISOString().slice(0, 10), downloads: value });
  }
  return { downloads };
}

const WAITING_JOBS = [
  { id: 't1', title: 'fix the flaky login test' },
  { id: 't2', title: 'add the install page' },
  { id: 't3', title: 'next step toward: members work for hours' },
  { id: 't4', title: 'next step toward: every repeat problem gets a tool' },
  { id: 't5', title: 'retire the old sync job' },
];
const QUEUE_KIND = { t1: 'branch', t2: 'merged_open', t3: 'placeholder', t4: 'placeholder', t5: 'branch' };

const PASS = JSON.stringify({ verdict: 'pass', missing_first: 'nothing', moves_metric: true, reason: 'a getting started page is what new installs hit first.' });

const fixtureDeps = {
  seasonFacts: () => ({ landed: 4, target: { landed: 4, goal: 6, verdict: 'behind' }, record: { won: 2, lost: 1 }, waiting_on_review: 5, waiting_jobs: WAITING_JOBS, stuck: 0 }),
  classifyQueue: (root, jobs) => jobs.map(j => ({ ...j, kind: QUEUE_KIND[j.id] })),
  gitLanded: () => ['gm phone: decision cards', 'bench: agy engine', 'second review runs joined checks', 'scoped token fix'],
  fetchJson: async url => (url.startsWith('https://registry.npmjs.org/') ? { version: '3.71.3' } : npmBody()),
  releaseGap: () => ({ count: 67 }),
  packageName: 'atris',
  runSkeptic: async () => ({ ok: true, text: PASS }),
};

const SOURCE_KEYS = ['now', 'season', 'landed', 'installs', 'installs_best', 'release', 'team', 'briefs', 'ledger'];

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

async function bundleFor(root, deps = fixtureDeps) {
  const events = [];
  const bundle = await gmBet.readBundle(root, { deps, emit: e => events.push(e), ledgerFile: path.join(root, 'bets.jsonl') });
  return { bundle, events };
}

// ---- the context bundle ---------------------------------------------------------

test('bundle: every source is read in order, each event carries a real fact', async () => {
  const root = workspace();
  const { bundle, events } = await bundleFor(root);
  assert.deepEqual(events.map(e => e.key), SOURCE_KEYS);
  assert.ok(events.every(e => e.kind === 'source'));
  const line = Object.fromEntries(events.map(e => [e.key, e.line]));
  assert.equal(line.now, 'read now.md, last updated 2026-10-20 at 09:00 local time');
  assert.equal(line.season, 'this week: 4 of 6 landed, behind, season 2 won 1 lost, 5 waiting on review, 0 stuck');
  // the queue split is kept as data for the team, never a fact the owner or the writer sees
  assert.equal(bundle.sources.queue.fact, '5 waiting: 2 with work on a branch, 1 already merged but open, 2 placeholders with no check');
  assert.ok(!bundle.facts.some(f => /waiting:/.test(f)));
  assert.doesNotMatch(gmBet.bundleText(bundle), /jobs waiting on review now|placeholder/);
  assert.equal(line.landed, 'changes merged this week: 4');
  assert.equal(line.installs, 'installs last week: 1,400 (week before: 1,300)');
  assert.equal(line.installs_best, 'best week for installs in the last 2 months: 1,550');
  assert.equal(line.release, 'published 3.71.3; 67 changes on master not published yet');
  assert.equal(line.briefs, 'read 3 research briefs, newest: brief newest');
  assert.equal(line.ledger, 'past bets: none yet');
  assert.match(gmBet.bundleText(bundle), /## release\npublished on npm: 3\.71\.3\nchanges on master not in it: 67/);
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
  assert.deepEqual(events.map(e => `${e.kind}:${e.key}`), ['skip:now', 'skip:season', 'skip:landed', 'skip:installs', 'skip:release', 'source:team', 'skip:briefs', 'source:ledger']);
  assert.deepEqual(Object.keys(bundle.sources), ['team', 'ledger']);
  assert.deepEqual(bundle.facts, ['team: 3 members in atris/team', 'past bets: none yet']);
  const text = gmBet.bundleText(bundle);
  assert.doesNotMatch(text, /now\.md|installs|landed on master|research brief|published|swing/);
  // with nothing readable, a target cannot be set, and the reason says so
  assert.match(gmBet.validateBet(goodBet(), { bundle, today: TODAY }).reasons.join(' | '), /no number we can read here for a target/);
});

test('bundle: the goal, open missions, who is on what, and the latest journal reach both writers; stale sources say so', async () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, 'atris', 'now.md'), '# now\n\nLast updated: 2026-09-29 at 00:47 local time\n\n- keep the workspace coherent\n');
  fs.writeFileSync(path.join(root, 'atris', 'TODO.md'), '# TODO.md\n\n## Endgame\n\n**Slug:** zero-revision-nights\n**Picked:** 2026-10-15 00:48\n**Horizon:** Overnight agent work lands itself and holds up.\n\n## Backlog\n');
  fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
  fs.writeFileSync(path.join(root, '.atris', 'state', 'scoreboard.json'), JSON.stringify({ goal: 'first outside customer pays for atris', metrics: [], updated_at: '2026-07-16T18:45:12.647Z' }));
  fs.mkdirSync(path.join(root, 'atris', 'logs', '2026'), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris', 'logs', '2026', '2026-10-02.md'), '# old day\n- an old line\n');
  fs.writeFileSync(path.join(root, 'atris', 'logs', '2026', '2026-10-20.md'), '# 2026-10-20\n\n- shipped the phone orb preview\n- first-timer page drafted\n');
  const ago = d => new Date(Date.UTC(2026, 9, 21) - d * 86400000).toISOString();
  const missions = new Map(Object.entries({
    m1: { id: 'm1', owner: 'builder', status: 'running', objective: 'Write the try page for first-timers. why now: installs fell.', created_at: ago(1), updated_at: ago(0) },
    m2: { id: 'm2', owner: 'launcher', status: 'complete', objective: 'Post the launch thread.', created_at: ago(3), updated_at: ago(2) },
    m3: { id: 'm3', owner: 'researcher', status: 'paused', objective: 'Survey ten agent teams about pricing.', created_at: ago(40), updated_at: ago(30) },
    // still says running, but has not moved in days: a dead run, like the old match sheet
    m4: { id: 'm4', owner: 'builder', status: 'running', objective: 'Write a match sheet pairing merges with jobs.', created_at: ago(3), last_tick_at: ago(2) },
  }));
  const deps = { ...fixtureDeps, readMissions: () => missions };
  const events = [];
  const bundle = await gmBet.readBundle(root, { deps, emit: e => events.push(e), ledgerFile: path.join(root, 'bets.jsonl'), today: TODAY });
  const text = gmBet.bundleText(bundle);
  // a stale now.md is labeled stale, in the facts and in the text
  assert.equal(events.find(e => e.key === 'now').line, 'read now.md, last updated 2026-09-29 at 00:47 local time, 22 days ago, stale');
  assert.match(text, /## atris\/now\.md \(stale: 22 days old, prefer the fresher sections\)/);
  // the goal: the endgame horizon and the goal sentence, each with its age
  assert.match(text, /## the goal\n- horizon: Overnight agent work lands itself and holds up\. \(picked 2026-10-15\)\n- goal: first outside customer pays for atris \(set 2026-07-16, stale: 97 days old\)/);
  // open missions as plain titles, fresh first; finished ones are left out
  assert.match(text, /## open missions\n- Write the try page for first-timers \(builder\)\n- Survey ten agent teams about pricing \(researcher, stale: 30 days old\)/);
  assert.doesNotMatch(text, /Post the launch thread|match sheet/);
  // what each member is on now, one line each
  assert.match(text, /- builder: Builder\. Writes and tests the code\. now on: Write the try page for first-timers/);
  // the newest journal day only
  assert.match(text, /## latest journal, 2026-10-20\n# 2026-10-20\n- shipped the phone orb preview\n- first-timer page drafted/);
  assert.doesNotMatch(text, /an old line/);
  // bounded: each new section has a cap
  assert.ok(text.length < 20000, `bundle text ${text.length}`);
  // both writers get the goal, and the rule to prefer fresh sections
  const idea = gmBet.buildPrompt(bundle, { today: TODAY });
  assert.match(idea, /Overnight agent work lands itself and holds up/);
  assert.match(idea, /- a section marked stale is old: prefer the fresh ones, and never present a stale line as what is happening now\./);
  const prompts = [];
  await gmBet.generateQuestion({ workspaceRoot: root, bundle, ledgerFile: path.join(root, 'bets.jsonl'), deps: { runModel: async (p) => { prompts.push(p); return { ok: false, reason: 'stub' }; } } });
  assert.match(prompts[0], /Overnight agent work lands itself and holds up/);
  assert.match(prompts[0], /first outside customer pays for atris/);
  assert.match(prompts[0], /- a section marked stale is old: prefer the fresh ones/);
});

test('installWeeks sums the newest 7 days and the 7 before', () => {
  assert.deepEqual(gmBet.installWeeks(npmBody()), { last_week: 1400, week_before: 1300, through: '2026-09-30' });
  assert.equal(gmBet.installWeeks({ downloads: [] }), null);
});

// ---- gate one: ambitious, past normal swing ---------------------------------------

test('best week: the biggest weekly total of the last 8 full weeks', () => {
  // newest full blocks first; the 4 leading days are not a full week
  assert.deepEqual(gmBet.installTotals(npmBody()), [1400, 1300, 1300, 1550, 1300, 1300, 1300, 1300]);
  assert.deepEqual(gmBet.bestWeek([1511, 1640, 2319, 1415, 302, 499, 419, 1886]), { best: 2319, weeks: 8 });
  assert.deepEqual(gmBet.bestWeek([10, 20, 30, 40, 50, 60, 70, 80, 9000]), { best: 80, weeks: 8 }, 'only the newest 8 weeks count');
  assert.deepEqual(gmBet.bestWeek([12]), { best: 12, weeks: 1 });
  assert.equal(gmBet.bestWeek([]), null);
  // days before the package had any installs are not weeks it existed
  const young = { downloads: [...Array(20).fill(0), ...Array(14).fill(10)].map((n, i) => ({ day: `2026-01-${String(i + 1).padStart(2, '0')}`, downloads: n })) };
  assert.deepEqual(gmBet.installTotals(young), [70, 70]);
});

test('ambition: installs must beat the best recent week; an owner card never picks the team-only queue metric', async () => {
  const { bundle } = await bundleFor(workspace());
  const owner = target => gmBet.validateBet(goodBet({ target }), { bundle, today: TODAY }).reasons.join(' | ');
  assert.equal(owner({ metric: 'queue_landed', baseline: 0, goal: 2 }), 'target metric queue_landed measures team plumbing, not a business move; an owner bet moves installs');
  // the team can still use it, with its own bar
  const check = target => gmBet.validateBet(goodBet({ target }), { bundle, today: TODAY, allowTeamMetrics: true }).reasons.join(' | ');
  assert.equal(check({ metric: 'installs', baseline: 1400, goal: 1550 }), 'target goal 1,550 does not beat our best installs week of the last 2 months, 1,550; the goal must be above 1,550');
  assert.equal(check({ metric: 'installs', baseline: 1400, goal: 1551 }), '', 'one more than the best week is enough');
  // 5 jobs wait, 3 have real work (2 are placeholders): at least 2 of those 3 must land, counted from 0
  assert.equal(check({ metric: 'queue_landed', baseline: 0, goal: 1 }), 'target goal 1 does not land half the waiting jobs with real work: 3 have real work, so the goal must be at least 2');
  assert.equal(check({ metric: 'queue_landed', baseline: 0, goal: 2 }), '');
  assert.equal(check({ metric: 'queue_landed', baseline: 0, goal: 3 }), '');
  assert.equal(check({ metric: 'queue_landed', baseline: 0, goal: 4 }), 'target goal 4 is more than the 3 waiting jobs with real work');
  const hollow = await bundleFor(workspace(), { ...fixtureDeps, classifyQueue: (root, jobs) => jobs.map(j => ({ ...j, kind: 'placeholder' })) });
  assert.equal(gmBet.validateBet(goodBet({ target: { metric: 'queue_landed', baseline: 0, goal: 1 } }), { bundle: hollow.bundle, today: TODAY, allowTeamMetrics: true }).reasons.join(' | '), 'none of the 5 waiting jobs has real work behind it, so none can land; pick another metric');
  // the queue size and changes merged are not metrics: closing jobs empties one, filler jobs inflate the other
  assert.equal(check({ metric: 'waiting', baseline: 3, goal: 1 }), 'target metric must be one we can read here: installs or queue_landed, got "waiting"');
  assert.equal(check({ metric: 'landed', baseline: 4, goal: 40 }), 'target metric must be one we can read here: installs or queue_landed, got "landed"');
  assert.match(check(undefined), /target is missing/);
  const empty = await bundleFor(workspace(), { ...fixtureDeps, seasonFacts: () => ({ landed: 0, target: null, record: null, waiting_on_review: 0, waiting_jobs: [], stuck: 0 }) });
  assert.equal(gmBet.validateBet(goodBet({ target: { metric: 'queue_landed', baseline: 0, goal: 0 } }), { bundle: empty.bundle, today: TODAY, allowTeamMetrics: true }).reasons.join(' | '), 'nothing is waiting on review, so there is no queue to land; pick another metric');
  // the check is a week out at least, so every day read is after the start
  assert.match(gmBet.validateBet(goodBet({ check_in_days: 5 }), { bundle, today: TODAY }).reasons.join(' | '), /from 7 to 14, got 5/);
  // the prompt names the readable metrics with their baselines and the bar to clear
  const prompt = gmBet.buildPrompt(bundle, { today: TODAY });
  assert.match(prompt, /the most ambitious move this team can start this week, one that would beat our best installs week of the last 2 months if it works/);
  // business moves only; plumbing is the team's job
  assert.match(prompt, /Propose only a business move: customers, revenue, reach, or product people use\. Plumbing is the team's job and happens without asking: releases, review queues, unmerged or stuck jobs, test speed, and fixing counts are never the bet\./);
  assert.match(prompt, /the release is one step for "you" inside the move, never the move itself/);
  assert.doesNotMatch(prompt, /queue_landed|waiting on review, any idea/);
  assert.match(prompt, /Small safe bets get rejected/);
  assert.ok(prompt.includes('"installs" (npm installs in the 7 days that end on the check date; baseline 1400; the best week in the last 2 months was 1,550, so the goal must be above 1,550)'));

  // the writer and the skeptic both see which jobs count

  assert.doesNotMatch(prompt, /swing/);
});

test('ambition: a baseline that is not the real number is turned down', async () => {
  const { bundle } = await bundleFor(workspace());
  const check = target => gmBet.validateBet(goodBet({ target }), { bundle, today: TODAY, allowTeamMetrics: true }).reasons.join(' | ');
  assert.equal(check({ metric: 'installs', baseline: 1511, goal: 2000 }), 'target baseline 1,511 does not match the real number: installs last week is 1,400');
  assert.equal(check({ metric: 'queue_landed', baseline: 3, goal: 2 }), 'target baseline 3 does not match the real number: jobs landed from today\'s review queue is 0');
  assert.match(check({ metric: 'installs', baseline: '1400', goal: 2000 }), /target baseline must be a number/);
});

test('a passing bet carries its target, the snapshot of waiting jobs, and one short goal line for the card', async () => {
  const root = workspace();
  const run = bet => gmBet.generateBet({ workspaceRoot: root, today: TODAY, ledgerFile: path.join(root, 'bets.jsonl'), deps: { ...fixtureDeps, runModel: async () => ({ ok: true, text: JSON.stringify(bet) }) } });
  const out = await run(goodBet());
  assert.equal(out.ok, true, out.reason);
  assert.deepEqual(out.bet.target, { metric: 'installs', baseline: 1400, goal: 1700 });
  assert.equal(out.bet.goal_line, 'goal 1,700, best week in 2 months 1,550');
  const queueBet = goodBet({ title: 'Look over the three oldest waiting jobs with a second checker lane', target: { metric: 'queue_landed', baseline: 0, goal: 2 } });
  const refused = await run(queueBet);
  assert.equal(refused.ok, false, 'an owner card never measures plumbing');
  assert.match(refused.reason, /measures team plumbing, not a business move/);
  const queue = await gmBet.generateBet({ workspaceRoot: root, today: TODAY, ledgerFile: path.join(root, 'bets.jsonl'), allowTeamMetrics: true, deps: { ...fixtureDeps, runModel: async () => ({ ok: true, text: JSON.stringify(queueBet) }) } });
  assert.equal(queue.ok, true, queue.reason);
  // placeholders are left out of the snapshot
  assert.deepEqual(queue.bet.target, { metric: 'queue_landed', baseline: 0, goal: 2, job_ids: ['t1', 't2', 't5'] });
  assert.equal(queue.bet.goal_line, 'goal 2 of the 3 jobs with work landed');
  assert.ok(out.bet.goal_line.length <= 48 && queue.bet.goal_line.length <= 48, 'fits one short line on a phone');
});

// ---- gate two: makes sense (the release gap and the skeptic) ----------------------------

function gitRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-bet-rel-'));
  const git = (...args) => require('node:child_process').execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  git('init', '-q', '-b', 'master');
  return { repo, git };
}

test('release gap: published version and the changes on master not in its tag, or unknown without a tag', async () => {
  const { repo, git } = gitRepo();
  git('commit', '-q', '--allow-empty', '-m', 'first');
  git('tag', 'v1.4.0');
  git('commit', '-q', '--allow-empty', '-m', 'merged after the release');
  git('commit', '-q', '--allow-empty', '-m', 'and another');
  git('update-ref', 'refs/remotes/origin/master', 'HEAD');
  assert.deepEqual(gmBet.defaultReleaseGap(repo, '1.4.0'), { count: 2 });
  assert.deepEqual(gmBet.defaultReleaseGap(repo, '1.5.0'), { count: null, why: 'no v1.5.0 tag here' });
  const deps = { readNow: () => null, seasonFacts: () => null, readBriefs: () => null, packageName: 'atris' };
  const at = async (version) => {
    const events = [];
    await gmBet.readBundle(repo, { deps: { ...deps, fetchJson: async url => (url === 'https://registry.npmjs.org/atris/latest' ? { version } : npmBody()) }, emit: e => events.push(e), ledgerFile: path.join(repo, 'b.jsonl') });
    return events.find(e => e.key === 'release');
  };
  assert.deepEqual(await at('1.4.0'), { kind: 'source', key: 'release', line: 'published 1.4.0; 2 changes on master not published yet' });
  assert.deepEqual(await at('1.5.0'), { kind: 'source', key: 'release', line: 'published 1.5.0; changes on master not published yet: unknown (no v1.5.0 tag here)' });
  assert.equal(gmBet.releaseFact('2.0.0', { count: 0 }), 'published 2.0.0; everything on master is published');
  assert.equal(gmBet.releaseFact('2.0.0', { count: 1 }), 'published 2.0.0; 1 change on master not published yet');
  const offline = [];
  await gmBet.readBundle(repo, { deps: { ...deps, fetchJson: async () => { throw new Error('offline'); } }, emit: e => offline.push(e), ledgerFile: path.join(repo, 'b.jsonl') });
  assert.deepEqual(offline.find(e => e.key === 'release'), { kind: 'skip', key: 'release', line: 'could not read the published version from npm, left out' });
});

test('skeptic: a named blocker becomes the next bet, not a patch on the blocked idea', async () => {
  const root = workspace();
  const attemptsFile = path.join(root, 'attempts.jsonl');
  const prompts = [];
  const judged = [];
  const fail = { verdict: 'fail', missing_first: 'release the gm game, it is merged but not on npm', moves_metric: false, reason: 'people who install from the post get 3.71.3, which has no gm game.' };
  const release = goodBet({
    title: 'Release 3.72 with the gm game and a two minute install check on a clean laptop',
    target: { metric: 'installs', baseline: 1400, goal: 1600 },
    steps: [{ text: 'run the release checks on master', who: 'team', member: 'builder', public: false }, { text: 'release the merged gm game to npm', who: 'you', public: true }],
  });
  const events = [];
  const out = await gmBet.generateBet({
    workspaceRoot: root, today: TODAY, ledgerFile: path.join(root, 'bets.jsonl'), attemptsFile, emit: e => events.push(e), writers: 1,
    deps: {
      ...fixtureDeps,
      runModel: async (prompt) => { prompts.push(prompt); return { ok: true, text: JSON.stringify(prompts.length === 1 ? goodBet() : release) }; },
      runSkeptic: async (prompt) => { judged.push(prompt); return { ok: true, text: JSON.stringify(judged.length === 1 ? fail : { verdict: 'pass', missing_first: 'nothing', moves_metric: true, reason: 'the release is the move now.' }) }; },
    },
  });
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.attempts, 2);
  assert.equal(out.bet.title, release.title);
  assert.deepEqual(out.bet.skeptic, { verdict: 'pass', moves_metric: true, missing_first: 'nothing', reason: 'the release is the move now.' });
  // the skeptic sees the bet and the same facts, including the release gap
  assert.match(judged[0], /You are a skeptical cofounder/);
  assert.match(judged[0], /published 3\.71\.3; 67 changes on master not published yet/);
  assert.match(judged[0], /"goal": 1700/);
  assert.doesNotMatch(judged[0], /You are the strategist/);
  // plumbing as the whole deliverable fails; as one step inside a business move it is fine
  assert.match(judged[0], /is the deliverable internal plumbing \(a release, a review queue, merging or unsticking jobs, test speed, fixing a count or a dashboard\)\? that is the team's job and never an owner bet, so fail it\./);
  assert.match(judged[0], /it is not obviously wrong, and it is not plumbing\. otherwise "fail"/);
  assert.match(prompts[1], /If the blocker is team plumbing \(a release, a merge, a review, a fix to the build or a count\), it is never the bet: keep a business move and put the plumbing in as one step\./);
  // the retry makes the blocker the bet: no patch, no last answer to fix
  assert.ok(prompts[1].includes(`The last idea ("${goodBet().title}") is blocked by: release the gm game, it is merged but not on npm. Don't patch that idea. Make clearing this blocker the bet, as big as this team can do in the window, with its own target.`));
  assert.doesNotMatch(prompts[1], /Your last answer was/);
  assert.ok(prompts[1].includes(`- ${goodBet().title}`), 'the blocked idea is on the list to differ from');
  assert.deepEqual(events.filter(e => ['model', 'skeptic', 'reject', 'check'].includes(e.kind)).map(e => e.line.split(':')[0]), ['asking the model for one bet', 'a second model is checking that it makes sense', 'first answer turned down', 'asking again', 'a second model is checking that it makes sense', 'checked the bet']);
  const rows = fs.readFileSync(attemptsFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(rows.map(r => [r.kind, r.attempt, r.strategy, r.passed]), [['writer', 1, 'first', true], ['skeptic', 1, 'first', false], ['writer', 2, 'blocker', true], ['skeptic', 2, 'blocker', true]]);
  assert.equal(rows[2].blocker, 'release the gm game, it is merged but not on npm');
  assert.equal(rows[1].verdict.verdict, 'fail');
  assert.equal(rows[1].title, goodBet().title);
});

test('retry paths: code rejects and a skeptic fail with no blocker patch the last answer; a patch of the blocked idea is turned down', async () => {
  const root = workspace();
  const attemptsFile = path.join(root, 'attempts.jsonl');
  const prompts = [];
  const answers = [
    goodBet({ check_in_days: 3 }),
    goodBet(),
    // after the blocker, the writer patches the blocked idea anyway
    goodBet({ title: 'Write a getting started page for atris gm phone with a 30 second clip and a release' }),
  ];
  const verdicts = [
    { verdict: 'fail', missing_first: 'a public build that has the phone page', moves_metric: false, reason: 'the page shows a feature nobody can install.' },
  ];
  const out = await gmBet.generateBet({
    workspaceRoot: root, today: TODAY, ledgerFile: path.join(root, 'bets.jsonl'), attemptsFile, writers: 1,
    deps: {
      ...fixtureDeps,
      runModel: async (prompt) => { prompts.push(prompt); return { ok: true, text: JSON.stringify(answers[prompts.length - 1]) }; },
      runSkeptic: async () => ({ ok: true, text: JSON.stringify(verdicts.shift()) }),
    },
  });
  // no draft passed both checks: the one that met the rules is the card, with the worry on it
  assert.equal(out.ok, true);
  assert.equal(out.checked, false);
  assert.equal(out.bet.title, goodBet().title);
  assert.equal(out.bet.concern, 'one worry: the page shows a feature nobody can install.');
  // try 2 patches the code reject with the last answer
  assert.match(prompts[1], /Your last answer was:\n\{/);
  assert.match(prompts[1], /Your last answer was rejected: check_in_days must be a whole number from 7 to 14, got 3/);
  // try 3 is the blocker, and the near copy of the blocked idea fails the code check
  assert.match(prompts[2], /is blocked by: a public build that has the phone page\. Don't patch that idea\./);
  const rows = fs.readFileSync(attemptsFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(rows.map(r => [r.kind, r.strategy, r.passed]), [['writer', 'first', false], ['writer', 'patch', true], ['skeptic', 'patch', false], ['writer', 'blocker', false]]);
  assert.match(rows[3].reasons.join(' | '), /too close to a bet already shown or waiting: "Write a getting started page/);
  // a skeptic fail that names nothing missing is a patch with its reason
  const plain = [];
  const again = await gmBet.generateBet({
    workspaceRoot: root, today: TODAY, ledgerFile: path.join(root, 'bets.jsonl'), writers: 1,
    deps: {
      ...fixtureDeps,
      runModel: async (prompt) => { plain.push(prompt); return { ok: true, text: JSON.stringify(goodBet()) }; },
      runSkeptic: async () => ({ ok: true, text: JSON.stringify({ verdict: plain.length < 2 ? 'fail' : 'pass', missing_first: 'nothing', moves_metric: true, reason: 'a page alone reaches nobody new.' }) }),
    },
  });
  assert.equal(again.ok, true, again.reason);
  assert.match(plain[1], /Your last answer was rejected: a skeptic turned it down: a page alone reaches nobody new\./);
  assert.doesNotMatch(plain[1], /Don't patch that idea/);
  // the writer prompt names the review jam as a blocker for new code
  assert.match(plain[0], /Propose only a business move/);
  assert.doesNotMatch(plain[0], /prefer the move that unblocks/);
});

test('trim: a format-only reject gets one free repair turn in the same try, then the skeptic still runs', async () => {
  const root = workspace();
  const attemptsFile = path.join(root, 'attempts.jsonl');
  const long = goodBet({ steps: [{ text: 'draft the getting started page and a matching readme section with screenshots', who: 'team', member: 'builder', public: false }, goodBet().steps[2]] });
  const short = goodBet({ steps: [{ text: 'draft the getting started page and a readme section', who: 'team', member: 'builder', public: false }, goodBet().steps[2]] });
  const prompts = [];
  let judged = 0;
  const events = [];
  const out = await gmBet.generateBet({
    workspaceRoot: root, today: TODAY, ledgerFile: path.join(root, 'bets.jsonl'), attemptsFile, emit: e => events.push(e), writers: 1,
    deps: {
      ...fixtureDeps,
      runModel: async (prompt) => { prompts.push(prompt); return { ok: true, text: JSON.stringify(prompts.length === 1 ? long : short) }; },
      runSkeptic: async () => { judged += 1; return { ok: true, text: PASS }; },
    },
  });
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.attempts, 1, 'the trim did not use up a try');
  assert.equal(judged, 1, 'the skeptic still judged the trimmed bet');
  assert.equal(out.bet.steps[0].text, 'draft the getting started page and a readme section');
  // the trim turn gets only the reasons and the last answer, and may change only those fields
  assert.match(prompts[1], /^Your last answer below broke only these length or sentence limits:\n- step 1 is 77 characters, over the 70 that fit one line\n/);
  assert.match(prompts[1], /Shorten only those fields so they fit\. Change nothing else/);
  assert.match(prompts[1], /Your last answer:\n\{"title":"Write a getting started page/);
  assert.doesNotMatch(prompts[1], /You are the strategist/);
  const rows = fs.readFileSync(attemptsFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(rows.map(r => [r.kind, r.attempt, r.strategy, r.passed]), [['writer', 1, 'first', false], ['writer', 1, 'trim', true], ['skeptic', 1, 'trim', true]]);
  assert.ok(events.some(e => e.kind === 'model' && e.line === 'asking for the same bet, shorter'));
  // what counts as format only: lengths and sentence counts, nothing else
  const { bundle } = await bundleFor(workspace());
  const v = over => gmBet.validateBet(goodBet(over), { bundle, today: TODAY });
  assert.equal(v({ why_now: 'installs were 1,400. the page is new. nobody has seen it.' }).formatOnly, true);
  assert.equal(v({ cost: 'x'.repeat(201) }).formatOnly, true);
  assert.equal(v({ title: `Write a getting started page for atris gm phone ${'with more words '.repeat(7)}` }).formatOnly, true);
  assert.equal(v({ title: 'Optimize the onboarding flow for new users this week', cost: 'x'.repeat(201) }).formatOnly, false, 'a vague verb is not a length problem');
  assert.equal(v({ check_in_days: 3 }).formatOnly, false);
});

test('trim: a trim that changes more than the long fields, or a mixed reject, is a normal reject that uses the try', async () => {
  const root = workspace();
  const attemptsFile = path.join(root, 'attempts.jsonl');
  const long = goodBet({ steps: [{ text: 'draft the getting started page and a matching readme section with screenshots', who: 'team', member: 'builder', public: false }, goodBet().steps[2]] });
  const sneaky = goodBet({ target: { metric: 'installs', baseline: 1400, goal: 1600 }, steps: [{ text: 'draft the page', who: 'team', member: 'builder', public: false }, goodBet().steps[2]] });
  const prompts = [];
  const out = await gmBet.generateBet({
    workspaceRoot: root, today: TODAY, ledgerFile: path.join(root, 'bets.jsonl'), attemptsFile, writers: 1,
    deps: { ...fixtureDeps, runModel: async (prompt) => { prompts.push(prompt); return { ok: true, text: JSON.stringify(prompts.length === 2 ? sneaky : (prompts.length === 1 ? long : goodBet())) }; } },
  });
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.attempts, 2, 'the bad trim used up the first try');
  assert.match(prompts[2], /Your last answer was rejected: the trim changed more than the fields over a limit/);
  const rows = fs.readFileSync(attemptsFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(rows.filter(r => r.kind === 'writer').map(r => [r.attempt, r.strategy, r.passed]), [[1, 'first', false], [1, 'trim', false], [2, 'patch', true]]);
  // a reject with a real problem besides a length gets no trim turn
  const mixed = [];
  await gmBet.generateBet({
    workspaceRoot: root, today: TODAY, ledgerFile: path.join(root, 'bets.jsonl'), writers: 1,
    deps: { ...fixtureDeps, runModel: async (prompt) => { mixed.push(prompt); return { ok: true, text: JSON.stringify(mixed.length === 1 ? { ...long, check_in_days: 3 } : goodBet()) }; } },
  });
  assert.doesNotMatch(mixed[1], /broke only these length or sentence limits/);
  assert.match(mixed[1], /Your last answer was rejected: .*check_in_days must be a whole number from 7 to 14, got 3/);
});

test('skeptic: when nothing passes, the best draft is the card with the worry; a pass that does not move the number is a fail; a broken skeptic leaves it not double-checked', async () => {
  const root = workspace();
  const run = runSkeptic => gmBet.generateBet({ workspaceRoot: root, today: TODAY, ledgerFile: path.join(root, 'bets.jsonl'), writers: 1, deps: { ...fixtureDeps, runModel: async () => ({ ok: true, text: JSON.stringify(goodBet()) }), runSkeptic } });
  // three fails: never an error, the draft is shown with the skeptic's own worry for the owner
  const thrice = await run(async () => ({ ok: true, text: JSON.stringify({ verdict: 'fail', missing_first: 'nothing', moves_metric: true, reason: 'a page alone reaches nobody new. add a post.', concern: 'a page alone reaches nobody new' }) }));
  assert.deepEqual([thrice.ok, thrice.checked, thrice.bet.title], [true, false, goodBet().title]);
  assert.equal(thrice.bet.concern, 'one worry: a page alone reaches nobody new.');
  assert.match(thrice.reason, /a skeptic turned it down: a page alone reaches nobody new/);
  let calls = 0;
  const contradicts = await run(async () => { calls += 1; return { ok: true, text: JSON.stringify({ verdict: 'pass', missing_first: '', moves_metric: false, reason: 'fine, though the bet reaches nobody.' }) }; });
  assert.equal(contradicts.checked, false, 'a pass that does not move the number does not pass');
  assert.equal(calls, 3, 'three writer answers, each judged');
  // the skeptic's reason uses a word the owner never reads: the line says the kind of worry instead
  assert.equal(contradicts.bet.concern, 'one worry: it may not move your number much this week.');
  const steps = await run(async () => ({ ok: true, text: JSON.stringify({ verdict: 'pass', missing_first: 'nothing', moves_metric: true, doable: false, reason: 'the mission waits on strangers to reply.' }) }));
  assert.equal(steps.checked, false, 'a team step the team cannot do and check on its own is a fail');
  assert.equal(steps.bet.concern, 'one worry: one step depends on people outside the team.');
  const down = await run(async () => ({ ok: false, reason: 'the model took longer than 120 seconds and was stopped' }));
  assert.deepEqual([down.ok, down.checked, down.bet.concern], [true, false, 'not double-checked: the second look did not finish.']);
  assert.equal(down.reason, 'the skeptic could not check the bet: the model took longer than 120 seconds and was stopped');
  const garbled = await run(async () => ({ ok: true, text: '{"verdict": "maybe"}' }));
  assert.deepEqual([garbled.ok, garbled.checked, garbled.reason], [true, false, 'the skeptic could not check the bet: the skeptic gave no pass or fail verdict']);
  assert.deepEqual(gmBet.parseVerdict('nope'), { error: "the skeptic's answer: the answer was not JSON" });
  // the real skeptic is its own claude -p call on the subscription path, thinking briefly
  const args = gmBet.skepticCommand().args('judge this');
  assert.deepEqual(args.slice(0, 4), ['-p', 'judge this', '--model', 'opus']);
  assert.deepEqual(args.slice(-2), ['--effort', 'low']);
  assert.equal(gmBet.skepticCommand().bin, 'claude');
});

// ---- gate three: what works (score bets, feed results back) ------------------------

let rowClock = 0;
function ledgerRow(file, root, id, over) {
  rowClock += 1;
  fs.appendFileSync(file, `${JSON.stringify({ id, workspace: root, created_at: new Date(Date.UTC(2026, 9, 1) + rowClock * 1000).toISOString(), ...over })}\n`);
}

test('scorer: doing bets are scored won or lost from the same source once due; proposed and future ones are not', async () => {
  const root = workspace();
  const file = path.join(root, 'bets.jsonl');
  const bet = (title, over = {}) => ({ ...goodBet({ title }), check_date: '2026-10-10', ...over });
  const queue = { metric: 'queue_landed', baseline: 0, goal: 11, job_ids: Array.from({ length: 22 }, (_, i) => `job-${i}`) };
  ledgerRow(file, root, 'won', { status: 'doing', bet: bet('Write the gm phone getting started page') });
  ledgerRow(file, root, 'lost', { status: 'doing', bet: bet('Run two review lanes on the waiting jobs', { target: queue, check_date: '2026-10-19' }) });
  ledgerRow(file, root, 'qwon', { status: 'doing', bet: bet('Add a second checker to the review queue', { target: queue, check_date: '2026-10-20' }) });
  ledgerRow(file, root, 'qtoday', { status: 'doing', bet: bet('Land half the queue by today', { target: queue, check_date: TODAY }) });
  ledgerRow(file, root, 'qnoids', { status: 'doing', bet: bet('A queue bet with no snapshot', { target: { metric: 'queue_landed', baseline: 0, goal: 11 } }) });
  ledgerRow(file, root, 'waiting', { status: 'doing', bet: bet('Cut the review queue in half', { target: { metric: 'waiting', baseline: 22, goal: 11 } }) });
  ledgerRow(file, root, 'landed', { status: 'doing', bet: bet('Land forty small fixes', { target: { metric: 'landed', baseline: 4, goal: 40 } }) });
  ledgerRow(file, root, 'notarget', { status: 'doing', bet: bet('An old bet from before targets', { target: undefined }) });
  ledgerRow(file, root, 'proposed', { status: 'proposed', bet: bet('A proposed bet nobody started') });
  ledgerRow(file, root, 'future', { status: 'doing', bet: bet('A bet still running', { check_date: '2026-10-25' }) });
  ledgerRow(file, root, 'today', { status: 'doing', bet: bet('An installs bet whose week ends today', { check_date: TODAY }) });
  ledgerRow(file, root, 'late', { status: 'doing', bet: bet('A bet npm has not counted yet', { check_date: '2026-10-19' }) });
  ledgerRow(file, root, 'toolate', { status: 'doing', bet: bet('A bet npm never counted', { check_date: '2026-10-01' }) });
  const reads = [];
  const readMetric = async (metric, { start, end, target }) => {
    reads.push([metric, start, end]);
    if (metric === 'queue_landed') {
      if (!target.job_ids) return { error: 'the bet has no snapshot of the waiting jobs to score', transient: false };
      return { value: end === '2026-10-19' ? 7 : 12 };
    }
    if (end === '2026-10-19' || end === '2026-10-01') return { error: `npm has not counted every day up to ${end} yet`, transient: true };
    return { value: 1800 };
  };
  const events = [];
  const scored = await gmBet.scoreBets(root, { ledgerFile: file, today: TODAY, deps: { readMetric }, emit: e => events.push(e) });
  assert.deepEqual(scored.map(s => [s.id, s.status]), [['won', 'won'], ['lost', 'lost'], ['qwon', 'won'], ['qnoids', 'unreadable'], ['waiting', 'unreadable'], ['landed', 'unreadable'], ['notarget', 'unreadable'], ['toolate', 'unreadable']]);
  assert.deepEqual(reads.find(r => r[2] === '2026-10-10'), ['installs', '2026-10-04', '2026-10-10'], 'the 7 days that end on the check date');
  assert.ok(!reads.some(r => r[2] === '2026-10-25' || r[2] === TODAY), 'a bet not yet due, or a check date not yet over, is not read');
  const byId = Object.fromEntries(gmBet.readLedger(file, root).map(r => [r.id, r]));
  assert.deepEqual([byId.won.status, byId.won.actual, byId.won.window], ['won', 1800, '2026-10-04 to 2026-10-10']);
  assert.deepEqual([byId.lost.status, byId.lost.actual, byId.lost.window], ['lost', 7, 'landed by the end of 2026-10-19, of 22 jobs waiting at the start']);
  assert.deepEqual([byId.qwon.status, byId.qwon.actual], ['won', 12]);
  assert.equal(byId.qtoday.status, 'doing', 'jobs can still land today, so the queue is read tomorrow');
  assert.deepEqual([byId.qnoids.status, byId.qnoids.why], ['unreadable', 'the bet has no snapshot of the waiting jobs to score']);
  assert.deepEqual([byId.waiting.status, byId.waiting.why], ['unreadable', 'there is no way to read "waiting"']);
  assert.deepEqual([byId.landed.status, byId.landed.why], ['unreadable', 'there is no way to read "landed"']);
  assert.deepEqual([byId.notarget.status, byId.notarget.why], ['unreadable', 'the bet has no target number to read']);
  assert.deepEqual([byId.toolate.status, byId.toolate.why], ['unreadable', 'npm has not counted every day up to 2026-10-01 yet']);
  assert.equal(byId.late.status, 'doing', 'late data inside the grace window waits for the next run');
  assert.equal(byId.today.status, 'doing', 'an installs week that ends today is read tomorrow');
  assert.equal(byId.proposed.status, 'proposed', 'a proposed bet is never scored');
  assert.equal(byId.future.status, 'doing');
  assert.equal(events[0].line, 'scored a past bet: won, Write the gm phone getting started page (goal 1,700, got 1,800)');
  // a second run scores nothing new
  assert.deepEqual(await gmBet.scoreBets(root, { ledgerFile: file, today: TODAY, deps: { readMetric } }), []);
});

test('scorer: a queue bet counts only snapshotted jobs that landed by the check date; closed, dropped, or parked count zero', async () => {
  const root = workspace();
  const dbPath = path.join(root, 'tasks.db');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE task_events (event_id TEXT, task_id TEXT, event_type TEXT, payload TEXT, created_at INTEGER)');
  const at = (day, hour) => { const [y, m, d] = day.split('-').map(Number); return new Date(y, m - 1, d, hour).getTime(); };
  const add = db.prepare('INSERT INTO task_events VALUES (?, ?, ?, ?, ?)');
  add.run('e1', 'j1', 'completed', JSON.stringify({ action: 'accepted' }), at('2026-10-15', 9));
  add.run('e2', 'j2', 'completed', JSON.stringify({ action: 'merged' }), at('2026-10-17', 23));
  add.run('e3', 'j3', 'completed', JSON.stringify({ action: 'merged' }), at('2026-10-18', 1));
  add.run('e4', 'j4', 'completed', JSON.stringify({ action: 'closed' }), at('2026-10-15', 9));
  add.run('e5', 'j5', 'archived', '{}', at('2026-10-15', 9));
  add.run('e6', 'j6', 'claim_released', '{}', at('2026-10-15', 9));
  add.run('e7', 'other', 'completed', JSON.stringify({ action: 'accepted' }), at('2026-10-15', 9));
  add.run('e8', 'j1', 'completed', JSON.stringify({ action: 'accepted' }), at('2026-10-16', 9));
  db.close();
  const file = path.join(root, 'bets.jsonl');
  const job_ids = ['j1', 'j2', 'j3', 'j4', 'j5', 'j6'];
  ledgerRow(file, root, 'q', { status: 'doing', bet: { ...goodBet({ target: { metric: 'queue_landed', baseline: 0, goal: 3, job_ids } }), check_date: '2026-10-17' } });
  const out = await gmBet.scoreBets(root, { ledgerFile: file, today: TODAY, deps: { taskDbPath: dbPath } });
  // j1 (accepted, counted once) and j2 (merged before midnight) landed; j3 landed after the check date;
  // j4 closed, j5 archived, j6 dropped, and the job that was never in the queue count zero
  assert.deepEqual(out.map(s => [s.status, s.actual, s.window]), [['lost', 2, 'landed by the end of 2026-10-17, of 6 jobs waiting at the start']]);
  const missing = path.join(root, 'none.jsonl');
  ledgerRow(missing, root, 'm', { status: 'doing', bet: { ...goodBet({ target: { metric: 'queue_landed', baseline: 0, goal: 3, job_ids } }), check_date: '2026-10-17' } });
  assert.deepEqual(await gmBet.scoreBets(root, { ledgerFile: missing, today: TODAY, deps: { taskDbPath: path.join(root, 'nope.db') } }), [], 'no task db yet is a wait, not a loss');
});

test('queue split: real work is read from git and the task db, placeholders and unknowns are left out of the snapshot', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-bet-queue-'));
  const DAY = 24 * 60 * 60;
  const nowS = Math.floor(Date.now() / 1000);
  const git = (date, ...args) => require('node:child_process').execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_AUTHOR_DATE: `@${date} +0000`, GIT_COMMITTER_DATE: `@${date} +0000` } });
  const write = (file) => { fs.mkdirSync(path.join(repo, path.dirname(file)), { recursive: true }); fs.writeFileSync(path.join(repo, file), `// ${file}\n`); };
  git(nowS - 3 * DAY, 'init', '-q', '-b', 'master');
  write('test/old.test.js');
  git(nowS - 3 * DAY, 'add', '.');
  git(nowS - 3 * DAY, 'commit', '-q', '-m', 'an old test, from before the jobs were made');
  // the jobs are made two days ago; only commits after that count
  git(nowS - 1 * DAY, 'checkout', '-q', '-b', 'feat');
  write('test/feat-a.test.js');
  git(nowS - 1 * DAY, 'add', '.');
  git(nowS - 1 * DAY, 'commit', '-q', '-m', 'work for job a, on a branch');
  git(nowS, 'checkout', '-q', 'master');
  write('test/feat-b.test.js');
  git(nowS, 'add', '.');
  git(nowS, 'commit', '-q', '-m', 'work for job b, merged');
  git(nowS, 'update-ref', 'refs/remotes/origin/master', 'HEAD');

  const dbPath = path.join(repo, 'tasks.db');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE tasks (id TEXT, created_at INTEGER, metadata TEXT)');
  const made = (nowS - 2 * DAY) * 1000;
  const addJob = db.prepare('INSERT INTO tasks VALUES (?, ?, ?)');
  addJob.run('a', made, JSON.stringify({ verify: 'node --test test/feat-a.test.js' }));
  addJob.run('b', made, JSON.stringify({ verify: 'node --test test/feat-b.test.js' }));
  addJob.run('c', made, JSON.stringify({ verify: 'node --test test/feat-c.test.js' }));
  addJob.run('old', made, JSON.stringify({ verify: 'node --test test/old.test.js' }));
  addJob.run('ph', made, JSON.stringify({ verify: 'npm run test:fast' }));
  db.close();
  const jobs = ['a', 'b', 'c', 'old', 'ph', 'gone'].map(id => ({ id, title: `job ${id}` }));
  const base = { readNow: () => null, readBriefs: () => null, gitLanded: () => null, packageName: null, seasonFacts: () => ({ landed: 0, target: null, record: null, waiting_on_review: jobs.length, waiting_jobs: jobs, stuck: 0 }) };
  const read = async (root, deps) => (await gmBet.readBundle(root, { deps: { ...base, ...deps }, ledgerFile: path.join(repo, 'b.jsonl') })).sources.queue;

  const queue = await read(repo, { taskDbPath: dbPath });
  assert.deepEqual(Object.fromEntries(queue.jobs.map(j => [j.id, j.kind])), { a: 'branch', b: 'merged_open', c: 'no_work', old: 'no_work', ph: 'placeholder', gone: 'unknown' });
  assert.equal(queue.fact, '6 waiting: 1 with work on a branch, 1 already merged but open, 2 with a check but no work yet, 1 placeholder with no check, 1 unknown');
  // only real work is snapshotted, and the bar is half of it
  const bundle = await gmBet.readBundle(repo, { deps: { ...base, taskDbPath: dbPath }, ledgerFile: path.join(repo, 'b.jsonl') });
  assert.match(gmBet.validateBet(goodBet({ target: { metric: 'queue_landed', baseline: 0, goal: 3 } }), { bundle, today: TODAY, allowTeamMetrics: true }).reasons.join(' | '), /target goal 3 is more than the 2 waiting jobs with real work/);
  // git that cannot tell is unknown, never a guess; a missing db makes every job unknown
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-bet-nogit-'));
  const noGit = await read(bare, { taskDbPath: dbPath });
  assert.deepEqual(Object.fromEntries(noGit.jobs.map(j => [j.id, j.kind])), { a: 'unknown', b: 'unknown', c: 'unknown', old: 'unknown', ph: 'placeholder', gone: 'unknown' });
  const noDb = await read(repo, { taskDbPath: path.join(repo, 'nope.db') });
  assert.equal(noDb.fact, '6 waiting: 6 unknown');
});

test('scorer: installs are read from the npm range for exactly those 7 days, and never scored from a partial week', async () => {
  const root = workspace();
  const file = path.join(root, 'bets.jsonl');
  ledgerRow(file, root, 'a', { status: 'doing', bet: { ...goodBet(), check_date: '2026-10-17' } });
  const urls = [];
  const week = days => ({ downloads: Array.from({ length: days }, (_, i) => ({ day: `2026-10-${String(11 + i).padStart(2, '0')}`, downloads: 250 })) });
  const partial = await gmBet.scoreBets(root, { ledgerFile: file, today: TODAY, deps: { packageName: 'atris', fetchJson: async (u) => { urls.push(u); return week(5); } } });
  assert.deepEqual(partial, [], 'five of seven days counted is not a score yet');
  assert.equal(urls[0], 'https://api.npmjs.org/downloads/range/2026-10-11:2026-10-17/atris');
  const full = await gmBet.scoreBets(root, { ledgerFile: file, today: TODAY, deps: { packageName: 'atris', fetchJson: async () => week(7) } });
  assert.deepEqual(full.map(s => [s.status, s.actual]), [['won', 1750]]);
  const none = path.join(root, 'none.jsonl');
  ledgerRow(none, root, 'b', { status: 'doing', bet: { ...goodBet(), check_date: '2026-10-10' } });
  const unpublished = await gmBet.scoreBets(root, { ledgerFile: none, today: TODAY, deps: { packageName: null } });
  assert.deepEqual(unpublished.map(s => [s.status, s.why]), [['unreadable', 'no published package here to read installs from']]);
});

test('results: readBundle scores first, then past bets show won and lost with numbers, and the prompt leans on them', async () => {
  const root = workspace();
  const file = path.join(root, 'bets.jsonl');
  ledgerRow(file, root, 'w', { status: 'doing', bet: { ...goodBet({ title: 'Write the gm phone getting started page' }), check_date: '2026-10-10' } });
  ledgerRow(file, root, 'l', { status: 'doing', bet: { ...goodBet({ title: 'Post a sixty second gm clip on x' }), check_date: '2026-10-11' } });
  const readMetric = async (metric, { end }) => ({ value: end === '2026-10-10' ? 1900 : 1450 });
  const events = [];
  const bundle = await gmBet.readBundle(root, { deps: { ...fixtureDeps, readMetric }, emit: e => events.push(e), ledgerFile: file, today: TODAY });
  assert.deepEqual(events.slice(0, 2).map(e => e.kind), ['score', 'score'], 'scoring runs first');
  assert.equal(bundle.sources.ledger.fact, 'past bets: 2 (1 won, 1 lost, 0 open, 0 skipped)');
  const text = gmBet.bundleText(bundle);
  assert.ok(text.includes('- won: Write the gm phone getting started page (goal 1,700, got 1,900)'));
  assert.ok(text.includes('- lost: Post a sixty second gm clip on x (goal 1,700, got 1,450)'));
  const prompt = gmBet.buildPrompt(bundle, { today: TODAY });
  assert.match(prompt, /lean toward moves like the winners and away from the losers, and when you do, say so in why_now/);
  assert.ok(prompt.includes('- lost: Post a sixty second gm clip on x (goal 1,700, got 1,450)'));
});

// ---- validation -----------------------------------------------------------------

test('validate: a good bet passes', async () => {
  const { bundle } = await bundleFor(workspace());
  const out = gmBet.validateBet(goodBet(), { bundle, today: TODAY });
  assert.deepEqual(out, { ok: true, reasons: [], formatOnly: false });
});

test('validate: vague title, bad date, all-you steps, uncited why_now, and a posting team step are turned down', async () => {
  const { bundle } = await bundleFor(workspace());
  const check = over => gmBet.validateBet(goodBet(over), { bundle, today: TODAY }).reasons.join(' | ');
  assert.match(check({ title: 'Improve onboarding for new users of the product' }), /vague verb "improve"/);
  assert.match(check({ title: 'Ship it' }), /too short/);
  assert.match(check({ title: 'Make things better for growth and engagement' }), /no concrete deliverable/);
  assert.match(check({ check_in_days: 15 }), /check_in_days must be a whole number from 7 to 14, got 15/);
  assert.match(check({ check_in_days: 0 }), /got 0/);
  assert.match(check({ check_in_days: 3.5 }), /got 3\.5/);
  assert.match(check({ check_in_days: '7' }), /got "7"/);
  assert.match(check({ check_in_days: undefined }), /check_in_days is missing/);
  // a date the model writes is ignored; only the number of days counts
  assert.equal(gmBet.validateBet(goodBet({ check_date: '1999-01-01' }), { bundle, today: TODAY }).ok, true);
  assert.match(check({ steps: goodBet().steps.map(s => ({ ...s, who: 'you' })) }), /no step is for the team/);
  assert.match(check({ why_now: 'people would probably like a nicer first run experience overall.' }), /does not quote a fact/);
  assert.match(check({ steps: [{ text: 'post the thread on x', who: 'team', member: 'builder', public: false }, goodBet().steps[0]] }), /step 1 reaches the outside world/);
  assert.match(check({ steps: [{ text: 'draft and send the email to 20 users', who: 'team', member: 'builder', public: false }, goodBet().steps[0]] }), /step 1 reaches the outside world/);
  assert.doesNotMatch(check({ steps: [{ text: 'draft the launch post for review', who: 'team', member: 'builder', public: false }, goodBet().steps[2]] }), /step 1/);
  assert.match(check({ expect: 'more installs' }), /number and a metric/);
  assert.match(check({ metric_source: 'how people feel' }), /not a source we can read/);
  assert.match(check({ why_now: '' }), /why_now is missing/);
  // the card fits one phone screen: short why, at most 5 one-line steps, no paths or commands
  assert.match(check({ why_now: `installs last week were 1,400. ${'and the page is new. '.repeat(8)}` }), /why_now is \d+ characters, over 160/);
  assert.match(check({ why_now: 'installs were 1,400. the page is new. nobody has seen it.' }), /more than two sentences/);
  const step = { text: 'draft one short section', who: 'team', member: 'builder', public: false };
  assert.match(check({ steps: [step, step, step, step, step, step] }), /steps must have 2 to 5 items/);
  assert.match(check({ steps: [{ ...step, text: 'draft the getting started page and a matching readme section with screenshots' }, goodBet().steps[2]] }), /step 1 is 77 characters, over the 70 that fit one line/);
  assert.match(check({ steps: [{ ...step, text: 'rerun scripts/det/bakeoff.sh on both engines' }, goodBet().steps[2]] }), /step 1 has a file path or a command in it/);
  assert.match(check({ steps: [{ ...step, text: 'update package.json keywords' }, goodBet().steps[2]] }), /step 1 has a file path or a command/);
  assert.match(check({ steps: [{ ...step, text: 'run npm publish after review' }, goodBet().steps[2]] }), /step 1 has a file path or a command/);
  assert.match(check({ steps: [{ ...step, text: 'ship with the --demo flag on' }, goodBet().steps[2]] }), /step 1 has a file path or a command/);
  assert.match(check({ steps: [{ ...step, detail: 'x'.repeat(241) }, goodBet().steps[2]] }), /step 1 detail must be text under 240/);
  assert.equal(gmBet.validateBet(goodBet(), { bundle, today: TODAY }).ok, true);
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
    writers: 1,
    deps: { ...fixtureDeps, runModel: async (prompt) => { prompts.push(prompt); return { ok: true, text: bad }; } },
  });
  // no draft met the plain rules, so there is no card to show: the one honest failure left
  assert.equal(out.ok, false);
  assert.equal(prompts.length, 3);
  assert.doesNotMatch(prompts[0], /was rejected/);
  assert.match(prompts[1], /Your last answer was rejected: .*vague verb "optimize"/);
  assert.match(out.reason, /turned down 3 times/);
  assert.match(prompts[2], /Your last answer was rejected: .*vague verb "optimize"/);
  assert.deepEqual(events.slice(SOURCE_KEYS.length).map(e => e.kind), ['swarm', 'model', 'reject', 'model', 'reject', 'model', 'reject', 'none']);
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
    writers: 1,
    deps: {
      ...fixtureDeps,
      now: () => (n += 5000),
      runModel: async (prompt, { onProgress }) => {
        const retry = /was rejected/.test(prompt);
        onProgress({ thinking: 300, chars: 0, text: '' });
        onProgress({ thinking: 300, chars: 40, text: '{"title": "write the page' });
        return { ok: true, text: retry ? `\`\`\`json\n${JSON.stringify(goodBet())}\n\`\`\`` : 'not json at all' };
      },
    },
  });
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.attempts, 2);
  assert.equal(out.bet.title, goodBet().title);
  assert.deepEqual(events.map(e => e.kind), [...SOURCE_KEYS.map(() => 'source'), 'swarm', 'model', 'thinking', 'thinking', 'reject', 'model', 'thinking', 'thinking', 'skeptic', 'check']);
  assert.equal(events[SOURCE_KEYS.length + 1].line, 'asking the model for one bet');
  assert.equal(events[SOURCE_KEYS.length + 2].line, 'thinking...');
  assert.equal(events[SOURCE_KEYS.length + 3].line, 'thinking... 4 words written');
  // the lines the waiting card shows, in the owner's words
  assert.deepEqual(events.filter(e => e.say).map(e => e.say), ['drafting an idea', 'one draft did not fit. redrafting it', 'the first draft is in. checking it', 'found one that holds up']);
  // the waiting lines say what is happening to the idea, never how the work is checked
  for (const t of events.filter(e => e.say).map(e => e.say)) assert.doesNotMatch(t, /\brules?\b|\bcheck(s|ed)? (date|rule)|\bskeptic|\bjudge/, t);
  assert.ok(events.every(e => !/token|character/.test(e.line)));
  // the date is worked out from the owner's today, in calendar days
  assert.equal(out.bet.check_in_days, 9);
  assert.equal(out.bet.check_date, '2026-10-30');
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
  assert.deepEqual(progress.map(p => [p.thinking, p.chars, p.text]), [[120, 0, ''], [120, 5, '{"a":'], [120, 7, '{"a":1}']]);
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
  // long enough for a busy machine to start the stub and its child first
  const res = await gmBet.runModel('x', { command: { bin, args: [] }, timeoutMs: 3000 });
  assert.equal(res.ok, false);
  assert.equal(res.timed_out, true);
  assert.equal(res.reason, 'the model took longer than 3 seconds and was stopped');
  assert.ok(Date.now() - started < 10000);
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

test('model: stopping the phone server ends every writer still running, so none is left behind', { skip: process.platform === 'win32' }, async () => {
  const { EventEmitter } = require('node:events');
  const kills = [];
  const fake = (pid) => () => { const c = new EventEmitter(); c.pid = pid; c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => {}; return c; };
  const children = [];
  const spawnFn = (...a) => { const c = fake(4200 + children.length)(...a); children.push(c); return c; };
  const kill = (pid, sig) => { kills.push([pid, sig]); };
  const a = gmBet.runModel('one', { spawnFn, kill, timeoutMs: 60000 });
  const b = gmBet.runModel('two', { spawnFn, kill, timeoutMs: 60000 });
  assert.equal(gmBet.stopWriters(), 2);
  assert.deepEqual(kills, [[-4200, 'SIGTERM'], [-4201, 'SIGTERM']]);
  for (const c of children) c.emit('close', 143);
  assert.match((await a).reason, /exited with code 143/);
  await b;
  // finished writers are forgotten
  assert.equal(gmBet.stopWriters(), 0);
  // the gm phone stop handler calls it
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'commands', 'gm.js'), 'utf8'), /require\('\.\.\/lib\/gm-bet'\)\.stopWriters\(\);/);
});

test('model: a non-zero exit with no answer fails with the reason', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-bet-fail-'));
  const bin = stubScript(dir, 'broken', 'process.stderr.write("not logged in\\n"); process.exit(3);');
  const res = await gmBet.runModel('x', { command: { bin, args: [] } });
  assert.deepEqual(res, { ok: false, reason: 'the model exited with code 3: not logged in' });
});

// ---- the desk: the queue, taps, skip, do it, ledger ---------------------------------------

const TITLES = [
  'Write a getting started page for atris gm phone with a 30 second screen recording',
  'Record a two minute demo video of the phone front office for the readme',
  'Add a pricing comparison table for teams to the landing page footer',
  'Email ten recent installers a three question survey about their first hour',
  'Draft a changelog digest of merged pull requests for the weekly newsletter',
  'Build a sample workspace template that new users can clone in one command',
];
// a title as the owner reads it: every card speaks lowercase
const shown = t => t[0].toLowerCase() + t.slice(1);

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
const FALLBACK_CHOICES = [{ id: 'using', label: 'more people using it' }, { id: 'money', label: 'making money from it' }, { id: 'better', label: 'making it better' }];

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

test('queue: opening the page fills it to 3, one generation at a time, never more than 3 in flight', async () => {
  const h = desk(workspace());
  for (let i = 0; i < 6; i += 1) h.d.warm();
  assert.equal(h.gen.calls.length, 1);
  assert.equal(h.d.state.inFlight, 1);
  await h.gen.releaseOne();
  await h.gen.releaseOne();
  await h.gen.releaseOne();
  assert.equal(h.d.view().queue, 3);
  assert.equal(h.gen.calls.length, 3);
  assert.equal(h.gen.maxActive, 1);
  assert.ok(h.d.state.maxInFlight <= 3);
  h.d.warm();
  assert.equal(h.gen.calls.length, 3, 'a full queue starts nothing');
  assert.deepEqual(h.ledger().map(r => r.status), ['queued', 'queued', 'queued']);
});

test('queue: a tap shows the next bet at once, and the next one is written at once, back to 3', async () => {
  const h = await filled(workspace());
  const first = h.d.next();
  assert.equal(first.status, 'ready');
  assert.equal(first.bet.title, TITLES[0]);
  assert.equal(first.queue, 2);
  assert.equal(h.gen.calls.length, 4, 'showing one starts the next');
  const second = h.d.next();
  assert.equal(second.bet.title, TITLES[1]);
  assert.equal(second.queue, 1);
  assert.equal(h.gen.calls.length, 4, 'still one at a time');
  await h.gen.releaseOne();
  assert.equal(h.gen.calls.length, 5, 'and keeps going to 3');
  await h.gen.releaseOne();
  assert.equal(h.d.view().queue, 3);
  assert.equal(h.gen.calls.length, 5);
  assert.equal(h.gen.maxActive, 1);
});

test('queue: each new bet is asked to differ from every one shown or waiting', async () => {
  const h = await filled(workspace());
  h.d.next();
  h.d.next();
  const avoid = h.gen.calls[3].avoidTitles;
  for (const t of TITLES.slice(0, 3)) assert.ok(avoid.includes(t), t);
  const { bundle } = await bundleFor(workspace());
  const near = gmBet.validateBet(goodBet({ title: 'Write a getting started page for atris gm phone with a screen recording' }), { bundle, today: TODAY, avoidTitles: TITLES.slice(0, 1) });
  assert.match(near.reasons.join(' | '), /too close to a bet already shown or waiting/);
  const far = gmBet.validateBet(goodBet({ title: 'Email ten recent installers a three question survey about their first hour' }), { bundle, today: TODAY, avoidTitles: TITLES.slice(0, 1) });
  assert.equal(far.ok, true, far.reasons.join(' | '));
  const prompt = gmBet.buildPrompt({ facts: [], sources: {} }, { today: TODAY, avoidTitles: TITLES.slice(0, 2) });
  assert.match(prompt, /different move from every one of these bets/);
  assert.ok(prompt.includes(`- ${TITLES[1]}`));
});

// what an owner sees when nothing is ready and every question is answered
const WAIT = { what: 'writing your next idea.' };

test('queue: with every question answered and nothing ready, a tap shows a plain card at once, never a wait', async () => {
  const h = desk(workspace(), { answered: true });
  const tap = h.d.next();
  assert.deepEqual([tap.status, tap.kind, tap.job, tap.events], ['ready', 'wait', WAIT, []]);
  assert.equal(h.gen.calls.length, 1, 'the idea really is being written');
  await h.gen.releaseOne();
  // the calm line stays on screen with the idea ready behind it; the page asks for it
  assert.deepEqual([h.d.view().kind, h.d.view().queue], ['wait', 1]);
  assert.deepEqual([h.d.next().kind, h.d.view().bet.title], ['bet', TITLES[0]]);
});

test('calm line: words typed while the idea is written are a note for it: the same card takes them, read by no model, and the idea that comes in is the one written with them', async () => {
  const reads = [];
  const h = desk(workspace(), { answered: true, readSaid: async (p) => { reads.push(p); return { ok: true, kind: 'instruction', reply: '' }; } });
  h.d.next();
  const calm = h.d.card().card;
  // the calm line keeps its box open, as a note for the idea being written
  assert.deepEqual([calm.kind, calm.watch, calm.input.action, calm.input.placeholder], ['wait', true, 'say', 'add a note for this idea']);
  assert.equal(h.gen.calls.length, 1, 'an idea is being written');
  // one lands while the owner types, and the next starts behind it
  await h.gen.releaseOne();
  assert.equal(h.gen.calls.length, 2);

  // a typed post names the calm line and is taken, not refused as stale
  const said = await h.d.act({ card_id: calm.id, text: 'make it about schools' });
  assert.equal(said.status, 200, JSON.stringify(said.body));
  assert.deepEqual([said.body.ok, said.body.ack, said.body.card.kind, said.body.card.id], [true, 'got it, i\'ll fold that in.', 'wait', calm.id]);
  assert.deepEqual(said.body.card.thread, [{ who: 'owner', text: 'make it about schools' }, { who: 'orb', text: 'got it, i\'ll fold that in.' }]);
  assert.ok(said.body.card.input, 'the box stays open');
  assert.equal(reads.length, 0, 'a note is read by no model');
  assert.ok(h.logs.some(r => r.choice === 'wait_note' && r.kind === 'wait'), 'the note is recorded');
  // the drafting no one asked for is stopped for it; the idea written before it waits
  assert.equal(h.gen.calls[1].signal.aborted, true);
  assert.equal(h.d.card().queue, 0, 'nothing is ready for this card yet');
  const early = await h.d.act({ orb: true, card_id: calm.id });
  assert.deepEqual([early.body.card.kind, early.body.card.id], ['wait', calm.id], 'the big orb waits for the noted idea too');
  await h.gen.releaseOne();
  assert.equal(h.gen.calls[2].ownerNote, 'make it about schools');

  // a second note joins the first under the same card; the drafting with the first goes on
  const more = await h.d.act({ card_id: calm.id, text: 'and keep it cheap' });
  assert.deepEqual([more.status, more.body.card.id], [200, calm.id]);
  assert.deepEqual(more.body.card.thread.map(t => t.text), ['make it about schools', 'and keep it cheap', 'got it, i\'ll fold that in.']);
  assert.equal(h.gen.calls[2].signal.aborted, false);
  await h.gen.releaseOne();
  assert.equal(h.gen.calls[3].ownerNote, 'make it about schools; and keep it cheap');
  assert.equal(h.d.card().queue, 0, 'the first note alone is not the newest note');
  await h.gen.releaseOne();
  assert.ok(h.d.card().queue > 0);
  const landed = await h.d.act({ orb: true, card_id: calm.id });
  assert.deepEqual([landed.body.card.kind, landed.body.card.title], ['idea', shown(TITLES[3])]);
  assert.equal(h.d.view().queue, 2, 'the ideas written without the newest note are kept for later');
});

test('calm line: an older calm line is stale, the same one under a new stamp is not, and the wait for a noted idea lasts one drafting budget: then the ready idea comes alone, saying the note is still being folded in, and the noted one is the next card', async () => {
  const h = desk(workspace(), { answered: true, choices: true });
  h.d.next();
  const calm = h.d.card().card;
  const [base] = calm.id.split('#');
  await h.gen.releaseOne();
  // the same calm line served under another stamp (its words changed) still takes words
  const restamped = await h.d.act({ card_id: `${base}#00000000`, text: 'make it about schools' });
  assert.deepEqual([restamped.status, restamped.body.card.id], [200, calm.id]);
  // a calm line from before is another card
  const old = await h.d.act({ card_id: 'wait:1#00000000', text: 'hello' });
  assert.deepEqual([old.status, old.body.reason], [409, 'gone']);
  // the hold is one drafting budget, the same 30 seconds the writers get
  assert.equal(h.d.card().queue, 0);
  h.tick(29000);
  assert.equal(h.d.card().queue, 0);
  h.tick(1001);
  assert.equal(h.d.card().queue, 1);
  const ready = await h.d.act({ orb: true, card_id: calm.id });
  assert.deepEqual([ready.body.card.kind, ready.body.card.title, ready.body.card.line], ['idea', shown(TITLES[0]), 'your note is still being folded in. that version comes next.']);
  // the noted one lands while that idea is up: nothing swaps under him
  await h.gen.releaseOne();
  assert.equal(h.gen.calls[2].ownerNote, 'make it about schools');
  await h.gen.releaseOne();
  await h.gen.releaseOne();
  assert.ok(h.d.view().queue >= 2, 'two ideas ready, enough for a choice');
  assert.equal(h.d.card().card.id, ready.body.card.id, 'the card on screen stays');
  // and it is the next card, on its own, not one of a choice
  const next = await h.d.act({ orb: true, card_id: ready.body.card.id });
  assert.deepEqual([next.body.card.kind, next.body.card.title, next.body.card.line || null], ['idea', shown(TITLES[2]), null]);
});

test('calm line: a note on a wait that ends with nothing is kept, and try again drafts with it', async () => {
  const h = desk(workspace(), { answered: true, gen: stubGenerator({ fail: n => n === 1 }) });
  h.d.next();
  const calm = h.d.card().card;
  await h.d.act({ card_id: calm.id, text: 'make it about schools' });
  await h.gen.releaseOne();
  assert.equal(h.gen.calls[1].ownerNote, 'make it about schools');
  // the drafting with the note fails: the wait ends in a card he can act on
  await h.gen.releaseOne();
  const missed = h.d.card().card;
  assert.equal(missed.kind, 'missed');
  const again = await h.d.act({ card_id: missed.id, option_id: 'again' });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  await h.gen.releaseOne();
  assert.equal(h.gen.calls[h.gen.calls.length - 1].ownerNote, 'make it about schools');
});

test('calm line: try again after a failed noted drafting joins the one already writing the combined note, never a second', async () => {
  const h = desk(workspace(), { answered: true, gen: stubGenerator({ fail: n => n === 1 }) });
  const joined = 'make it about schools; and keep it cheap';
  h.d.next();
  const calm = h.d.card().card;
  await h.d.act({ card_id: calm.id, text: 'make it about schools' });
  await h.gen.releaseOne();
  assert.equal(h.gen.calls[1].ownerNote, 'make it about schools');
  // a second note while the first is being written
  await h.d.act({ card_id: calm.id, text: 'and keep it cheap' });
  // that drafting fails: the wait ends, and the combined note starts drafting on its own
  await h.gen.releaseOne();
  const missed = h.d.card().card;
  assert.equal(missed.kind, 'missed');
  assert.equal(h.gen.calls[2].ownerNote, joined);
  // try again joins it: the calm line shows the notes and starts nothing new
  const again = await h.d.act({ card_id: missed.id, option_id: 'again' });
  assert.deepEqual([again.status, again.body.card.kind], [200, 'wait'], JSON.stringify(again.body));
  assert.deepEqual(again.body.card.thread.map(x => x.text), ['make it about schools', 'and keep it cheap', 'got it, i\'ll fold that in.']);
  assert.equal(h.d.card().queue, 0, 'the calm line waits for the idea with the note');
  await h.gen.releaseOne();
  assert.equal(h.gen.calls.filter(c => c.ownerNote === joined).length, 1, 'one drafting carries the note');
  // and that idea is the one that comes in
  const landed = await h.d.act({ orb: true, card_id: again.body.card.id });
  assert.deepEqual([landed.body.card.kind, landed.body.card.title], ['idea', shown(TITLES[2])]);
  await h.gen.release();
  assert.equal(h.gen.calls.filter(c => c.ownerNote === joined).length, 1, 'and never a second one later');
});

test('queue: a tap while a background bet is being made shows a card now, and starts no second call', async () => {
  const h = desk(workspace(), { answered: true });
  h.d.warm();
  const tap = h.d.next();
  assert.deepEqual([tap.status, tap.kind], ['ready', 'wait']);
  assert.equal(h.gen.calls.length, 1);
  await h.gen.releaseOne();
  assert.equal(h.d.next().bet.title, TITLES[0]);
  assert.equal(h.gen.calls.length, 2, 'and the next one is being written');
});

test('queue: bets older than 6 hours are dropped, and a restart picks up the fresh ones', async () => {
  const root = workspace();
  const h = await filled(root, { answered: true });
  h.tick(gmBet.STALE_MS + 1000);
  const tap = h.d.next();
  assert.deepEqual([tap.status, tap.kind], ['ready', 'wait'], 'all three were stale');
  assert.deepEqual(h.ledger().filter(r => r.status === 'stale').length, 3);

  const root2 = workspace();
  const fresh = await filled(root2);
  assert.equal(fresh.d.view().queue, 3);
  const again = desk(root2, { ledgerFile: fresh.ledgerFile, start: NOW + 1000 });
  assert.equal(again.d.view().queue, 3, 'the queue lives in the ledger, a reload wastes nothing');
});

test('queue: bets made under older rules are dropped as stale with why on load, and the first tap never shows them', async () => {
  const root = workspace();
  const ledgerFile = path.join(root, 'gm-bets.jsonl');
  const at = new Date(NOW - 60 * 60000).toISOString();
  const old = (id, bet) => ledgerRow(ledgerFile, root, id, { created_at: at, status: 'queued', bet: { ...bet, check_date: '2026-10-30' } });
  // the live bug: a plumbing bet from before members and verify
  old('plumbing', { ...goodBet({ title: 'Run one landing day that merges the five waiting branch jobs' }), target: { metric: 'queue_landed', baseline: 0, goal: 5, job_ids: ['j1'] }, verify: undefined, steps: [{ text: 'merge the five branches', who: 'team', public: false }, { text: 'approve the merges', who: 'you', public: false }] });
  old('nomember', { ...goodBet({ title: 'Record a demo video of the phone front office' }), steps: [{ text: 'record the demo', who: 'team', public: false }, goodBet().steps[2]] });
  old('ghost', { ...goodBet({ title: 'Email ten recent installers a three question survey' }), steps: [{ text: 'draft the survey', who: 'team', member: 'sales-bot', public: false }, goodBet().steps[2]] });
  old('noverify', { ...goodBet({ title: 'Add a pricing comparison table for teams' }), verify: 'git diff --check' });
  old('good', goodBet({ title: 'Write a getting started page for atris gm phone with a 30 second screen recording' }));
  const h = desk(root, { ledgerFile });
  assert.equal(h.d.view().queue, 1, 'only the bet that meets today\'s rules is kept');
  const byId = Object.fromEntries(h.ledger().map(r => [r.id, r]));
  assert.deepEqual(['plumbing', 'nomember', 'ghost', 'noverify', 'good'].map(id => [id, byId[id].status, byId[id].stale_reason || null]), [
    ['plumbing', 'stale', 'its target queue_landed measures team plumbing, not a business move'],
    ['nomember', 'stale', 'step 1 names no member on the team'],
    ['ghost', 'stale', 'step 1 names no member on the team'],
    ['noverify', 'stale', 'verify "git diff --check" is always true or only checks formatting; it must prove the deliverable (a test file, a file that must exist, a count read back)'],
    ['good', 'queued', null],
  ]);
  const first = h.d.next();
  assert.equal(first.bet.title, 'Write a getting started page for atris gm phone with a 30 second screen recording');
  assert.equal(h.gen.calls.length, 1, 'the queue refills behind the dropped bets');
  assert.equal(gmBet.queuedProblem(goodBet(), [{ name: 'builder' }, { name: 'launcher' }]), null);
  assert.equal(gmBet.queuedProblem({ title: 'x' }, null), 'it is not a whole bet');
});

test('queue: two failed background bets in a row back off on a timer, then the queue refills on its own', async () => {
  const timers = [];
  const gen = stubGenerator({ fail: n => n < 2 });
  const h = desk(workspace(), { gen, setTimer: (fn, ms) => { timers.push({ fn, ms }); } });
  h.d.warm();
  await gen.releaseOne();
  await gen.releaseOne();
  assert.equal(gen.calls.length, 2);
  h.d.warm();
  assert.equal(gen.calls.length, 2, 'backing off: nothing new starts');
  assert.deepEqual(timers.map(t => t.ms), [gmBet.BACKOFF_MS], 'one retry timer, not a stop until the next tap');
  assert.equal(gmBet.BACKOFF_MS, 10 * 60 * 1000);
  // a tap during the backoff still gets a card at once and starts nothing
  assert.equal(h.d.next().kind, 'question');
  assert.equal(gen.calls.length, 2);
  // the timer fires: the desk tries again with no tap
  h.tick(gmBet.BACKOFF_MS);
  timers[0].fn();
  assert.equal(gen.calls.length, 3);
  await gen.releaseOne();
  assert.equal(h.d.view().queue, 1);
  assert.equal(gen.calls.length, 4, 'and keeps refilling');
});

test('desk: it starts filling the queue as soon as it is made, before the page opens', async () => {
  const gen = stubGenerator();
  const h = desk(workspace(), { gen, warm: true });
  assert.equal(gen.calls.length, 1);
  assert.equal(h.d.state.inFlight, 1);
  h.d.warm();
  assert.equal(gen.calls.length, 1, 'still one generation at a time');
  await gen.releaseOne();
  assert.equal(h.d.view().queue, 1);
});

test('questions: with none written yet, one generic question shows at once; once answered this week, the plain card', async () => {
  const root = workspace();
  const h = desk(root, { questions: false });
  const q = h.d.next();
  assert.deepEqual([q.status, q.kind], ['ready', 'question']);
  assert.deepEqual(q.question, { ask: 'what matters most for this project this month?', line: 'installs rose to 1,400 last week, up from 1,300.', choices: FALLBACK_CHOICES });
  assert.equal(h.d.answer({ choice: 'money' }).ack, 'got it: making money from it.');
  assert.deepEqual([h.d.next().kind, h.d.view().job], ['wait', { what: 'writing your next idea.' }]);
  // no npm numbers in this workspace: the question stands alone, with no made-up fact
  const plain = desk(workspace(), { questions: false, bundle: null });
  assert.equal(plain.d.next().question.line, null);
  // a week later the generic question can come back
  const later = desk(root, { questions: false, ledgerFile: h.ledgerFile, start: NOW + 8 * 24 * 60 * 60 * 1000 });
  assert.equal(later.d.next().kind, 'question');
});

test('questions: the writer keeps two ready from this project, a tap shows one at once, and it is an interview', async () => {
  const root = workspace();
  const h = desk(root, { warm: true });
  await tick();
  assert.equal(h.qgen.calls.length, 2, 'two questions written ahead');
  assert.deepEqual(h.qgen.calls[0].answers, []);
  const q = h.d.next();
  assert.deepEqual([q.kind, q.question.ask, q.question.line], ['question', QLIST[0].ask, QLIST[0].fact]);
  assert.deepEqual(q.question.choices, [{ id: 'a1', label: 'solo founders' }, { id: 'a2', label: 'small teams' }, { id: 'a3', label: 'nobody yet' }]);
  assert.equal(h.d.answer({ choice: 'a2' }).ack, 'got it: small teams.');
  await tick();
  // the next question is written knowing the answer, and never repeats an asked one
  const after = h.qgen.calls[h.qgen.calls.length - 1];
  assert.deepEqual(after.answers, [{ ask: QLIST[0].ask, label: 'small teams' }]);
  assert.ok(after.avoid.includes(QLIST[0].ask));
  assert.equal(h.d.next().question.ask, QLIST[1].ask);
  // the idea writer reads the same answers
  const bundle = await gmBet.readBundle(root, { deps: fixtureDeps, ledgerFile: h.ledgerFile });
  assert.deepEqual(bundle.sources.focus.answers.map(a => [a.ask, a.label]), [[QLIST[0].ask, 'small teams']]);
  assert.match(gmBet.buildPrompt(bundle, { today: TODAY }), /who uses the phone page most right now\? small teams/);
  // the one written before the answer was set aside; a restart keeps the one written after it
  const again = desk(root, { ledgerFile: h.ledgerFile, questions: false });
  assert.equal(again.d.next().question.ask, QLIST[3].ask);
});

test('questions: the real writer reads the project files and earlier answers; a banned word gets one rewrite, then it is dropped', async () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, 'README.md'), '# atris\n\nan operating system for small teams of ai agents. solo founders run it from a laptop.\n');
  const context = gmBet.readProjectContext(root);
  assert.match(context, /## README\.md\n# atris\n\nan operating system for small teams of ai agents/);
  const base = { workspaceRoot: root, ledgerFile: path.join(root, 'bets.jsonl'), today: TODAY, answers: [{ ask: 'who uses it most?', label: 'solo founders' }], avoid: ['who uses it most?'] };
  const good = { ask: 'what would make a solo founder pay for it?', fact: 'solo founders run it from a laptop.', choices: ['saving hours', 'fewer mistakes'] };
  const worded = { ...good, ask: 'what bet would make a solo founder pay for it?' };
  const prompts = [];
  const model = list => async (prompt) => { prompts.push(prompt); return { ok: true, text: JSON.stringify(list[prompts.length - 1]) }; };
  const out = await gmBet.generateQuestion({ ...base, deps: { ...fixtureDeps, runModel: model([worded, good]) } });
  assert.deepEqual(out, { ok: true, question: good });
  assert.match(prompts[0], /Write exactly ONE question for the owner about the product or the business of this project/);
  assert.match(prompts[0], /- who uses it most\? solo founders/);
  assert.match(prompts[0], /an operating system for small teams of ai agents/);
  assert.match(prompts[0], /never use these words: bet, bets, check date/);
  // the fact gives the reason for its question, or is left out; no talk of how answers are used
  assert.match(prompts[0], /- fact: the plain reason this question matters now/);
  assert.match(prompts[0], /if nothing in the files gives a reason for this question, set fact to ""/);
  assert.match(prompts[0], /never mention ideas, the team, or what happens to his answer/);
  assert.match(prompts[1], /^Your last question broke only these limits:\n- ask uses "bet"/);
  // the rewrite still uses one: dropped
  prompts.length = 0;
  const dropped = await gmBet.generateQuestion({ ...base, deps: { ...fixtureDeps, runModel: model([worded, worded]) } });
  assert.equal(dropped.ok, false);
  assert.match(dropped.reason, /dropped: ask uses "bet"/);
  // a fact not drawn from the project's files, or a repeat of an asked question, is dropped at once
  prompts.length = 0;
  const madeUp = await gmBet.generateQuestion({ ...base, deps: { ...fixtureDeps, runModel: model([{ ...good, fact: 'revenue doubled in march across europe.' }]) } });
  assert.deepEqual([madeUp.ok, prompts.length], [false, 1]);
  assert.match(madeUp.reason, /the fact is not in this project's files/);
  // no fitting fact: the question stands on its own
  prompts.length = 0;
  const bare = await gmBet.generateQuestion({ ...base, deps: { ...fixtureDeps, runModel: model([{ ...good, ask: 'who do you most want using this?', fact: '' }]) } });
  assert.deepEqual(bare, { ok: true, question: { ask: 'who do you most want using this?', fact: null, choices: good.choices } });
  // our process in the question is dropped like a banned word
  assert.match(gmBet.validateQuestion({ ask: 'what should the next idea be about?', fact: '', choices: ['a', 'b'] }, { source: '' }).reasons.join(' | '), /ask talks about our ideas/);
  prompts.length = 0;
  const repeat = await gmBet.generateQuestion({ ...base, deps: { ...fixtureDeps, runModel: model([{ ...good, ask: 'who uses it most?' }]) } });
  assert.match(repeat.reason, /already asked/);
});

test('questions: a question writer that keeps failing rests on the timer, and taps still get a card', async () => {
  const timers = [];
  const qgen = stubQuestions({ list: [] });
  const h = desk(workspace(), { qgen, setTimer: (fn, ms) => { timers.push({ fn, ms }); } });
  h.d.warm();
  await tick();
  assert.equal(qgen.calls.length, 2, 'two misses, then it rests');
  assert.ok(timers.some(t => t.ms === gmBet.BACKOFF_MS));
  assert.equal(h.d.next().question.ask, 'what matters most for this project this month?');
});

test('owner words: no fixed page string, card template, or question uses our internal words', async () => {
  const banned = gmBet.OWNER_BANNED;
  for (const w of ['bet', 'bets', 'check date', 'started so far', 'the team takes on', 'mission', 'queue', 'landed', 'review', 'reviewed', 'receipt', 'skeptic', 'verify', 'target number']) {
    assert.match(`so the ${w} is`, banned, w);
  }
  for (const ok of ['better', 'alphabet', 'landing page', 'reviewer2x']) assert.doesNotMatch(ok, banned, ok);
  const said = [];
  // the generic question, its answers, and the reply
  const F = gmBet.FALLBACK_QUESTION;
  said.push(F.ask, ...F.choices.map(c => c.label));
  const h = desk(workspace(), { questions: false });
  const v = h.d.next();
  said.push(v.question.ask, v.question.line, h.d.answer({ choice: 'using' }).ack);
  // the plain card, the yes and done templates, and every ack
  const w = h.d.next();
  said.push(w.job.what, ...(w.job.why ? [w.job.why] : []));
  const root = workspace();
  const file = path.join(root, 'gm-bets.jsonl');
  doingRow(file, root, 'b-ask', 'm-ask', 'Write the launch thread');
  doingRow(file, root, 'b-done', 'm-done', 'Write the getting started page');
  const j = jobDesk(root, {
    'm-ask': { id: 'm-ask', owner: 'launcher', status: 'running', updated_at: new Date(NOW).toISOString(), human_asks: ['post the thread on x now?'] },
    'm-done': { id: 'm-done', owner: 'builder', status: 'complete', receipt_path: 'r', human_asks: [] },
  });
  await j.d.settle();
  const yes = j.d.next();
  said.push(yes.job.what, yes.job.why, (await j.d.answerYes()).ack);
  const done = j.d.next();
  said.push(done.job.what, done.job.why, j.d.nice().ack);
  const f = await filled(workspace());
  f.d.next();
  const skipped = f.d.skip();
  // not now on an idea: the got-it line says what happened, and the line under the orb says what to do, never not now twice
  assert.equal(skipped.ack, 'set aside.');
  said.push(skipped.ack, f.d.skip().message);
  f.d.next();
  said.push((await f.d.doIt()).ack);
  for (const t of said) {
    assert.equal(typeof t, 'string');
    assert.doesNotMatch(t, banned, t);
  }
  // a model-written question with one of the words never reaches the owner
  assert.match(gmBet.validateQuestion({ ask: 'which bet next?', fact: 'solo founders run it.', choices: ['a', 'b'] }, { source: 'solo founders run it.' }).reasons.join(' | '), /ask uses "bet"/);
  // every sentence the page itself can show, and its labels
  const html = phonePage('NONCE');
  const script = html.split('<script nonce="NONCE">')[1].split('</script>')[0];
  const copy = [...script.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)].map(m => m[1]).filter(t => / /.test(t) && !/[();]/.test(t));
  const labels = [...html.matchAll(/aria-label="([^"]+)"/g)].map(m => m[1]);
  assert.ok(copy.length > 10 && labels.length >= 2);
  for (const t of [...copy, ...labels]) assert.doesNotMatch(t, banned, t);
});

test('owner words: every refusal the desk or the page can show ends like a sentence, with no semicolons', () => {
  // the line under the options and the line under the orb read the same way on every card
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'gm-bet.js'), 'utf8');
  const said = [...src.matchAll(/(?:message: |refuse\('[a-z_]+', |out\.message \|\| )(['`])((?:(?!\1)[^\n])*)\1/g)].map(m => m[2]);
  assert.ok(said.length > 25, `found ${said.length}`);
  for (const t of said) {
    assert.match(t, /[.?!]$/, t);
    assert.doesNotMatch(t, /;/, t);
  }
  const html = phonePage('NONCE');
  const errors = [...html.matchAll(/'((?:that|this|it) [^'\n]*(?:try again|stopped working)[^'\n]*)'/g)].map(m => m[1]);
  assert.ok(errors.length >= 4, errors.join(' | '));
  for (const t of errors) assert.match(t, /\.$/, t);
});

test('owner words: the writer is told the words, and a card that uses one gets one free rewrite before it is kept', async () => {
  const { bundle } = await bundleFor(workspace());
  assert.match(gmBet.buildPrompt(bundle, { today: TODAY }), /- title, why_now, and expect are read by the owner, so they never use these words: bet, bets, check date/);
  const v = gmBet.validateBet(goodBet({ why_now: 'installs last week were 1,400, and this bet reaches people who have never tried it.' }), { bundle, today: TODAY });
  assert.equal(v.ok, false);
  assert.equal(v.formatOnly, true, 'a banned word is fixed by the free rewrite turn');
  assert.match(v.reasons.join(' | '), /why_now uses "bet", a word the owner never reads; say it plainly/);
  // in a real run: the rewrite turn swaps the word and the idea is kept on the same try
  const root = workspace();
  const worded = goodBet({ title: 'Write a getting started page for the phone, the bet we make this week' });
  const plain = goodBet({ title: 'Write a getting started page for the phone this week' });
  const prompts = [];
  const out = await gmBet.generateBet({
    workspaceRoot: root, today: TODAY, ledgerFile: path.join(root, 'bets.jsonl'), attemptsFile: path.join(root, 'a.jsonl'), writers: 1,
    deps: { ...fixtureDeps, runModel: async (prompt) => { prompts.push(prompt); return { ok: true, text: JSON.stringify(prompts.length === 1 ? worded : plain) }; } },
  });
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.attempts, 1);
  assert.equal(out.bet.title, 'Write a getting started page for the phone this week');
  assert.match(prompts[1], /^Your last answer below broke only these wording or length limits:\n- title uses "bet"/);
  assert.match(prompts[1], /swap each word named for a plain one/);
});

test('question: the answer is saved next to the ledger, only for this workspace, and a wrong one is refused', async () => {
  const root = workspace();
  const h = desk(root, { questions: false });
  const q = h.d.next();
  // an answer from a page that missed the next card is saved against nothing, and the words say the new card is already there
  const stale = h.d.answer({ choice: 'money', card: 'question:old' });
  assert.deepEqual(stale, { ok: false, reason: 'gone', message: 'that card changed, so nothing was saved. here is the one on screen now.' });
  assert.ok(q && q.id !== 'question:old');
  assert.deepEqual(h.d.answer({ choice: 'nope' }), { ok: false, reason: 'bad_choice', message: 'that is not one of the answers.' });
  assert.equal(h.d.answer({ choice: 'money' }).ok, true);
  assert.deepEqual(h.d.answer({ choice: 'money' }), { ok: false, reason: 'gone', message: 'there is no question on screen.' });
  const file = path.join(path.dirname(h.ledgerFile), 'gm-focus.jsonl');
  assert.equal(gmBet.focusPath(path.dirname(h.ledgerFile)), file);
  const focus = gmBet.readFocus(file, root);
  assert.deepEqual([focus.focus.answer, focus.focus.label, focus.focus.at], ['money', 'making money from it', new Date(NOW).toISOString()]);
  assert.deepEqual(gmBet.readFocus(file, '/some/other/workspace'), {});
  const bundle = await gmBet.readBundle(root, { deps: fixtureDeps, ledgerFile: h.ledgerFile });
  const prompt = gmBet.buildPrompt(bundle, { today: TODAY });
  assert.match(prompt, /what matters most for this project this month\? making money from it/);
  assert.match(prompt, /the bet must serve what the owner asked for/);
});

test('sharper never waits: the bet is passed, a card shows now, and the sharper idea is made behind it', async () => {
  const gen = stubGenerator();
  const h = desk(workspace(), { gen });
  h.d.warm();
  await gen.releaseOne();
  const shown = h.d.next();
  assert.equal(shown.bet.title, TITLES[0]);
  const s = h.d.next({ sharper: true });
  assert.deepEqual([s.status, s.kind], ['ready', 'question']);
  const row = h.ledger().find(r => r.id === shown.id);
  assert.deepEqual([row.status, row.note], ['passed', 'asked for a sharper idea']);
  // the plain refill finishes, then the sharper one is asked for
  await gen.releaseOne();
  assert.equal(gen.calls[2].previousTitle, TITLES[0]);
  await gen.releaseOne();
  // the sharper idea is the next bet shown
  assert.equal(h.d.next().bet.title, TITLES[2]);
});

test('a writer that dies (exit 143) never leaves the desk thinking, through sharper, skip, answer, and plain taps', async () => {
  const gen = stubGenerator({ fail: n => n >= 1, reason: 'the model exited with code 143' });
  const h = desk(workspace(), { gen, setTimer: () => {}, questions: false });
  const seen = [];
  const tap = (opts) => { const v = h.d.next(opts); seen.push(v.status); return v; };
  h.d.warm();
  await gen.releaseOne();
  assert.equal(tap().kind, 'bet');
  assert.equal(tap({ sharper: true }).kind, 'question');
  await gen.release();
  seen.push(h.d.view().status);
  assert.equal(h.d.answer({ choice: 'money' }).ok, true);
  assert.equal(tap().kind, 'wait');
  await gen.release();
  seen.push(h.d.view().status);
  assert.equal(tap().kind, 'wait');
  await gen.release();
  seen.push(h.d.view().status);
  assert.equal(tap().kind, 'wait');
  assert.equal(h.d.skip().ok, false, 'there is no bet to skip');
  assert.equal(tap().kind, 'wait');
  assert.ok(seen.every(st => st === 'ready'), seen.join(', '));
  assert.equal(h.d.view().error, null);
  // a writer that dies before its first bet: the first tap is still a card
  const cold = desk(workspace(), { gen: stubGenerator({ fail: () => true, reason: 'the model exited with code 143' }), warm: true, answered: true });
  await cold.gen.release();
  const first = cold.d.next();
  assert.deepEqual([first.status, first.kind], ['ready', 'wait']);
});

test('passed vs skipped: a re-tap passes the bet over, not now skips it, sharper passes and asks again', async () => {
  const h = await filled(workspace());
  const a = h.d.next();
  const b = h.d.next();
  assert.notEqual(a.id, b.id);
  assert.equal(h.d.skip().ok, true);
  const rows = Object.fromEntries(h.ledger().map(r => [r.id, r]));
  assert.equal(rows[a.id].status, 'passed');
  assert.equal(rows[b.id].status, 'skipped');
  assert.ok(rows[a.id].shown_at);
  // after not now, a tap shows the next one and records nothing more for b
  const c = h.d.next();
  assert.equal(c.status, 'ready');
  assert.equal(Object.fromEntries(h.ledger().map(r => [r.id, r]))[b.id].status, 'skipped');
  // sharper passes c over, shows the next card now, and asks for a bet sharper than c
  await h.gen.release();
  const before = h.gen.calls.length;
  const s = h.d.next({ sharper: true });
  assert.deepEqual([s.status, s.kind], ['ready', 'bet']);
  assert.equal(h.gen.calls.length, before + 1);
  assert.equal(h.gen.calls[before].previousTitle, c.bet.title);
  const cRow = Object.fromEntries(h.ledger().map(r => [r.id, r]))[c.id];
  assert.equal(cRow.status, 'passed');
  assert.equal(cRow.note, 'asked for a sharper idea');
});

test('desk: a failed writer never reaches the screen; a wait it ends is a card to try again, never the error', async () => {
  const gen = stubGenerator({ fail: () => true });
  const h = desk(workspace(), { gen, answered: true });
  h.d.next();
  await gen.releaseOne();
  const v = h.d.view();
  assert.deepEqual([v.status, v.kind, v.error, v.events, v.job], ['ready', 'missed', null, [], { what: 'no idea came together this time.' }]);
  const card = h.d.card().card;
  assert.deepEqual([card.kind, card.title, card.options.map(o => [o.label, o.action])], ['missed', 'no idea came together this time.', [['try again', 'next']]]);
  assert.ok(card.input, 'the owner can say what he wants instead');
  assert.doesNotMatch(JSON.stringify(card), /empty answer|model/);
  // try again: the drafting that started behind it is what the wait shows
  const again = await h.d.act({ card_id: card.id, option_id: 'again' });
  assert.equal(again.body.card.kind, 'wait');
});

test('choice: with 2 or more ideas ready a tap shows up to 3 to pick from; one tap opens it, the rest are passed', async () => {
  const h = await filled(workspace(), { choices: true });
  const c = h.d.next();
  assert.deepEqual([c.status, c.kind, c.bet], ['ready', 'choice', null]);
  assert.deepEqual(c.choice.options.map(o => o.title), TITLES.slice(0, 3));
  // each option: a one-line title and one plain line of why, the idea's expected result
  assert.deepEqual(Object.keys(c.choice.options[0]), ['id', 'title', 'why']);
  assert.equal(c.choice.options[0].why, '300 more npm installs in the week before nov 1.');
  for (const o of c.choice.options) assert.doesNotMatch(`${o.title} ${o.why}`, gmBet.OWNER_BANNED);
  // the why is one short clause, never cut mid word: the real lines from this repo's ideas
  assert.equal(gmBet.choiceWhy('if it works, the 7 days ending nov 3 pass 2,500 installs, past our best week of 2,319, with launch day oct 28 counted in it.'), 'the 7 days ending nov 3 pass 2,500 installs.');
  assert.equal(gmBet.choiceWhy('if it works, maintainers share their scores on launch day oct 27 and weekly installs pass 2,500 by nov 1, past our best week of 2,319.'), 'maintainers share their scores on launch day oct 27 and weekly installs pass 2,500 by nov 1.');
  assert.equal(gmBet.choiceWhy('if it works, weekly installs pass 2,450 by nov 3, past our best week of 2,319, as people run the one line and share the result.'), 'weekly installs pass 2,450 by nov 3, past our best week of 2,319.');
  // one tap picks: its full card shows, with do it as before
  const picked = h.d.pick({ id: c.choice.options[1].id });
  assert.deepEqual([picked.ok, picked.status, picked.kind, picked.bet.title], [true, 'ready', 'bet', TITLES[1]]);
  const rows = Object.fromEntries(h.ledger().map(r => [r.id, r]));
  assert.deepEqual([rows[c.choice.options[0].id].status, rows[c.choice.options[0].id].note], ['passed', 'not picked']);
  assert.deepEqual([rows[c.choice.options[2].id].status, rows[c.choice.options[1].id].status], ['passed', 'proposed']);
  assert.equal((await h.d.doIt()).ok, true);
  // a pick with nothing on screen, or an id not on the card, does nothing
  assert.deepEqual(h.d.pick({ id: 'nope' }), { ok: false, reason: 'gone', message: 'there is nothing to pick on screen.' });
  // one idea ready: the single card, as before
  const one = desk(workspace(), { choices: true });
  one.d.warm();
  await one.gen.releaseOne();
  assert.equal(one.d.next().kind, 'bet');
});

test('choice: the deck order holds: a yes, then a finished job, then the choice; a re-tap passes every option', async () => {
  const root = workspace();
  const file = path.join(root, 'gm-bets.jsonl');
  doingRow(file, root, 'b-ask', 'm-ask', 'Write the launch thread for the phone page');
  const h = jobDesk(root, { 'm-ask': { id: 'm-ask', owner: 'launcher', status: 'blocked', created_at: new Date(NOW - 60000).toISOString(), human_asks: ['post the thread on x now?'] } }, { choices: true });
  h.d.warm();
  for (let i = 0; i < 3; i += 1) await h.gen.releaseOne();
  assert.equal(h.d.next().kind, 'yes');
  const c = h.d.next();
  assert.equal(c.kind, 'choice');
  h.d.next();
  for (const o of c.choice.options) assert.equal(h.ledger().find(r => r.id === o.id).status, 'passed');
});

test('say something: on any card free text does the plain thing, capped and logged', async () => {
  // on an idea: it is passed with the note, and the writer reworks it; the rework is the next idea
  const h = await filled(workspace());
  const idea = h.d.next();
  const said = await h.d.say({ text: 'make it work for teams without a designer' });
  assert.deepEqual(said, { ok: true, ack: 'got it. reworking that idea with your note.' });
  const row = h.ledger().find(r => r.id === idea.id);
  assert.deepEqual([row.status, row.owner_note], ['passed', 'make it work for teams without a designer']);
  await h.gen.release();
  const call = h.gen.calls.find(c => c.ownerNote);
  assert.deepEqual([call.reworkOf, call.ownerNote], [idea.bet.title, 'make it work for teams without a designer']);
  // the stub names each idea by its call, so the rework's title is known
  assert.equal(h.d.next().bet.title, TITLES[h.gen.calls.indexOf(call) % TITLES.length], 'the rework comes first');
  // on a question: it is the answer
  const qroot = workspace();
  const q = desk(qroot, { questions: false });
  q.d.next();
  assert.deepEqual(await q.d.say({ text: 'paying customers in schools' }), { ok: true, ack: 'got it: paying customers in schools.' });
  assert.equal(gmBet.readFocus(gmBet.focusPath(path.dirname(q.ledgerFile)), qroot).focus.label, 'paying customers in schools');
  // on the calm line: a note for the idea being written, and the card stays
  assert.equal(q.d.next().kind, 'wait');
  assert.deepEqual(await q.d.say({ text: 'something for schools' }), { ok: true, noted: true, ack: 'got it, i\'ll fold that in.' });
  assert.equal(q.d.view().kind, 'wait');
  // one writer at a time: the note goes to the next one, right after the one running now
  await q.gen.releaseOne();
  assert.equal(q.gen.calls[q.gen.calls.length - 1].ownerNote, 'something for schools');
  // limits
  assert.equal((await q.d.say({ text: '  ' })).reason, 'empty');
  assert.equal((await q.d.say({ text: 'x'.repeat(281) })).reason, 'too_long');
  assert.ok(h.logs.some(l => l.choice === 'say' && l.kind === 'bet' && l.chars === 41));
  // nothing on screen
  const none = desk(workspace());
  assert.equal((await none.d.say({ text: 'hi' })).reason, 'gone');
});

test('say something: on a yes or a finished job it steers that member', async () => {
  const root = workspace();
  const file = path.join(root, 'gm-bets.jsonl');
  doingRow(file, root, 'b-ask', 'm-ask', 'Write the launch thread');
  doingRow(file, root, 'b-done', 'm-done', 'Write the getting started page');
  const h = jobDesk(root, {
    'm-ask': { id: 'm-ask', owner: 'launcher', status: 'running', updated_at: new Date(NOW).toISOString(), human_asks: ['post the thread on x now?'] },
    'm-done': { id: 'm-done', owner: 'builder', status: 'complete', receipt_path: 'r', human_asks: [] },
  }, { live: ['launcher'] });
  await h.d.settle();
  assert.equal(h.d.next().kind, 'yes');
  // launcher is really running: it reaches them now, through a steer that cannot start anyone
  assert.deepEqual(await h.d.say({ text: 'wait for tuesday' }), { ok: true, ack: 'sent to launcher.' });
  assert.deepEqual(h.cli[h.cli.length - 1], ['member', 'steer', 'launcher', '--no-ignite', '--json', '--', 'the owner says: wait for tuesday']);
  assert.equal(h.d.next().kind, 'done');
  // builder finished: starting them again takes a second tap
  assert.equal((await h.d.say({ text: 'add a short video too' })).reason, 'needs_confirm');
  assert.deepEqual(await h.d.say({ text: 'add a short video too', confirm: true }), { ok: true, ack: 'builder is starting on it.' });
});

test('say something: the writer is told the owner note and may keep the same deliverable', async () => {
  const { bundle } = await bundleFor(workspace());
  const p = gmBet.buildPrompt(bundle, { today: TODAY, reworkOf: 'Write a getting started page', ownerNote: 'make it shorter' });
  assert.match(p, /The owner read the idea "Write a getting started page" and said: "make it shorter"\. Rework it so it fits what they said; it may keep the same deliverable\./);
  assert.doesNotMatch(p, /different from: Write a getting started page/);
  const fresh = gmBet.buildPrompt(bundle, { today: TODAY, ownerNote: 'something for schools' });
  assert.match(fresh, /The owner said: "something for schools"\. The next idea must fit that\./);
});

// a reader that takes words on a question as the answer and anything else as an instruction
// a reply that stays on the card, without its thread, for comparing
const stayed = o => ({ ok: o.ok, stay: o.stay, kind: o.kind, reply: o.reply });

const READ_PLAIN = async ({ card }) => ({ ok: true, kind: card.kind === 'question' ? 'answer' : 'instruction', reply: '' });

const SUGGEST = async () => ({ ok: true, choices: [{ name: 'installs each week', up: true }, { name: 'people who ran it twice', up: true }] });

test('scoreboard: with none saved, the first card asks what number says it is going well, from the project, plus something else', async () => {
  const root = workspace();
  const h = desk(root, { scoreboard: true, suggest: SUGGEST, warm: true });
  await tick();
  const q = h.d.next();
  assert.deepEqual([q.kind, q.question.ask, q.question.line], ['question', 'what number tells you this is going well?', null]);
  assert.deepEqual(q.question.choices, [{ id: 's1', label: 'installs each week' }, { id: 's2', label: 'people who ran it twice' }, { id: 'other', label: 'something else', other: true }]);
  assert.equal(h.d.answer({ choice: 's2' }).ack, 'got it: people who ran it twice.');
  const file = gmBet.scoreboardPath(path.dirname(h.ledgerFile));
  assert.deepEqual(gmBet.readScoreboard(file, root), { name: 'people who ran it twice', up: true, source: 'reported', at: new Date(NOW).toISOString(), reports: [] });
  // a number nobody can read on its own: the plain weekly card, before any idea
  const r = h.d.next();
  assert.deepEqual([r.kind, r.report], ['report', { what: 'people who ran it twice: what is it this week?', why: 'one number a week shows if this is going well.' }]);
  assert.equal(h.d.report({ value: 'lots' }).reason, 'bad_number');
  assert.equal(h.d.report({ value: '12' }).ack, 'saved: 12.');
  assert.deepEqual(gmBet.readScoreboard(file, root).reports.map(x => x.value), [12]);
  assert.notEqual(h.d.next().kind, 'report', 'once a week');
  const later = desk(root, { scoreboard: true, ledgerFile: h.ledgerFile, start: NOW + 8 * 24 * 60 * 60 * 1000 });
  const back = later.d.next();
  assert.deepEqual([back.kind, back.report.why], ['report', 'last time it was 12, on oct 21.']);
  // installs on a workspace with npm numbers are read on their own: no weekly card
  const npmRoot = workspace();
  const npm = desk(npmRoot, { scoreboard: true, suggest: SUGGEST, warm: true });
  await tick();
  npm.d.next();
  npm.d.answer({ choice: 's1' });
  assert.equal(gmBet.readScoreboard(gmBet.scoreboardPath(path.dirname(npm.ledgerFile)), npmRoot).source, 'installs');
  assert.notEqual(npm.d.next().kind, 'report');
  // something else: its own words, and which way is good read from them
  const ownRoot = workspace();
  const own = desk(ownRoot, { scoreboard: true });
  own.d.next();
  // an empty name asks for a name, not a value
  assert.deepEqual(own.d.answer({ choice: 'other', text: '  ' }), { ok: false, reason: 'empty', message: 'name the number in a few words.' });
  assert.equal(own.d.answer({ choice: 'other', text: 'fewer support emails' }).ack, 'got it: fewer support emails.');
  const ownBoard = gmBet.readScoreboard(gmBet.scoreboardPath(path.dirname(own.ledgerFile)), ownRoot);
  assert.deepEqual([ownBoard.name, ownBoard.up, ownBoard.source], ['fewer support emails', false, 'reported']);
  // before the model suggests, plain ones that fit any project
  const plain = desk(workspace(), { scoreboard: true });
  assert.deepEqual(plain.d.next().question.choices.map(c => c.label), ['installs each week', 'people who used it this week', 'money that came in this month', 'something else']);
});

function writeBoard(dir, root, pick, values) {
  const file = gmBet.scoreboardPath(dir);
  fs.appendFileSync(file, `${JSON.stringify({ workspace: root, kind: 'pick', ...pick, at: '2026-09-01T00:00:00.000Z' })}\n`);
  values.forEach((value, i) => fs.appendFileSync(file, `${JSON.stringify({ workspace: root, kind: 'report', value, at: new Date(Date.UTC(2026, 8, 7 + i * 7)).toISOString() })}\n`));
}

test('scoreboard: the last report is the baseline; with 3 or more, the goal must beat the best of the last 8; the writer is told', async () => {
  const root = workspace();
  const ledgerFile = path.join(root, 'bets.jsonl');
  writeBoard(root, root, { name: 'experiments that worked', up: true, source: 'reported' }, [3, 5]);
  let { bundle } = { bundle: await gmBet.readBundle(root, { deps: fixtureDeps, ledgerFile, today: TODAY }) };
  const prompt = gmBet.buildPrompt(bundle, { today: TODAY });
  assert.match(prompt, /metric is one of: "scoreboard" \(experiments that worked, the owner's own number; baseline 5; with fewer than 3 reports any honest goal above the baseline 5 passes\)/);
  assert.doesNotMatch(prompt, /metric is one of: [^\n]*"installs"/, 'the owner\'s number replaces installs as the target');
  const v = target => gmBet.validateBet(goodBet({ target }), { bundle, today: TODAY });
  assert.equal(v({ metric: 'scoreboard', baseline: 5, goal: 6 }).ok, true, v({ metric: 'scoreboard', baseline: 5, goal: 6 }).reasons.join(' | '));
  assert.match(v({ metric: 'scoreboard', baseline: 5, goal: 5 }).reasons.join(' | '), /target goal 5 must be above the baseline 5/);
  assert.match(v({ metric: 'scoreboard', baseline: 3, goal: 6 }).reasons.join(' | '), /does not match the real number: the last reported value is 5/);
  fs.appendFileSync(gmBet.scoreboardPath(root), `${JSON.stringify({ workspace: root, kind: 'report', value: 4, at: '2026-10-01T00:00:00.000Z' })}\n`);
  bundle = await gmBet.readBundle(root, { deps: fixtureDeps, ledgerFile, today: TODAY });
  assert.match(v({ metric: 'scoreboard', baseline: 4, goal: 5 }).reasons.join(' | '), /target goal 5 does not beat the best of the last 3 reports, 5; the goal must be above 5/);
  assert.equal(v({ metric: 'scoreboard', baseline: 4, goal: 6 }).ok, true);
  // lower is better: the best is the lowest
  const down = workspace();
  writeBoard(down, down, { name: 'support emails', up: false, source: 'reported' }, [10, 8, 9]);
  const db = await gmBet.readBundle(down, { deps: fixtureDeps, ledgerFile: path.join(down, 'bets.jsonl'), today: TODAY });
  const dv = target => gmBet.validateBet(goodBet({ target }), { bundle: db, today: TODAY });
  assert.match(dv({ metric: 'scoreboard', baseline: 9, goal: 8 }).reasons.join(' | '), /does not beat the best of the last 3 reports, 8; the goal must be below 8/);
  assert.equal(dv({ metric: 'scoreboard', baseline: 9, goal: 7 }).ok, true);
  // an installs scoreboard on an npm workspace keeps installs, as before
  const npm = workspace();
  writeBoard(npm, npm, { name: 'installs each week', up: true, source: 'installs' }, []);
  const nb = await gmBet.readBundle(npm, { deps: fixtureDeps, ledgerFile: path.join(npm, 'bets.jsonl'), today: TODAY });
  assert.equal(gmBet.validateBet(goodBet(), { bundle: nb, today: TODAY }).ok, true);
  assert.match(gmBet.buildPrompt(nb, { today: TODAY }), /metric is one of: "installs"/);
});

test('scoreboard: a bet on it is scored from the first report on or after its check date; with none it waits, and the desk asks', async () => {
  const root = workspace();
  const ledgerFile = path.join(root, 'gm-bets.jsonl');
  const report = (value, at) => fs.appendFileSync(gmBet.scoreboardPath(root), `${JSON.stringify({ workspace: root, kind: 'report', value, at })}\n`);
  writeBoard(root, root, { name: 'experiments that worked', up: true, source: 'reported' }, [3, 5, 4]);
  ledgerRow(ledgerFile, root, 'sb', { status: 'doing', bet: { ...goodBet({ title: 'Run the five pending experiments' }), target: { metric: 'scoreboard', baseline: 4, goal: 6, name: 'experiments that worked', up: true }, check_date: '2026-10-20' } });
  // a report this week, but none since the check date: scoring waits, and the desk asks for the number
  report(5, '2026-10-18T09:00:00.000Z');
  assert.deepEqual(await gmBet.scoreBets(root, { ledgerFile, today: '2026-10-22' }), []);
  const h = desk(root, { scoreboard: true, ledgerFile });
  assert.equal(h.d.next().kind, 'report', 'a bet is waiting on the number');
  // the number comes in: it is scored from it
  report(7, '2026-10-20T09:00:00.000Z');
  const scored = await gmBet.scoreBets(root, { ledgerFile, today: '2026-10-22' });
  assert.deepEqual(scored.map(r => [r.status, r.actual, r.window]), [['won', 7, 'reported on or after 2026-10-20']]);
});

test('money: ideas never propose trades or moving money; the code, the writer, and the skeptic all say so', async () => {
  const { bundle } = await bundleFor(workspace());
  const v = over => gmBet.validateBet(goodBet(over), { bundle, today: TODAY }).reasons.join(' | ');
  assert.match(v({ title: 'Buy 200 shares of the index fund before friday' }), /it proposes a trade or moving money; ideas never do that/);
  assert.match(v({ steps: [goodBet().steps[0], { text: 'wire the cash to the new brokerage account', who: 'you', public: false }] }), /it proposes a trade or moving money/);
  assert.doesNotMatch(v({}), /trade/);
  assert.doesNotMatch(v({ title: 'Write a getting started page for buyers of the team plan' }), /trade/);
  assert.match(gmBet.buildPrompt(bundle, { today: TODAY }), /- never propose a trade, buying or selling stocks, shares, crypto, or any security, or moving money between accounts\./);
  const seen = [];
  await gmBet.generateBet({ workspaceRoot: workspace(), today: TODAY, ledgerFile: path.join(os.tmpdir(), `b-${Date.now()}.jsonl`), attemptsFile: path.join(os.tmpdir(), `a-${Date.now()}.jsonl`), deps: { ...fixtureDeps, runModel: async () => ({ ok: true, text: JSON.stringify(goodBet()) }), runSkeptic: async (p) => { seen.push(p); return { ok: true, text: PASS }; } } });
  assert.match(seen[0], /a trade, buying or selling stocks, shares, crypto, or any security, or moving money between accounts: fail it/);
});

test('send back: a stopped job whose process is still alive is never resent', async () => {
  const root = workspace();
  const file = path.join(root, 'gm-bets.jsonl');
  doingRow(file, root, 'b1', 'm1', 'Write the getting started page');
  const h = jobDesk(root, { m1: { id: 'm1', owner: 'builder', status: 'stopped', stop_reason: 'no progress', human_asks: [] } }, { driverAlive: () => true });
  await h.d.settle();
  assert.equal(h.cli.filter(a => a[1] === 'start').length, 0);
  assert.notEqual(h.ledger()[0].mission_result, 'failed');
  // and a row already marked failed is put back, whatever the status
  ledgerRow(file, root, 'b2', { status: 'doing', mission_id: 'm2', owner: 'builder', mission_result: 'failed', mission_halted: true, bet: { ...goodBet({ title: 'Record the demo video' }), check_date: '2026-10-30' } });
  const h2 = jobDesk(root, { m1: { id: 'm1', owner: 'builder', status: 'stopped', human_asks: [] }, m2: { id: 'm2', owner: 'builder', status: 'complete', human_asks: [] } }, { driverAlive: () => true });
  await h2.d.settle();
  assert.equal(h2.cli.filter(a => a[1] === 'start').length, 0);
  assert.equal(h2.ledger().find(r => r.id === 'b2').mission_result, null);
});

test('free text: a question back is answered on the same card and saves nothing', async () => {
  const root = workspace();
  const seen = [];
  const reply = 'it is the one number you would check each week to know this is working, like installs this week for atris.';
  const h = desk(root, { scoreboard: true, readSaid: async (opts) => { seen.push(opts); return { ok: true, kind: 'question', reply }; } });
  h.d.next();
  const out = await h.d.say({ text: 'what do you mean?' });
  assert.deepEqual(stayed(out), { ok: true, stay: true, kind: 'question', reply });
  assert.deepEqual(out.thread, [{ who: 'owner', text: 'what do you mean?' }, { who: 'orb', text: reply }]);
  // the reader saw the card and the words
  assert.deepEqual([seen[0].text, seen[0].card.kind, seen[0].card.title], ['what do you mean?', 'question', 'what number tells you this is going well?']);
  assert.ok(seen[0].card.buttons.includes('something else'));
  // nothing saved, and the same card stays up
  assert.equal(gmBet.readScoreboard(gmBet.scoreboardPath(path.dirname(h.ledgerFile)), root), null);
  assert.deepEqual(gmBet.readFocus(gmBet.focusPath(path.dirname(h.ledgerFile)), root), {});
  assert.deepEqual([h.d.view().status, h.d.view().question.ask], ['ready', 'what number tells you this is going well?']);
});

test('free text: each card is a short conversation; "why?" after "what do you mean?" is read with the first exchange', async () => {
  const root = workspace();
  const seen = [];
  const first = 'it is the one number you would check each week, like installs this week for atris.';
  const reader = async (opts) => {
    seen.push(opts);
    if (!opts.thread.length) return { ok: true, kind: 'question', reply: first, suggestions: ['installs this week', 'paying customers', 'which bet is it'] };
    return { ok: true, kind: 'question', reply: `because ${opts.thread[1].text.split(',')[0].replace(/^it is /, '')} tells you if the week worked.` };
  };
  const h = desk(root, { scoreboard: true, readSaid: reader });
  h.d.next();
  const one = await h.d.say({ text: 'what do you mean?' });
  // up to 3 suggested replies, plain words only
  assert.deepEqual(one.suggestions, ['installs this week', 'paying customers']);
  const two = await h.d.say({ text: 'why?' });
  assert.deepEqual(seen[1].thread, [{ who: 'owner', text: 'what do you mean?' }, { who: 'orb', text: first }]);
  assert.equal(two.reply, 'because the one number you would check each week tells you if the week worked.');
  assert.deepEqual(two.thread.map(t => t.who), ['owner', 'orb', 'owner', 'orb']);
  // the thread keeps the last 6 turns
  for (let i = 0; i < 4; i += 1) await h.d.say({ text: `and then ${i}?` });
  assert.equal(h.d.view().thread.length, 6);
  // something real ends it: an answer saved clears the thread
  const kinds = ['question', 'answer'];
  const sRoot = workspace();
  const saved = desk(sRoot, { scoreboard: true, readSaid: async () => ({ ok: true, kind: kinds.shift(), reply: 'it is the number you watch each week.' }) });
  saved.d.next();
  await saved.d.say({ text: 'what do you mean?' });
  assert.equal(saved.d.view().thread.length, 2);
  await saved.d.say({ text: 'paying schools' });
  assert.deepEqual(saved.d.view().thread, []);
  // a new card starts a new thread
  h.d.next();
  assert.deepEqual(h.d.view().thread, []);
});

test('free text: talking with one member is a thread too; a question back is answered, an instruction steers', async () => {
  const root = workspace();
  const NAGO = m => new Date(NOW - m * 60000).toISOString();
  const seen = [];
  const h = jobDesk(root, { m1: { id: 'm1', owner: 'builder', status: 'running', objective: 'Write the try page.', created_at: NAGO(30), last_tick_at: NAGO(1), human_asks: [] } }, {
    driverAlive: () => true,
    live: ['builder'],
    readSaid: async (opts) => { seen.push(opts); return opts.text.endsWith('?') ? { ok: true, kind: 'question', reply: 'builder is writing the try page and is about halfway.' } : { ok: true, kind: 'instruction', reply: '' }; },
  });
  const q = await h.d.talk({ member: 'builder', text: 'how is it going?' });
  assert.deepEqual([q.stay, q.reply], [true, 'builder is writing the try page and is about halfway.']);
  assert.deepEqual([seen[0].card.kind, seen[0].card.title], ['member', 'builder']);
  assert.equal(h.cli.length, 0, 'a question steers nothing');
  const go = await h.d.talk({ member: 'builder', text: 'do the readme first' });
  assert.deepEqual(go, { ok: true, ack: 'sent to builder.' });
  assert.deepEqual(seen[1].thread.map(t => t.who), ['owner', 'orb']);
});

test('free text: words that end in a question mark are never saved as an answer', async () => {
  // the live case: the reader called "why?" an answer, and it was saved as the scoreboard
  const root = workspace();
  const seen = [];
  const h = desk(root, { scoreboard: true, readSaid: async (opts) => { seen.push(opts); return opts.hint ? { ok: true, kind: 'question', reply: 'because one weekly number shows if the work is paying off.' } : { ok: true, kind: 'answer', reply: '' }; } });
  h.d.next();
  const out = await h.d.say({ text: 'why?' });
  assert.deepEqual(stayed(out), { ok: true, stay: true, kind: 'question', reply: 'because one weekly number shows if the work is paying off.' });
  assert.equal(seen[1].hint, 'his message ends with a question mark: it is a question back, not an answer');
  assert.equal(gmBet.readScoreboard(gmBet.scoreboardPath(path.dirname(h.ledgerFile)), root), null);
  // if the second read still calls it an answer, the plain line shows and nothing is saved
  const stubborn = desk(workspace(), { scoreboard: true, readSaid: async () => ({ ok: true, kind: 'answer', reply: '' }) });
  stubborn.d.next();
  assert.deepEqual(stayed(await stubborn.d.say({ text: 'and then?' })), { ok: true, stay: true, kind: 'unclear', reply: 'say that another way, or tap a button.' });
  // the reader is told so too
  const calls = [];
  await gmBet.readSaid({ text: 'why?', card: { kind: 'question', title: 'q', buttons: [] }, workspaceRoot: root, hint: 'h', deps: { readerModel: () => 'haiku', runModel: async (p) => { calls.push(p); return { ok: false, reason: 'stub' }; } } });
  assert.match(calls[0], /- a message that ends with "\?" or asks why, what, or how is a question back, never an answer\./);
  assert.match(calls[0], /note: h/);
});

test('free text: a plain answer saves, on the scoreboard card as the scoreboard', async () => {
  const root = workspace();
  const h = desk(root, { scoreboard: true, readSaid: async () => ({ ok: true, kind: 'answer', reply: '' }) });
  h.d.next();
  assert.deepEqual(await h.d.say({ text: 'paying schools each month' }), { ok: true, ack: 'got it: paying schools each month.' });
  assert.equal(gmBet.readScoreboard(gmBet.scoreboardPath(path.dirname(h.ledgerFile)), root).name, 'paying schools each month');
  assert.deepEqual(gmBet.readFocus(gmBet.focusPath(path.dirname(h.ledgerFile)), root), {}, 'not mixed into the answers');
});

test('free text: an instruction routes to the writer with the reply saying what will happen', async () => {
  const root = workspace();
  const h = desk(root, { questions: false, readSaid: async () => ({ ok: true, kind: 'instruction', reply: 'the next idea will be about the try page.' }) });
  h.d.next();
  assert.deepEqual(await h.d.say({ text: 'work on the try page instead' }), { ok: true, ack: 'the next idea will be about the try page.' });
  assert.deepEqual(gmBet.readFocus(gmBet.focusPath(path.dirname(h.ledgerFile)), root), {}, 'an instruction is not an answer');
  await h.gen.releaseOne();
  assert.equal(h.gen.calls[h.gen.calls.length - 1].ownerNote, 'work on the try page instead');
});

test('free text: unclear asks back; a failed, slow, or off-words read falls back and saves nothing', async () => {
  const unclear = desk(workspace(), { questions: false, readSaid: async () => ({ ok: true, kind: 'unclear', reply: 'do you mean the number, or the project?' }) });
  unclear.d.next();
  assert.deepEqual(stayed(await unclear.d.say({ text: 'hmm' })), { ok: true, stay: true, kind: 'unclear', reply: 'do you mean the number, or the project?' });
  const FALL = { ok: true, stay: true, kind: 'unclear', reply: 'say that another way, or tap a button.' };
  const slow = desk(workspace(), { questions: false, sayTimeoutMs: 30, readSaid: () => new Promise(() => {}) });
  slow.d.next();
  assert.deepEqual(stayed(await slow.d.say({ text: 'what do you mean?' })), FALL);
  const broken = desk(workspace(), { questions: false, readSaid: async () => ({ ok: false, reason: 'the model exited with code 1' }) });
  broken.d.next();
  assert.deepEqual(stayed(await broken.d.say({ text: 'what do you mean?' })), FALL);
  const worded = desk(workspace(), { questions: false, readSaid: async () => ({ ok: true, kind: 'question', reply: 'it picks the next bet.' }) });
  worded.d.next();
  assert.deepEqual(stayed(await worded.d.say({ text: 'why?' })), FALL);
  for (const d of [slow, broken, worded]) assert.deepEqual(gmBet.readFocus(gmBet.focusPath(path.dirname(d.ledgerFile)), 'x'), {});
});

test('free text: the real reader is one quick subscription call on the roster model, strict json, 15 seconds', async () => {
  const root = workspace();
  const calls = [];
  const out = await gmBet.readSaid({
    text: 'what do you mean?',
    card: { kind: 'question', title: 'what number tells you this is going well?', detail: null, buttons: ['installs this week', 'something else'] },
    workspaceRoot: root,
    deps: { readerModel: () => 'claude-haiku-5-5', runModel: async (prompt, opts) => { calls.push({ prompt, opts }); return { ok: true, text: '{"kind": "question", "reply": "it is the number you watch each week."}' }; } },
  });
  assert.deepEqual(out, { ok: true, kind: 'question', reply: 'it is the number you watch each week.' });
  assert.equal(calls[0].opts.timeoutMs, 15000);
  assert.deepEqual(calls[0].opts.command.args('P').slice(0, 4), ['-p', 'P', '--model', 'claude-haiku-5-5']);
  assert.match(calls[0].prompt, /\{"kind": "question" \| "answer" \| "instruction" \| "unclear", "reply": "\.\.\."\}/);
  assert.match(calls[0].prompt, /what number tells you this is going well\?/);
  assert.match(calls[0].prompt, /his message: "what do you mean\?"/);
  // the wrong shape is a failed read
  const bad = await gmBet.readSaid({ text: 'x', card: { kind: 'bet', title: 't', buttons: [] }, workspaceRoot: root, deps: { readerModel: () => 'haiku', runModel: async () => ({ ok: true, text: '{"kind": "maybe"}' }) } });
  assert.equal(bad.ok, false);
});

test('steer from the phone: it can only reach a live run; one that is not running takes a second tap, or keeps it as a note', async () => {
  const root = workspace();
  const h = jobDesk(root, {}, { live: ['builder'] });
  assert.deepEqual(await h.d.steer({ member: 'builder', text: 'readme first' }), { ok: true, ack: 'sent to builder.' });
  assert.deepEqual(h.cli[h.cli.length - 1], ['member', 'steer', 'builder', '--no-ignite', '--json', '--', 'the owner says: readme first']);
  // launcher is not running: the steer that cannot start anyone finds nothing, and the page asks
  assert.deepEqual(await h.d.steer({ member: 'launcher', text: 'draft the thread' }), { ok: false, reason: 'needs_confirm', message: 'tap again to start launcher on this.' });
  assert.ok(h.cli.every(a => !a.includes('--detach')), 'nothing was started');
  // the second tap starts them in the background, and says so from the start result
  assert.deepEqual(await h.d.steer({ member: 'launcher', text: 'draft the thread', confirm: true }), { ok: true, ack: 'launcher is starting on it.' });
  assert.deepEqual(h.cli[h.cli.length - 1], ['member', 'steer', 'launcher', '--detach', '--json', '--', 'the owner says: draft the thread']);
  // a start that did not happen says so
  const failed = jobDesk(workspace(), {}, { detach: { code: 1, stdout: JSON.stringify({ ok: false, action: 'member_run_not_started' }) } });
  assert.deepEqual(await failed.d.steer({ member: 'launcher', text: 'go', confirm: true }), { ok: false, reason: 'not_started', message: 'launcher did not start. try again in a minute.' });
  // a start refused before it began says why, in plain words
  const refused = jobDesk(workspace(), {}, { detach: { code: 1, stdout: JSON.stringify({ ok: false, action: 'member_run_not_started', reason: 'launcher is a person, not an AI teammate; Atris can prepare work for them but cannot act as them' }) } });
  assert.deepEqual(await refused.d.steer({ member: 'launcher', text: 'go', confirm: true }), { ok: false, reason: 'not_started', message: 'launcher did not start: launcher is a person, not an AI teammate; Atris can prepare work for them but cannot act as them.' });
  // or it is kept as a note for their next run
  const noted = await h.d.steer({ member: 'researcher', text: 'look at pricing pages first', note: true });
  assert.deepEqual(noted, { ok: true, ack: "saved for researcher's next run." });
  const rows = fs.readFileSync(path.join(root, '.atris', 'state', 'steering.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual([rows[0].schema, rows[0].status, rows[0].scope.member, rows[0].raw, rows[0].memory], ['atris.steering.v1', 'active', 'researcher', 'look at pricing pages first', ['look at pricing pages first']]);
  // the say box on a done card goes the same way
  const file = path.join(root, 'gm-bets.jsonl');
  doingRow(file, root, 'b-done', 'm-done', 'Write the getting started page');
  const d2 = jobDesk(root, { 'm-done': { id: 'm-done', owner: 'builder', status: 'complete', receipt_path: 'r', human_asks: [] } });
  await d2.d.settle();
  assert.equal(d2.d.next().kind, 'done');
  assert.equal((await d2.d.say({ text: 'add a short video' })).reason, 'needs_confirm');
  assert.equal((await d2.d.say({ text: 'add a short video', confirm: true })).ack, 'builder is starting on it.');
});

test('steer from the phone: owner words are never options, even when they start with a dash', async () => {
  const h = jobDesk(workspace(), {}, { live: ['builder'] });
  await h.d.steer({ member: 'builder', text: '--verify=printf example' });
  assert.deepEqual(h.cli[h.cli.length - 1], ['member', 'steer', 'builder', '--no-ignite', '--json', '--', 'the owner says: --verify=printf example']);
  await h.d.steer({ member: 'launcher', text: '-rf everything', confirm: true });
  assert.deepEqual(h.cli[h.cli.length - 1], ['member', 'steer', 'launcher', '--detach', '--json', '--', 'the owner says: -rf everything']);
});

test('free text: a reply that comes back after the card changed is dropped, and the card is left alone', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = await filled(workspace(), { readSaid: async () => { await gate; return { ok: true, kind: 'instruction', reply: '' }; } });
  const idea = h.d.next();
  const pending = h.d.say({ text: 'make it smaller' });
  // the owner taps do it while the read is still out
  assert.equal((await h.d.doIt()).ok, true);
  release();
  // the refusal comes back with the card on screen now, so it says where the new card is
  assert.deepEqual(await pending, { ok: false, reason: 'gone', message: 'that card changed, so nothing was done. here is the one on screen now.' });
  const row = h.ledger().find(r => r.id === idea.id);
  assert.equal(row.status, 'doing', 'the started job is still tracked');
});

test('send back: a job whose process is still alive is never resent, even when its times look old', async () => {
  const root = workspace();
  const file = path.join(root, 'gm-bets.jsonl');
  doingRow(file, root, 'b1', 'm1', 'Write the getting started page');
  const NAGO = m => new Date(NOW - m * 60000).toISOString();
  // after the laptop slept, the mission looks still for 5 hours, but its driver is alive
  const missions = { m1: { id: 'm1', owner: 'builder', status: 'running', created_at: NAGO(400), last_tick_at: NAGO(300), human_asks: [] } };
  const h = jobDesk(root, missions, { driverAlive: m => m.id === 'm1' });
  await h.d.settle();
  assert.equal(h.cli.filter(a => a[1] === 'start').length, 0);
  assert.deepEqual(h.d.view().working.map(w => w.title), ['Write the getting started page']);
  assert.equal(h.ledger()[0].mission_result, undefined);
  // a row already marked failed, whose process turns out alive, is put back to working, not resent
  ledgerRow(file, root, 'b2', { status: 'doing', mission_id: 'm2', owner: 'builder', mission_result: 'failed', mission_stalled: true, mission_stop_reason: 'stopped moving 5 hours ago, nothing finished', bet: { ...goodBet({ title: 'Record the demo video' }), check_date: '2026-10-30' } });
  missions.m2 = { id: 'm2', owner: 'builder', status: 'running', created_at: NAGO(400), last_tick_at: NAGO(300), human_asks: [] };
  const h2 = jobDesk(root, missions, { driverAlive: () => true });
  await h2.d.settle();
  assert.equal(h2.cli.filter(a => a[1] === 'start').length, 0);
  assert.equal(h2.ledger().find(r => r.id === 'b2').mission_result, null);
});

test('do it: starts a real mission with every step and the your-yes rule, then runs it', async () => {
  const h = await filled(workspace());
  h.d.next();
  const out = await h.d.doIt();
  assert.equal(out.ok, true);
  assert.equal(h.cli.length, 2);
  const start = h.cli[0];
  assert.deepEqual(start.slice(0, 2), ['mission', 'start']);
  const objective = start[2];
  assert.match(objective, /^Write a getting started page for atris gm phone/);
  // each step names its member; the owner hands the next member's step off by name
  assert.match(objective, /1\. \[builder\] draft the getting started page \(docs\/gm-phone\.md, about 300 words\) 2\. \[launcher\] record a 30 second screen capture/);
  assert.match(objective, /3\. \[your yes\] publish the page and post the recording on x/);
  const betId = h.ledger().find(r => r.mission_id).id;
  assert.ok(objective.includes(`handoffs: you are builder; do your steps, then pass each step that belongs to another member with atris member handoff builder launcher "[${betId}] record a 30 second screen capture of the phone page".`));
  assert.ok(objective.includes('done means this check passes: test -s docs/gm-phone.md'));
  assert.ok(objective.includes(gmBet.YES_RULE));
  const flag = name => start[start.indexOf(name) + 1];
  // the first team step's member starts it; the lane still comes from what the bet asks for
  assert.equal(flag('--owner'), 'builder');
  assert.equal(flag('--lane'), 'launch');
  assert.equal(flag('--runner'), 'claude');
  // the bet's own check, not the formatting check
  assert.equal(flag('--verify'), 'test -s docs/gm-phone.md');
  assert.ok(start.includes('--json'));
  // the idea says about 4 hours: it gets 5 (a quarter more), at 12 rounds an hour, on start and on run
  assert.equal(start.includes('--budget'), false, 'never the one-hour tier');
  assert.deepEqual([flag('--max-wall'), flag('--max-ticks')], ['18000', '60']);
  // the hours are a ceiling: a job that finishes early stops
  assert.ok(start.includes('--stop-when-done'));
  assert.deepEqual(h.cli[1], ['mission', 'run', 'mission-2026-10-21-write-a-getting-abc', '--max-wall', '18000', '--max-ticks', '60', '--stop-when-done', '--detach', '--json']);
  assert.equal(h.d.view().mission.line, 'launcher has it and is starting now.');
  const last = h.ledger().find(r => r.mission_id);
  assert.equal(last.status, 'doing');
  assert.deepEqual(h.logs.filter(l => l.choice === 'do').map(l => l.command.split(' ').slice(0, 3).join(' ')), ['atris mission start', 'atris mission run']);
  // the your-yes step becomes a decision card that pings the mission, and it
  // stays after the next tap shows another bet
  h.d.next();
  const cards = h.d.yesCards();
  assert.equal(cards.length, 1);
  assert.equal(cards[0].id, 'yes-0-2');
  assert.equal(cards[0].text, 'your yes: publish the page and post the recording on x');
  assert.deepEqual(cards[0].choices[0].steps[0].slice(0, 3), ['mission', 'ping', 'mission-2026-10-21-write-a-getting-abc']);
  assert.ok(cards[0].choices[0].steps[0].includes('gm-phone'));
});

test('job time: the hours the idea says, plus a quarter, from 1 to 24 hours; 3 hours when it says none', () => {
  const t = cost => gmBet.jobTime({ cost });
  assert.deepEqual(t('about 6 hours of agent time, $0'), { seconds: 27000, ticks: 90 });
  assert.deepEqual(t('2-3 hours of agent time'), { seconds: 13500, ticks: 45 });
  assert.deepEqual(t('about 90 minutes of agent time, $0'), { seconds: 6750, ticks: 23 });
  assert.deepEqual(t('about 20 minutes, $0'), { seconds: 3600, ticks: 12 }, 'never under an hour');
  assert.deepEqual(t('about 40 hours of agent time'), { seconds: 86400, ticks: 288 }, 'never over a day');
  assert.deepEqual(t('$0, a short job'), { seconds: 10800, ticks: 36 }, 'no hours: the deep tier');
  assert.deepEqual(gmBet.jobTime({}), { seconds: 10800, ticks: 36 });
  // whole numbers, decimals, and commas are read whole
  assert.deepEqual(t('about .5 hours of agent time'), { seconds: 3600, ticks: 12 }, 'half an hour, not five');
  assert.deepEqual(t('about 2.5 hours'), { seconds: 11250, ticks: 38 });
  assert.deepEqual(t('1,000 hours of agent time'), { seconds: 86400, ticks: 288 }, 'a thousand hours caps at a day');
  assert.deepEqual(t('about 1.5-2.5 hours'), { seconds: 11250, ticks: 38 });
});

test('do it: a mission that will not start leaves the bet ready, says so plainly, and logs why', async () => {
  const cli = [];
  const h = await filled(workspace(), { runCli: async (args) => { cli.push(args); return { code: 2, stdout: '', stderr: 'mission start refused: no verifier' }; } });
  h.d.next();
  const out = await h.d.doIt();
  assert.equal(out.ok, false);
  assert.equal(out.message, 'it did not get going. try again in a minute.');
  assert.ok(h.logs.some(l => l.choice === 'do' && l.error === 'mission start refused: no verifier'));
  assert.equal(h.d.view().status, 'ready');
  assert.equal(cli.length, 1);
});

test('pickOwner: the first team step\'s member starts the job; the lane comes from what the bet asks for', () => {
  const root = workspace();
  const code = goodBet({ title: 'Add an atris gm phone demo flag that seeds sample cards', steps: [{ text: 'build the flag and a test', who: 'team', member: 'builder', public: false }, { text: 'release it', who: 'you', public: true }] });
  assert.deepEqual(gmBet.pickOwner(code, root), { owner: 'builder', lane: 'code' });
  const post = goodBet({ title: 'Write a launch thread about the phone page for x', steps: [{ text: 'find three phone page facts worth a thread', who: 'team', member: 'researcher', public: false }, { text: 'draft the thread', who: 'team', member: 'launcher', public: false }] });
  assert.deepEqual(gmBet.pickOwner(post, root), { owner: 'researcher', lane: 'launch' });
  // a member that is not on this team is not trusted; the old pick stands
  const ghost = goodBet({ title: 'Call three customers about renewal pricing tiers', steps: [{ text: 'list three customers from the ledger', who: 'team', member: 'sales-bot', public: false }] });
  assert.deepEqual(gmBet.pickOwner(ghost, root), { owner: 'mission-lead', lane: 'workspace' });
  const legacy = goodBet({ title: 'Write a launch thread about the phone page for x', steps: [{ text: 'draft the thread', who: 'team', public: false }] });
  assert.deepEqual(gmBet.pickOwner(legacy, root), { owner: 'launcher', lane: 'launch' }, 'a bet from before members keeps the keyword pick');
});

// ---- the real team, step members, a real check ---------------------------------------------

test('team: the writer sees every member with a one-line role, and each team step must name a real member', async () => {
  const { bundle, events } = await bundleFor(workspace());
  assert.equal(events.find(e => e.key === 'team').line, 'team: 3 members in atris/team');
  const prompt = gmBet.buildPrompt(bundle, { today: TODAY });
  assert.ok(prompt.includes('## the team (a team step names one of these as its member)\n- builder: Builder. Writes and tests the code\n- launcher: Launcher. Writes posts, pages, and launch copy\n- researcher: Deep Researcher. Finds ground truth on any topic'));
  assert.match(prompt, /member: every team step names the one member of the team below who does it/);
  assert.match(prompt, /"who": "team", "member": "builder"/);
  const check = steps => gmBet.validateBet(goodBet({ steps }), { bundle, today: TODAY }).reasons.join(' | ');
  const you = goodBet().steps[2];
  assert.equal(check([{ text: 'draft the page', who: 'team', member: 'sales-bot', public: false }, you]), 'step 1 member "sales-bot" is not on the team; use a name from the team list');
  assert.equal(check([{ text: 'draft the page', who: 'team', public: false }, you]), 'step 1 has no member; name the team member who does it');
  assert.equal(check([{ text: 'find three facts for the page', who: 'team', member: 'researcher', public: false }, you]), '', 'a you step needs no member');
  // with no team folder, steps name no member and nothing is turned down for it
  const bare = await bundleFor(workspace(), { ...fixtureDeps, readTeam: () => null });
  assert.equal(gmBet.validateBet(goodBet({ steps: [{ text: 'draft the page', who: 'team', public: false }, you] }), { bundle: bare.bundle, today: TODAY }).ok, true);
  // a kept bet carries each member
  const root = workspace();
  const out = await gmBet.generateBet({ workspaceRoot: root, today: TODAY, ledgerFile: path.join(root, 'bets.jsonl'), deps: { ...fixtureDeps, runModel: async () => ({ ok: true, text: JSON.stringify(goodBet()) }) } });
  assert.deepEqual(out.bet.steps.map(st => st.member || null), ['builder', 'launcher', null]);
  assert.equal(out.bet.verify, 'test -s docs/gm-phone.md');
});

test('verify: a check that is always true, or only checks formatting, is turned down; a real one passes', async () => {
  const { bundle } = await bundleFor(workspace());
  const check = verify => gmBet.validateBet(goodBet({ verify }), { bundle, today: TODAY }).reasons.join(' | ');
  assert.match(check(undefined), /^verify is missing; give one command that proves the deliverable/);
  assert.match(check(''), /^verify is missing/);
  for (const trivial of ['true', ':', 'exit 0', 'echo done', 'printf ok', 'git diff --check', 'git diff --check && true', 'test 1 -eq 1', '[ 2 -gt 1 ]']) {
    assert.match(check(trivial), /is always true or only checks formatting; it must prove the deliverable/, trivial);
  }
  assert.match(check('node --test test/gm-phone.test.js || true'), /can never fail \(it ends in \|\| true\)/);
  for (const real of ['node --test test/gm-phone.test.js', 'test -s docs/gm-phone.md', 'test "$(wc -l < atris/learnings.jsonl)" -ge 20', 'git diff --check && node --test test/gm-bet.test.js']) {
    assert.equal(check(real), '', real);
  }
  // the writer is told what a real check looks like
  assert.match(gmBet.buildPrompt(bundle, { today: TODAY }), /verify: one shell command, run from the repo root, that exits 0 only when the deliverable exists and works/);
});

test('copy: expect is one plain sentence that follows why_now, with the numbers inside it', async () => {
  const { bundle } = await bundleFor(workspace());
  const check = expect => gmBet.validateBet(goodBet({ expect }), { bundle, today: TODAY });
  assert.equal(check('if it works, weekly installs pass 1,700 by oct 30, past our best week of 1,550.').ok, true);
  const two = check('installs go up. we think by 300 a week.');
  assert.deepEqual([two.reasons, two.formatOnly], [['expect is more than one sentence'], true]);
  assert.match(check(`if it works, installs pass 1,700 ${'and more words here '.repeat(8)}.`).reasons.join(' | '), /expect is \d+ characters, over 160/);
  const prompt = gmBet.buildPrompt(bundle, { today: TODAY });
  assert.match(prompt, /expect: one plain sentence, under 160 characters, that follows why_now and says what we expect if it works, with the numbers inside it/);
  assert.match(prompt, /the card shows why_now and expect together as one short paragraph, so they must read as one/);
});

// ---- flow state: jobs in flight, done and yes cards in the same deck ----------------------

const MS = Date.parse('2026-10-21T10:00:00Z');
const RECEIPT = { result: { passed: true, landing: { changed: 'added the getting started page and a 30 second clip.', proof: 'Receipt saved at atris/runs/r1.json.' } } };

test('jobs: mission status maps to working, yes, done, or gone, with proof only as the receipt says it', () => {
  const row = { id: 'bet-1', owner: 'builder', bet: { title: 'Write the getting started page' } };
  const at = (over = {}) => ({ id: 'm1', owner: 'builder', status: 'planning', created_at: new Date(MS - (2 * 60 + 5) * 60000).toISOString(), updated_at: new Date(MS - 10 * 60000).toISOString(), human_asks: [], ...over });
  assert.deepEqual(gmBet.jobState(row, at(), null, MS), { bet_id: 'bet-1', mission_id: 'm1', title: 'Write the getting started page', owner: 'builder', since: MS - 125 * 60000, running_for: '2h 5m', status: 'planning', kind: 'working' });
  assert.equal(gmBet.jobState(row, at({ status: 'running' }), null, MS).kind, 'working');
  // an open ask is a yes; an answered one is not
  const asked = gmBet.jobState(row, at({ human_asks: [{ text: 'post the clip on x?', answered_at: '2026-10-20T00:00:00Z' }, 'publish the page now?'] }), null, MS);
  assert.equal(asked.kind, 'yes');
  assert.deepEqual(asked.asks, [{ index: 1, text: 'publish the page now?', answered: false }]);
  // finished with a passing receipt: what changed, the receipt as proof, passed
  const done = gmBet.jobState(row, at({ status: 'complete', receipt_path: 'atris/runs/r1.json' }), RECEIPT, MS);
  assert.deepEqual([done.kind, done.checked, done.failed, done.changed, done.proof], ['done', 'passed', false, 'added the getting started page and a 30 second clip.', 'atris/runs/r1.json']);
  // finished with no receipt: it says so, it does not invent proof
  const bare = gmBet.jobState(row, at({ status: 'complete' }), null, MS);
  assert.deepEqual([bare.checked, bare.proof, bare.changed, bare.failed], ['none', null, null, false]);
  // a failed check, or a halt nothing proved, can be sent back
  assert.equal(gmBet.jobState(row, at({ status: 'complete', receipt_path: 'r' }), { result: { passed: false } }, MS).failed, true);
  const halted = gmBet.jobState(row, at({ status: 'stopped', stop_reason: 'no progress across consecutive ticks' }), null, MS);
  assert.deepEqual([halted.kind, halted.halted, halted.failed, halted.stop_reason], ['done', true, true, 'no progress across consecutive ticks']);
  assert.equal(gmBet.jobState(row, null, null, MS).kind, 'gone');
  assert.equal(gmBet.jobState(row, at({ status: 'archived' }), null, MS).kind, 'gone');
});

test('jobs: an open mission that has not moved in over 2 hours is not working; it goes back to its member once, then closes quietly', async () => {
  const row = { id: 'bet-1', owner: 'builder', bet: { title: 'Write a match sheet' } };
  const ago = m => new Date(MS - m * 60000).toISOString();
  // the live case: running, created 15h ago, last tick 13h 47m ago and it errored
  const live = { id: 'm1', owner: 'builder', status: 'running', created_at: ago(15 * 60), updated_at: ago(13 * 60 + 47), last_tick_at: ago(13 * 60 + 47), last_tick_status: 'errored', human_asks: [] };
  const stale = gmBet.jobState(row, live, null, MS);
  assert.deepEqual([stale.kind, stale.halted, stale.stalled, stale.failed, stale.checked, stale.stop_reason], ['done', true, true, true, 'none', 'stopped moving 14 hours ago, nothing finished']);
  assert.equal(gmBet.STALL_MS, 2 * 60 * 60 * 1000);
  // the newest of last tick and updated time counts
  assert.equal(gmBet.jobState(row, { ...live, last_tick_at: ago(30) }, null, MS).kind, 'working');
  assert.equal(gmBet.jobState(row, { ...live, last_tick_at: null, updated_at: ago(119) }, null, MS).kind, 'working');
  assert.equal(gmBet.jobState(row, { ...live, last_tick_at: null, updated_at: null, created_at: ago(3 * 24 * 60) }, null, MS).stop_reason, 'stopped moving 3 days ago, nothing finished');
  // an open ask waits on the owner, so it is still a yes
  assert.equal(gmBet.jobState(row, { ...live, human_asks: ['post it?'] }, null, MS).kind, 'yes');

  // on the desk: never working, never a card; it goes back to its member once on its own
  const root = workspace();
  const file = path.join(root, 'gm-bets.jsonl');
  doingRow(file, root, 'b-stale', 'm-stale', 'Write a match sheet pairing this week');
  doingRow(file, root, 'b-work', 'm-work', 'Record the demo video of the front office');
  // the live #261: a bet made before targets existed is plumbing, closed quietly, never sent back
  ledgerRow(file, root, 'b-old', { status: 'doing', mission_id: 'm-old', owner: 'builder', bet: { title: 'Write a match sheet pairing 160 merges with 19 target jobs, then fix the count', why_now: 'x', expect: 'y', steps: [] } });
  const NAGO = m => new Date(NOW - m * 60000).toISOString();
  const missions = {
    'm-stale': { id: 'm-stale', owner: 'builder', status: 'running', created_at: NAGO(15 * 60), updated_at: NAGO(13 * 60 + 47), last_tick_at: NAGO(13 * 60 + 47), human_asks: [] },
    'm-work': { id: 'm-work', owner: 'launcher', status: 'running', created_at: NAGO(40), last_tick_at: NAGO(5), human_asks: [] },
    'm-old': { id: 'm-old', owner: 'builder', status: 'running', created_at: NAGO(15 * 60), last_tick_at: NAGO(13 * 60), human_asks: [] },
  };
  const h = jobDesk(root, missions);
  await h.d.settle();
  assert.deepEqual(h.d.view().working, [{ title: 'Record the demo video of the front office', owner: 'launcher' }]);
  const starts = h.cli.filter(a => a[1] === 'start');
  assert.equal(starts.length, 1, 'only the real bet goes back');
  assert.match(starts[0][2], /try again/);
  const sent = h.ledger().find(r => r.id === 'b-stale');
  assert.deepEqual([sent.status, sent.mission_id, sent.mission_result, sent.auto_sent_back], ['doing', 'm-new', null, 1]);
  const old = h.ledger().find(r => r.id === 'b-old');
  assert.equal(old.mission_result, 'closed');
  assert.equal(old.closed_reason, 'it has no target number we can read');
  // the next tap is never a stopped job
  assert.notEqual(h.d.next().kind, 'done');
  // it stalls again: closed quietly with why, nothing new starts
  missions['m-new'] = { id: 'm-new', owner: 'builder', status: 'running', created_at: NAGO(5 * 60), last_tick_at: NAGO(3 * 60), human_asks: [] };
  h.d.pollJobs();
  await h.d.settle();
  assert.equal(h.cli.filter(a => a[1] === 'start').length, 1);
  const closed = h.ledger().find(r => r.id === 'b-stale');
  assert.deepEqual([closed.mission_result, closed.closed_reason], ['closed', 'stopped moving 3 hours ago, nothing finished, after one try again']);
  assert.deepEqual(h.d.view().working.map(w => w.title), ['Record the demo video of the front office']);
  assert.ok(h.logs.find(l => l.choice === 'close' && l.bet_id === 'b-stale'));
});

test('jobs: a job that runs out of time keeps going in up to two fresh rounds while it makes progress, then closes quietly', async () => {
  const root = workspace();
  const file = path.join(root, 'gm-bets.jsonl');
  doingRow(file, root, 'b-long', 'm-long', 'Write the getting started page');
  const NAGO = m => new Date(NOW - m * 60000).toISOString();
  // round one hit its wall mid tick 3 hours ago, with a receipt to show for it
  const missions = { 'm-long': { id: 'm-long', owner: 'builder', status: 'running', created_at: NAGO(5 * 60), last_tick_at: NAGO(3 * 60), last_tick_reason: 'wall-exceeded-during-tick', receipt_path: 'r1', human_asks: [] } };
  const h = jobDesk(root, missions);
  await h.d.settle();
  const starts = () => h.cli.filter(a => a[1] === 'start');
  assert.equal(starts().length, 1);
  assert.match(starts()[0][2], /the last run ran out of time before its check passed; pick up where it left off\. try again\./);
  assert.deepEqual([h.ledger()[0].auto_sent_back, h.ledger()[0].mission_id], [1, 'm-new']);
  // round two used every round it had, made progress, and paused: it goes on at once, no two-hour wait
  missions['m-new'] = { id: 'm-new', owner: 'builder', status: 'paused', pause_reason: 'max-ticks-reached', created_at: NAGO(60), updated_at: NAGO(1), receipt_path: 'r2', human_asks: [] };
  h.d.pollJobs();
  await h.d.settle();
  assert.equal(starts().length, 2);
  assert.equal(h.ledger()[0].auto_sent_back, 2);
  // a third time: closed quietly, with why
  h.d.pollJobs();
  await h.d.settle();
  assert.equal(starts().length, 2);
  assert.deepEqual([h.ledger()[0].mission_result, h.ledger()[0].closed_reason], ['closed', 'ran out of time before its check passed; pick up where it left off, after two more rounds']);
  assert.deepEqual(h.d.view().working, []);
});

test('working: the footer says plainly how long each job has left', () => {
  const root = workspace();
  const file = path.join(root, 'gm-bets.jsonl');
  doingRow(file, root, 'b1', 'm1', 'Write the getting started page');
  doingRow(file, root, 'b2', 'm2', 'Record the demo video');
  doingRow(file, root, 'b3', 'm3', 'Draft the launch thread');
  const NAGO = m => new Date(NOW - m * 60000).toISOString();
  const h = jobDesk(root, {
    m1: { id: 'm1', owner: 'builder', status: 'running', created_at: NAGO(40), last_tick_at: NAGO(5), max_wall_seconds: 5 * 3600, human_asks: [] },
    m2: { id: 'm2', owner: 'launcher', status: 'running', created_at: NAGO(40), last_tick_at: NAGO(5), budget_contract: { requested_seconds: 3600 }, human_asks: [] },
    m3: { id: 'm3', owner: 'researcher', status: 'running', created_at: NAGO(40), last_tick_at: NAGO(5), human_asks: [] },
  });
  assert.deepEqual(h.d.view().working, [
    { title: 'Write the getting started page', owner: 'builder', left: 'about 4 hours left' },
    { title: 'Record the demo video', owner: 'launcher', left: 'about 20 minutes left' },
    { title: 'Draft the launch thread', owner: 'researcher' },
  ]);
  for (const w of h.d.view().working) assert.doesNotMatch(JSON.stringify(w), /budget|tick/);
});

function addMember(root, name, role) {
  fs.mkdirSync(path.join(root, 'atris', 'team', name), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris', 'team', name, 'MEMBER.md'), `---\nname: ${name}\nrole: ${role}\n---\n`);
}

test('team table: one honest status per member; working only with a live process or a move in the last few minutes', async () => {
  const root = workspace();
  for (const [n, r] of [['executor', 'Executor'], ['navigator', 'Navigator'], ['validator', 'Validator'], ['linguist', 'Linguist'], ['scout', 'Scout']]) addMember(root, n, r);
  const file = path.join(root, 'gm-bets.jsonl');
  doingRow(file, root, 'b1', 'm1', 'Launch a try page for any public repo');
  const NAGO = m => new Date(NOW - m * 60000).toISOString();
  const missions = {
    m1: { id: 'm1', owner: 'builder', status: 'running', objective: 'x', created_at: NAGO(40), last_tick_at: NAGO(20), max_wall_seconds: 5 * 3600, human_asks: [] },
    m2: { id: 'm2', owner: 'launcher', status: 'running', objective: 'Write the launch thread. why now: x', created_at: NAGO(60), last_tick_at: NAGO(2), human_asks: [] },
    m3: { id: 'm3', owner: 'researcher', status: 'running', objective: 'Survey ten agent teams about pricing.', created_at: NAGO(90), last_tick_at: NAGO(30), human_asks: [] },
    m4: { id: 'm4', owner: 'executor', status: 'planning', objective: 'Split the big test file.', created_at: NAGO(10), human_asks: [] },
    m5: { id: 'm5', owner: 'navigator', status: 'blocked', objective: 'Plan the pricing page.', created_at: NAGO(150), updated_at: NAGO(120), human_asks: ['ship the pricing page now?'] },
    m6: { id: 'm6', owner: 'validator', status: 'complete', objective: 'Check the two reports.', created_at: NAGO(200), updated_at: NAGO(60), human_asks: [] },
    m7: { id: 'm7', owner: 'scout', status: 'complete', objective: 'Old scouting.', created_at: NAGO(5000), updated_at: NAGO(4320), human_asks: [] },
  };
  const handoffs = [
    { id: 'h1', from: 'builder', to: 'linguist', summary: '[b1] Rewrite the page in plain words', status: 'open', created_at: NAGO(15) },
  ];
  const h = jobDesk(root, missions, { handoffs, driverAlive: m => m.id === 'm1' });
  const rows = h.d.teamTable().rows;
  assert.deepEqual(rows.map(({ member, on, status, time }) => ({ member, on, status, time })), [
    { member: 'navigator', on: 'Plan the pricing page', status: 'waiting for your yes', time: 'asked 2 hours ago' },
    { member: 'builder', on: 'Launch a try page for any public repo', status: 'working', time: 'about 4 hours left' },
    { member: 'launcher', on: 'Write the launch thread', status: 'working', time: 'at it for 1 hour' },
    { member: 'executor', on: 'Split the big test file', status: 'waiting to start', time: 'added 10 minutes ago' },
    { member: 'linguist', on: 'Rewrite the page in plain words', status: 'waiting to start', time: 'added 15 minutes ago' },
    { member: 'researcher', on: 'Survey ten agent teams about pricing', status: 'stopped', time: 'stopped 30 minutes ago' },
    { member: 'validator', on: 'Check the two reports', status: 'done', time: 'finished 1 hour ago' },
    // nothing in the last day: still on the team, idle, with no work to name
    { member: 'scout', on: '', status: 'idle', time: '' },
  ]);
  assert.equal(rows.find(r => r.member === 'navigator').sentence, 'waiting for your yes: plan the pricing page, asked 2 hours ago');
  // the time words never say waiting a second time after the status
  for (const r of rows) assert.ok((r.sentence.match(/\bwaiting\b/g) || []).length <= 1, r.sentence);
  // the footer counts only what is really working
  assert.equal(h.d.view().team_working, 2);
  for (const r of rows) assert.doesNotMatch(Object.values(r).join(' '), gmBet.OWNER_BANNED);
});

// one play for the season stub: the same shape gm-season reads from the task list
function play(member, kind, i) {
  return { event_id: `${member}-${kind}-${i}`, task_id: `T-${member}-${i}`, member, title: `job ${i}`, kind, at: NOW - (i + 1) * 3600000, claimed_at: NOW - (i + 2) * 3600000 };
}

function seasonOf(counts) {
  const outcomes = [];
  for (const [member, kinds] of Object.entries(counts)) {
    let i = 0;
    for (const [kind, n] of Object.entries(kinds)) for (let k = 0; k < n; k += 1) outcomes.push(play(member, kind, i++));
  }
  return { outcomes, claims: [], missions: [], asleep: [], error: null };
}

// Which tools count as installed comes from the workspace's own registry
// file, as it does for a real run, so no probe of this machine's PATH decides
// what the table shows: the named tools are ready, every other one is missing
// and was just checked.
function readyEngines(root, ...ready) {
  const ids = Object.keys(require('../lib/runner-command').RUNNER_PROFILE_DEFS);
  const checked = new Date().toISOString();
  const engines = ids.map(id => (ready.includes(id) ? { id, health: { status: 'ready' } } : { id, installed: false, health: { status: 'not_installed', checked_at: checked } }));
  fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
  fs.writeFileSync(path.join(root, '.atris', 'state', 'engines.json'), `${JSON.stringify({ engines })}\n`);
}

const PROJECT_ROSTER = '# roster\n\n## search\n- claude code, model: haiku 5.5\n\n## build\n- claude code, model: opus 5.5\n\n## review\n- codex, model: gpt-6.1-sol\n\n## team\n- launcher: codex, model: gpt-6.1-sol\n';

test('team table: every member with a few words of role, the board rating, the exact model, and one status sentence', async () => {
  const root = workspace();
  addMember(root, 'validator', 'Reviewer');
  addMember(root, 'linguist', 'Linguist - operator language and understanding');
  // a parked member keeps its folder but the table leaves it out
  fs.mkdirSync(path.join(root, 'atris', 'team', 'coordinator'), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris', 'team', 'coordinator', 'MEMBER.md'), '---\nname: coordinator\nstatus: parked\nrole: Coordinator\n---\n');
  // a person on the team: the runner never runs people, so no model shows
  fs.mkdirSync(path.join(root, 'atris', 'team', 'designer'), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris', 'team', 'designer', 'MEMBER.md'), '---\nname: designer\ntype: human\nrole: Designer\ndescription: Draws the screens by hand\n---\n');
  fs.writeFileSync(path.join(root, 'atris', 'ROSTER.md'), PROJECT_ROSTER);
  readyEngines(root, 'claude', 'codex');
  const NAGO = m => new Date(NOW - m * 60000).toISOString();
  const missions = { m1: { id: 'm1', owner: 'builder', status: 'running', objective: 'Write the try page.', created_at: NAGO(10), last_tick_at: NAGO(1), human_asks: [] } };
  // builder: 4 landed, 1 dropped is round(60 + 39 * 4 / 5) = 91. validator:
  // 3 landed, 1 sent back is 89. launcher has 2 finished, a rookie. linguist
  // only claimed a job and finished none, so it has no rating yet.
  // researcher has no plays at all.
  const season = seasonOf({
    builder: { landed: 4, dropped: 1 },
    validator: { landed: 3, sent_back: 1 },
    launcher: { landed: 2 },
    linguist: { took: 1 },
  });
  const h = jobDesk(root, missions, { driverAlive: () => true, loadSeason: () => season });
  const rows = h.d.teamTable().rows;
  // a role that only repeats the member's name gives its description instead
  assert.deepEqual(rows.map(r => [r.member, r.role, r.ovr, r.engine, r.sentence]), [
    ['builder', 'writes and tests the code', '91', 'claude opus 5.5', 'working: write the try page, at it for 10 minutes'],
    ['designer', 'draws the screens by hand', '··', 'person', 'idle: no work in the last day'],
    ['launcher', 'writes posts, pages, and launch copy', 'new', 'codex gpt-6.1-sol', 'idle: no work in the last day'],
    ['linguist', 'linguist, operator language and understanding', '··', 'claude opus 5.5', 'idle: no work in the last day'],
    ['researcher', 'deep researcher', '··', 'claude haiku 5.5', 'idle: no work in the last day'],
    ['validator', 'reviewer', '89', 'codex gpt-6.1-sol', 'idle: no work in the last day'],
  ]);
  // the board says the same numbers for the same plays
  const board = require('../lib/gm-season').rosterRows({ outcomes: season.outcomes, now: NOW });
  assert.deepEqual(Object.fromEntries(board.map(r => [r.name, [r.ovr, r.finished]])), { builder: [91, 5], validator: [89, 4], launcher: [null, 2], linguist: [null, 0] });
  // the working count and the talk card still read the same status
  assert.equal(h.d.view().team_working, 1);
  assert.deepEqual(rows[0].status, 'working');
  for (const r of rows) assert.doesNotMatch(r.sentence, /[A-Z]/, 'the status sentence is lowercase');
});

test('team table: no rating shows two dots, never a made-up number, and an unpinned model shows two dots too', async () => {
  const root = workspace();
  readyEngines(root, 'claude', 'codex');
  // no roster file: the router picks a tool with no model pinned, so no exact model is known
  const h = jobDesk(root, {}, { loadSeason: () => ({ outcomes: [], error: 'could not open the task list' }) });
  const rows = h.d.teamTable().rows;
  assert.deepEqual(rows.map(r => [r.member, r.ovr, r.engine]), [
    ['builder', '··', '··'],
    ['launcher', '··', '··'],
    ['researcher', '··', '··'],
  ]);
  // a season loader that throws reads the same way
  const broken = jobDesk(root, {}, { loadSeason: () => { throw new Error('locked'); }, resolveEngine: () => { throw new Error('bad roster'); } });
  assert.deepEqual(broken.d.teamTable().rows.map(r => [r.ovr, r.engine]), [['··', '··'], ['··', '··'], ['··', '··']]);
  // a pick with an engine but no model is not an exact model
  const bare = jobDesk(root, {}, { loadSeason: () => seasonOf({}), resolveEngine: () => ({ engine: { id: 'claude' }, model: '' }) });
  assert.ok(bare.d.teamTable().rows.every(r => r.engine === '··'));
  // a model label that already starts with the tool name is not said twice
  const grok = jobDesk(root, {}, { loadSeason: () => seasonOf({}), resolveEngine: () => ({ engine: { id: 'grok' }, model: 'grok-4.7-build-fast' }) });
  assert.match(grok.d.teamTable().rows[0].engine, /^grok 4\.7 fast$/);
});

test('team table: a card with no frontmatter still gives its role, from a role line or its first paragraph', () => {
  const root = workspace();
  const card = (name, text) => {
    fs.mkdirSync(path.join(root, 'atris', 'team', name), { recursive: true });
    fs.writeFileSync(path.join(root, 'atris', 'team', name, 'MEMBER.md'), text);
  };
  card('alpha-judge', '# alpha judge\n\nrole: feature alchemist and gatekeeper. Activated in any chat.\n\n## what it is\n');
  card('engine-manager', '# engine-manager\n\nOwns the engine fleet: which terminal agents Atris can dispatch to.\n\n## job\n');
  card('blank', '# blank\n\n## job\n');
  const h = jobDesk(root, {}, { loadSeason: () => seasonOf({}), resolveEngine: () => null });
  const roles = Object.fromEntries(h.d.teamTable().rows.map(r => [r.member, r.role]));
  assert.equal(roles['alpha-judge'], 'feature alchemist and gatekeeper');
  assert.equal(roles['engine-manager'], 'owns the engine fleet');
  assert.equal(roles.blank, '\u00b7\u00b7');
});

test('job deck: one card per running job, needs you first, with a divided row of done, work, member, role, ovr, engine, status', () => {
  const root = workspace();
  addMember(root, 'navigator', 'Navigator');
  addMember(root, 'scout', 'Scout');
  fs.writeFileSync(path.join(root, 'atris', 'ROSTER.md'), PROJECT_ROSTER);
  readyEngines(root, 'claude', 'codex');
  const file = path.join(root, 'gm-bets.jsonl');
  doingRow(file, root, 'b1', 'm1', 'Launch a try page for any public repo');
  const NAGO = m => new Date(NOW - m * 60000).toISOString();
  const missions = {
    m1: { id: 'm1', owner: 'builder', status: 'running', objective: 'x', created_at: NAGO(40), last_tick_at: NAGO(2), human_asks: [] },
    m5: { id: 'm5', owner: 'navigator', status: 'blocked', objective: 'Plan the pricing page.', created_at: NAGO(150), updated_at: NAGO(120), human_asks: ['ship the pricing page now?'] },
    m6: { id: 'm6', owner: 'scout', status: 'complete', objective: 'Old scouting.', created_at: NAGO(200), updated_at: NAGO(60), human_asks: [] },
  };
  const h = jobDesk(root, missions, { loadSeason: () => seasonOf({ builder: { landed: 4, dropped: 1 } }) });
  const deck = h.d.jobDeck();
  assert.equal(deck.cards.length, 2, 'finished jobs are not on the deck');
  assert.deepEqual(deck.columns, ['done', 'work', 'member', 'role', 'ovr', 'engine', 'status']);
  assert.deepEqual(deck.cards.map(c => [c.mission_id, c.label, c.member]), [['m5', 'needs you', 'navigator'], ['m1', 'working', 'builder']]);
  // role, ovr, and engine are the team table's own cells
  const table = new Map(h.d.teamTable().rows.map(r => [r.member, r]));
  for (const c of deck.cards) {
    const t = table.get(c.member);
    assert.deepEqual([c.rows[0].role, c.rows[0].ovr, c.rows[0].engine], [t.role, t.ovr, t.engine]);
  }
  assert.deepEqual(deck.cards[0].rows[0].ovr, '\u00b7\u00b7', 'no rating is two dots');
  assert.deepEqual(deck.cards[1].rows[0].ovr, '91');
  assert.deepEqual(deck.cards[1].rows[0].engine, 'claude opus 5.5');
  assert.deepEqual(deck.cards[1].rows[0].work, 'Launch a try page for any public repo');
  for (const c of deck.cards) assert.doesNotMatch(JSON.stringify(c.rows), gmBet.OWNER_BANNED);
});

// a command, a flag, a path, or a file name: never in a cell the owner reads
const CODE_TELL = /`|(^|\s)--?[a-z]|\/|\.(js|md|json)\b|\bnpm (publish|test)\b/i;

test('job deck: a card that needs you carries its yes in plain words, and a yes from the deck answers that job alone', async () => {
  const root = workspace();
  addMember(root, 'navigator', 'Navigator');
  const NAGO = m => new Date(NOW - m * 60000).toISOString();
  const missions = {
    // the work and the ask both name a command, a flag, and a path
    'm-ask': { id: 'm-ask', owner: 'navigator', status: 'blocked', objective: 'Fix lib/gm-bet.js so the `npm test` run passes.', created_at: NAGO(30), updated_at: NAGO(20), human_asks: ['ok to run `npm publish --tag next` from lib/release.js?'] },
    m1: { id: 'm1', owner: 'builder', status: 'running', objective: 'Write the try page.', created_at: NAGO(40), last_tick_at: NAGO(1), human_asks: [] },
  };
  const h = jobDesk(root, missions, { driverAlive: () => true });
  const [needs, working] = h.d.jobDeck().cards;
  assert.deepEqual([needs.member, needs.label, working.member, working.label], ['navigator', 'needs you', 'builder', 'working']);
  // the yes card's own two lines, and the key the page sends back with the yes
  assert.deepEqual(needs.yes, { key: 'm-ask:0', what: 'ok to publish this package to npm under the next tag?', why: 'navigator is waiting for your yes.' });
  assert.equal(working.yes, undefined, 'only a card that needs you has a yes');
  // plain words in every cell: the path and the command are gone, the meaning stays
  assert.equal(needs.rows[0].work, 'Fix a file so the run passes');
  assert.deepEqual([needs.rows[0].done, working.rows[0].done], ['not yet', 'not yet']);
  for (const c of h.d.jobDeck().cards) assert.doesNotMatch(JSON.stringify([c.rows, c.yes || null]), CODE_TELL);
  // the main screen shows something else: a yes from the deck leaves it alone
  const before = h.d.view().status;
  // a yes names its job and its key, both
  assert.equal((await h.d.answerYes({ key: 'm-ask:0' })).reason, 'gone');
  // the same shape as a no: told navigator no. it goes on without it.
  assert.deepEqual(await h.d.answerYes({ key: 'm-ask:0', job: 'm-ask' }), { ok: true, ack: 'told navigator yes.' });
  assert.deepEqual(h.cli.slice(-2), [['decide', '--json'], ['decide', '2', 'yes', '--json']]);
  assert.equal(h.d.view().status, before);
  // said once: the card stops asking, and the same yes again, or a made-up one, goes nowhere
  assert.equal(h.d.jobDeck().cards[0].yes, undefined);
  const calls = h.cli.length;
  assert.equal((await h.d.answerYes({ key: 'm-ask:0', job: 'm-ask' })).reason, 'gone');
  assert.equal((await h.d.answerYes({ key: 'nobody:0', job: 'nobody' })).reason, 'gone');
  assert.equal(h.cli.length, calls, 'nothing runs for a yes that is not asked');
});

test('job deck: the yes on a card is the desk yes card for that job, in plain words, and a yes on the deck clears it on the main screen', async () => {
  const root = workspace();
  const file = path.join(root, 'gm-bets.jsonl');
  doingRow(file, root, 'b-ask', 'm-ask', 'Write the launch thread for the phone page');
  const h = jobDesk(root, { 'm-ask': { id: 'm-ask', owner: 'launcher', status: 'blocked', created_at: new Date(NOW - 60000).toISOString(), human_asks: ['run `git push --tags` now?'] } });
  const shown = h.d.next();
  assert.equal(shown.kind, 'yes');
  // the main yes card reads in plain words too
  assert.equal(shown.job.what, 'ok to push every tag to the default remote?');
  const card = h.d.jobDeck().cards[0];
  assert.deepEqual(card.yes, { key: 'm-ask:0', ...shown.job });
  assert.equal((await h.d.answerYes({ key: card.yes.key, job: card.job_id })).ok, true);
  assert.equal(h.d.view().status, 'cleared', 'the same yes on the main screen is answered too');
});

// Codex review on #1563: a yes card keeps the verb and the target. A held
// release delete once read "wants to make a release", so a yes to what
// looked like a new release would have deleted one.
test('yes words: a held command keeps its verb and its target, and one that cannot be said exactly shows where it goes and what it names', async () => {
  const root = workspace();
  const yesLock = require('../lib/yes-lock');
  const seal = yesLock.handoffSeal();
  yesLock.writeYesLocks(root, 'm-child', { seal, parentMissionId: null });
  assert.equal(yesLock.check({ stateDir: root, missionId: 'm-child', seal, tool: 'gh', args: ['release', 'delete', 'v1.2.3', '--yes'] }).hold, true);
  const h = jobDesk(root, {});
  h.d.pollJobs();
  const card = h.d.next();
  assert.deepEqual([card.kind, card.job.what], ['yes', 'a handed-off job wants to delete the GitHub release v1.2.3 in this repo']);
  const said = [
    ['a handed-off job wants to gh release delete v1.2.3 --yes', 'a handed-off job wants to delete the GitHub release v1.2.3 in this repo'],
    ['a handed-off job wants to gh release delete v1.2.3 --cleanup-tag -R atrislabs/atris', 'a handed-off job wants to delete the GitHub release v1.2.3 and its tag in atrislabs/atris'],
    ['a handed-off job wants to gh release create v1.2.3 --draft', 'a handed-off job wants to create the GitHub release v1.2.3 as a draft in this repo'],
    ['a handed-off job wants to gh pr merge 5', 'a handed-off job wants to merge pull request 5 in this repo'],
    ['a handed-off job wants to gh pr merge 5 --squash --delete-branch -R atrislabs/atris', 'a handed-off job wants to squash and merge pull request 5 and delete its branch in atrislabs/atris'],
    ['a handed-off job wants to gh pr close 7', 'a handed-off job wants to close pull request 7 in this repo'],
    ['a handed-off job wants to git push origin main', 'a handed-off job wants to push main to origin'],
    ['a handed-off job wants to git push origin feature:master', 'a handed-off job wants to push feature to master on origin'],
    ['a handed-off job wants to git push --force origin main', 'a handed-off job wants to force push main to origin, replacing what is there'],
    ['a handed-off job wants to git push origin --delete v1.2.3', 'a handed-off job wants to delete v1.2.3 on origin'],
    ['a handed-off job wants to git push origin :v1.2.3', 'a handed-off job wants to delete v1.2.3 on origin'],
    ['a handed-off job wants to npm publish', 'a handed-off job wants to publish this package to npm'],
    ['a handed-off job wants to npm publish ./a', 'a handed-off job wants to publish the package in "./a" to npm'],
    ['a handed-off job wants to npm publish --tag next --access public', 'a handed-off job wants to publish this package to npm under the next tag, public'],
    // nothing that cannot be said exactly gets a friendlier verb
    ['a handed-off job wants to gh release edit v1.2.3 --draft=false', 'a handed-off job wants to run a command that changes GitHub: "release edit v1.2.3 --draft=false"'],
    ['a handed-off job wants to gh pr merge 5 --admin', 'a handed-off job wants to run a command that changes GitHub: "pr merge 5 --admin"'],
    ['a handed-off job wants to npm unpublish atris@3.0.0', 'a handed-off job wants to run a command that changes npm: "unpublish atris@3.0.0"'],
    ['a handed-off job wants to git push --mirror backup', 'a handed-off job wants to run a command that changes the git remote: "push --mirror backup"'],
    ['a handed-off job wants to gh release create v2 --notes big release', 'a handed-off job wants to run a command that changes GitHub: "release create v2 --notes big release"'],
    // a command in a written ask, between backticks
    ['ok to run `npm publish --tag next` from lib/release.js?', 'ok to publish this package to npm under the next tag?'],
    ['run `git push --tags` now?', 'ok to push every tag to the default remote?'],
    // plain asks, and asks with no command to read, stay as written
    ['ship the pricing page now?', 'ship the pricing page now?'],
    ['ok to change lib/x.js?', 'ok to change lib/x.js?'],
  ];
  for (const [ask, plain] of said) assert.equal(gmBet.plainAsk(ask), plain, ask);
  // the guard's own words for a held command: a delete says delete, a force push says so, a tag is named
  const away = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-held-'));
  const held = (tool, args) => yesLock.plainWhat(JSON.stringify({ tool, args, cwd: away }));
  assert.equal(held('gh', ['release', 'delete', 'v1.2.3', '--yes']), 'delete the GitHub release v1.2.3 in this repo');
  assert.equal(held('gh', ['release', 'edit', 'v1.2.3', '--draft=false']), 'run a command that changes GitHub: "release edit v1.2.3 --draft=false"');
  assert.equal(held('git', ['push', 'origin', '--delete', 'v1.2.3']), 'delete v1.2.3 on its remote');
  assert.equal(held('git', ['push', 'origin', ':v1.2.3']), 'delete v1.2.3 on its remote');
  assert.equal(held('git', ['push', 'origin', 'v1.2.3']), 'push the tag v1.2.3 to its remote');
  assert.equal(held('git', ['push', '--force', 'origin', 'pricing-page']), 'force push its pricing page branch to its remote, replacing what is there');
  assert.equal(held('git', ['push', 'origin', '+HEAD:master']), 'force push to master on its remote, replacing what is there');
  for (const [ask, plain] of said) {
    if (/\bdelete\b/.test(ask)) assert.doesNotMatch(plain, /\b(create|make|publish)\b/, `a delete never reads as a create: ${ask}`);
  }
});

// Codex review on #1563: two jobs from one member are two cards, and the
// yes on each is bound to the job its own table shows, never to the member.
test('job deck: two jobs from one member are two cards, and each yes answers the job its card shows', async () => {
  const root = workspace();
  const ago = m => new Date(NOW - m * 60000).toISOString();
  const missions = {
    old: { id: 'old', owner: 'builder', status: 'blocked', objective: 'Put the public site live', created_at: ago(20), updated_at: ago(10), human_asks: ['put it live now?'] },
    new: { id: 'new', owner: 'builder', status: 'blocked', objective: 'Put the billing service live', created_at: ago(5), updated_at: ago(1), human_asks: ['put it live now?'] },
  };
  const h = jobDesk(root, missions, { decisions: [{ number: 1, mission_id: 'old', ask_index: 0 }, { number: 2, mission_id: 'new', ask_index: 0 }] });
  // the newer yes was passed over on the main screen
  h.d.state.seenYes.add('new:0');
  const cards = h.d.jobDeck().cards;
  assert.deepEqual(cards.map(c => [c.job_id, c.rows[0].work, c.yes && c.yes.key]), [
    ['new', 'Put the billing service live', 'new:0'],
    ['old', 'Put the public site live', 'old:0'],
  ]);
  // a yes names its job too: sent with the other job's id, it goes nowhere
  const calls = h.cli.length;
  assert.equal((await h.d.answerYes({ key: 'old:0', job: 'new' })).reason, 'gone');
  assert.equal(h.cli.length, calls, 'nothing runs');
  // the yes on the billing card answers the billing job, and only it
  assert.equal((await h.d.answerYes({ key: 'new:0', job: 'new' })).ok, true);
  assert.deepEqual(h.cli.slice(-2), [['decide', '--json'], ['decide', '2', 'yes', '--json']]);
  // answered, the billing job is back with builder, so the job still waiting on the owner comes first
  assert.deepEqual(h.d.jobDeck().cards.map(c => [c.job_id, c.yes && c.yes.key, c.label]), [['old', 'old:0', 'needs you'], ['new', undefined, 'you answered']]);
});

test('team table: a talk card steers a member through atris member steer, capped and checked', async () => {
  const root = workspace();
  const h = jobDesk(root, {});
  const out = await h.d.steer({ member: 'builder', text: 'do the readme first', confirm: true });
  assert.deepEqual(out, { ok: true, ack: 'builder is starting on it.' });
  assert.deepEqual(h.cli[h.cli.length - 1], ['member', 'steer', 'builder', '--detach', '--json', '--', 'the owner says: do the readme first']);
  assert.equal((await h.d.steer({ member: 'nobody', text: 'hi' })).reason, 'gone');
  assert.equal((await h.d.steer({ member: 'builder', text: '   ' })).reason, 'empty');
  assert.equal((await h.d.steer({ member: 'builder', text: 'x'.repeat(281) })).reason, 'too_long');
  assert.ok(h.logs.some(l => /^steer/.test(l.choice) && l.member === 'builder' && !/do the readme first/.test(l.command)), 'logged by length, never by its words');
});

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

test('deck: a yes comes first, then a finished job, then the next bet; nothing interrupts the card on screen', async () => {
  const root = workspace();
  const file = path.join(root, 'gm-bets.jsonl');
  doingRow(file, root, 'b-work', 'm-work', 'Record the demo video of the front office');
  doingRow(file, root, 'b-ask', 'm-ask', 'Write the launch thread for the phone page');
  doingRow(file, root, 'b-done', 'm-done', 'Write the getting started page');
  const missions = {
    'm-work': { id: 'm-work', owner: 'launcher', status: 'running', created_at: new Date(NOW - 40 * 60000).toISOString(), human_asks: [] },
    'm-ask': { id: 'm-ask', owner: 'launcher', status: 'blocked', created_at: new Date(NOW - 90 * 60000).toISOString(), human_asks: ['post the thread on x now?'] },
    'm-done': { id: 'm-done', owner: 'builder', status: 'complete', receipt_path: 'atris/runs/r1.json', human_asks: [] },
  };
  const h = jobDesk(root, missions);
  // a finished job is reviewed by the roster's reviewer before it counts as done
  assert.deepEqual(h.d.view().working.map(w => w.owner).sort(), ['builder', 'launcher'], 'a job being looked over still shows who has it, nothing about a review');
  await h.d.settle();
  // then it is written once, with its proof and the review; the bet stays doing so it is still scored
  const finished = h.ledger().find(r => r.id === 'b-done');
  assert.deepEqual(finished.review, { engine: 'codex', verdict: 'pass', reason: 'the page is there and the clip plays.' });
  assert.deepEqual([finished.status, finished.mission_result, finished.mission_checked, finished.mission_proof, finished.mission_changed], ['doing', 'done', 'passed', 'atris/runs/r1.json', 'added the getting started page and a 30 second clip.']);
  h.d.pollJobs();
  assert.equal(fs.readFileSync(file, 'utf8').split('\n').filter(l => l.includes('"mission_result"')).length, 1, 'read again, not written again');
  // the working line: only the job that is working, with who has it and for how long
  assert.deepEqual(h.d.view().working, [{ title: 'Record the demo video of the front office', owner: 'launcher' }]);
  // fill the bet queue, then tap: yes, then done, then a bet
  h.d.warm();
  for (let i = 0; i < 3; i += 1) await h.gen.releaseOne();
  const first = h.d.next();
  assert.equal(first.kind, 'yes');
  // the same words the team page uses for this status: waiting for your yes
  assert.match(first.job.why, /^launcher is waiting for your yes\. /);
  assert.deepEqual(first.job, { what: 'post the thread on x now?', why: 'launcher is waiting for your yes. 300 more npm installs in the week before nov 1.' });
  assert.equal(first.bet, null);
  // the card on screen stays until the owner moves on, even as jobs change
  h.d.pollJobs();
  assert.equal(h.d.view().kind, 'yes');
  const second = h.d.next();
  assert.equal(second.kind, 'done');
  assert.deepEqual(second.job, { what: 'Write the getting started page', why: 'this is done. 300 more npm installs in the week before nov 1.' });
  const third = h.d.next();
  assert.equal(third.kind, 'bet');
  assert.equal(third.bet.title, TITLES[0]);
  // passing over a done card marks it seen; passing a yes waits for a later session
  assert.ok(h.ledger().find(r => r.id === 'b-done').done_seen_at);
  assert.equal(h.d.next().kind, 'bet', 'the yes already passed over does not come back this session');
  // a fresh desk (a restart) brings the yes back, but not the seen done card
  const again = jobDesk(root, missions);
  assert.equal(again.d.next().kind, 'yes');
  assert.notEqual(again.d.next().kind, 'done');
});

test('deck: after do it the next queued card comes on the next tap, with nothing recorded as passed', async () => {
  const root = workspace();
  const h = jobDesk(root, {});
  h.d.warm();
  for (let i = 0; i < 3; i += 1) await h.gen.releaseOne();
  const shown = h.d.next();
  const out = await h.d.doIt();
  assert.equal(out.ok, true);
  assert.equal(h.d.view().status, 'started');
  assert.equal(h.d.view().mission.line, 'builder has it and is starting now.');
  // the page taps for the owner after the line holds; the started bet is not passed over
  const next = h.d.next();
  assert.equal(next.kind, 'bet');
  assert.notEqual(next.id, shown.id);
  assert.equal(h.ledger().find(r => r.id === shown.id).status, 'doing');
  // and the started job is on the working line right away
  assert.equal(h.d.view().working.length, 0, 'the stub mission map has no such mission yet, so nothing is invented');
});

test('yes and send back: a yes answers the right ask through atris decide; a halted job goes back on its own, never as a card', async () => {
  const root = workspace();
  const file = path.join(root, 'gm-bets.jsonl');
  doingRow(file, root, 'b-ask', 'm-ask', 'Write the launch thread for the phone page');
  doingRow(file, root, 'b-fail', 'm-fail', 'Split the biggest test file into four');
  const h = jobDesk(root, {
    'm-ask': { id: 'm-ask', owner: 'launcher', status: 'running', updated_at: new Date(NOW).toISOString(), human_asks: ['post the thread on x now?'] },
    'm-fail': { id: 'm-fail', owner: 'builder', status: 'stopped', stop_reason: 'no progress across consecutive ticks', human_asks: [] },
  });
  await h.d.settle();
  const start = h.cli.find(a => a[1] === 'start');
  assert.match(start[2], /why now: the last run halted: no progress across consecutive ticks\. try again\./);
  const row = h.ledger().find(r => r.id === 'b-fail');
  assert.deepEqual([row.status, row.mission_id, row.mission_result, row.auto_sent_back, row.done_seen_at], ['doing', 'm-new', null, 1, null]);
  h.cli.length = 0;
  assert.equal(h.d.next().kind, 'yes');
  const yes = await h.d.answerYes();
  assert.deepEqual([yes.ok, yes.ack], [true, 'told launcher yes.']);
  assert.deepEqual(h.cli.slice(0, 2), [['decide', '--json'], ['decide', '2', 'yes', '--json']], 'matched by mission and ask, not by place');
  assert.equal(h.d.view().status, 'cleared');
  assert.notEqual(h.d.next().kind, 'done', 'the halted job never shows');
  // nice on a finished job only dismisses it
  const root2 = workspace();
  doingRow(path.join(root2, 'gm-bets.jsonl'), root2, 'b-ok', 'm-ok', 'Write the getting started page');
  const ok = jobDesk(root2, { 'm-ok': { id: 'm-ok', owner: 'builder', status: 'complete', receipt_path: 'r', human_asks: [] } });
  await ok.d.settle();
  ok.cli.length = 0;
  assert.equal(ok.d.next().kind, 'done');
  assert.deepEqual(ok.d.nice(), { ok: true, ack: 'nice.' });
  assert.equal(ok.cli.length, 0, 'nice runs nothing');
  // a finished plumbing bet is never a done card
  const root3 = workspace();
  ledgerRow(path.join(root3, 'gm-bets.jsonl'), root3, 'b-pl', { status: 'doing', mission_id: 'm-pl', owner: 'builder', bet: { ...goodBet({ title: 'Run one landing day for the waiting branch jobs' }), target: { metric: 'queue_landed', baseline: 0, goal: 5 } } });
  const pl = jobDesk(root3, { 'm-pl': { id: 'm-pl', owner: 'builder', status: 'complete', receipt_path: 'r', human_asks: [] } });
  await pl.d.settle();
  assert.notEqual(pl.d.next().kind, 'done');
});

test('review: a failed review sends the job back; a review that cannot run is tried again, then counts as failed with why', async () => {
  const done = { 'm1': { id: 'm1', owner: 'builder', status: 'complete', receipt_path: 'r', human_asks: [] } };
  const setup = () => { const root = workspace(); doingRow(path.join(root, 'gm-bets.jsonl'), root, 'b1', 'm1', 'Write the getting started page'); return root; };
  const failed = jobDesk(setup(), done, { review: { verdict: 'fail', reason: 'the page exists but the clip link is broken.' } });
  await failed.d.settle();
  // a failed review sends the job back on its own; it is never a card
  assert.notEqual(failed.d.next().kind, 'done');
  const back = failed.ledger()[0];
  assert.deepEqual([back.review.verdict, back.mission_id, back.auto_sent_back], ['fail', 'm-new', 1]);
  assert.match(failed.cli.find(a => a[1] === 'start')[2], /the last run did not pass: the page exists but the clip link is broken\. try again\./);
  // the reviewer reads the bet, its check, and what the worker says changed, and is asked for pass or fail
  const ask = failed.cli.find(a => a[0] === 'engine');
  assert.deepEqual([ask[1], ask[3], ask[4], ask[5], ask[6], ask[7]], ['ask', '--engine', 'codex', '--timeout', '900', '--json']);
  assert.match(ask[2], /The check that had to pass: test -s docs\/gm-phone\.md/);
  assert.match(ask[2], /What the worker says changed: added the getting started page and a 30 second clip\./);
  assert.match(ask[2], /\{"verdict": "pass", "reason"/);
  // the review cannot run: tried on each read, and after 3 it counts as failed with why
  const root = setup();
  const down = jobDesk(root, done, { review: { code: 1 } });
  await down.d.settle();
  assert.equal(down.ledger()[0].mission_result, undefined, 'one miss is not a verdict');
  for (let i = 0; i < 2; i += 1) { down.d.pollJobs(); await down.d.settle(); }
  const gave = down.ledger()[0];
  // after 3 misses it counts as failed and goes back once; the new mission starts its tries at 0
  assert.deepEqual([gave.review_tries, gave.review, gave.auto_sent_back], [0, { engine: 'codex', verdict: 'could not run', reason: 'the review exited with code 1' }, 1]);
  // no reviewer in the roster is said plainly
  const none = jobDesk(setup(), done, { reviewer: null });
  for (let i = 0; i < 2; i += 1) none.d.pollJobs();
  assert.equal(none.ledger()[0].review.reason, 'no reviewer is set in the engine roster');
  // a halted job is not reviewed; it is failed as it stands
  const halted = jobDesk(setup(), { 'm1': { id: 'm1', owner: 'builder', status: 'stopped', stop_reason: 'stuck', human_asks: [] } });
  await halted.d.settle();
  assert.equal(halted.cli.filter(a => a[0] === 'engine').length, 0);
  assert.equal(halted.ledger()[0].auto_sent_back, 1);
});

test('working: the member who has each job now follows its bet-tagged handoffs', () => {
  const root = workspace();
  doingRow(path.join(root, 'gm-bets.jsonl'), root, 'b1', 'm1', 'Write the launch thread for the phone page');
  doingRow(path.join(root, 'gm-bets.jsonl'), root, 'b2', 'm2', 'Record the demo video of the front office');
  const missions = {
    m1: { id: 'm1', owner: 'researcher', status: 'running', human_asks: [] },
    m2: { id: 'm2', owner: 'builder', status: 'running', human_asks: [] },
  };
  const handoffs = [
    { from: 'researcher', to: 'launcher', summary: '[b1] draft the thread', status: 'open' },
    { from: 'builder', to: 'researcher', summary: 'an older handoff about something else', status: 'open' },
  ];
  const h = jobDesk(root, missions, { handoffs });
  assert.deepEqual(h.d.view().working.map(w => [w.title, w.owner]), [['Write the launch thread for the phone page', 'launcher'], ['Record the demo video of the front office', 'builder']]);
});

// Live 2026-10-22: the phone said "validator has it" after a handoff that
// started no validator run. A handoff whose member did not start says so.
test('working: a handoff whose member did not start says so instead of "has it"', () => {
  const root = workspace();
  doingRow(path.join(root, 'gm-bets.jsonl'), root, 'b1', 'm1', 'Launch the try page');
  doingRow(path.join(root, 'gm-bets.jsonl'), root, 'b2', 'm2', 'Record the demo video of the front office');
  const missions = {
    m1: { id: 'm1', owner: 'builder', status: 'running', human_asks: [] },
    m2: { id: 'm2', owner: 'builder', status: 'running', human_asks: [] },
  };
  const handoffs = [
    { from: 'builder', to: 'validator', summary: '[b1] try it on 20 repos', status: 'open',
      wake: { status: 'not_started', reason: 'at_limit', text: 'validator did not start: 6 members are already working and the limit is 6. nobody is working on this step yet. to start it: atris member wake validator' } },
    { from: 'builder', to: 'linguist', summary: '[b2] write the captions', status: 'open',
      wake: { status: 'started', reason: 'started', mission_id: 'm-9', text: 'linguist is working on it now (mission m-9)' } },
  ];
  const working = jobDesk(root, missions, { handoffs }).d.view().working;
  const stuck = working.find(w => w.title === 'Launch the try page');
  assert.equal(stuck.owner, 'validator');
  assert.equal(stuck.waiting, 'validator did not start: 6 members are already working and the limit is 6. nobody is working on this step yet');
  const moving = working.find(w => w.title === 'Record the demo video of the front office');
  assert.equal(moving.owner, 'linguist');
  assert.equal(moving.waiting, undefined);
});

test('yes lock on the desk: do it locks the owner steps before the job runs; a held step is a yes card; yes opens only that step', async () => {
  const root = workspace();
  const yesLock = require('../lib/yes-lock');
  const h = jobDesk(root, { 'm-new': { id: 'm-new', owner: 'builder', status: 'running', created_at: new Date(NOW).toISOString(), human_asks: [] } });
  h.d.warm();
  for (let i = 0; i < 3; i += 1) await h.gen.releaseOne();
  h.d.next();
  await h.d.doIt();
  // the lock is written between start and run, for the bet's your-yes step
  const order = h.cli.map(a => a[1]);
  assert.deepEqual(order.slice(0, 2), ['start', 'run']);
  // the seal goes into the mission record at start; approvals live beside the ledger
  const start0 = h.cli.find(a => a[1] === 'start');
  const seal = JSON.parse(start0[start0.indexOf('--yes-lock') + 1]);
  assert.deepEqual(seal, [{ step: 3, text: 'publish the page and post the recording on x', categories: ['publish', 'tag', 'post'] }]);
  const locks = yesLock.effectiveLocks(root, 'm-new', seal);
  assert.equal(locks.trusted, true);
  assert.deepEqual(locks.locks.map(l => [l.step, l.categories, l.asked_at]), [[3, ['post', 'publish', 'tag'], null]]);
  assert.ok(h.logs.some(l => l.choice === 'lock' && l.exit_code === 0));
  // the job tries to publish: the guard holds it, and the next tap is the yes card
  const held = yesLock.check({ stateDir: root, missionId: 'm-new', seal, tool: 'npm', args: ['publish'] });
  assert.deepEqual([held.hold, held.steps], [true, [3]]);
  h.d.pollJobs();
  const card = h.d.next();
  assert.deepEqual([card.kind, card.job.what], ['yes', 'publish the page and post the recording on x']);
  const yes = await h.d.answerYes();
  assert.deepEqual([yes.ok, yes.ack], [true, 'told builder yes.']);
  const ping = h.cli.find(a => a[1] === 'ping');
  assert.deepEqual(ping.slice(0, 3), ['mission', 'ping', 'm-new']);
  assert.match(ping[3], /the owner said yes to step 3: publish the page and post the recording on x\. the guard lets it through now/);
  assert.ok(yesLock.effectiveLocks(root, 'm-new', seal).locks[0].approved_at);
  assert.deepEqual(yesLock.check({ stateDir: root, missionId: 'm-new', seal, tool: 'npm', args: ['publish'] }).consume, [3], 'now it runs, once');
  // the job is told about the lock in its own words
  const start = h.cli.find(a => a[1] === 'start');
  assert.match(start[2], /a step marked "your yes" is locked until the owner says yes: publishing, pushing tags, releases, posting, sending, and merging to master are held by the guard on your PATH/);
});

test('page: the working line is static and lists who has each job; do it hands off to the next card', () => {
  const html = phonePage('NONCE');
  assert.match(html, /<button type="button" class="quiet" id="working">the team<\/button>/);
  assert.match(html, /btn\.textContent = n \? n \+ ' working' : 'the team';/);
  // no pulse or loop on the new pieces
  const css = html.slice(html.indexOf('.quiet {'), html.indexOf('.bet tr.row'));
  assert.ok(css.length > 40);
  assert.doesNotMatch(css, /animation|transition/);
  // after do it, who has it shows under the sphere for 1.5 s, then the orb plays into the next card
  assert.match(html, /var AFTER_MS = 1500;/);
  // a start that did not get going comes back on its card with do it and one line why
  assert.match(html, /if \(!r\.ok\) \{ spiralTo\(then, function \(\) \{ unsent\(then, r,/);
  // a finished job: two big sentences from the Mac and a nice, never a send back
  const gmCard = require('../lib/gm-card');
  const done = gmCard.done({ id: 'done:b1', title: 'Write the getting started page', body: 'this is done.' });
  assert.deepEqual(done.options.map(o => [o.label, o.style]), [['nice', 'primary']]);
  assert.doesNotMatch(html, /sendback|send back/);
  assert.match(html, /if \(card\.body\) b\.appendChild\(el\('p', 'why', card\.body\)\);/);
});

// ---- over http: the routes and the deck ----------------------------------------------------

test('over http: tap, do it needs a second tap, and your-yes cards lead the deck', async () => {
  const root = workspace();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-bet-http-'));
  const ran = [];
  const hosts = [];
  const TOKEN = 'k'.repeat(43);
  const gen = stubGenerator();
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
    makeBetDesk: log => gmBet.createBetDesk({
      workspaceRoot: root,
      ledgerFile: path.join(dir, 'bets.jsonl'),
      now: () => NOW,
      log,
      generate: gen.generate,
      choices: false,
      runCli: async args => (args[1] === 'start'
        ? { code: 0, stdout: '{"mission":{"id":"mission-x","owner":"launcher"}}' }
        : { code: 0, stdout: '{"action":"mission_run_detached"}' }),
    }),
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
    const opened = await call('GET', '/card');
    assert.equal(opened.json.status, 'idle');
    assert.equal(gen.calls.length, 1, 'opening the page starts the prefetch');
    for (let i = 0; i < 3; i += 1) await gen.releaseOne();
    const tapped = await call('POST', '/act', { orb: true });
    assert.equal(tapped.status, 200);
    assert.equal(tapped.json.status, 'ready');
    const idea = tapped.json.card;
    assert.equal(idea.kind, 'idea');
    const once = await call('POST', '/act', { card_id: idea.id, option_id: 'do' });
    assert.equal(once.status, 409);
    assert.equal(once.json.reason, 'needs_confirm');
    // the idea card has no yes, no send back (the team sends work back on its own), and no nice
    for (const option of ['yes', 'sendback', 'nice']) assert.equal((await call('POST', '/act', { card_id: idea.id, option_id: option, confirm: true })).json.reason, 'bad_option', option);
    const twice = await call('POST', '/act', { card_id: idea.id, option_id: 'do', confirm: true });
    assert.equal(twice.status, 200);
    assert.equal(twice.json.ack, 'launcher has it and is starting now.');
    assert.notEqual(twice.json.card.id, idea.id, 'the next card comes with it');
    const state = await call('GET', '/state');
    assert.equal(state.json.card.id, 'yes-0-2');
    assert.match(state.json.card.choices[0].commands[0], /^atris mission ping mission-x /);
    const tapOnce = await call('POST', '/action', { card: 'yes-0-2', choice: 'yes' });
    assert.equal(tapOnce.json.reason, 'needs_confirm');
    const yes = await call('POST', '/action', { card: 'yes-0-2', choice: 'yes', confirm: true });
    assert.equal(yes.status, 200);
    await Promise.all(handler.actions.map(a => a.done));
    assert.equal(ran.length, 1);
    assert.deepEqual(ran[0].slice(0, 3), ['mission', 'ping', 'mission-x']);
    assert.equal((await call('GET', '/state')).json.card, null);
    const rows = gmBet.readLedger(path.join(dir, 'bets.jsonl'), root);
    assert.ok(rows.find(r => r.yes && r.yes[2]));
    const log = fs.readFileSync(path.join(dir, 'gm-phone-actions.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    // the act, then do it as before, then the next card served with the answer
    assert.deepEqual(log.map(l => `${l.card}:${l.choice}`), ['bet:generate', 'bet:generate', 'bet:generate', 'bet:think', 'bet:show', 'bet:act', 'bet:do', 'bet:lock', 'bet:do', 'bet:think', 'bet:show', 'yes-0-2:yes']);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await gen.release();
  }
});

test('page: one dark theme, the orb is the button, the lava stops once the card is up', () => {
  const html = phonePage('NONCE');
  const gmCard = require('../lib/gm-card');
  // the orb in the middle is the button, with a keyboard path and a label
  assert.match(html, /<canvas id="orb" tabindex="0" role="button" aria-label="the atris orb\. tap to think of one new idea for the business"><\/canvas>/);
  assert.match(html, /e\.key === 'Enter' \|\| e\.key === ' '/);
  assert.match(html, /<p class="line" id="line" aria-live="polite">tap to think<\/p>/);
  assert.doesNotMatch(html, /id="think"/);
  assert.match(html, /id="lava"/);
  assert.match(html, /<article class="bet" id="bet" hidden>/);
  // the homepage letter's dark brand values and serif, amber the only accent
  for (const v of ['--bg: #141110', '--text: #eae3d9', '--text-2: #a39b92', '--text-3: #9a9187', '--line: #3d332d', '--amber: rgb(255, 140, 66)']) assert.ok(html.includes(v), v);
  assert.match(html, /--serif: 'Iowan Old Style', 'Palatino Linotype', Palatino, 'Book Antiqua', Georgia, serif;/);
  assert.doesNotMatch(html, /#fff\b|#ffffff|#f6f5f2|background: white/i);
  // no decision sheet on the phone, and no overlay of its own: the team is a card
  assert.doesNotMatch(html, /things only you can do|id="sheet"|id="team"/);
  // the idea card's words come from the Mac
  const idea = gmCard.idea({ id: 'b1', title: 'Write the getting started page', body: 'installs last week were 1,400. more people try it by nov 1.' });
  assert.deepEqual(idea.options.map(o => [o.label, o.confirm || null]), [['do it', 'tap again to start'], ['sharpen it', null], ['not now', null]]);
  // the worry version of the card names the same tap the same way
  const worried = gmCard.idea({ id: 'b2', title: 'Write the getting started page', body: 'installs last week were 1,400.', concern: 'one worry: it may not move your number much this week.' });
  assert.equal(worried.options.find(o => o.action === 'sharper').label, idea.options.find(o => o.action === 'sharper').label);
  // no process text ever reaches the page: no skeptic, no rejects, no word counts, no thinking screen
  assert.doesNotMatch(html, /tokens|second look|words written|turned down|skeptic|sayEvent|progressOf|'thinking'|'failed'/);
  // one script scope: a function declared twice silently replaces the first
  const names = [...html.matchAll(/function ([A-Za-z]\w*)\(/g)].map(m => m[1]);
  assert.deepEqual(names.filter((n, i) => names.indexOf(n) !== i), []);
  assert.match(html, /navigator\.vibrate\(10\)/);
  // two speeds by truth: from the big orb a queued card plays the landing curves at
  // two fifths of their length; an act on a card is the short motion
  assert.match(html, /var FAST = 0\.4;/);
  assert.match(html, /var GROW_MS = 1050, MAX_SCALE = 3\.2;/);
  assert.match(html, /\(GROW_MS \* pace\)/);
  assert.match(html, /\(SETTLE_MS \* pace\)/);
  assert.match(html, /\.lava\.still \.tx, \.lava\.still \.ty, \.lava\.still \.blob \{ animation-play-state: paused; \}/);
  assert.match(html, /prefers-reduced-motion: reduce/);
  assert.match(html, /api\('\/act', \{ orb: true, card_id: bet\.shown \? bet\.shown\.id : null \}\)/);
  // the bright point does not breathe
  assert.doesNotMatch(html, /Math\.sin\(boom/);
  // no eyebrow labels and no small lines: the card is the title, then why it matters in the same big body type
  assert.doesNotMatch(html, /'why now'|el\('span', 'k'|\['expect', |\['cost', |'needs your yes'|class="terms"|\.terms |'when'|'steps'/);
  assert.match(html, /\.why \{ margin: 14px 0 0; color: var\(--text\); font-size: 20px; line-height: 1\.4; \}/);
});

test('addDays counts calendar days, so the clock change on nov 1 cannot push the date out', () => {
  assert.equal(gmBet.addDays('2026-10-21', 14), '2026-11-04');
  assert.equal(gmBet.addDays('2026-10-21', 1), '2026-10-22');
  assert.equal(gmBet.addDays('2026-12-25', 10), '2027-01-04');
  assert.equal(gmBet.addDays('2026-03-01', 7), '2026-03-08');
});

test('attempts log: every model answer is saved with its raw text, parse result, reasons, and timing', async () => {
  const root = workspace();
  const attemptsFile = path.join(root, 'attempts.jsonl');
  let n = 0;
  const out = await gmBet.generateBet({
    workspaceRoot: root,
    today: TODAY,
    ledgerFile: path.join(root, 'bets.jsonl'),
    attemptsFile,
    writers: 1,
    deps: {
      ...fixtureDeps,
      now: () => (n += 1000),
      runModel: async prompt => ({ ok: true, text: /was rejected/.test(prompt) ? JSON.stringify(goodBet({ check_in_days: 40 })) : 'sure, here is a bet' }),
    },
  });
  assert.equal(out.ok, false);
  const rows = fs.readFileSync(attemptsFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(r => [r.attempt, r.parse, r.passed]), [[1, 'the answer was not JSON', false], [2, 'ok', false], [3, 'ok', false]]);
  assert.equal(rows[0].raw, 'sure, here is a bet');
  assert.match(rows[1].raw, /"check_in_days":40/);
  assert.deepEqual(rows[1].reasons, ['check_in_days must be a whole number from 7 to 14, got 40']);
  assert.ok(rows.every(r => r.ms > 0 && r.today === TODAY && r.workspace === root && r.model_ok === true && r.kind === 'writer' && r.lane === 1));
});

test('attempts log: a model that fails outright is saved too', async () => {
  const root = workspace();
  const attemptsFile = path.join(root, 'attempts.jsonl');
  await gmBet.generateBet({
    workspaceRoot: root, today: TODAY, ledgerFile: path.join(root, 'bets.jsonl'), attemptsFile,
    deps: { ...fixtureDeps, runModel: async () => ({ ok: false, reason: 'the model gave an empty answer' }) },
  });
  // one row for each of the three writers, each with its own lane and angle
  const rows = fs.readFileSync(attemptsFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(rows.map(r => [r.model_ok, r.lane]).sort((a, b) => a[1] - b[1]), [[false, 1], [false, 2], [false, 3]]);
  assert.deepEqual(rows[0].reasons, ['the model gave an empty answer']);
  assert.deepEqual(new Set(rows.map(r => r.angle)), new Set(gmBet.WRITER_ANGLES.map(a => a.key)));
});

test('merged changes: one per first-parent commit, merges named by their pull request title', () => {
  const git = (...args) => require('node:child_process').execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-bet-git-'));
  git('init', '-q', '-b', 'master');
  git('commit', '-q', '--allow-empty', '-m', 'direct fix on master');
  git('checkout', '-q', '-b', 'feature');
  git('commit', '-q', '--allow-empty', '-m', 'inside the branch one');
  git('commit', '-q', '--allow-empty', '-m', 'inside the branch two');
  git('checkout', '-q', 'master');
  git('merge', '-q', '--no-ff', 'feature', '-m', 'Merge pull request #7 from org/feature', '-m', 'add the phone page');
  git('update-ref', 'refs/remotes/origin/master', 'HEAD');
  return gmBet.readBundle(repo, { deps: { readNow: () => null, seasonFacts: () => null, readBriefs: () => null, packageName: null }, ledgerFile: path.join(repo, 'b.jsonl') }).then((bundle) => {
    assert.equal(bundle.sources.landed.fact, 'changes merged this week: 2');
    assert.deepEqual(bundle.sources.landed.subjects, ['add the phone page', 'direct fix on master']);
  });
});

// Codex review round 5 on #1483: a run woken by a handoff always runs under
// the fixed handoff seal. A held command is a yes card: on the parent job
// when the handoff found one, else on its own. A yes lets that one command
// run once.
test('a held handed-off command is a yes card on its own when it has no parent', async () => {
  const root = workspace();
  const yesLock = require('../lib/yes-lock');
  const seal = yesLock.handoffSeal();
  yesLock.writeYesLocks(root, 'm-child', { seal, parentMissionId: null });
  const held = yesLock.check({ stateDir: root, missionId: 'm-child', seal, tool: 'gh', args: ['pr', 'merge', '5'] });
  assert.equal(held.hold, true);
  assert.match(held.message, /^held: a handed-off job wants to gh pr merge 5\./);
  const h = jobDesk(root, {});
  h.d.pollJobs();
  const card = h.d.next();
  assert.deepEqual([card.kind, card.job.what], ['yes', 'a handed-off job wants to merge pull request 5 in this repo'], 'plain words that keep the verb and the target');
  const own = h.d.state.jobs.yes.find(y => y.mission_id === 'm-child');
  assert.deepEqual([own.title, own.bet_id, own.command], ['a handed-off job', null, 'gh pr merge 5'], 'no parent: its own card');
  const yes = await h.d.answerYes();
  assert.equal(yes.ok, true);
  assert.deepEqual(h.cli.find(a => a[1] === 'ping').slice(0, 3), ['mission', 'ping', 'm-child']);
  // the yes lets that one command run, once
  const once = yesLock.check({ stateDir: root, missionId: 'm-child', seal, tool: 'gh', args: ['pr', 'merge', '5'] });
  assert.equal(once.consume.length, 1);
  assert.equal(yesLock.check({ stateDir: root, missionId: 'm-child', seal, tool: 'npm', args: ['publish'] }).hold, true, 'not a different command');
  yesLock.consume(root, 'm-child', seal, once.consume, { ok: true, claims: once.claims });
  assert.equal(yesLock.check({ stateDir: root, missionId: 'm-child', seal, tool: 'gh', args: ['pr', 'merge', '5'] }).hold, true, 'not twice');
});

test('a held handed-off command shows on its parent job when there is one', async () => {
  const root = workspace();
  doingRow(path.join(root, 'gm-bets.jsonl'), root, 'b1', 'm-parent', 'Launch the try page');
  const yesLock = require('../lib/yes-lock');
  const seal = yesLock.handoffSeal();
  yesLock.writeYesLocks(root, 'm-child', { seal, parentMissionId: 'm-parent' });
  yesLock.check({ stateDir: root, missionId: 'm-child', seal, tool: 'npm', args: ['publish'], cwd: root });
  const h = jobDesk(root, { 'm-parent': { id: 'm-parent', owner: 'builder', status: 'running', human_asks: [] } });
  h.d.pollJobs();
  const card = h.d.next();
  assert.deepEqual([card.kind, card.job.what], ['yes', 'a handed-off job wants to publish a package to npm']);
  const onParent = h.d.state.jobs.yes.find(y => y.mission_id === 'm-child');
  assert.deepEqual([onParent.title, onParent.bet_id], ['Launch the try page', 'b1'], 'the card sits on the parent job');
  await h.d.answerYes();
  assert.deepEqual(h.cli.find(a => a[1] === 'ping').slice(0, 3), ['mission', 'ping', 'm-child'], 'the yes goes to the run that was held');
});

// Codex review round 4 on #1483: mission #266 ("do it" on the phone) ran in
// the shared main folder, which sat on an old branch, so its check could not
// see the merged work. A "do it" mission runs in its own worktree, where the
// work and its check live, and the desk still sees it there.
test('do it starts the mission in its own worktree', async () => {
  const root = workspace();
  require('child_process').execFileSync('git', ['init', '-q', '-b', 'master'], { cwd: root });
  const h = jobDesk(root, { 'm-new': { id: 'm-new', owner: 'builder', status: 'running', created_at: new Date(NOW).toISOString(), human_asks: [] } });
  h.d.warm();
  for (let i = 0; i < 3; i += 1) await h.gen.releaseOne();
  h.d.next();
  await h.d.doIt();
  const start = h.cli.find(a => a[1] === 'start');
  assert.ok(start.includes('--worktree'), start.join(' '));
});

// Codex review round 9 on #1483: a folder with no git has no master to
// protect and no worktree to make, so the job runs in place as before.
test('do it outside a git checkout starts the mission in place', async () => {
  const root = workspace();
  const h = jobDesk(root, { 'm-new': { id: 'm-new', owner: 'builder', status: 'running', created_at: new Date(NOW).toISOString(), human_asks: [] } });
  h.d.warm();
  for (let i = 0; i < 3; i += 1) await h.gen.releaseOne();
  h.d.next();
  await h.d.doIt();
  const start = h.cli.find(a => a[1] === 'start');
  assert.ok(start, 'the mission started');
  assert.equal(start.includes('--worktree'), false, start.join(' '));
});

test('the desk reads missions that live in a worktree', () => {
  const { spawnSync } = require('child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-desk-worktree-'));
  try {
    const git = (args, cwd = root) => assert.equal(spawnSync('git', args, { cwd, encoding: 'utf8' }).status, 0, args.join(' '));
    git(['init', '-q', '-b', 'master']);
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'base']);
    const wt = path.join(root, '.agent-worktrees', 'builder-try-page');
    git(['worktree', 'add', '-q', '-b', 'builder-try-page', wt]);
    fs.mkdirSync(path.join(wt, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(wt, '.atris', 'state', 'missions.jsonl'), `${JSON.stringify({ schema: 'atris.mission.v1', id: 'mission-2026-10-22-try-page-aaaa0001', objective: 'launch try page', owner: 'builder', status: 'running', worktree_root: wt, created_at: new Date().toISOString() })}\n`);
    const missions = gmBet.readDeskMissions(root);
    assert.equal(missions.get('mission-2026-10-22-try-page-aaaa0001').owner, 'builder');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Codex review round 6 on #1483: each held command is its own card, bound to
// that exact command; answering one releases only it and hides no other.
test('two held commands on one step are two cards; the yes on the first releases only the first', async () => {
  const root = workspace();
  const yesLock = require('../lib/yes-lock');
  const seal = yesLock.handoffSeal();
  yesLock.writeYesLocks(root, 'm-child', { seal });
  for (const [dir, name] of [['a', 'alpha'], ['b', 'beta']]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, 'package.json'), JSON.stringify({ name }));
  }
  yesLock.check({ stateDir: root, missionId: 'm-child', seal, tool: 'npm', args: ['publish', './a'], cwd: root });
  yesLock.check({ stateDir: root, missionId: 'm-child', seal, tool: 'npm', args: ['publish', './b'], cwd: root });
  const h = jobDesk(root, {});
  h.d.pollJobs();
  const keys = h.d.state.jobs.yes.filter(y => y.mission_id === 'm-child').map(y => y.key);
  assert.equal(new Set(keys).size, 2, 'each card has its own key');
  const card = h.d.next();
  assert.equal(card.job.what, 'a handed-off job wants to publish alpha to npm');
  await h.d.answerYes();
  assert.equal(yesLock.check({ stateDir: root, missionId: 'm-child', seal, tool: 'npm', args: ['publish', './b'], cwd: root }).hold, true, 'B is still held');
  assert.ok(yesLock.check({ stateDir: root, missionId: 'm-child', seal, tool: 'npm', args: ['publish', './a'], cwd: root }).consume, 'A runs');
  h.d.pollJobs();
  // one yes in a row at most: a normal card comes between, then the later request
  assert.notEqual(h.d.next().kind, 'yes');
  const next = h.d.next();
  assert.deepEqual([next.kind, next.job.what], ['yes', 'a handed-off job wants to publish beta to npm'], 'the answer did not hide the later request');
});

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

test('yes cards never take over: at most one in a row, not now sends it to the back, and the next card is an idea', async () => {
  const root = workspace();
  const h = jobDesk(root, threeAsks(root));
  h.d.warm();
  for (let i = 0; i < 3; i += 1) await h.gen.releaseOne();
  const first = h.d.next();
  assert.deepEqual([first.kind, first.job.what], ['yes', 'post the thread on x now?']);
  assert.equal(first.needs_you, 2, 'the other two wait behind the small line');
  // not now: the card is skipped, and the next card is an idea, not another yes
  const after = h.d.next({ later: true });
  assert.equal(after.kind, 'bet');
  assert.equal(after.needs_you, 3, 'a skipped yes is still owed');
  assert.ok(h.logs.some(l => l.choice === 'later' && l.kind === 'yes'));
  // after an idea, a different yes not seen yet may show; the skipped one does not come back on its own
  const second = h.d.next();
  assert.equal(second.kind, 'yes');
  assert.notEqual(second.id, first.id);
  // a plain pass on a yes serves a normal card too
  assert.equal(h.d.next().kind, 'bet');
  const third = h.d.next();
  assert.equal(third.kind, 'yes');
  assert.ok(![first.id, second.id].includes(third.id));
  assert.equal(h.d.next().kind, 'bet');
  assert.notEqual(h.d.next().kind, 'yes', 'every yes was seen once; the rest wait in the deck');
  // the skipped one is at the back of the job deck
  const needs = h.d.jobDeck().cards.filter(c => c.label === 'needs you');
  assert.equal(needs.length, 3);
  assert.equal(needs[needs.length - 1].yes.what, 'post the thread on x now?');
});

test('yes cards never take over: with no idea ready, the card after a yes is a question', async () => {
  const root = workspace();
  const h = jobDesk(root, threeAsks(root));
  assert.equal(h.d.next().kind, 'yes');
  const after = h.d.next({ later: true });
  assert.equal(after.kind, 'question');
  assert.equal(h.d.next().kind, 'yes', 'after the question, a yes not seen yet');
});

test('no on a yes card: that one request is told no, the job is pinged to move on, and the card does not come back', async () => {
  const root = workspace();
  const yesLock = require('../lib/yes-lock');
  const seal = yesLock.handoffSeal();
  yesLock.writeYesLocks(root, 'm-child', { seal });
  for (const [dir, name] of [['a', 'alpha'], ['b', 'beta']]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, 'package.json'), JSON.stringify({ name }));
  }
  yesLock.check({ stateDir: root, missionId: 'm-child', seal, tool: 'npm', args: ['publish', './a'], cwd: root });
  yesLock.check({ stateDir: root, missionId: 'm-child', seal, tool: 'npm', args: ['publish', './b'], cwd: root });
  const h = jobDesk(root, {});
  h.d.pollJobs();
  const card = h.d.next();
  assert.equal(card.job.what, 'a handed-off job wants to publish alpha to npm');
  const denied = h.d.state.jobs.yes[0];
  const no = await h.d.answerNo();
  assert.equal(no.ok, true);
  assert.match(no.ack, /no/);
  assert.equal(h.d.view().status, 'cleared');
  const ping = h.cli.find(a => a[1] === 'ping');
  assert.deepEqual(ping.slice(0, 3), ['mission', 'ping', 'm-child']);
  assert.match(ping[3], /the owner said no/);
  assert.match(ping[3], /do not run it/);
  // A stays held, and asking again says the owner said no; B is still waiting for its own answer
  const again = yesLock.check({ stateDir: root, missionId: 'm-child', seal, tool: 'npm', args: ['publish', './a'], cwd: root });
  assert.equal(again.hold, true);
  assert.match(again.message, /the owner said no/);
  assert.deepEqual(yesLock.askedYesLocks(root, 'm-child').map(l => l.held_command), ['npm publish ./b']);
  h.d.pollJobs();
  assert.equal(h.d.view().needs_you, 1);
  // a request told no cannot be approved later
  assert.equal(yesLock.approveYesLock(root, 'm-child', denied.lock_step, null, new Date(NOW).toISOString(), { hash: denied.lock_hash }), null);
  // a plain ask is answered no through atris decide, matched by mission and ask
  const root2 = workspace();
  const asks = threeAsks(root2);
  const h2 = jobDesk(root2, asks, { decisions: [{ number: 1, mission_id: 'other', ask_index: 0 }, { number: 2, mission_id: 'm-a', ask_index: 0 }] });
  assert.equal(h2.d.next().kind, 'yes');
  const no2 = await h2.d.answerNo();
  assert.equal(no2.ok, true);
  assert.deepEqual(h2.cli.slice(0, 2), [['decide', '--json'], ['decide', '2', 'no', '--json']]);
  assert.ok(h2.ledger().find(r => r.id === 'b-a').no_answered);
  // nothing on screen: no answers nothing
  assert.equal((await jobDesk(workspace(), {}).d.answerNo()).reason, 'gone');
});

test('queue: showing an idea starts the next at once; with none ready the card is one calm line, with the idea ready behind it when written', async () => {
  const h = await filled(workspace());
  const first = h.d.next();
  assert.equal(first.queue, 2);
  assert.equal(h.gen.calls.length, 4, 'showing one starts writing the next');
  assert.equal(h.gen.maxActive, 1, 'still one at a time');
  // nothing ready and every question answered: one calm line, no tap the orb
  const dry = desk(workspace(), { answered: true });
  const tap = dry.d.next();
  assert.deepEqual([tap.kind, tap.job], ['wait', { what: 'writing your next idea.' }]);
  await dry.gen.releaseOne();
  // the idea waits behind the calm line until the page asks, so typing there is never cut off
  const v = dry.d.view();
  assert.deepEqual([v.status, v.kind, v.queue], ['ready', 'wait', 1]);
  assert.equal(dry.d.next().bet.title, TITLES[0]);
});

test('scoreboard: the weekly number card has a way out: a question is explained and saves nothing, not now passes it for today, and an instruction stops tracking it', async () => {
  const root = workspace();
  let reading = { ok: true, kind: 'answer', reply: '' };
  const h = desk(root, { scoreboard: true, questions: false, answered: true, readSaid: async () => reading });
  const board = () => gmBet.readScoreboard(gmBet.scoreboardPath(path.dirname(h.ledgerFile)), root);
  assert.equal(h.d.next().id, 'question:scoreboard');
  assert.equal(h.d.answer({ choice: 'other', text: 'paying schools' }).ack, 'got it: paying schools.');
  const weekly = h.d.next();
  assert.equal(weekly.kind, 'report');
  // what do you mean: explained on the same card, nothing saved
  reading = { ok: true, kind: 'question', reply: 'once a week i ask how many paying schools you have, so every idea can aim at that number.' };
  const asked = await h.d.say({ text: 'what do you mean?', card: weekly.id });
  assert.deepEqual([asked.stay, asked.reply], [true, reading.reply]);
  assert.deepEqual(board().reports, []);
  // not now: moves on, saves nothing, and is not asked again today
  assert.notEqual(h.d.next().kind, 'report');
  assert.notEqual(h.d.next().kind, 'report');
  assert.deepEqual(board().reports, []);
  // the next day it is asked again
  h.tick(24 * 60 * 60 * 1000);
  const tomorrow = h.d.next();
  assert.equal(tomorrow.kind, 'report');
  // stop tracking this: the reader says so, the number is cleared, and the next card asks which number, if any
  reading = { ok: true, kind: 'instruction', intent: 'stop', reply: '' };
  const stopped = await h.d.say({ text: 'stop tracking this', card: tomorrow.id });
  assert.equal(stopped.ok, true);
  assert.match(stopped.ack, /paying schools/);
  assert.equal(board(), null);
  assert.equal(h.d.next().id, 'question:scoreboard');
});

test('scoreboard: on the weekly number card, ask me tomorrow passes it for today; any other instruction gets a reply and changes nothing', async () => {
  const root = workspace();
  let reading = { ok: true, kind: 'answer', reply: '' };
  const h = desk(root, { scoreboard: true, questions: false, answered: true, readSaid: async () => reading });
  const board = () => gmBet.readScoreboard(gmBet.scoreboardPath(path.dirname(h.ledgerFile)), root);
  h.d.next();
  h.d.answer({ choice: 'other', text: 'paying schools' });
  const weekly = h.d.next();
  assert.equal(weekly.kind, 'report');
  // something the card cannot do: a reply on the same card, nothing changes
  reading = { ok: true, kind: 'instruction', intent: 'other', reply: 'this card only keeps the weekly number. say stop tracking this, or ask me tomorrow.' };
  const other = await h.d.say({ text: 'make the goal bigger', card: weekly.id });
  assert.deepEqual([other.stay, other.reply], [true, reading.reply]);
  assert.equal(board().name, 'paying schools');
  assert.equal(h.d.view().kind, 'report', 'still on the weekly card');
  // ask me tomorrow: like not now, the number is kept and asked again tomorrow
  reading = { ok: true, kind: 'instruction', intent: 'later', reply: '' };
  const later = await h.d.say({ text: 'ask me tomorrow', card: weekly.id });
  assert.equal(later.ok, true);
  assert.equal(board().name, 'paying schools', 'still tracking it');
  assert.notEqual(h.d.next().kind, 'report');
  h.tick(24 * 60 * 60 * 1000);
  assert.equal(h.d.next().kind, 'report');
});

test('reader: on the number card it is asked for an intent, and passes a known one through', async () => {
  const prompts = [];
  const run = text => async (p) => { prompts.push(p); return { ok: true, text }; };
  const card = { kind: 'number', title: 'paying schools: what is it this week?', detail: '', buttons: ['save', 'not now'] };
  const later = await gmBet.readSaid({ text: 'ask me tomorrow', card, workspaceRoot: workspace(), deps: { runModel: run('{"kind": "instruction", "intent": "later", "reply": ""}'), readContext: () => '' } });
  assert.deepEqual([later.kind, later.intent], ['instruction', 'later']);
  assert.match(prompts[0], /"intent": "stop"/);
  const odd = await gmBet.readSaid({ text: 'ask me tomorrow', card, workspaceRoot: workspace(), deps: { runModel: run('{"kind": "instruction", "intent": "delete everything", "reply": ""}'), readContext: () => '' } });
  assert.equal(odd.intent, undefined, 'an intent outside the list is dropped');
  // other cards are not asked for one
  await gmBet.readSaid({ text: 'hi', card: { kind: 'idea', title: 't', detail: '', buttons: [] }, workspaceRoot: workspace(), deps: { runModel: run('{"kind": "unclear", "reply": "what do you mean?"}'), readContext: () => '' } });
  assert.doesNotMatch(prompts[2], /intent/);
});

test('owner words: the prompts that write choices and replies talk to the owner as you, never by name', async () => {
  const prompts = [];
  const runModel = async (p) => { prompts.push(p); return { ok: false, reason: 'stub' }; };
  const root = workspace();
  await gmBet.readSaid({ text: 'what', card: { kind: 'question', title: 'which number?', detail: '', buttons: [] }, workspaceRoot: root, deps: { runModel, readContext: () => '' } });
  await gmBet.generateScoreboardChoices({ workspaceRoot: root, bundle: { facts: [], sources: {} }, deps: { runModel, readContext: () => '' }, ledgerFile: path.join(root, 'bets.jsonl') });
  assert.equal(prompts.length, 2);
  for (const p of prompts) assert.match(p, /talk to him as "you"/, p.slice(0, 200));
});

// ---- the card contract: one card at a time, every kind, every invariant ---------------

const gmCard = require('../lib/gm-card');

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
  const yesLock = require('../lib/yes-lock');
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

test('card contract: every kind of card is whole: a way forward, options that answer its words, plain words, and a yes with yes, no, and not now bound to its request', async () => {
  const cards = await everyCard();
  const kinds = new Set(cards.map(c => c.card.kind));
  for (const k of gmCard.KINDS) assert.ok(kinds.has(k), `no fixture reaches a ${k} card`);
  const ids = new Set();
  for (const c of cards) {
    const show = `${c.name}: ${JSON.stringify(c.wire)}`;
    assert.deepEqual(gmCard.cardProblems(c.card), [], show);
    // the page gets the contract and nothing the desk keeps to itself
    assert.deepEqual(Object.keys(c.wire).filter(k => !['id', 'kind', 'title', 'body', 'options', 'input', 'job', 'table', 'thread', 'line', 'count', 'label', 'time', 'watch', 'progress', 'started_at', 'waited_ms'].includes(k)), [], show);
    for (const o of c.wire.options) assert.deepEqual(Object.keys(o).filter(k => !['id', 'label', 'action', 'binds', 'style', 'confirm', 'type', 'detail', 'chosen', 'cell', 'group'].includes(k)), [], show);
    assert.ok(c.wire.options.length > 0 || c.wire.input, show);
    // every card served has its own id
    assert.ok(!ids.has(c.wire.id), `${c.name} reuses the id ${c.wire.id}`);
    ids.add(c.wire.id);
  }
  // the yes cards: yes binds the exact request it shows
  const lock = cards.find(c => c.name === 'yes on a held command');
  const yes = lock.wire.options.find(o => o.id === 'yes');
  assert.equal(yes.binds.job, 'm-child');
  assert.match(yes.binds.hash, /^[0-9a-f]{16}$/);
  assert.equal(yes.confirm, 'tap again to say yes');
  assert.deepEqual(lock.wire.options.map(o => o.label), ['yes', 'no', 'not now']);
  // the reply that asks its own question shows only its answers, the box, and a way back
  const asks = cards.find(c => c.name === 'reply that asks');
  assert.deepEqual(asks.wire.options.map(o => o.label), ['it is still hard to tell', 'it is helping', 'show me last night\'s changes', 'back to the question']);
  // on an idea, the same kind of reply goes back to the idea, the card it really returns to
  const onIdea = gmCard.reply({ id: 'b1~r1', base: gmCard.idea({ id: 'b1', title: 'write the getting started page', body: 'installs last week were 1,400.' }), text: 'which page do you mean, the phone one or the readme?', suggestions: ['the phone one'] });
  assert.equal(onIdea.options.find(o => o.action === 'back').label, 'back to the idea');
  assert.ok(asks.wire.input);
  assert.equal(asks.wire.title, 'no problem. does the overnight run feel like it is helping you, or is it still hard to tell?');
  assert.notEqual(asks.wire.id, cards.find(c => c.name === 'question with something else').wire.id, 'a reply is a new card');
  // the reply that only explains keeps the question's own choices, once
  const explains = cards.find(c => c.name === 'reply that explains');
  const first = cards.find(c => c.name === 'question with something else').wire.options.map(o => o.label);
  assert.deepEqual(explains.wire.options.map(o => o.label), first);
  // the swap card: the list as it comes, picks first, more models last, and more is the same card with the full list
  const sw = cards.find(c => c.name === 'swap');
  const models = sw.wire.options.filter(o => o.action === 'swap_to' || o.chosen && o.style === 'choice');
  assert.deepEqual(models.map(o => o.label), ['atris fast', 'm-one']);
  assert.deepEqual(sw.wire.options.slice(2).map(o => o.label), ['more models', 'only builder', 'everyone doing builder\'s kind of work', 'back to the team']);
  const all = cards.find(c => c.name === 'swap with more models');
  assert.notEqual(all.wire.id, sw.wire.id, 'more models is a new card');
  assert.deepEqual(all.wire.options.filter(o => o.style === 'choice').map(o => o.label), ['atris fast', 'm-one', 'm-two']);
  assert.ok(!all.wire.options.some(o => o.label === 'more models'));
  // the best draft no other beat: go with it, sharpen it, or something else, and the worry in its line
  const worry = cards.find(c => c.name === 'idea with a worry');
  assert.deepEqual(worry.wire.options.map(o => [o.label, o.action]), [['go with it', 'do'], ['sharpen it', 'sharper'], ['something else', 'next']]);
  assert.equal(worry.wire.line, 'one worry: a page alone reaches nobody new.');
  // the waiting card says how far along it is, under the same id while that changes
  const w = cards.find(c => c.name === 'wait');
  assert.ok(Array.isArray(w.wire.progress) && Number.isFinite(w.wire.started_at) && Number.isFinite(w.wire.waited_ms), JSON.stringify(w.wire));
});

test('card contract: the checks catch a card with no way out, options for other words, a command in the words, and a yes that binds nothing', () => {
  const base = gmCard.question({ id: 'q1', title: 'which number?', choices: [{ id: 'a1', label: 'installs' }] });
  assert.deepEqual(gmCard.cardProblems(base), []);
  assert.match(gmCard.cardProblems({ ...base, options: [], input: null }).join('\n'), /no way forward/);
  const mixed = gmCard.reply({ id: 'q1~r1', base, text: 'does it help?', suggestions: ['yes'] });
  assert.deepEqual(gmCard.cardProblems(mixed), []);
  assert.match(gmCard.cardProblems({ ...mixed, options: [...mixed.options, ...base.options] }).join('\n'), /answers other words/);
  assert.match(gmCard.cardProblems({ ...base, title: 'run npm publish --tag next' }).join('\n'), /command, flag, or path/);
  const y = gmCard.yes({ id: 'y1', title: 'ok to publish?', body: 'builder is waiting.', request: { job: 'm1', key: 'm1:0', hash: null } });
  assert.deepEqual(gmCard.cardProblems(y), []);
  assert.match(gmCard.cardProblems({ ...y, options: y.options.map(o => (o.id === 'yes' ? { ...o, binds: { job: 'm2', key: 'm1:0' } } : o)) }).join('\n'), /does not bind/);
  assert.match(gmCard.cardProblems({ ...y, options: y.options.filter(o => o.id !== 'no') }).join('\n'), /has no no/);
  // a card that slips through is made safe before it is served
  const fixed = gmCard.enforce({ ...base, title: 'edit lib/gm-bet.js', options: [], input: null });
  assert.deepEqual(gmCard.cardProblems(fixed), []);
  assert.deepEqual(gmCard.sequenceProblems([{ kind: 'yes' }, { kind: 'idea' }, { kind: 'yes' }]), []);
  assert.equal(gmCard.sequenceProblems([{ kind: 'yes' }, { kind: 'yes' }]).length, 1);
});

test('card contract: at most one yes in a row over a run of taps, and the rest wait behind the need-you count', async () => {
  const root = workspace();
  const h = jobDesk(root, threeAsks(root));
  h.d.warm();
  for (let i = 0; i < 3; i += 1) await h.gen.releaseOne();
  const run = [];
  let card = null;
  for (let i = 0; i < 8; i += 1) {
    const out = await h.d.act({ card_id: card ? card.id : null, orb: true });
    card = out.body.card;
    run.push({ kind: card.kind, needs: out.body.needs_you });
  }
  assert.deepEqual(gmCard.sequenceProblems(run), [], JSON.stringify(run));
  assert.equal(run[0].kind, 'yes');
  assert.equal(run[0].needs, 2);
  assert.equal(run[1].kind, 'idea');
});

test('card contract: an action names the card on screen and an option on it, or nothing is done', async () => {
  const root = workspace();
  const yesLock = require('../lib/yes-lock');
  const seal = yesLock.handoffSeal();
  yesLock.writeYesLocks(root, 'm-child', { seal });
  for (const [dir, name] of [['a', 'alpha'], ['b', 'beta']]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, 'package.json'), JSON.stringify({ name }));
  }
  yesLock.check({ stateDir: root, missionId: 'm-child', seal, tool: 'npm', args: ['publish', './a'], cwd: root });
  yesLock.check({ stateDir: root, missionId: 'm-child', seal, tool: 'npm', args: ['publish', './b'], cwd: root });
  const h = jobDesk(root, {});
  h.d.pollJobs();
  const first = (await h.d.act({ orb: true })).body.card;
  assert.equal(first.title, 'a handed-off job wants to publish alpha to npm');
  // an old card id, an option not on the card, and a yes without its second tap all do nothing
  const old = await h.d.act({ card_id: 'question:focus', option_id: 'yes', confirm: true });
  assert.deepEqual([old.status, old.body.reason, old.body.card.id], [409, 'gone', first.id]);
  const odd = await h.d.act({ card_id: first.id, option_id: 'do', confirm: true });
  assert.deepEqual([odd.status, odd.body.reason], [409, 'bad_option']);
  const once = await h.d.act({ card_id: first.id, option_id: 'yes' });
  assert.deepEqual([once.status, once.body.reason], [409, 'needs_confirm']);
  assert.equal(yesLock.askedYesLocks(root, 'm-child').length, 2, 'nothing approved yet');
  // the page sends no key: the yes is the one the card showed, by its hash, and only it
  const said = await h.d.act({ card_id: first.id, option_id: 'yes', confirm: true, key: 'anything', job: 'else' });
  assert.equal(said.status, 200);
  assert.equal(said.body.ack, 'told the handed-off job yes.');
  assert.ok(yesLock.check({ stateDir: root, missionId: 'm-child', seal, tool: 'npm', args: ['publish', './a'], cwd: root }).consume, 'A runs');
  assert.equal(yesLock.check({ stateDir: root, missionId: 'm-child', seal, tool: 'npm', args: ['publish', './b'], cwd: root }).hold, true, 'B is still held');
  // the old card is gone now: acting on it again does nothing
  assert.equal((await h.d.act({ card_id: first.id, option_id: 'no' })).body.reason, 'gone');
});

test('card contract: a reply is its own card, back brings the first question again, and a tapped answer on the reply is said', async () => {
  const said = [];
  const root = workspace();
  const h = desk(root, { scoreboard: true, questions: false, answered: true, readSaid: async (o) => { said.push(o.text); return o.text === 'the overnight run' ? ASKS_BACK() : { ok: true, kind: 'answer', reply: '' }; } });
  const q = (await h.d.act({ orb: true })).body.card;
  assert.match(q.id, /^question:scoreboard#[0-9a-f]{8}$/);
  const r = (await h.d.act({ card_id: q.id, option_id: 'other', text: 'the overnight run' })).body.card;
  assert.equal(r.kind, 'reply');
  assert.ok(!r.options.some(o => q.options.some(x => x.label === o.label)), 'none of the first question\'s choices');
  assert.deepEqual(r.thread, [{ who: 'owner', text: 'the overnight run' }]);
  const again = (await h.d.act({ card_id: r.id, option_id: 'back' })).body.card;
  assert.deepEqual([again.id, again.options.map(o => o.label)], [q.id, q.options.map(o => o.label)]);
  // the reply's own answer is said on the first question, and saved as its answer
  const r2 = (await h.d.act({ card_id: again.id, option_id: 'other', text: 'the overnight run' }));
  assert.equal(r2.body.card.kind, 'reply');
  const tapped = await h.d.act({ card_id: r2.body.card.id, option_id: 'r2' });
  assert.equal(tapped.status, 200);
  assert.equal(said[said.length - 1], 'it is helping');
  assert.equal(gmBet.readScoreboard(gmBet.scoreboardPath(path.dirname(h.ledgerFile)), root).name, 'it is helping');
});

const walk = require('../scripts/gm-phone-trace');
const WALK_CHROME = walk.findChrome();

test('browser: every kind of card, one after another, as the desk served it: the page draws exactly that card\'s options and its box, and nothing from the card before', { skip: !WALK_CHROME && 'no chrome on this machine', timeout: 240000 }, async () => {
  const ids = new Set();
  const cards = (await everyCard()).map(c => c.card).filter(c => !ids.has(c.id) && ids.add(c.id));
  const seen = await walk.walkTrace({ chromePath: WALK_CHROME, cards });
  const show = JSON.stringify(seen, null, 1);
  assert.equal(seen.length, cards.length, show);
  for (const s of seen) {
    assert.deepEqual(s.shown.options, s.want.options, `${s.kind}: ${show}`);
    assert.equal(s.shown.box, s.want.box, `${s.kind}: ${show}`);
    assert.equal(s.shown.title, s.want.title, `${s.kind}: ${show}`);
  }
  for (const k of gmCard.KINDS) assert.ok(seen.some(s => s.kind === k), `the walk never showed a ${k} card`);
});

test('card contract: a swap from a swap card no longer on screen does nothing, and the one on screen swaps the member it shows', async () => {
  const root = workspace();
  const swaps = [];
  const h = jobDesk(root, {}, { ...TEAM_DEPS, swapFromCard: (r, name, engine, model, scope) => { swaps.push([name, engine, model, scope]); return { line: `${name} now runs on ${engine} ${model}.`, command: 'roster set', changed: true }; } });
  const team = (await h.d.act({ open: 'team' })).body.card;
  const forBuilder = (await h.d.act({ card_id: team.id, option_id: 'swap:builder' })).body.card;
  const back = (await h.d.act({ card_id: forBuilder.id, option_id: 'back' })).body.card;
  const forLauncher = (await h.d.act({ card_id: back.id, option_id: 'swap:launcher' })).body.card;
  assert.equal(forLauncher.title, 'launcher');
  // builder's card answers late: nothing is swapped
  const fast = c => c.options.find(o => o.label === 'atris fast').id;
  const late = await h.d.act({ card_id: forBuilder.id, option_id: fast(forBuilder) });
  assert.deepEqual([late.status, late.body.reason, late.body.card.id], [409, 'gone', forLauncher.id]);
  assert.deepEqual(swaps, []);
  // the card on screen swaps launcher, and the team comes back with one line
  const done = await h.d.act({ card_id: forLauncher.id, option_id: fast(forLauncher) });
  assert.deepEqual(swaps, [['launcher', 'atris', 'fast', 'member']]);
  assert.deepEqual([done.body.card.kind, done.body.card.line], ['team', 'launcher now runs on atris fast.']);
});

test('card contract: every served card speaks lowercase: an idea or job title written with a plain capital starts lowercase, and names stay as written', () => {
  const idea = gmCard.enforce(gmCard.idea({ id: 'b1', title: 'Write the getting started page', body: 'installs last week were 1,400.' }));
  assert.equal(idea.title, 'write the getting started page');
  const api = gmCard.enforce(gmCard.idea({ id: 'b2', title: 'API docs for the phone page', body: 'installs last week were 1,400.' }));
  assert.equal(api.title, 'API docs for the phone page');
  const deck = gmCard.enforce(gmCard.deck({ id: 'deck~1', at: 0, total: 1, columns: ['work', 'member', 'role', 'status'], card: { job_id: 'm1', mission_id: 'm1', member: 'builder', label: 'working', time: 'about 3 hours left', rows: [{ work: 'Write the getting started page', member: 'builder', role: 'writes and tests the code', status: 'working' }] } }));
  assert.equal(deck.title, 'write the getting started page');
  assert.equal(deck.table.rows[0][0], 'write the getting started page');
  const choice = gmCard.enforce(gmCard.choice({ id: 'c1', items: [{ id: 'b1', title: 'Record a demo video', why: 'more people try it.' }] }));
  assert.equal(choice.options[0].label, 'record a demo video');
  // a proper name as the first word stays as written: any capital after the first letter, all caps, or a lowercase start
  const titleOf = t => gmCard.enforce(gmCard.idea({ id: 'b3', title: t, body: 'installs last week were 1,400.' })).title;
  for (const t of ['OpenAI integration for new users', 'GitHub app for the phone page', 'YouTube demo of the orb', 'iPhone home screen icon', 'McKinsey style one pager', 'API docs for the phone page', 'CRM import for small teams']) assert.equal(titleOf(t), t);
  assert.equal(titleOf('Email ten recent installers'), 'email ten recent installers');
  // a name in a choice keeps its capitals too
  const named = gmCard.enforce(gmCard.choice({ id: 'c2', items: [{ id: 'b1', title: 'GitHub app for the phone page', why: 'more people try it.' }, { id: 'b2', title: 'Write the readme', why: 'more people try it.' }] }));
  assert.deepEqual(named.options.filter(o => o.style === 'option').map(o => o.label), ['GitHub app for the phone page', 'write the readme']);
  // member and model names are never changed: in the team table's cells, its buttons, and the cards titled with a name
  const team = gmCard.enforce(gmCard.team({ id: 'team~1', rows: [{ member: 'Sam', role: 'Owner of the roadmap', ovr: '91', engine: 'Claude Opus 5.5', status: 'working', sentence: 'working: the try page' }] }));
  assert.deepEqual(team.table.rows[0].slice(0, 4), ['Sam', 'Owner of the roadmap', '91', 'Claude Opus 5.5']);
  assert.deepEqual(team.options.filter(o => o.cell).map(o => o.label), ['Sam', 'Claude Opus 5.5']);
  assert.equal(gmCard.enforce(gmCard.member({ id: 'member~1', name: 'Sam', sentence: 'idle.' })).title, 'Sam');
  const swap = gmCard.enforce(gmCard.swap({ id: 'swap~9', name: 'Sam', choices: { scopes: [], options: [{ engine: 'one', tool: 'Claude Code', model: 'm', label: 'Opus 5.5', current: false, record: null }] } }));
  assert.deepEqual([swap.title, swap.options[0].label, swap.options[0].detail], ['Sam', 'Opus 5.5', 'Claude Code']);
  // in the deck only the work cell is the job's words; the member cell is a name
  const job = gmCard.enforce(gmCard.deck({ id: 'deck~2', at: 0, total: 1, columns: ['work', 'member', 'role', 'status'], card: { job_id: 'm2', mission_id: 'm2', member: 'Sam', label: 'working', time: 'about 3 hours left', rows: [{ work: 'OpenAI integration for new users', member: 'Sam', role: 'Owner of the roadmap', status: 'working' }] } }));
  assert.deepEqual(job.table.rows[0].slice(0, 2), ['OpenAI integration for new users', 'Sam']);
});

test('card contract: a swap list with no picks opens short too, the model in use first, and more models fills the same card with all of them', () => {
  const list = ['m-a', 'm-b', 'm-c', 'm-d', 'm-e', 'm-f'].map((m, i) => ({ engine: 'one', tool: 'tool one', model: m, label: m, current: i === 4, record: null }));
  const short = gmCard.swap({ id: 'swap~1', name: 'builder', choices: { line: 'builder runs on tool one m-e.', scopes: [], options: list } });
  assert.deepEqual(short.options.map(o => o.label), ['m-e', 'm-a', 'm-b', 'more models', 'back to the team']);
  // a list that would hide only one model shows them all
  const four = gmCard.swap({ id: 'swap~2', name: 'builder', choices: { scopes: [], options: list.slice(0, 4) } });
  assert.ok(!four.options.some(o => o.label === 'more models'));
  const all = gmCard.swap({ id: 'swap~1', name: 'builder', choices: { line: 'builder runs on tool one m-e.', scopes: [], options: list }, all: true });
  assert.deepEqual(all.options.map(o => o.label), ['m-a', 'm-b', 'm-c', 'm-d', 'm-e', 'm-f', 'back to the team']);
  for (const c of [short, all]) assert.deepEqual(gmCard.cardProblems(c), []);
  // a model named for its own tool says it once: codex, not codex over codex
  const own = gmCard.swap({ id: 'swap~3', name: 'builder', choices: { scopes: [], options: [{ engine: 'codex', tool: 'codex', model: '', label: 'codex', current: false, record: null }, { engine: 'codex', tool: 'codex', model: '', label: 'Codex', current: false, record: '1 of 2 finished this week' }, { engine: 'one', tool: 'tool one', model: 'm-a', label: 'm-a', current: false, record: null }] } });
  assert.deepEqual(own.options.slice(0, 3).map(o => o.detail || null), [null, '1 of 2 finished this week', 'tool one']);
});

test('card contract: a card\'s options never change under one id: when the job in the deck changes, the card id changes and a yes on the old id approves nothing', async () => {
  const root = workspace();
  const file = path.join(root, 'gm-bets.jsonl');
  doingRow(file, root, 'b-a', 'm-a', 'Write the launch thread for the phone page');
  doingRow(file, root, 'b-b', 'm-b', 'Record the demo video of the front office');
  const missions = {
    'm-a': { id: 'm-a', owner: 'launcher', status: 'blocked', created_at: new Date(NOW - 60000).toISOString(), human_asks: ['post the thread on x now?'] },
    'm-b': { id: 'm-b', owner: 'builder', status: 'running', created_at: new Date(NOW - 120000).toISOString(), last_tick_at: new Date(NOW - 60000).toISOString(), human_asks: [] },
  };
  const h = jobDesk(root, missions, { ...TEAM_DEPS, decisions: [{ number: 1, mission_id: 'm-a', ask_index: 0 }, { number: 2, mission_id: 'm-b', ask_index: 0 }] });
  h.d.pollJobs();
  const a = (await h.d.act({ open: 'deck' })).body.card;
  assert.equal(a.title, 'post the thread on x now?');
  // job B asks for a yes too and moves ahead of A while the phone shows A
  missions['m-b'] = { ...missions['m-b'], status: 'blocked', updated_at: new Date(NOW).toISOString(), human_asks: ['publish the video now?'] };
  h.d.pollJobs();
  const refreshed = h.d.card().card;
  assert.equal(refreshed.title, 'publish the video now?');
  assert.notEqual(refreshed.id, a.id, 'new options, new card id');
  const old = await h.d.act({ card_id: a.id, option_id: 'yes', confirm: true });
  assert.deepEqual([old.status, old.body.reason], [409, 'gone']);
  assert.equal(h.cli.filter(c => c[0] === 'decide' && c[2] === 'yes').length, 0, 'nothing was approved');
});

test('card contract: more models is a new card with option ids of its own, so a pick from the short list after a lost answer picks nothing', async () => {
  const root = workspace();
  const swaps = [];
  const h = jobDesk(root, {}, { ...TEAM_DEPS, swapFromCard: (r, name, engine, model, scope) => { swaps.push([name, engine, model, scope]); return { line: `${name} now runs on ${engine} ${model}.`, command: 'roster set', changed: true }; } });
  const team = (await h.d.act({ open: 'team' })).body.card;
  const short = (await h.d.act({ card_id: team.id, option_id: 'swap:builder' })).body.card;
  const full = (await h.d.act({ card_id: short.id, option_id: 'more' })).body.card;
  assert.notEqual(full.id, short.id, 'more models is a new card');
  // the same model keeps the same option id on both lists, and no id is reused for another model
  const target = o => `${o.binds.engine}/${o.binds.model}`;
  const pick = c => c.options.filter(o => o.action === 'swap_to' || (o.binds && o.binds.engine));
  for (const o of pick(short)) assert.equal(target(full.options.find(x => x.id === o.id)), target(o));
  // the page lost the answer and still shows the short list: its pick names the old card and does nothing
  const lost = await h.d.act({ card_id: short.id, option_id: pick(short)[0].id });
  assert.deepEqual([lost.status, lost.body.reason], [409, 'gone']);
  assert.deepEqual(swaps, []);
});

// ---- the swarm: three writers at once, the first that passes wins -------------------------

// A writer stub whose calls wait until the test answers them, and end at
// once when the swarm stops them, the way the real model call does.
function heldWriters() {
  const calls = [];
  const run = (prompt, opts) => new Promise((resolve) => {
    const c = { prompt, opts, stopped: false, answer: text => resolve({ ok: true, text }) };
    calls.push(c);
    opts.signal.addEventListener('abort', () => { c.stopped = true; resolve({ ok: false, reason: 'stopped: another idea was picked first', stopped: true }); });
  });
  return { calls, run };
}

const until = async (cond, n = 50) => { for (let i = 0; i < n && !cond(); i += 1) await tick(); };

test('swarm: three writers start at once, each judged as it lands; the first that passes wins and every other call is stopped', async () => {
  const root = workspace();
  const attemptsFile = path.join(root, 'attempts.jsonl');
  const writers = heldWriters();
  const skeptics = heldWriters();
  const events = [];
  const started = Date.now();
  const pending = gmBet.generateBet({ workspaceRoot: root, today: TODAY, ledgerFile: path.join(root, 'bets.jsonl'), attemptsFile, emit: e => events.push(e), deps: { ...fixtureDeps, runModel: writers.run, runSkeptic: skeptics.run } });
  await until(() => writers.calls.length === 3);
  assert.equal(writers.calls.length, 3, 'three writers at once, none waiting on another');
  // each leans a different way, so the drafts differ
  for (const a of gmBet.WRITER_ANGLES) assert.equal(writers.calls.filter(c => c.prompt.includes(a.text)).length, 1, a.key);
  // the first draft lands and goes to its own skeptic while the others keep writing
  writers.calls[0].answer(JSON.stringify(goodBet({ title: TITLES[0] })));
  await until(() => skeptics.calls.length === 1);
  assert.equal(skeptics.calls.length, 1);
  assert.equal(writers.calls.length, 3);
  // the third lands and its skeptic passes it before the first skeptic answers: it is the idea
  writers.calls[2].answer(JSON.stringify(goodBet({ title: TITLES[3] })));
  await until(() => skeptics.calls.length === 2);
  skeptics.calls[1].answer(PASS);
  const out = await pending;
  assert.deepEqual([out.ok, out.checked, out.lane, out.bet.title], [true, true, 3, TITLES[3]]);
  assert.deepEqual(out.bet.skeptic, JSON.parse(PASS));
  // the second writer and the first skeptic were still running: both were stopped, and nothing new started
  assert.deepEqual(writers.calls.map(c => c.stopped), [false, true, false]);
  assert.deepEqual(skeptics.calls.map(c => c.stopped), [true, false]);
  assert.equal(writers.calls.length + skeptics.calls.length, 5);
  assert.ok(Date.now() - started < 5000);
  // the judge is never the writer: the skeptic prompt never went to a writer
  assert.ok(writers.calls.every(c => /^You are the strategist/.test(c.prompt) && !/skeptical cofounder/.test(c.prompt)));
  assert.ok(skeptics.calls.every(c => /^You are a skeptical cofounder/.test(c.prompt)));
  // what the waiting card says, in plain words with none of our own
  const said = events.filter(e => e.say).map(e => e.say);
  assert.deepEqual(said, ['drafting three ideas at once', 'the first draft is in. checking it', 'the second draft is in. checking it', 'found one that holds up']);
  for (const line of said) assert.doesNotMatch(line, gmBet.OWNER_BANNED);
  // every call is in the attempts log with its lane, the stopped ones too
  const rows = fs.readFileSync(attemptsFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(rows.filter(r => r.stopped).map(r => [r.kind, r.lane]).sort(), [['skeptic', 1], ['writer', 2]]);
  assert.deepEqual(rows.filter(r => r.kind === 'skeptic' && r.passed).map(r => r.lane), [3]);
});

test('swarm: a stop from the desk ends every call at once and gives no idea', async () => {
  const root = workspace();
  const writers = heldWriters();
  const stop = new AbortController();
  const pending = gmBet.generateBet({ workspaceRoot: root, today: TODAY, ledgerFile: path.join(root, 'bets.jsonl'), signal: stop.signal, deps: { ...fixtureDeps, runModel: writers.run } });
  await until(() => writers.calls.length === 3);
  stop.abort();
  const out = await pending;
  assert.deepEqual([out.ok, out.stopped], [false, true]);
  assert.deepEqual(writers.calls.map(c => c.stopped), [true, true, true]);
});

test('swarm: nothing passes inside the budget: the best draft so far is the card with the worry in one plain line, and every call is stopped', async () => {
  const root = workspace();
  const writers = heldWriters();
  const fail = { verdict: 'fail', doable: true, moves_metric: true, missing_first: 'nothing', reason: 'two posts may reach few people. add a third channel.', concern: 'two posts may reach few people' };
  const started = Date.now();
  const events = [];
  const pending = gmBet.generateBet({
    workspaceRoot: root, today: TODAY, ledgerFile: path.join(root, 'bets.jsonl'), budgetMs: 1500, emit: e => events.push(e),
    deps: { ...fixtureDeps, runModel: writers.run, runSkeptic: async () => ({ ok: true, text: JSON.stringify(fail) }) },
  });
  await until(() => writers.calls.length === 3);
  // one draft lands at once and is turned down; its writer tries again, and the other two never answer
  writers.calls[0].answer(JSON.stringify(goodBet()));
  const out = await pending;
  const took = Date.now() - started;
  assert.ok(took >= 1400 && took < 4000, `ended on the budget, ${took} ms`);
  assert.deepEqual([out.ok, out.checked, out.bet.title], [true, false, goodBet().title]);
  assert.equal(out.bet.concern, 'one worry: two posts may reach few people.');
  assert.deepEqual(out.bet.skeptic, fail);
  assert.ok(writers.calls.length >= 4, 'the turned-down writer tried again in the time left');
  assert.ok(writers.calls.filter((c, i) => i !== 0).every(c => c.stopped), 'every writer still going was stopped');
  assert.equal(events.filter(e => e.say).pop().say, 'out of time. bringing the best one so far');
  // a draft whose second look is still out when time runs out is shown not double-checked
  const late = heldWriters();
  const looks = heldWriters();
  const lateRun = gmBet.generateBet({ workspaceRoot: root, today: TODAY, ledgerFile: path.join(root, 'bets.jsonl'), budgetMs: 400, deps: { ...fixtureDeps, runModel: late.run, runSkeptic: looks.run } });
  await until(() => late.calls.length === 3);
  late.calls[1].answer(JSON.stringify(goodBet()));
  const unchecked = await lateRun;
  assert.deepEqual([unchecked.ok, unchecked.checked, unchecked.bet.concern, unchecked.bet.skeptic], [true, false, 'not double-checked yet: it came in as time ran out.', null]);
  assert.deepEqual(looks.calls.map(c => c.stopped), [true], 'the look still out was stopped');
});

test('swarm: when every lane is turned down, the draft with the smallest worry is the card', async () => {
  const root = workspace();
  // lane 1 does not move the number, lane 2 only has a small doubt, lane 3 is blocked
  const verdicts = {
    reach: { verdict: 'fail', doable: true, moves_metric: false, missing_first: 'nothing', reason: 'nobody outside sees it.' },
    first_hour: { verdict: 'fail', doable: true, moves_metric: true, missing_first: 'nothing', reason: 'it is a small step for a week.', concern: 'it is a small step for a week' },
    proof: { verdict: 'fail', doable: true, moves_metric: true, missing_first: 'a public build', reason: 'the demo shows what nobody can install.' },
  };
  const angleOf = p => gmBet.WRITER_ANGLES.find(a => p.includes(a.text)).key;
  const titles = { reach: TITLES[0], first_hour: TITLES[3], proof: TITLES[5] };
  const out = await gmBet.generateBet({
    workspaceRoot: root, today: TODAY, ledgerFile: path.join(root, 'bets.jsonl'),
    deps: {
      ...fixtureDeps,
      runModel: async p => ({ ok: true, text: JSON.stringify(goodBet({ title: titles[angleOf(p)] })) }),
      runSkeptic: async p => ({ ok: true, text: JSON.stringify(verdicts[Object.keys(titles).find(k => p.includes(titles[k]))]) }),
    },
  });
  assert.deepEqual([out.ok, out.checked, out.bet.title, out.bet.concern], [true, false, TITLES[3], 'one worry: it is a small step for a week.']);
});

test('skeptic bar: the team is judged on what it controls and can check; the idea must push the number the right way, not reach the goal', async () => {
  const { bundle } = await bundleFor(workspace());
  const bet = { ...goodBet(), check_date: '2026-10-30' };
  const p = gmBet.buildSkepticPrompt(bet, bundle, { today: TODAY });
  assert.match(p, /The team is judged only on what it controls and can check\./);
  assert.match(p, /- doable: is every team step work the team can do on its own this week, and check once it is done/);
  assert.match(p, /would it plausibly push the target number the right way this week/);
  assert.match(p, /it does not have to reach target\.goal; the goal is the hope, not the bar, so never fail it only because the goal is ambitious\./);
  assert.match(p, /verdict is "pass" when doable and moves_metric are both true/);
  // the old bar, from the baseline all the way to the goal, is gone
  assert.doesNotMatch(p, /from the baseline to the goal/);
  // the worry the owner reads is asked for in plain words, without our own
  assert.match(p, /concern: when it fails, the worry in one plain everyday line under 120 characters for the owner/);
  assert.ok(p.includes(`never these words: ${['bet', 'bets', 'check date'].join(', ')}`));
  // a pass needs a yes on moving the number and never a no on doable; doable left out still counts
  const v = o => gmBet.parseVerdict(JSON.stringify({ verdict: 'pass', missing_first: 'nothing', moves_metric: true, reason: 'fine.', ...o })).verdict;
  assert.deepEqual(v({ doable: false, concern: 'one step waits on strangers' }), { verdict: 'pass', moves_metric: true, missing_first: 'nothing', reason: 'fine.', doable: false, concern: 'one step waits on strangers' });
  assert.equal(v({}).doable, undefined);
  // the writer and the skeptic are separate calls, each thinking briefly
  assert.deepEqual(gmBet.writerCommand().args('w').slice(0, 4), ['-p', 'w', '--model', 'opus']);
  assert.deepEqual(gmBet.writerCommand().args('w').slice(-2), ['--effort', 'low']);
  assert.notEqual(gmBet.writerCommand().args, gmBet.skepticCommand().args);
});

test('model: a stop ends the whole process group at once, so no child of the model is left running', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-bet-stop-'));
  const pidFile = path.join(dir, 'child.pid');
  const bin = stubScript(dir, 'busy', `
const { spawn } = require('child_process');
const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(kid.pid));
setInterval(() => {}, 1000);
`);
  const stop = new AbortController();
  const started = Date.now();
  const pending = gmBet.runModel('x', { command: { bin, args: [] }, timeoutMs: 60000, signal: stop.signal });
  for (let i = 0; i < 100 && !fs.existsSync(pidFile); i += 1) await new Promise(r => setTimeout(r, 50));
  const kid = Number(fs.readFileSync(pidFile, 'utf8'));
  stop.abort();
  const res = await pending;
  assert.deepEqual(res, { ok: false, reason: 'stopped: another idea was picked first', stopped: true });
  assert.ok(Date.now() - started < 10000);
  let alive = true;
  for (let i = 0; i < 40 && alive; i += 1) {
    try { process.kill(kid, 0); await new Promise(r => setTimeout(r, 50)); } catch { alive = false; }
  }
  assert.equal(alive, false, 'the grandchild in the same group is gone');
  // past the grace the group's SIGKILL has gone out, and it is no longer counted
  await new Promise(r => setTimeout(r, 1700));
  assert.equal(gmBet.stopWriters(), 0, 'and it is no longer counted as running');
  // a signal already stopped never starts the model
  let spawned = 0;
  const early = new AbortController();
  early.abort();
  assert.equal((await gmBet.runModel('x', { signal: early.signal, spawnFn: () => { spawned += 1; } })).stopped, true);
  assert.equal(spawned, 0);
});

// ---- the desk: one idea prepared ahead, and the waiting card ---------------------------

test('prepared ahead: the next idea is drafted while the owner reads a card, never moves the screen, and the next tap shows it at once', async () => {
  const h = desk(workspace(), { answered: true });
  h.d.warm();
  await h.gen.releaseOne();
  const first = h.d.next();
  assert.deepEqual([first.kind, first.bet.title], ['bet', TITLES[0]]);
  // one drafting runs behind the card, never two
  assert.equal(h.d.state.inFlight, 1);
  await h.gen.releaseOne();
  // it landed behind the card: the screen did not change
  assert.deepEqual([h.d.view().id, h.d.view().bet.title, h.d.view().queue], [first.id, TITLES[0], 1]);
  assert.equal(h.gen.maxActive, 1);
  // the next tap is instant: the prepared idea, not a wait
  const second = h.d.next();
  assert.deepEqual([second.kind, second.bet.title], ['bet', TITLES[1]]);
});

test('prepared ahead: one written before the owner\'s newest answer, or too close to one he already saw, is never shown, and the drafting under way starts over', async () => {
  const root = workspace();
  const h = await filled(root, { answered: true });
  assert.equal(h.d.next().bet.title, TITLES[0]);
  // the next one is being drafted behind the card
  const running = h.gen.calls[3];
  assert.equal(running.signal.aborted, false);
  // he answers a question: what is ready was written without that answer
  fs.appendFileSync(gmBet.focusPath(path.dirname(h.ledgerFile)), `${JSON.stringify({ workspace: root, key: 'who', answer: 'own', label: 'small schools', ask: 'who is it for?', at: new Date(NOW).toISOString() })}\n`);
  const tap = h.d.next();
  assert.equal(tap.kind, 'wait', 'nothing ready knows his answer');
  assert.deepEqual(h.ledger().filter(r => r.status === 'stale').map(r => r.stale_reason), Array(2).fill('written before the owner\'s newest answer'));
  assert.equal(running.signal.aborted, true, 'the drafting that began before the answer was stopped');
  // a fresh idea too close to one he already turned down is dropped too
  const root2 = workspace();
  const h2 = await filled(root2, { answered: true });
  ledgerRow(h2.ledgerFile, root2, 'seen-before', { status: 'passed', bet: goodBet({ title: 'Record a two minute demo video of the phone front office for the website' }) });
  const shown = h2.d.next();
  assert.equal(shown.bet.title, TITLES[0]);
  assert.deepEqual(h2.d.state.queue.map(i => i.bet.title), [TITLES[2]]);
  assert.match(h2.ledger().find(r => r.bet && r.bet.title === TITLES[1]).stale_reason, /^too close to one already shown: Record a two minute demo video/);
});

test('waiting card: it carries the drafting\'s plain lines and when it began, and keeps its id while they change', async () => {
  let gate;
  let emit;
  const h = desk(workspace(), { answered: true, generate: (opts) => { emit = opts.emit; emit({ kind: 'swarm', line: '3 writers at once', say: 'drafting three ideas at once' }); return new Promise((r) => { gate = r; }); } });
  const tap = h.d.next();
  assert.equal(tap.kind, 'wait');
  const one = h.d.card().card;
  assert.equal(one.kind, 'wait');
  assert.deepEqual(one.progress, [{ at: NOW, line: 'drafting three ideas at once' }]);
  assert.deepEqual([one.started_at, one.waited_ms, one.watch], [NOW, 0, true]);
  h.tick(6000);
  emit({ kind: 'skeptic', line: 'a second model is checking that it makes sense', say: 'the first draft is in. checking it' });
  const two = h.d.card().card;
  assert.equal(two.id, one.id, 'new lines, same card');
  assert.deepEqual(two.progress.map(p => p.line), ['drafting three ideas at once', 'the first draft is in. checking it']);
  assert.deepEqual([two.started_at, two.waited_ms], [NOW, 6000]);
  // the lines the swarm writes are plain words, with none of our own
  for (const p of two.progress) assert.deepEqual(gmCard.cardProblems({ ...two, progress: [p] }), []);
  // the idea lands: it waits for the page to ask, the way it always did
  gate({ ok: true, bet: { ...goodBet(), check_date: '2026-10-30' } });
  await tick();
  assert.deepEqual([h.d.view().kind, h.d.view().queue], ['wait', 1]);
});

test('waiting card: words said on it start a drafting with them at once, stopping the one under way', async () => {
  const h = desk(workspace(), { answered: true });
  h.d.next();
  assert.equal(h.gen.calls.length, 1);
  const out = await h.d.say({ text: 'make it about small schools' });
  assert.equal(out.ok, true);
  assert.equal(h.gen.calls[0].signal.aborted, true, 'the background drafting was stopped');
  await h.gen.releaseOne();
  // its idea is dropped, and the drafting with his words is the one running now
  assert.equal(h.d.view().queue, 0);
  assert.equal(h.gen.calls.length, 2);
  assert.equal(h.gen.calls[1].ownerNote, 'make it about small schools');
  await h.gen.releaseOne();
  assert.equal(h.d.next().bet.title, TITLES[1]);
});

test('prepared ahead: a rework of the idea the owner wrote a note on may stay close to it, and it is the next card', async () => {
  let n = 0;
  const REWORK = 'Write a getting started page for atris gm phone with a 30 second screen recording for schools';
  const h = desk(workspace(), { answered: true, generate: async opts => ({ ok: true, bet: { ...goodBet({ title: opts.ownerNote ? REWORK : TITLES[n++ % TITLES.length] }), check_date: '2026-10-30' } }) });
  h.d.next();
  for (let i = 0; i < 10; i += 1) await tick();
  const first = h.d.next();
  assert.equal(first.bet.title, TITLES[0]);
  const said = await h.d.say({ text: 'make it for schools' });
  assert.equal(said.ok, true);
  for (let i = 0; i < 10; i += 1) await tick();
  const next = h.d.next();
  assert.equal(next.bet.title, REWORK, 'close to the idea it reworks, and still shown');
  assert.equal(h.ledger().filter(r => r.status === 'stale').length, 0);
});

// ---- review fixes: a child that ignores SIGTERM, words typed as a wait ends, slow facts ----

test('model: a child that ignores SIGTERM and has its own stdio is still killed after the grace, though the model already exited', { skip: process.platform === 'win32', timeout: 20000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-bet-stubborn-'));
  const pidFile = path.join(dir, 'kid.pid');
  // the kid ignores SIGTERM, keeps no pipe to the model, and says it is ready only once it does
  const kidCode = `process.on('SIGTERM', () => {}); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
  const bin = stubScript(dir, 'parent', `
const { spawn } = require('child_process');
spawn(process.execPath, ['-e', ${JSON.stringify(kidCode)}], { stdio: 'ignore' });
setInterval(() => {}, 1000);
`);
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const readKid = () => { try { return Number(fs.readFileSync(pidFile, 'utf8')) || null; } catch { return null; } };
  const stop = new AbortController();
  const pending = gmBet.runModel('x', { command: { bin, args: [] }, timeoutMs: 60000, signal: stop.signal });
  let kid = null;
  try {
    for (let i = 0; i < 200 && !readKid(); i += 1) await new Promise(r => setTimeout(r, 25));
    kid = readKid();
    assert.ok(kid, 'the kid started');
    stop.abort();
    const res = await pending;
    assert.equal(res.stopped, true);
    // the model is gone and the call is over, and the kid that ignored SIGTERM is still up
    assert.equal(alive(kid), true, 'the kid outlived the SIGTERM');
    // until the group's SIGKILL after the grace
    let gone = false;
    for (let i = 0; i < 80 && !gone; i += 1) { await new Promise(r => setTimeout(r, 50)); gone = !alive(kid); }
    assert.equal(gone, true, 'the kid is gone after the grace');
  } finally {
    // a failed check never leaves the model or the kid behind
    stop.abort();
    await pending;
    kid = kid || readKid();
    if (kid && alive(kid)) process.kill(kid, 'SIGKILL');
  }
});

test('waiting card: words typed while the wait ends with nothing are never dropped; the next drafting is written with them', async () => {
  // the drafting under way would fail; his words on the calm line are a note, taken at once
  // with no read, and that drafting is stopped for them, so the wait never ends with nothing
  const gen = stubGenerator({ fail: n => n === 0 });
  const reads = [];
  const h = desk(workspace(), { gen, answered: true, readSaid: async (p) => { reads.push(p); return { ok: true, kind: 'instruction', reply: '' }; } });
  const wait = (await h.d.act({ orb: true })).body.card;
  assert.equal(wait.kind, 'wait');
  const out = await h.d.act({ card_id: wait.id, text: 'make it about small schools' });
  assert.deepEqual([out.status, out.body.ok, out.body.card.kind], [200, true, 'wait'], JSON.stringify(out.body));
  assert.equal(reads.length, 0);
  await gen.releaseOne();
  assert.equal(h.d.view().kind, 'wait', 'the stopped drafting ends as stopped, not as nothing');
  assert.equal(gen.calls[gen.calls.length - 1].ownerNote, 'make it about small schools');
  // the wait ended before he sent, and the page had looked again: the words still count
  const gen2 = stubGenerator({ fail: n => n === 0 });
  const h2 = desk(workspace(), { gen: gen2, answered: true });
  const wait2 = (await h2.d.act({ orb: true })).body.card;
  await gen2.releaseOne();
  assert.equal(h2.d.card().card.kind, 'missed');
  // a tap on an option named by the old card is still refused: only words carry over
  assert.equal((await h2.d.act({ card_id: wait2.id, option_id: 'again' })).body.reason, 'gone');
  const late = await h2.d.act({ card_id: wait2.id, text: 'something for teachers' });
  assert.deepEqual([late.status, late.body.ok], [200, true], JSON.stringify(late.body));
  await gen2.releaseOne();
  assert.equal(gen2.calls[gen2.calls.length - 1].ownerNote, 'something for teachers');
});

test('swarm: the budget covers reading the facts: slow scoring and a slow npm read are left out, and the writers still get their time', async () => {
  const root = workspace();
  const started = Date.now();
  let wroteAt = null;
  const events = [];
  const out = await gmBet.generateBet({
    workspaceRoot: root, today: TODAY, ledgerFile: path.join(root, 'bets.jsonl'), budgetMs: 2000, writers: 1, emit: e => events.push(e),
    deps: {
      ...fixtureDeps,
      // four overdue bets at ten seconds each, never done inside the budget
      scoreBets: () => new Promise(r => setTimeout(r, 40000).unref()),
      fetchJson: async url => (url.startsWith('https://registry.npmjs.org/') ? new Promise(() => {}) : npmBody()),
      runModel: async () => { wroteAt = Date.now() - started; return { ok: true, text: JSON.stringify(goodBet()) }; },
    },
  });
  const took = Date.now() - started;
  assert.deepEqual([out.ok, out.checked], [true, true], out.reason);
  // the facts get the first quarter of the budget, 500 ms here, and the writer starts right after
  assert.ok(wroteAt >= 450 && wroteAt < 1200, `the writer started at ${wroteAt} ms`);
  assert.ok(took < 2000, `done inside the budget, ${took} ms`);
  assert.ok(events.some(e => e.kind === 'skip' && e.key === 'score'));
  assert.ok(events.some(e => e.kind === 'skip' && e.key === 'release'));
  // a stop while the facts are read ends it at once, and no writer starts
  let wrote = 0;
  const stop = new AbortController();
  const t0 = Date.now();
  const pending = gmBet.generateBet({ workspaceRoot: root, today: TODAY, ledgerFile: path.join(root, 'bets.jsonl'), signal: stop.signal, deps: { ...fixtureDeps, scoreBets: () => new Promise(() => {}), runModel: async () => { wrote += 1; return { ok: false, reason: 'x' }; } } });
  setTimeout(() => stop.abort(), 50);
  const stopped = await pending;
  assert.deepEqual([stopped.ok, stopped.stopped, wrote], [false, true, 0]);
  assert.ok(Date.now() - t0 < 1000, 'it did not wait for the facts');
  // the budget is spent while the facts are read (the read blocks): no writer starts
  let late = 0;
  const spent = await gmBet.generateBet({
    workspaceRoot: root, today: TODAY, ledgerFile: path.join(root, 'bets.jsonl'), budgetMs: 300,
    deps: { ...fixtureDeps, gitLanded: () => { const end = Date.now() + 450; while (Date.now() < end) { /* a slow git read */ } return ['x']; }, runModel: async () => { late += 1; return { ok: true, text: JSON.stringify(goodBet()) }; } },
  });
  assert.equal(spent.ok, false);
  assert.equal(late, 0, 'no writer starts once the budget is spent');
  assert.match(spent.reason, /no time was left to draft inside 0 seconds|nothing usable came back/);
});

test('swarm: a stop while the facts are read leaves no timer behind, so the process exits at once', { timeout: 20000 }, async () => {
  const root = workspace();
  const script = `
    const gmBet = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'gm-bet.js'))});
    const stop = new AbortController();
    const t0 = Date.now();
    gmBet.generateBet({
      workspaceRoot: ${JSON.stringify(root)}, today: '2026-10-21', ledgerFile: ${JSON.stringify(path.join(root, 'bets.jsonl'))}, signal: stop.signal,
      deps: { readNow: () => null, seasonFacts: () => null, gitLanded: () => null, packageName: null, readBriefs: () => null, scoreBets: () => new Promise(() => {}), runModel: async () => ({ ok: false, reason: 'never asked' }) },
    }).then((out) => { process.stdout.write(JSON.stringify({ stopped: out.stopped, returned: Date.now() - t0 })); });
    setTimeout(() => stop.abort(), 50);
  `;
  const started = Date.now();
  const res = require('node:child_process').spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 15000, env: { ...process.env, HOME } });
  const lived = Date.now() - started;
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.stopped, true);
  assert.ok(out.returned < 1000, `returned after ${out.returned} ms`);
  // the source deadline is 7.5 seconds into a 30 second budget; nothing waits for it
  assert.ok(lived < 4000, `the process lived ${lived} ms after a stop at 50 ms`);
});
