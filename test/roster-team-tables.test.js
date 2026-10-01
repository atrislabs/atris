'use strict';

// atris engine roster and atris team print plain aligned tables: a header
// row, two spaces between columns, no pipes. atris team marks a member
// "working now" from live engine runs read through one ps call.

const test = require('node:test');
const assert = require('node:assert/strict');

const { renderTable } = require('../lib/text-table');
const { listLiveEngineRuns, liveEngineRuns, parseEngineProcess, parsePsLine, shortElapsed } = require('../lib/engine-processes');
const { attachStaleModels } = require('../lib/roster-stale');
const { renderRosterReport } = require('../commands/engine');

// --- the table ---------------------------------------------------------------

test('a table aligns columns two spaces apart under a header, with extra cell lines underneath', () => {
  const out = renderTable(
    [{ header: 'JOB' }, { header: 'LEADS' }, { header: 'MAX' }],
    [['review', ['codex · gpt-6.1-sol', '(medium effort)'], '20 min'], ['search', 'claude · haiku 4.5', '-']],
    { width: 100 },
  );
  assert.equal(out, [
    'JOB     LEADS                MAX',
    'review  codex · gpt-6.1-sol  20 min',
    '        (medium effort)',
    'search  claude · haiku 4.5   -',
  ].join('\n'));
  assert.ok(!out.includes('|'));
});

test('only a clip column shrinks to fit, ending in an ellipsis; a wrap column carries on underneath', () => {
  const columns = [{ header: 'MEMBER' }, { header: 'DOING', clip: true }, { header: 'LAST' }];
  const clipped = renderTable(columns, [['backend-independent-validator', 'second-round review of a long diff', '1m']], { width: 50 });
  const row = clipped.split('\n')[1];
  assert.ok(row.length <= 50, row);
  assert.match(row, /^backend-independent-validator  second-round\S*…  1m$/);

  const wrapped = renderTable([{ header: 'JOB' }, { header: 'NOTE', wrap: true }], [['build', 'not ready, falls back to build']], { width: 24 });
  assert.deepEqual(wrapped.split('\n'), ['JOB    NOTE', 'build  not ready, falls', '       back to build']);
});

// --- live engine runs --------------------------------------------------------

// Lines as `ps -axo pid=,ppid=,etime=,command=` prints them on this Mac.
const PS = [
  '  500     1  02:39:31 /Users/k/arena/atrisos-backend/venv/bin/python -u /Users/k/arena/atrisos-backend/scripts/orchestrator.py --loop --interval 60',
  '31162 31146     06:18 devin -p --permission-mode dangerous --model swe-2-max -- You are the night shift for the Atris backend. You have this one run, with no human awake, to land ONE real, verified improvement.\\012\\012Working tree: /tmp/night',
  '33648 31131     13:24 node /opt/homebrew/bin/codex exec --cd /Users/k/night-2026-10-01-0 --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -m gpt-5.6-sol -o /tmp/x You are the night shift for the Atris backend.',
  '33654 33648     13:24 /opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex exec --cd /Users/k/night-2026-10-01-0 --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -m gpt-5.6-sol -o /tmp/x You are the night shift for the Atris backend.',
  '40001 40000     01:05 node /Users/keshavrao/.bun/bin/codex exec --ephemeral -m gpt-6.1-sol -c model_reasoning_effort=medium -s read-only -o /tmp/review2-3972.md You are acting as backend-independent-validator. Second-round review of git diff origin/master...HEAD for PR 3972',
  '40002 40001     01:05 /Users/keshavrao/.bun/install/global/node_modules/@openai/codex/vendor/codex exec --ephemeral -m gpt-6.1-sol -c model_reasoning_effort=medium -s read-only -o /tmp/review2-3972.md You are acting as backend-independent-validator. Second-round review of git diff origin/master...HEAD for PR 3972',
  '41000     1     00:40 claude --dangerously-skip-permissions',
  '42000     1     00:01 ps -axo pid=,ppid=,etime=,command=',
].join('\n');

test('ps lines parse into pid, parent, elapsed seconds, and the command', () => {
  assert.deepEqual(parsePsLine('31162 31146     06:18 devin -p x'), { pid: 31162, ppid: 31146, elapsed_seconds: 378, command: 'devin -p x' });
  assert.equal(parsePsLine('1 0 1-02:03:04 x').elapsed_seconds, 93784);
  assert.equal(shortElapsed(30), 'now');
  assert.equal(shortElapsed(378), '6m');
  assert.equal(shortElapsed(7200), '2h');
  assert.equal(shortElapsed(200000), '2d');
});

test('one ps read finds each real run once, with its member, engine, model, and what it is doing', () => {
  const runs = listLiveEngineRuns({ runPs: () => ({ status: 0, stdout: PS }), selfPid: 42000 });
  assert.equal(runs.length, 3, JSON.stringify(runs, null, 2));
  const [review, devin, night] = runs;
  assert.deepEqual(
    [review.member, review.engine, review.model, review.effort, review.elapsed_seconds],
    ['backend-independent-validator', 'codex', 'gpt-6.1-sol', 'medium', 65],
  );
  assert.equal(review.doing, 'Second-round review of git diff origin/master...HEAD for PR 3972');
  // The node wrapper and the native binary are one run: the child is kept.
  assert.equal(review.pid, 40002);
  assert.equal(night.pid, 33654);
  assert.deepEqual([night.member, night.engine, night.model], [null, 'codex', 'gpt-5.6-sol']);
  assert.match(night.doing, /^You are the night shift for the Atris backend\.$/);
  assert.deepEqual([devin.member, devin.engine, devin.model], [null, 'devin', 'swe-2-max']);
  // ps writes a newline as \012; the prompt reads as one line.
  assert.match(devin.doing, /verified improvement\. Working tree: \/tmp\/night$/);
  assert.ok(!runs.some((run) => run.pid === 500), 'the orchestrator daemon is not a run');
  assert.ok(!runs.some((run) => run.pid === 41000), 'an interactive claude is a person, not a run');
});

