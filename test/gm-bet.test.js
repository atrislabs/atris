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
    workspaceRoot: root, today: TODAY, ledgerFile: path.join(root, 'bets.jsonl'), attemptsFile, emit: e => events.push(e),
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
    workspaceRoot: root, today: TODAY, ledgerFile: path.join(root, 'bets.jsonl'), attemptsFile,
    deps: {
      ...fixtureDeps,
      runModel: async (prompt) => { prompts.push(prompt); return { ok: true, text: JSON.stringify(answers[prompts.length - 1]) }; },
      runSkeptic: async () => ({ ok: true, text: JSON.stringify(verdicts.shift()) }),
    },
  });
  assert.equal(out.ok, false);
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
    workspaceRoot: root, today: TODAY, ledgerFile: path.join(root, 'bets.jsonl'),
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
    workspaceRoot: root, today: TODAY, ledgerFile: path.join(root, 'bets.jsonl'), attemptsFile, emit: e => events.push(e),
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
    workspaceRoot: root, today: TODAY, ledgerFile: path.join(root, 'bets.jsonl'), attemptsFile,
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
    workspaceRoot: root, today: TODAY, ledgerFile: path.join(root, 'bets.jsonl'),
    deps: { ...fixtureDeps, runModel: async (prompt) => { mixed.push(prompt); return { ok: true, text: JSON.stringify(mixed.length === 1 ? { ...long, check_in_days: 3 } : goodBet()) }; } },
  });
  assert.doesNotMatch(mixed[1], /broke only these length or sentence limits/);
  assert.match(mixed[1], /Your last answer was rejected: .*check_in_days must be a whole number from 7 to 14, got 3/);
});

test('skeptic: two fails end honestly; pass without moving the number is a fail; a broken skeptic stops the bet', async () => {
  const root = workspace();
  const run = runSkeptic => gmBet.generateBet({ workspaceRoot: root, today: TODAY, ledgerFile: path.join(root, 'bets.jsonl'), deps: { ...fixtureDeps, runModel: async () => ({ ok: true, text: JSON.stringify(goodBet()) }), runSkeptic } });
  const twice = await run(async () => ({ ok: true, text: JSON.stringify({ verdict: 'fail', missing_first: 'nothing', moves_metric: true, reason: 'a page alone reaches nobody new.' }) }));
  assert.equal(twice.ok, false);
  assert.match(twice.reason, /turned down 3 times \(a skeptic turned it down: a page alone reaches nobody new\. if the missing piece/);
  let calls = 0;
  const contradicts = await run(async () => { calls += 1; return { ok: true, text: JSON.stringify({ verdict: 'pass', missing_first: '', moves_metric: false, reason: 'fine, though it reaches nobody.' }) }; });
  assert.equal(contradicts.ok, false, 'a pass that does not move the number does not ship');
  assert.equal(calls, 3, 'three writer answers, each judged');
  const down = await run(async () => ({ ok: false, reason: 'the model took longer than 120 seconds and was stopped' }));
  assert.deepEqual([down.ok, down.reason], [false, 'the skeptic could not check the bet: the model took longer than 120 seconds and was stopped']);
  const garbled = await run(async () => ({ ok: true, text: '{"verdict": "maybe"}' }));
  assert.deepEqual([garbled.ok, garbled.reason], [false, 'the skeptic could not check the bet: the skeptic gave no pass or fail verdict']);
  assert.deepEqual(gmBet.parseVerdict('nope'), { error: "the skeptic's answer: the answer was not JSON" });
  // the real skeptic is its own claude -p call on the subscription path
  const args = gmBet.skepticCommand().args('judge this');
  assert.deepEqual(args.slice(0, 4), ['-p', 'judge this', '--model', 'opus']);
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
    deps: { ...fixtureDeps, runModel: async (prompt) => { prompts.push(prompt); return { ok: true, text: bad }; } },
  });
  assert.equal(out.ok, false);
  assert.equal(prompts.length, 3);
  assert.doesNotMatch(prompts[0], /was rejected/);
  assert.match(prompts[1], /Your last answer was rejected: .*vague verb "optimize"/);
  assert.match(out.reason, /turned down 3 times/);
  assert.match(prompts[2], /Your last answer was rejected: .*vague verb "optimize"/);
  assert.deepEqual(events.slice(SOURCE_KEYS.length).map(e => e.kind), ['model', 'reject', 'model', 'reject', 'model', 'reject']);
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
        onProgress({ thinking: 300, chars: 0, text: '' });
        onProgress({ thinking: 300, chars: 40, text: '{"title": "write the page' });
        return { ok: true, text: retry ? `\`\`\`json\n${JSON.stringify(goodBet())}\n\`\`\`` : 'not json at all' };
      },
    },
  });
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.attempts, 2);
  assert.equal(out.bet.title, goodBet().title);
  assert.deepEqual(events.map(e => e.kind), [...SOURCE_KEYS.map(() => 'source'), 'model', 'thinking', 'thinking', 'reject', 'model', 'thinking', 'thinking', 'skeptic', 'check']);
  assert.equal(events[SOURCE_KEYS.length].line, 'asking the model for one bet');
  assert.equal(events[SOURCE_KEYS.length + 1].line, 'thinking...');
  assert.equal(events[SOURCE_KEYS.length + 2].line, 'thinking... 4 words written');
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
  said.push(f.d.skip().ack, f.d.skip().message);
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
    workspaceRoot: root, today: TODAY, ledgerFile: path.join(root, 'bets.jsonl'), attemptsFile: path.join(root, 'a.jsonl'),
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
  h.d.next();
  assert.deepEqual(h.d.answer({ choice: 'nope' }), { ok: false, reason: 'bad_choice', message: 'that is not one of the answers' });
  assert.equal(h.d.answer({ choice: 'money' }).ok, true);
  assert.deepEqual(h.d.answer({ choice: 'money' }), { ok: false, reason: 'gone', message: 'there is no question on screen' });
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

