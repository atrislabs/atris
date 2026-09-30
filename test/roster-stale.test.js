'use strict';

// The roster flags a worker on an outdated model (a newer version in the same
// name prefix is known locally) and a pin whose newest proof is over 30 days
// old, with a renew command that keeps the rest of the line.

const test = require('node:test');
const assert = require('node:assert/strict');

const { modelFamily, newerModel, attachStaleModels, modelCatalog } = require('../lib/roster-stale');
const { rosterPickFromValue } = require('../lib/engine-registry');

const NOW = new Date(2026, 8, 30, 12, 0, 0);
const CODEX = ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-reserve', 'gpt-5.6-sol', 'gpt-5.5', 'codex-auto-review'];
const CLAUDE = ['opus 5.5', 'opus 5', 'sonnet 5', 'haiku 4.5', 'fable 5.1'];

test('model family reads prefix, version, and tail', () => {
  assert.deepEqual(modelFamily('gpt-6-astra'), { prefix: 'gpt', version: [6], variant: 'astra' });
  assert.deepEqual(modelFamily('gpt-6.1-sol'), { prefix: 'gpt', version: [6, 1], variant: 'sol' });
  assert.deepEqual(modelFamily('claude-opus-4-6'), { prefix: 'opus', version: [4, 6], variant: '' });
  assert.deepEqual(modelFamily('grok 4.7 fast'), { prefix: 'grok', version: [4, 7], variant: 'fast' });
  assert.equal(modelFamily('codex-auto-review'), null);
  assert.equal(modelFamily('gpt-reserve'), null);
});

test('a newer version in the same prefix is found; the owner case gpt-6-astra to gpt-6.1-sol', () => {
  assert.equal(newerModel('gpt-6-astra', CODEX), 'gpt-6.1-sol');
  assert.equal(newerModel('gpt-6.1-sol', CODEX), null);
  assert.equal(newerModel('gpt-5.5', CODEX), 'gpt-6.1-sol');
  // Same tail wins over a higher version with another tail.
  assert.equal(newerModel('gpt-5.6-sol', ['gpt-7-luna', 'gpt-6-sol']), 'gpt-6-sol');
  assert.equal(newerModel('claude-opus-4-6', CLAUDE), 'opus 5.5');
  assert.equal(newerModel('claude-opus-5-5', CLAUDE), null);
  assert.equal(newerModel('claude-haiku-4-5', CLAUDE), null);
});

test('models with a different prefix never compare', () => {
  assert.equal(newerModel('sonnet 4.6', ['opus 5.5']), null);
  assert.equal(newerModel('gemini-3.7-flash-high', ['gpt-9']), null);
  assert.equal(newerModel('codex-auto-review', CODEX), null);
});

test('the catalog shares claude names across claude-family engines', () => {
  const catalog = modelCatalog([
    { id: 'claude', models: ['opus 5.5'] },
    { id: 'fable', models: ['fable'] },
    { id: 'grok', models: ['grok 4.7 fast', 'grok 4.7'] },
  ]);
  assert.ok(catalog.fable.includes('opus 5.5'));
  assert.ok(catalog.claude.includes('sonnet 5'));
  assert.deepEqual(catalog.grok, ['grok 4.7 fast', 'grok 4.7']);
});

function view(engine, model, source = 'roster') {
  return { engine, model, model_source: source, text: `${engine} (${model})` };
}

function report() {
  return {
    jobs: [
      {
        job: 'review',
        from: 'all projects',
        file: '~/.atris/ROSTER.md',
        workers: [
          { engine: 'codex', model: 'gpt-6-astra', effort: 'medium', max_seconds: 1200, prep: 'search', status: 'leads', why: '', line: 11, runs: view('codex', 'gpt-6-astra') },
          { engine: 'claude', model: 'claude-opus-5', status: 'backup', why: '', line: 12, runs: view('claude', 'claude-opus-5') },
        ],
      },
      {
        job: 'small build',
        from: 'this project',
        file: 'atris/ROSTER.md',
        workers: [
          { engine: 'codex', model: '', status: 'leads', why: '', line: 4, runs: view('codex', 'gpt-6-astra', 'codex settings') },
        ],
      },
      {
        job: 'hard problem',
        from: 'all projects',
        file: '~/.atris/ROSTER.md',
        workers: [
          { engine: 'codex', model: 'gpt-6.1-sol', status: 'leads', why: '', line: 15, verified: '2026-08-15', runs: view('codex', 'gpt-6.1-sol') },
        ],
      },
      {
        job: 'build',
        from: 'all projects',
        file: '~/.atris/ROSTER.md',
        workers: [
          { engine: 'claude', model: 'claude-opus-5-5', status: 'leads', why: '', line: 7, verified: '2026-08-01', runs: view('claude', 'claude-opus-5-5') },
        ],
      },
    ],
    team: [
      { member: 'orb', engine: 'claude', model: 'claude-opus-4-6', source: 'file', file: '~/.atris/ROSTER.md' },
      { member: 'scout', engine: 'claude', model: 'claude-haiku-4-5', source: 'auto', file: null },
    ],
  };
}

