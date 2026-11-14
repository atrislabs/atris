'use strict';

// The start-up screen in whole sentences: each paragraph says what
// happened, why it matters and how we know, with no codes or bare scores.

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderStatus, recentChanges, valuesSentence } = require('../lib/plain-status');
const { bootTeamSentence } = require('../lib/team-lineup');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-13T20:00:00Z');

function lines(text) {
  return text.split('\n');
}

// Sentences wrap at the window edge; match them as one line.
function flat(text) {
  return String(text).replace(/\s+/g, ' ');
}

test('a job nobody touched in three weeks reads as stuck, with its own reason', () => {
  const text = renderStatus({
    now: NOW,
    glance: {
      active: 1,
      activeItems: [{
        title: 'Pin Fast and Rapid to the new model (Verify: grep -q x y.py)',
        result: 'You can review a tested model upgrade for both assistants.',
        startedMs: NOW - 21 * DAY,
        movedMs: NOW - 21 * DAY,
      }],
    },
  });
  assert.match(flat(text), /Stuck: an agent started "Pin Fast and Rapid to the new model" 3 weeks ago and has not moved since/);
  assert.match(flat(text), /When it is done: you can review a tested model upgrade/);
  assert.doesNotMatch(text, /Verify:/, 'the check command is for agents, not the reader');
});

test('a job touched today reads as working, not stuck', () => {
  const text = renderStatus({
    now: NOW,
    glance: { active: 1, activeItems: [{ title: 'Write the welcome email', startedMs: NOW - 5 * 60 * 60 * 1000, movedMs: NOW - 60 * 1000 }] },
  });
  assert.match(flat(text), /Working now: an agent is on "Write the welcome email"\. It started 5 hours ago\./);
  assert.doesNotMatch(text, /Stuck/);
});

