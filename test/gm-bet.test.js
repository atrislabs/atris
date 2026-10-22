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

const PASS = JSON.stringify({ verdict: 'pass', missing_first: 'nothing', moves_metric: true, reason: 'a getting started page is what new installs hit first.' });

const fixtureDeps = {
  seasonFacts: () => ({ landed: 4, target: { landed: 4, goal: 6, verdict: 'behind' }, record: { won: 2, lost: 1 }, waiting_on_review: 3, waiting_jobs: [{ id: 't1', title: 'fix the flaky login test' }, { id: 't2', title: 'add the install page' }, { id: 't3', title: 'retire the old sync job' }], stuck: 0 }),
  gitLanded: () => ['gm phone: decision cards', 'bench: agy engine', 'second review runs joined checks', 'scoped token fix'],
  fetchJson: async url => (url.startsWith('https://registry.npmjs.org/') ? { version: '3.71.3' } : npmBody()),
  releaseGap: () => ({ count: 67 }),
  packageName: 'atris',
  runSkeptic: async () => ({ ok: true, text: PASS }),
};

const SOURCE_KEYS = ['now', 'season', 'landed', 'installs', 'installs_best', 'release', 'briefs', 'ledger'];

function goodBet(over = {}) {
  return {
    title: 'Write a getting started page for atris gm phone with a 30 second screen recording',
    why_now: 'installs last week were 1,400 and the phone page just landed, so new installs have nothing to try first.',
    expect: '300 more npm installs in the week before the check date',
    target: { metric: 'installs', baseline: 1400, goal: 1700 },
    check_in_days: 9,
    metric_source: 'npm installs for atris',
    cost: 'about 4 hours of agent time, $0',
    steps: [
      { text: 'draft the getting started page', detail: 'docs/gm-phone.md, about 300 words', who: 'team', public: false },
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
  assert.deepEqual(events.map(e => e.key), SOURCE_KEYS);
  assert.ok(events.every(e => e.kind === 'source'));
  const line = Object.fromEntries(events.map(e => [e.key, e.line]));
  assert.equal(line.now, 'read now.md, last updated 2026-10-20 at 09:00 local time');
  assert.equal(line.season, 'this week: 4 of 6 landed, behind, season 2 won 1 lost, 3 waiting on review, 0 stuck');
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
  assert.deepEqual(events.map(e => `${e.kind}:${e.key}`), ['skip:now', 'skip:season', 'skip:landed', 'skip:installs', 'skip:release', 'skip:briefs', 'source:ledger']);
  assert.deepEqual(Object.keys(bundle.sources), ['ledger']);
  assert.deepEqual(bundle.facts, ['past bets: none yet']);
  const text = gmBet.bundleText(bundle);
  assert.doesNotMatch(text, /now\.md|installs|landed on master|research brief|published|swing/);
  // with nothing readable, a target cannot be set, and the reason says so
  assert.match(gmBet.validateBet(goodBet(), { bundle, today: TODAY }).reasons.join(' | '), /no number we can read here for a target/);
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

test('ambition: installs must beat the best recent week, half the review queue must land, with the numbers', async () => {
  const { bundle } = await bundleFor(workspace());
  const check = target => gmBet.validateBet(goodBet({ target }), { bundle, today: TODAY }).reasons.join(' | ');
  assert.equal(check({ metric: 'installs', baseline: 1400, goal: 1550 }), 'target goal 1,550 does not beat our best installs week of the last 2 months, 1,550; the goal must be above 1,550');
  assert.equal(check({ metric: 'installs', baseline: 1400, goal: 1551 }), '', 'one more than the best week is enough');
  // the fixture season has 3 jobs waiting on review: at least 2 must land, counted from 0
  assert.equal(check({ metric: 'queue_landed', baseline: 0, goal: 1 }), 'target goal 1 does not land half the review queue: 3 wait now, so the goal must be at least 2');
  assert.equal(check({ metric: 'queue_landed', baseline: 0, goal: 2 }), '');
  assert.equal(check({ metric: 'queue_landed', baseline: 0, goal: 3 }), '');
  assert.equal(check({ metric: 'queue_landed', baseline: 0, goal: 4 }), 'target goal 4 is more than the 3 jobs waiting now');
  // the queue size and changes merged are not metrics: closing jobs empties one, filler jobs inflate the other
  assert.equal(check({ metric: 'waiting', baseline: 3, goal: 1 }), 'target metric must be one we can read here: installs or queue_landed, got "waiting"');
  assert.equal(check({ metric: 'landed', baseline: 4, goal: 40 }), 'target metric must be one we can read here: installs or queue_landed, got "landed"');
  assert.match(check(undefined), /target is missing/);
  const empty = await bundleFor(workspace(), { ...fixtureDeps, seasonFacts: () => ({ landed: 0, target: null, record: null, waiting_on_review: 0, waiting_jobs: [], stuck: 0 }) });
  assert.equal(gmBet.validateBet(goodBet({ target: { metric: 'queue_landed', baseline: 0, goal: 0 } }), { bundle: empty.bundle, today: TODAY }).reasons.join(' | '), 'nothing is waiting on review, so there is no queue to land; pick another metric');
  // the check is a week out at least, so every day read is after the start
  assert.match(gmBet.validateBet(goodBet({ check_in_days: 5 }), { bundle, today: TODAY }).reasons.join(' | '), /from 7 to 14, got 5/);
  // the prompt names the readable metrics with their baselines and the bar to clear
  const prompt = gmBet.buildPrompt(bundle, { today: TODAY });
  assert.match(prompt, /the most ambitious move this team can start this week, one that would beat our best installs week of the last 2 months or land at least half of the jobs waiting on review if it works/);
  assert.match(prompt, /Small safe bets get rejected/);
  assert.ok(prompt.includes('"installs" (npm installs in the 7 days that end on the check date; baseline 1400; the best week in the last 2 months was 1,550, so the goal must be above 1,550)'));
  assert.ok(prompt.includes('"queue_landed" (jobs waiting on review today that land (accepted or merged) by the check date; closing, dropping, or parking one counts zero; baseline 0; 3 wait now, so the goal must be at least 2 of them landed)'));
  // the writer and the skeptic both see which jobs count
  assert.match(gmBet.bundleText(bundle), /## jobs waiting on review now \(3; only these count toward queue_landed\)\n- fix the flaky login test\n- add the install page\n- retire the old sync job/);
  assert.doesNotMatch(prompt, /swing/);
});

test('ambition: a baseline that is not the real number is turned down', async () => {
  const { bundle } = await bundleFor(workspace());
  const check = target => gmBet.validateBet(goodBet({ target }), { bundle, today: TODAY }).reasons.join(' | ');
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
  const queue = await run(goodBet({ title: 'Review the three oldest waiting jobs with a second checker lane', target: { metric: 'queue_landed', baseline: 0, goal: 2 } }));
  assert.equal(queue.ok, true, queue.reason);
  assert.deepEqual(queue.bet.target, { metric: 'queue_landed', baseline: 0, goal: 2, job_ids: ['t1', 't2', 't3'] });
  assert.equal(queue.bet.goal_line, 'goal 2 of the 3 waiting jobs landed');
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
    steps: [{ text: 'run the release checks on master', who: 'team', public: false }, { text: 'release the merged gm game to npm', who: 'you', public: true }],
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
  assert.match(plain[0], /if the facts show nothing landed this week and jobs are waiting on review, any idea that needs new code merged is blocked by that, so prefer the move that unblocks\./);
});

test('trim: a format-only reject gets one free repair turn in the same try, then the skeptic still runs', async () => {
  const root = workspace();
  const attemptsFile = path.join(root, 'attempts.jsonl');
  const long = goodBet({ steps: [{ text: 'draft the getting started page and a matching readme section with screenshots', who: 'team', public: false }, goodBet().steps[2]] });
  const short = goodBet({ steps: [{ text: 'draft the getting started page and a readme section', who: 'team', public: false }, goodBet().steps[2]] });
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
  const long = goodBet({ steps: [{ text: 'draft the getting started page and a matching readme section with screenshots', who: 'team', public: false }, goodBet().steps[2]] });
  const sneaky = goodBet({ target: { metric: 'installs', baseline: 1400, goal: 1600 }, steps: [{ text: 'draft the page', who: 'team', public: false }, goodBet().steps[2]] });
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
  assert.match(check({ steps: [{ text: 'post the thread on x', who: 'team', public: false }, goodBet().steps[0]] }), /step 1 reaches the outside world/);
  assert.match(check({ steps: [{ text: 'draft and send the email to 20 users', who: 'team', public: false }, goodBet().steps[0]] }), /step 1 reaches the outside world/);
  assert.doesNotMatch(check({ steps: [{ text: 'draft the launch post for review', who: 'team', public: false }, goodBet().steps[2]] }), /step 1/);
  assert.match(check({ expect: 'more installs' }), /number and a metric/);
  assert.match(check({ metric_source: 'how people feel' }), /not a source we can read/);
  assert.match(check({ why_now: '' }), /why_now is missing/);
  // the card fits one phone screen: short why, at most 5 one-line steps, no paths or commands
  assert.match(check({ why_now: `installs last week were 1,400. ${'and the page is new. '.repeat(8)}` }), /why_now is \d+ characters, over 160/);
  assert.match(check({ why_now: 'installs were 1,400. the page is new. nobody has seen it.' }), /more than two sentences/);
  const step = { text: 'draft one short section', who: 'team', public: false };
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
function stubGenerator({ fail = () => false } = {}) {
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const gates = [];
  const generate = (opts) => {
    calls.push(opts);
    active += 1;
    maxActive = Math.max(maxActive, active);
    opts.emit({ kind: 'source', key: 'now', line: 'read now.md' });
    const n = calls.length - 1;
    return new Promise((resolve) => { gates.push(resolve); }).then(() => {
      active -= 1;
      if (fail(n)) return { ok: false, reason: 'the model gave an empty answer' };
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
  const d = gmBet.createBetDesk({
    workspaceRoot: root,
    ledgerFile,
    now: () => clock,
    log: row => logs.push(row),
    generate: over.generate || gen.generate,
    runCli: over.runCli || (async (args) => {
      cli.push(args);
      if (args[1] === 'start') return { code: 0, stdout: JSON.stringify({ ok: true, action: 'mission_started', mission: { id: 'mission-2026-10-21-write-a-getting-abc', owner: 'launcher', status: 'planning' } }, null, 2), stderr: '' };
      return { code: 0, stdout: JSON.stringify({ ok: true, action: 'mission_run_detached', mission_id: 'mission-2026-10-21-write-a-getting-abc', pid: 42 }), stderr: '' };
    }),
  });
  const ledger = () => gmBet.readLedger(ledgerFile, root);
  return { d, gen, cli, logs, ledger, ledgerFile, tick: (ms) => { clock += ms; } };
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

test('queue: a tap shows the next bet at once; below 2 it refills back to 3', async () => {
  const h = await filled(workspace());
  const first = h.d.next();
  assert.equal(first.status, 'ready');
  assert.equal(first.bet.title, TITLES[0]);
  assert.equal(first.queue, 2);
  assert.equal(h.gen.calls.length, 3, 'two left is enough, nothing starts');
  const second = h.d.next();
  assert.equal(second.bet.title, TITLES[1]);
  assert.equal(second.queue, 1);
  assert.equal(h.gen.calls.length, 4, 'below 2 a refill starts');
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

test('queue: an empty queue on a tap shows the real thinking, then reveals the bet', async () => {
  const h = desk(workspace());
  const tap = h.d.next();
  assert.equal(tap.status, 'thinking');
  assert.deepEqual(tap.events.map(e => e.kind), ['source']);
  await h.gen.releaseOne();
  const v = h.d.view();
  assert.equal(v.status, 'ready');
  assert.equal(v.bet.title, TITLES[0]);
  assert.equal(v.queue, 0, 'the waited bet goes to the screen, not the queue');
  assert.equal(h.gen.calls.length, 2, 'and the refill starts behind it');
});

test('queue: a tap while a background bet is being made waits on that one, no second call', async () => {
  const h = desk(workspace());
  h.d.warm();
  const tap = h.d.next();
  assert.equal(tap.status, 'thinking');
  assert.equal(h.gen.calls.length, 1);
  await h.gen.releaseOne();
  assert.equal(h.d.view().bet.title, TITLES[0]);
});

test('queue: bets older than 6 hours are dropped, and a restart picks up the fresh ones', async () => {
  const root = workspace();
  const h = await filled(root);
  h.tick(gmBet.STALE_MS + 1000);
  const tap = h.d.next();
  assert.equal(tap.status, 'thinking', 'all three were stale');
  assert.deepEqual(h.ledger().filter(r => r.status === 'stale').length, 3);

  const root2 = workspace();
  const fresh = await filled(root2);
  assert.equal(fresh.d.view().queue, 3);
  const again = desk(root2, { ledgerFile: fresh.ledgerFile, start: NOW + 1000 });
  assert.equal(again.d.view().queue, 3, 'the queue lives in the ledger, a reload wastes nothing');
});

test('queue: two failed background bets in a row stop the prefetch until the next tap', async () => {
  const gen = stubGenerator({ fail: n => n < 2 });
  const h = desk(workspace(), { gen });
  h.d.warm();
  await gen.releaseOne();
  await gen.releaseOne();
  assert.equal(gen.calls.length, 2);
  h.d.warm();
  assert.equal(gen.calls.length, 2);
  const tap = h.d.next();
  assert.equal(tap.status, 'thinking');
  assert.equal(gen.calls.length, 3);
  await gen.releaseOne();
  assert.equal(h.d.view().status, 'ready');
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
  // sharper passes c over and waits on a new bet made sharper than c
  await h.gen.release();
  const before = h.gen.calls.length;
  const s = h.d.next({ sharper: true });
  assert.equal(s.status, 'thinking');
  assert.equal(h.gen.calls.length, before + 1);
  assert.equal(h.gen.calls[before].previousTitle, c.bet.title);
  const cRow = Object.fromEntries(h.ledger().map(r => [r.id, r]))[c.id];
  assert.equal(cRow.status, 'passed');
  assert.equal(cRow.note, 'asked for a sharper idea');
});

test('desk: a failed bet the owner is waiting on says what failed', async () => {
  const gen = stubGenerator({ fail: () => true });
  const h = desk(workspace(), { gen });
  h.d.next();
  await gen.releaseOne();
  const v = h.d.view();
  assert.equal(v.status, 'failed');
  assert.equal(v.error, 'the model gave an empty answer');
  assert.equal(v.events[v.events.length - 1].kind, 'failed');
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
  assert.match(objective, /1\. \[team\] draft the getting started page \(docs\/gm-phone\.md, about 300 words\)/);
  assert.match(objective, /3\. \[your yes\] publish the page and post the recording on x/);
  assert.ok(objective.includes(gmBet.YES_RULE));
  const flag = name => start[start.indexOf(name) + 1];
  assert.equal(flag('--owner'), 'launcher');
  assert.equal(flag('--lane'), 'launch');
  assert.equal(flag('--runner'), 'claude');
  assert.equal(flag('--verify'), 'git diff --check');
  assert.ok(start.includes('--json'));
  assert.deepEqual(h.cli[1], ['mission', 'run', 'mission-2026-10-21-write-a-getting-abc', '--detach', '--json']);
  assert.equal(h.d.view().mission.line, 'launcher has it. the mission is running now.');
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

test('do it: a mission that will not start leaves the bet ready and says why', async () => {
  const cli = [];
  const h = await filled(workspace(), { runCli: async (args) => { cli.push(args); return { code: 2, stdout: '', stderr: 'mission start refused: no verifier' }; } });
  h.d.next();
  const out = await h.d.doIt();
  assert.equal(out.ok, false);
  assert.equal(out.message, 'the mission did not start: mission start refused: no verifier');
  assert.equal(h.d.view().status, 'ready');
  assert.equal(cli.length, 1);
});

test('pickOwner: code bets go to the builder, everything unclear to the mission lead', () => {
  const root = workspace();
  const code = goodBet({ title: 'Add an atris gm phone demo flag that seeds sample cards', steps: [{ text: 'build the flag and a test', who: 'team', public: false }, { text: 'release it', who: 'you', public: true }] });
  assert.deepEqual(gmBet.pickOwner(code, root), { owner: 'builder', lane: 'code' });
  const post = goodBet({ title: 'Write a launch thread about the phone page for x', steps: [{ text: 'draft the thread', who: 'team', public: false }] });
  assert.deepEqual(gmBet.pickOwner(post, root), { owner: 'launcher', lane: 'launch' });
  const vague = goodBet({ title: 'Call three customers about renewal pricing tiers', steps: [{ text: 'list three customers from the ledger', who: 'team', public: false }] });
  assert.deepEqual(gmBet.pickOwner(vague, root), { owner: 'mission-lead', lane: 'workspace' });
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
    const twice = await call('POST', '/bet/do', { confirm: true });
    assert.equal(twice.status, 200);
    assert.equal(twice.json.mission.line, 'launcher has it. the mission is running now.');
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
    assert.deepEqual(log.map(l => `${l.card}:${l.choice}`), ['bet:generate', 'bet:generate', 'bet:generate', 'bet:think', 'bet:show', 'bet:do', 'bet:do', 'yes-0-2:yes']);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await gen.release();
  }
});

test('page: one dark theme, the orb is the button, the lava stops once the card is up', () => {
  const html = phonePage('NONCE');
  // the orb in the middle is the button, with a keyboard path and a label
  assert.match(html, /<canvas id="orb" tabindex="0" role="button" aria-label="the atris orb\. tap to think of one new bet for the business"><\/canvas>/);
  assert.match(html, /e\.key === 'Enter' \|\| e\.key === ' '/);
  assert.match(html, /<p class="line" id="line" aria-live="polite">tap to think<\/p>/);
  assert.doesNotMatch(html, /id="think"/);
  assert.match(html, /id="lava"/);
  assert.match(html, /<article class="bet" id="bet" hidden>/);
  // the homepage letter's dark brand values and serif, amber the only accent
  for (const v of ['--bg: #141110', '--text: #eae3d9', '--text-2: #a39b92', '--text-3: #9a9187', '--line: #3d332d', '--amber: rgb(255, 140, 66)']) assert.ok(html.includes(v), v);
  assert.match(html, /--serif: 'Iowan Old Style', 'Palatino Linotype', Palatino, 'Book Antiqua', Georgia, serif;/);
  assert.doesNotMatch(html, /#fff\b|#ffffff|#f6f5f2|background: white/i);
  // the owner's decisions sit behind one quiet link, the team row is gone
  assert.match(html, /things only you can do/);
  assert.doesNotMatch(html, /id="team"/);
  assert.match(html, /tap again to start/);
  assert.match(html, /sharper idea/);
  assert.match(html, /not now/);
  // progress and failure lines use plain words
  assert.match(html, /couldn\\'t land on a good bet\. tap to try again/);
  assert.doesNotMatch(html, /tokens/);
  // one script scope: a function declared twice silently replaces the first
  const names = [...html.matchAll(/function ([A-Za-z]\w*)\(/g)].map(m => m[1]);
  assert.deepEqual(names.filter((n, i) => names.indexOf(n) !== i), []);
  assert.match(html, /navigator\.vibrate\(10\)/);
  // two speeds by truth: a queued bet plays the landing curves at a fifth of
  // their length, a bet being made plays them at full length
  assert.match(html, /var FAST = 0\.2;/);
  assert.match(html, /var GROW_MS = 1050, MAX_SCALE = 3\.2;/);
  assert.match(html, /\(GROW_MS \* pace\)/);
  assert.match(html, /\(SETTLE_MS \* pace\)/);
  assert.match(html, /reveal\(s, true\);/);
  assert.match(html, /if \(was === 'thinking'\) \{ reveal\(s\); return; \}/);
  assert.match(html, /wait: function \(\) \{\n {8}pace = 1;/);
  assert.match(html, /\.lava\.still \.tx, \.lava\.still \.ty, \.lava\.still \.blob \{ animation-play-state: paused; \}/);
  assert.match(html, /prefers-reduced-motion: reduce/);
  assert.match(html, /\/bet\/think/);
  assert.match(html, /\/bet\/do/);
  assert.match(html, /'your yes' : 'team'/);
  // the bright point does not breathe
  assert.doesNotMatch(html, /Math\.sin\(boom/);
  // the card grows by at most one short line: the goal and the swing it beats, under expect
  assert.match(html, /if \(t\[0\] === 'expect' && b\.goal_line\) d\.appendChild\(el\('span', 'sub', b\.goal_line\)\);/);
  assert.match(html, /\.terms \.sub \{ display: block; color: var\(--text-3\); font-size: 12px;/);
  assert.match(html, /if \(e\.kind === 'skeptic'\) return 'a second look: does it make sense';/);
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