const CATALOG = { codex: CODEX, claude: CLAUDE };

test('a stale lead gets one line with an assign command that keeps its settings', () => {
  const out = attachStaleModels(report(), { catalog: CATALOG, runs: [], now: NOW });
  const review = out.jobs[0];
  assert.equal(review.stale_model, true);
  assert.equal(review.newer_model, 'gpt-6.1-sol');
  assert.equal(review.workers[0].stale_model, true);
  const line = out.stale.find((item) => item.job === 'review' && item.engine === 'codex');
  assert.equal(line.text, 'review: codex runs gpt-6-astra, newer gpt-6.1-sol is available. renew: atris engine assign review codex --model gpt-6.1-sol --effort medium --max "20 min" --prep search --everywhere');
  assert.ok(!line.text.includes('—'));
});

test('a stale backup points at its own line instead of an assign that would make it lead', () => {
  const out = attachStaleModels(report(), { catalog: CATALOG, runs: [], now: NOW });
  const backup = out.stale.find((item) => item.job === 'review' && item.engine === 'claude');
  assert.match(backup.text, /^review backup: claude code runs opus 5, newer opus 5\.5 is available\. renew: change the model to opus 5\.5 on line 12 of ~\/\.atris\/ROSTER\.md$/);
});

test('a model that comes from codex settings says so, and a project pick has no scope flag', () => {
  const out = attachStaleModels(report(), { catalog: CATALOG, runs: [], now: NOW });
  const small = out.stale.find((item) => item.job === 'small build');
  assert.equal(small.text, 'small build: codex runs gpt-6-astra from codex settings, newer gpt-6.1-sol is available. renew: atris engine assign "small build" codex --model gpt-6.1-sol');
  // No pin on the line, so no pin age.
  assert.equal(out.jobs[1].pin_age_days, null);
});

test('a pin verified over 30 days ago is flagged with its age; a recent landed run clears it', () => {
  const old = attachStaleModels(report(), { catalog: CATALOG, runs: [], now: NOW });
  const hard = old.jobs.find((row) => row.job === 'hard problem');
  assert.equal(hard.pin_age_days, 46);
  assert.equal(hard.workers[0].pin_verified_at, '2026-08-15');
  const flagged = old.stale.find((item) => item.kind === 'old pin' && item.job === 'hard problem');
  assert.match(flagged.text, /^hard problem: codex on gpt-6\.1-sol was last verified 46 days ago \(roster line\)\. smoke one prompt, then add "verified 2026-09-30" on line 15 of ~\/\.atris\/ROSTER\.md$/);

  const runs = [
    { at: '2026-09-28T10:00:00.000Z', engine: 'codex', model: 'gpt-6.1-sol', outcome: 'landed' },
    { at: '2026-09-29T10:00:00.000Z', engine: 'codex', model: 'gpt-6.1-sol', outcome: 'failed' },
    { at: '2026-09-29T10:00:00.000Z', engine: 'claude', model: 'claude-opus-5-5', outcome: 'landed' },
  ];
  const fresh = attachStaleModels(report(), { catalog: CATALOG, runs, now: NOW });
  const hardFresh = fresh.jobs.find((row) => row.job === 'hard problem');
  assert.equal(hardFresh.workers[0].pin_verified_at, '2026-09-28');
  assert.equal(hardFresh.pin_age_days, 2);
  assert.equal(fresh.jobs.find((row) => row.job === 'build').pin_age_days, 1);
  assert.ok(!fresh.stale.some((item) => item.kind === 'old pin'));
});

test('a pinned team line on an old model is flagged; an automatic member is left alone', () => {
  const out = attachStaleModels(report(), { catalog: CATALOG, runs: [], now: NOW });
  const orb = out.stale.find((item) => item.member === 'orb');
  assert.match(orb.text, /^orb: claude code runs opus 4\.6, newer opus 5\.5 is available/);
  assert.equal(out.team[0].stale_model, true);
  assert.equal(out.team[1].stale_model, undefined);
});

test('an expired worker is not checked', () => {
  const input = report();
  input.jobs[0].workers[0].why = 'expired';
  input.jobs[0].workers[0].status = 'skipped';
  const out = attachStaleModels(input, { catalog: CATALOG, runs: [], now: NOW });
  assert.ok(!out.stale.some((item) => item.job === 'review' && item.engine === 'codex'));
});

test('a roster line takes a verified date and refuses one that is not a date', () => {
  const pick = rosterPickFromValue('codex, model: gpt-6.1-sol, verified 2026-09-30', 'executor');
  assert.equal(pick.verified, '2026-09-30');
  const colon = rosterPickFromValue('codex, model: gpt-6.1-sol, verified: sep 30 2026', 'executor');
  assert.equal(colon.verified, '2026-09-30');
  assert.throws(() => rosterPickFromValue('codex, verified yesterday', 'executor'), /is not a date/);
});