test('a dispatcher above a run is hidden, and an unnamed child takes its member', () => {
  const entries = [
    { pid: 10, ppid: 1, elapsed_seconds: 100, command: 'node /usr/local/bin/atris engine dispatch T-1 --engine codex' },
    { pid: 11, ppid: 10, elapsed_seconds: 99, command: '/bin/zsh -c codex exec -m gpt-6.1-sol fix it' },
    { pid: 12, ppid: 11, elapsed_seconds: 99, command: 'codex exec -m gpt-6.1-sol fix the flaky test' },
    { pid: 20, ppid: 1, elapsed_seconds: 50, command: 'claude -p You are acting as executor. Build the table' },
    { pid: 21, ppid: 20, elapsed_seconds: 40, command: 'codex exec -s read-only check the diff' },
    { pid: 30, ppid: 1, elapsed_seconds: 10, command: 'node /x/bin/atris.js engine roster' },
  ];
  const runs = liveEngineRuns(entries, { selfPid: 0 });
  assert.deepEqual(runs.map((run) => [run.pid, run.engine, run.member]), [[21, 'codex', 'executor'], [12, 'codex', null]]);
  assert.equal(runs[0].doing, 'check the diff');
  assert.equal(runs[1].doing, 'fix the flaky test');
});

test('a ps that fails or throws means no runs, never an error', () => {
  assert.deepEqual(listLiveEngineRuns({ runPs: () => ({ status: 1, stdout: '' }) }), []);
  assert.deepEqual(listLiveEngineRuns({ runPs: () => { throw new Error('no ps'); } }), []);
  assert.equal(parseEngineProcess({ pid: 1, ppid: 0, command: 'opencode serve' }), null);
  assert.equal(parseEngineProcess({ pid: 1, ppid: 0, command: 'opencode run fix it' }).doing, 'fix it');
});

// --- the roster table keeps the outdated-model flags --------------------------

function view(engine, model, effort = '') {
  return { engine, model, model_source: 'roster', effort, text: `${engine} (${model})` };
}

function staleReport() {
  const worker = (engine, model, extra = {}) => ({ engine, model, status: 'backup', why: '', runs: view(engine, model, extra.effort || ''), ...extra });
  return {
    jobs: [
      {
        job: 'review',
        from: 'all projects',
        file: '~/.atris/ROSTER.md',
        pick: { engine: 'codex', model: 'gpt-6-astra' },
        status: 'picked',
        lead: 'first',
        now_runs: view('codex', 'gpt-6-astra', 'medium'),
        workers: [
          worker('codex', 'gpt-6-astra', { status: 'leads', effort: 'medium', max_seconds: 1200, prep: 'search', line: 11 }),
          worker('claude', 'claude-opus-5', { line: 12 }),
          worker('grok', 'grok-4.7-build-fast', { line: 13, until: '2026-10-24' }),
        ],
      },
      {
        job: 'hard problem',
        from: 'all projects',
        file: '~/.atris/ROSTER.md',
        pick: { engine: 'codex', model: 'gpt-6.1-sol' },
        status: 'picked',
        lead: 'first',
        now_runs: view('codex', 'gpt-6.1-sol'),
        workers: [worker('codex', 'gpt-6.1-sol', { status: 'leads', line: 15, verified: '2026-08-15' })],
      },
    ],
    team: [{ member: 'orb', job: 'review', engine: 'claude', model: 'claude-opus-4-6', source: 'file', file: '~/.atris/ROSTER.md' }],
    expiring: [],
    warnings: [],
  };
}

test('the roster table flags an outdated lead, an outdated backup, and an old pin, and keeps every backup', () => {
  const catalog = { codex: ['gpt-6.1-sol', 'gpt-6-astra'], claude: ['opus 5.5', 'opus 5', 'opus 4.6'] };
  const report = attachStaleModels(staleReport(), { catalog, runs: [], now: new Date(2026, 8, 30, 12) });
  const out = renderRosterReport(report, { width: 200 });
  const lines = out.split('\n');
  assert.equal(lines[0], 'jobs, from ~/.atris/ROSTER.md');
  assert.match(lines[1], /^JOB +LEADS +BACKUP +MAX +UNTIL +NOTE$/);
  assert.match(lines[2], /^review +codex · gpt-6-astra +claude · opus 5 +20 min +- +prep: search, newer gpt-6\.1-sol out, backup newer opus 5\.5 out$/);
  assert.match(lines[3], /^ +\(medium effort\) +grok · grok 4\.7 fast \(until oct 24\)$/);
  assert.match(lines[4], /^hard problem +codex · gpt-6\.1-sol +none +- +- +pin 46 days old$/);
  // The full lines with their fix commands still print under the table.
  assert.match(out, /^review: codex runs gpt-6-astra, newer gpt-6\.1-sol is available\. renew: atris engine assign review codex/m);
  assert.match(out, /^MEMBER +JOB +ENGINE · MODEL +SOURCE$/m);
  assert.match(out, /^orb +review +claude · opus 4\.6 \(newer opus 5\.5 out\) +~\/\.atris\/ROSTER\.md$/m);
  assert.ok(!out.includes('|'));
});