test('desk: a failed writer never reaches the screen', async () => {
  const gen = stubGenerator({ fail: () => true });
  const h = desk(workspace(), { gen, answered: true });
  h.d.next();
  await gen.releaseOne();
  const v = h.d.view();
  assert.deepEqual([v.status, v.kind, v.error, v.events], ['ready', 'wait', null, []]);
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
  assert.deepEqual(h.d.pick({ id: 'nope' }), { ok: false, reason: 'gone', message: 'there is nothing to pick on screen' });
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
  // on the plain card: the next idea fits it
  assert.equal(q.d.next().kind, 'wait');
  assert.deepEqual(await q.d.say({ text: 'something for schools' }), { ok: true, ack: 'got it. the next idea will fit that.' });
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
  assert.deepEqual(await h.d.steer({ member: 'launcher', text: 'draft the thread' }), { ok: false, reason: 'needs_confirm', message: 'tap again to start launcher on this' });
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
  assert.deepEqual(await pending, { ok: false, reason: 'gone', message: 'that card changed, so nothing was done' });
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
    { member: 'navigator', on: 'Plan the pricing page', status: 'waiting for your yes', time: 'waiting 2 hours' },
    { member: 'builder', on: 'Launch a try page for any public repo', status: 'working', time: 'about 4 hours left' },
    { member: 'launcher', on: 'Write the launch thread', status: 'working', time: 'at it for 1 hour' },
    { member: 'executor', on: 'Split the big test file', status: 'waiting to start', time: 'waiting 10 minutes' },
    { member: 'linguist', on: 'Rewrite the page in plain words', status: 'waiting to start', time: 'waiting 15 minutes' },
    { member: 'researcher', on: 'Survey ten agent teams about pricing', status: 'stopped', time: 'stopped 30 minutes ago' },
    { member: 'validator', on: 'Check the two reports', status: 'done', time: 'finished 1 hour ago' },
    // nothing in the last day: still on the team, idle, with no work to name
    { member: 'scout', on: '', status: 'idle', time: '' },
  ]);
  assert.equal(rows.find(r => r.member === 'navigator').sentence, 'waiting for your yes: plan the pricing page, waiting 2 hours');
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
  assert.deepEqual(needs.yes, { key: 'm-ask:0', what: 'ok to publish this package to npm under the next tag?', why: 'navigator is waiting on your yes for this.' });
  assert.equal(working.yes, undefined, 'only a card that needs you has a yes');
  // plain words in every cell: the path and the command are gone, the meaning stays
  assert.equal(needs.rows[0].work, 'Fix a file so the run passes');
  assert.deepEqual([needs.rows[0].done, working.rows[0].done], ['not yet', 'not yet']);
  for (const c of h.d.jobDeck().cards) assert.doesNotMatch(JSON.stringify([c.rows, c.yes || null]), CODE_TELL);
  // the main screen shows something else: a yes from the deck leaves it alone
  const before = h.d.view().status;
  // a yes names its job and its key, both
  assert.equal((await h.d.answerYes({ key: 'm-ask:0' })).reason, 'gone');
  assert.deepEqual(await h.d.answerYes({ key: 'm-ask:0', job: 'm-ask' }), { ok: true, ack: 'navigator: got your yes' });
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
  assert.deepEqual(h.d.jobDeck().cards.map(c => [c.job_id, c.yes && c.yes.key]), [['new', undefined], ['old', 'old:0']]);
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
  assert.deepEqual(first.job, { what: 'post the thread on x now?', why: 'launcher is waiting on your yes for this. 300 more npm installs in the week before nov 1.' });
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
  assert.deepEqual([yes.ok, yes.ack], [true, 'launcher: got your yes']);
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
  assert.deepEqual([yes.ok, yes.ack], [true, 'builder: got your yes']);
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
  assert.match(html, /<button type="button" class="quiet" id="working" aria-haspopup="dialog">the team<\/button>/);
  assert.match(html, /btn\.textContent = n \? n \+ ' working' : 'the team';/);
  // no pulse or loop on the new pieces
  const css = html.slice(html.indexOf('.quiet {'), html.indexOf('.team .row'));
  assert.ok(css.length > 40);
  assert.doesNotMatch(css, /animation|transition/);
  // after do it, the ack holds 1.5 s and the orb plays into the next card the re-tap way
  assert.match(html, /var AFTER_MS = 1500;/);
  // a start that did not get going returns first, so only a real start moves on
  assert.match(html, /if \(!r \|\| !r\.ok\) \{/);
  assert.match(html, /loadBet\(\); refresh\(\);\n\s+setTimeout\(function \(\) \{ tapOrb\(false\); \}, AFTER_MS\);/);
  // job cards: two big sentences from the server; a yes button or a nice, never a send back
  // job cards: the why shows when there is one; the calm line has none
  assert.match(html, /box\.appendChild\(el\('h1', null, j\.what\)\);\n {4}if \(j\.why\) box\.appendChild\(el\('p', 'why', j\.why\)\);/);
  assert.match(html, /var ok = el\('button', 'pill', 'nice'\);/);
  assert.doesNotMatch(html, /sendback|send back/);
  assert.match(html, /if \(\(s\.bet \|\| s\.job \|\| s\.question \|\| s\.choice \|\| s\.report\) && \(s\.status === 'ready'/);
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
    const opened = await call('GET', '/bet');
    assert.equal(opened.json.status, 'idle');
    assert.equal(gen.calls.length, 1, 'opening the page starts the prefetch');
    for (let i = 0; i < 3; i += 1) await gen.releaseOne();
    const tapped = await call('POST', '/bet/think', {});
    assert.equal(tapped.status, 200);
    assert.equal(tapped.json.status, 'ready');
    assert.equal(tapped.json.bet.steps.length, 3);
    const once = await call('POST', '/bet/do', {});
    assert.equal(once.status, 409);
    assert.equal(once.json.reason, 'needs_confirm');
    // a yes and a send back also start or unblock agents, so they need a second tap too
    assert.equal((await call('POST', '/bet/yes', {})).json.reason, 'needs_confirm');
    assert.equal((await call('POST', '/bet/sendback', { confirm: true })).status, 404, 'the team sends work back on its own');
    assert.equal((await call('POST', '/bet/nice', {})).json.reason, 'gone', 'nice with no finished job on screen does nothing');
    const twice = await call('POST', '/bet/do', { confirm: true });
    assert.equal(twice.status, 200);
    assert.equal(twice.json.mission.line, 'launcher has it and is starting now.');
    const state = await call('GET', '/state');
    assert.equal(state.json.bet.status, 'started');
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
    assert.deepEqual(log.map(l => `${l.card}:${l.choice}`), ['bet:generate', 'bet:generate', 'bet:generate', 'bet:think', 'bet:show', 'bet:do', 'bet:lock', 'bet:do', 'yes-0-2:yes']);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await gen.release();
  }
});