test('changes waiting for a check list what each one does, oldest wait first', () => {
  const text = renderStatus({
    now: NOW,
    glance: {
      review: 2,
      reviewCertified: 0,
      reviewItems: [
        { title: 'plan_day ranking', result: 'Owners can now see today\'s most important moves', movedMs: NOW - DAY },
        { title: 'Second thing', movedMs: NOW - 2 * 60 * 60 * 1000 },
      ],
    },
  });
  assert.match(flat(text), /Waiting for a check: 2 finished changes are waiting for a second agent to review them before they count\. The oldest has waited a day\./);
  assert.match(flat(text), / - Owners can now see today's most important moves\./);
  assert.match(flat(text), / - Second thing\./);
});

test('finished work that passed its check asks for the owner first', () => {
  const text = renderStatus({
    now: NOW,
    glance: { review: 1, reviewCertified: 1, certifiedItems: [{ title: 'Ship the invoice fix' }] },
    recent: { count: 4, agents: 4, examples: ['Invoices go out on time'] },
  });
  assert.ok(text.indexOf('Waiting on you') < text.indexOf('In the last day'), text);
  assert.match(flat(text), /Waiting on you: 1 finished change passed a second agent's check and needs your ok before it counts as done\./);
  assert.doesNotMatch(text, /Waiting for a check/, 'checked work is not counted twice');
});

test('the quality line says what was measured and what the goal is', () => {
  const text = renderStatus({ now: NOW, revisions: { fixed: 10, landings: 592 } });
  assert.match(flat(text), /10 of the 592 changes agents added were followed within three days by a commit with no agent signature that edited the same lines or the lines right beside them, which usually means a person fixed them\. That is 2 percent, and the goal is zero\./);
  assert.equal(renderStatus({ now: NOW, revisions: { fixed: 0, landings: 50 } }), '', 'zero is the healthy state and stays silent');
});

test('the last day counts changes, skips merges and housekeeping in the examples', () => {
  const commits = [
    { ms: NOW - 60 * 1000, parents: ['a', 'b'], subject: 'Merge pull request #1 from x', isAgent: true },
    { ms: NOW - 2 * 60 * 1000, parents: ['a'], subject: 'Refresh map references that moved', isAgent: true },
    { ms: NOW - 3 * 60 * 1000, parents: ['a'], subject: 'fix: invoices go out on time (#42)', isAgent: true },
    { ms: NOW - 4 * 60 * 1000, parents: ['a'], subject: 'Owner can pause a job', isAgent: false },
    { ms: NOW - 2 * DAY, parents: ['a'], subject: 'Old change', isAgent: true },
  ];
  const recent = recentChanges(commits, NOW);
  assert.deepEqual(recent, { count: 3, agents: 2, examples: ['invoices go out on time', 'Owner can pause a job'] });
  const text = renderStatus({ now: NOW, recent });
  assert.match(flat(text), /In the last day, 3 changes were added to this project, 2 of them by agents\. The newest 2:/);
  assert.match(flat(text), /- Invoices go out on time\./);
  assert.match(flat(renderStatus({ now: NOW, recent: { count: 0, agents: 0, examples: [] } })), /Nothing new was added to this project in the last day\./);
});

test('every line fits a narrow window and carries no dash or shouting', () => {
  const text = renderStatus({
    now: NOW,
    glance: { active: 1, backlog: 23, activeItems: [{ title: 'A very long job title that keeps going and going so the wrap has real work to do here', startedMs: NOW - DAY }] },
    goal: 'Snowpine runs for one week with no person in the middle of the work, inside a budget set in advance, proven the week its own records show two real replies or one paid order its agents produced.',
    values: valuesSentence([{ name: 'acceleration', gist: 'progress compounds' }, { name: 'accuracy', gist: 'a win counts when it is checked' }]),
  });
  for (const line of lines(text)) assert.ok(line.length <= 74, `too wide: ${line}`);
  assert.doesNotMatch(text, /—/);
  assert.doesNotMatch(text, /\b[A-Z]{4,}\b/);
  assert.match(flat(text), /Not started: 23 more jobs are written down and waiting for an agent\./);
  assert.match(flat(text), /The goal: Snowpine runs for one week/);
  assert.match(flat(text), /agents decide by 2 values: acceleration \(progress compounds\) and accuracy \(a win counts when it is checked\)\./);
});

test('the team reads as one sentence naming the tool and model for each job', () => {
  const jobs = [
    { job: 'review', now_runs: { engine: 'codex', model: 'gpt-6.1-sol' } },
    { job: 'build', now_runs: { engine: 'codex', model: 'gpt-6.1-terra' } },
    { job: 'ui edits', key: 'ui', now_runs: { engine: 'devin', model: 'swe-2' } },
  ];
  const text = bootTeamSentence(process.cwd(), { jobs });
  assert.match(flat(text), /^The agents run on these AI tools and models: codex \S+ writes the changes, codex \S+ checks them and devin \S+ takes the ui edits jobs\.$/);
  assert.equal(bootTeamSentence(process.cwd(), { jobs: [] }), '');
});

test('long dashes from titles written elsewhere become commas', () => {
  const text = renderStatus({ now: NOW, brief: { title: 'Swarm discovery \u2014 2026-11-13', path: 'atris/wiki/briefs/x.md' } });
  assert.doesNotMatch(text, /\u2014/);
  assert.match(flat(text), /"Swarm discovery, 2026-11-13"/);
});

test('a job held for a person decision is waiting on the owner, not stuck', () => {
  const text = flat(renderStatus({
    now: NOW,
    glance: { active: 1, activeItems: [{ title: 'Pin the new model', startedMs: NOW - 21 * DAY, movedMs: NOW - 21 * DAY, heldForPerson: true, result: 'Both assistants run the tested model.' }] },
  }));
  assert.match(text, /Waiting on you: an agent started "Pin the new model" 3 weeks ago and stopped because it needs a person to decide\. When it is done: both assistants run the tested model\./);
  assert.doesNotMatch(text, /Stuck|more job/);
});

test('jobs past the three shown still count toward stuck, and the oldest wait spans every waiting change', () => {
  const old = { startedMs: NOW - 5 * DAY, movedMs: NOW - 5 * DAY };
  const text = flat(renderStatus({
    now: NOW,
    glance: {
      active: 4,
      activeItems: ['a', 'b', 'c', 'd'].map((t) => ({ title: t, ...old })),
      review: 4,
      reviewCertified: 0,
      reviewItems: [1, 2, 3].map((h) => ({ title: `r${h}`, movedMs: NOW - h * 60 * 60 * 1000 })).concat([{ title: 'r7', movedMs: NOW - 7 * DAY }]),
    },
  }));
  assert.match(text, /1 more job is also in progress, and it is stuck with nothing moved in over three days\./);
  assert.match(text, /The oldest has waited 7 days\./);
  assert.match(text, /- And 1 more\./);
});

test('nothing in progress still says how many jobs wait', () => {
  const text = flat(renderStatus({ now: NOW, glance: { active: 0, backlog: 10, backlogTitles: ['Write the invoice email'] } }));
  assert.match(text, /Nothing is in progress\. 10 jobs are written down and waiting, starting with "Write the invoice email"\./);
});

test('small quality shares keep their real size', () => {
  assert.match(flat(renderStatus({ now: NOW, revisions: { fixed: 1, landings: 1000 } })), /That is 0\.1 percent/);
  assert.match(flat(renderStatus({ now: NOW, revisions: { fixed: 1, landings: 5000 } })), /That is under 0\.1 percent/);
});

test('a branch merged today counts today even when its commits were written earlier', () => {
  const commits = [
    { hash: 'm', ms: NOW - 60 * 1000, parents: ['p', 'b'], subject: 'Merge pull request #2', isAgent: true },
    { hash: 'b', ms: NOW - 2 * DAY, parents: ['p'], subject: 'Owners see the invoice total', isAgent: true },
    { hash: 'p', ms: NOW - 3 * DAY, parents: [], subject: 'Older change', isAgent: false },
  ];
  const arrival = new Map([['m', 'm'], ['p', 'p'], ['b', 'm']]);
  assert.deepEqual(recentChanges(commits, NOW, { arrival }), { count: 1, agents: 1, examples: ['Owners see the invoice total'] });
  assert.equal(recentChanges(commits, NOW).count, 0, 'without the merge map the author date decides');
});

test('setup titles read in plain words', () => {
  const text = flat(renderStatus({ now: NOW, glance: { active: 1, activeItems: [{ title: 'Generate MAP.md, scan codebase, populate index', startedMs: NOW - 60 * 1000 }] } }));
  assert.match(text, /"map this folder so agents can find things"/);
});