test('page: one dark theme, the orb is the button, the lava stops once the card is up', () => {
  const html = phonePage('NONCE');
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
  // no decision sheet on the phone, and the team row is gone
  assert.doesNotMatch(html, /things only you can do|id="sheet"/);
  // the old row of team circles is gone; the team is the table behind the footer link
  assert.equal((html.match(/id="team"/g) || []).length, 1);
  assert.match(html, /<section class="team" id="team" hidden role="dialog"/);
  assert.match(html, /tap again to start/);
  assert.match(html, /sharper idea/);
  assert.match(html, /not now/);
  // no process text ever reaches the page: no skeptic, no rejects, no word counts, no thinking screen
  assert.doesNotMatch(html, /tokens|second look|words written|turned down|skeptic|sayEvent|progressOf|'thinking'|'failed'/);
  // one script scope: a function declared twice silently replaces the first
  const names = [...html.matchAll(/function ([A-Za-z]\w*)\(/g)].map(m => m[1]);
  assert.deepEqual(names.filter((n, i) => names.indexOf(n) !== i), []);
  assert.match(html, /navigator\.vibrate\(10\)/);
  // two speeds by truth: a queued bet plays the landing curves at two fifths of
  // their length, a bet being made plays them at full length
  assert.match(html, /var FAST = 0\.4;/);
  assert.match(html, /var GROW_MS = 1050, MAX_SCALE = 3\.2;/);
  assert.match(html, /\(GROW_MS \* pace\)/);
  assert.match(html, /\(SETTLE_MS \* pace\)/);
  assert.match(html, /reveal\(s, true\);/);
  assert.match(html, /wait: function \(\) \{\n {8}pace = 1;/);
  assert.match(html, /\.lava\.still \.tx, \.lava\.still \.ty, \.lava\.still \.blob \{ animation-play-state: paused; \}/);
  assert.match(html, /prefers-reduced-motion: reduce/);
  assert.match(html, /\/bet\/think/);
  assert.match(html, /\/bet\/do/);
  // the bright point does not breathe
  assert.doesNotMatch(html, /Math\.sin\(boom/);
  // no eyebrow labels and no small lines: the bet card is the title, then why
  // it matters in the same big body type
  assert.doesNotMatch(html, /'why now'|el\('span', 'k'|\['expect', |\['cost', |'needs your yes'|class="terms"|\.terms |'when'|'steps'/);
  assert.match(html, /box\.appendChild\(el\('p', 'why', \[b\.why_now, b\.expect\]\.map\(sentence\)\.join\(' '\)\)\);/);
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
  assert.ok(rows.every(r => r.ms > 0 && r.today === TODAY && r.workspace === root && r.model_ok === true && r.kind === 'writer'));
});

test('attempts log: a model that fails outright is saved too', async () => {
  const root = workspace();
  const attemptsFile = path.join(root, 'attempts.jsonl');
  await gmBet.generateBet({
    workspaceRoot: root, today: TODAY, ledgerFile: path.join(root, 'bets.jsonl'), attemptsFile,
    deps: { ...fixtureDeps, runModel: async () => ({ ok: false, reason: 'the model gave an empty answer' }) },
  });
  const row = JSON.parse(fs.readFileSync(attemptsFile, 'utf8').trim());
  assert.equal(row.model_ok, false);
  assert.deepEqual(row.reasons, ['the model gave an empty answer']);
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
  const next = h.d.next();
  assert.deepEqual([next.kind, next.job.what], ['yes', 'a handed-off job wants to publish beta to npm'], 'the answer did not hide the later request');
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
