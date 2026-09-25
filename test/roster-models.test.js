'use strict';

// Every roster line runs the model it names, with optional effort and time
// cap, and the roster view shows the real model and where it came from.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { engineCommand } = require('../commands/engine');
const { resolveMissionTickRunner, missionTickTimeoutMs } = require('../commands/mission');
const { readyExecutor, lapModelPins } = require('../commands/one-lap');
const { buildPhaseRunner, buildPlanReviewRunner } = require('../commands/autopilot');
const fleet = require('../lib/fleet');
const { buildRunnerCommand } = require('../lib/runner-command');
const { readCodexSettings, engineRunsView } = require('../lib/roster-models');
const {
  readEngineRegistry,
  readRosterState,
  resolveEngineForRoleRanked,
  rosterJobRole,
  setEngineHealth,
} = require('../lib/engine-registry');
const { memberRosterEngine, resolveEngineForMember } = require('../lib/member-engine');

const NOW = new Date('2026-09-24T12:00:00.000Z');
const RUNNER_ENV = ['ATRIS_RUNNER_PROFILE', 'ATRIS_RUNNER_MODEL', 'ATRIS_RUNNER_BIN', 'ATRIS_RUNNER_COMMAND_TEMPLATE', 'ATRIS_CLAUDE_MODEL', 'ATRIS_CLAUDE_BIN', 'ATRIS_CLAUDE_COMMAND_TEMPLATE'];
const SCRATCH_ENV = ['ATRIS_MACHINE_ROSTER_PATH', 'ATRIS_MACHINE_ROSTER_MD_PATH', 'ATRIS_ROUTER_EXPLAIN', 'ATRIS_CODEX_CONFIG_PATH'];

// The owner's real roster, with the year written on its date.
const OWNER_ROSTER = `search: claude haiku
build: claude opus 5.5
review: codex, backup claude opus 5.5
small build: devin swe-2-max, backup grok, until 2026-10-24
## team
researcher: claude opus 5.5
codex-executor: codex
`;

const CODEX_CONFIG = `# personal codex settings
model = "gpt-6-sol"
model_reasoning_effort = "xhigh"

[profiles.fast]
model = "gpt-6-mini"
model_reasoning_effort = "low"
`;

// A scratch project, a scratch home for the all-projects roster, and a
// scratch codex settings file; the real ~/.atris and ~/.codex are never read.
function withRoom(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-roster-models-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-roster-models-home-'));
  fs.mkdirSync(path.join(root, 'atris'));
  const saved = new Map([...SCRATCH_ENV, ...RUNNER_ENV].map((key) => [key, process.env[key]]));
  for (const key of RUNNER_ENV) delete process.env[key];
  delete process.env.ATRIS_MACHINE_ROSTER_MD_PATH;
  process.env.ATRIS_MACHINE_ROSTER_PATH = path.join(home, '.atris', 'roster.json');
  process.env.ATRIS_ROUTER_EXPLAIN = '0';
  process.env.ATRIS_CODEX_CONFIG_PATH = path.join(home, '.codex', 'config.toml');
  const scratch = {
    home,
    machineMd: path.join(home, '.atris', 'ROSTER.md'),
    codexConfig: process.env.ATRIS_CODEX_CONFIG_PATH,
  };
  try { return fn(root, scratch); } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function ready(root, ...names) {
  readEngineRegistry(root);
  for (const name of names) setEngineHealth(name, 'ready', root);
}

function writeRoster(root, text) {
  fs.writeFileSync(path.join(root, 'atris', 'ROSTER.md'), text);
}

function readRoster(root) {
  return fs.readFileSync(path.join(root, 'atris', 'ROSTER.md'), 'utf8');
}

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function addMember(root, name, role) {
  writeFile(path.join(root, 'atris', 'team', name, 'MEMBER.md'), `---\nname: ${name}\nrole: ${role}\ndescription: test member\n---\n\n# ${name}\n`);
}

function command(root, args, now = NOW) {
  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...parts) => logs.push(parts.join(' '));
  console.error = (...parts) => errors.push(parts.join(' '));
  try {
    const exit = engineCommand(args, { root, now });
    return { exit, out: logs.join('\n'), err: errors.join('\n') };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function warningsOf(root) {
  const read = readRosterState(root, { now: NOW });
  return [...read.project.warnings, ...read.machine.warnings];
}

// --- launch commands ------------------------------------------------------

test('each engine gets its model and effort flags only when they are pinned', () => {
  const cases = [
    ['codex', 'gpt-6-astra', 'medium', /codex exec --model gpt-6-astra -c model_reasoning_effort=medium "\$\(cat/, /codex exec "\$\(cat/],
    ['cursor', 'gpt-5', '', /^cursor-agent --trust --model gpt-5 -p /, /^cursor-agent --trust -p /],
    ['agy', 'gemini-3.8-flash-high', 'high', /--add-dir "\$PWD" --model gemini-3\.8-flash-high --effort high -p /, /--add-dir "\$PWD" -p /],
    ['opencode', 'anthropic/claude-opus-5-5', 'max', /^opencode run --model anthropic\/claude-opus-5-5 --variant max "\$\(cat/, /^opencode run "\$\(cat/],
    ['claude', 'claude-opus-5-5', 'xhigh', /^claude -p .* --model claude-opus-5-5 --effort xhigh --allowedTools /, /^claude -p .* --model claude-opus-5-5 --allowedTools /],
    ['grok', 'grok-4.7', 'low', /^grok --always-approve --model grok-4\.7 --reasoning-effort low -p /, /^grok --always-approve -p /],
    ['devin', 'swe-2-max', '', /^devin -p --permission-mode dangerous --model swe-2-max -- /, /^devin -p --permission-mode dangerous -- /],
  ];
  for (const [engine, model, effort, pinned, bare] of cases) {
    const withPin = fleet.buildEngineCommand(engine, '/tmp/p.md', { model, effort });
    const without = fleet.buildEngineCommand(engine, '/tmp/p.md');
    assert.match(withPin, pinned, engine);
    assert.match(without, bare, engine);
    assert.doesNotMatch(without, /--effort|--variant|--reasoning-effort|model_reasoning_effort/, engine);
    if (engine !== 'claude') assert.doesNotMatch(without, /--model/, engine);
  }
  // agy no longer forces a model of its own: it rides the agy CLI default.
  process.env.ATRIS_RUNNER_PROFILE = 'agy';
  try {
    assert.doesNotMatch(buildRunnerCommand({ promptFile: '/tmp/p.md' }), /--model/);
  } finally {
    delete process.env.ATRIS_RUNNER_PROFILE;
  }
});

test('an engine that cannot take an effort refuses it at launch instead of running without it', () => {
  assert.throws(() => fleet.buildEngineCommand('devin', '/tmp/p.md', { effort: 'high' }), /devin cannot take the effort "high"/);
  assert.throws(() => fleet.buildEngineCommand('cursor', '/tmp/p.md', { effort: 'high' }), /cursor cannot take the effort "high"/);
  assert.throws(() => fleet.buildEngineCommand('codex', '/tmp/p.md', { effort: 'max' }), /codex cannot take the effort "max"/);
});

// --- reading lines --------------------------------------------------------

test('effort words follow the model, and an engine that cannot take one is a bad line with a warning', () => withRoom((root) => {
  ready(root, 'codex', 'claude', 'devin', 'grok');
  writeRoster(root, [
    '# roster',
    'review: codex gpt-6-astra medium',
    'build: codex high',
    'small build: devin swe-2-max high, backup grok',
    'deep build: codex gpt-6-astra max',
    'quick build: cursor gpt-5 high',
    'search: claude haiku low',
    '',
  ].join('\n'));
  const picks = readRosterState(root, { now: NOW }).project.picks;
  assert.deepEqual([picks.validator.engine, picks.validator.model, picks.validator.effort], ['codex', 'gpt-6-astra', 'medium']);
  assert.deepEqual([picks.executor.engine, picks.executor.model, picks.executor.effort], ['codex', '', 'high']);
  assert.deepEqual([picks.navigator.engine, picks.navigator.model, picks.navigator.effort], ['claude', 'haiku', 'low']);
  assert.equal(picks['small-build'], undefined);
  assert.equal(picks['deep-build'], undefined);
  assert.equal(picks['quick-build'], undefined);
  const messages = warningsOf(root).map((warning) => `${warning.line}: ${warning.message}`);
  assert.deepEqual(messages, [
    '4: devin cannot take an effort level, so small build uses the next pick in line',
    '5: codex takes effort low, medium, high, xhigh, not "max", so deep build uses the next pick in line',
    '6: cursor cannot take an effort level, so quick build uses the next pick in line',
  ]);
  const view = command(root, ['roster']);
  assert.equal(view.exit, 0, view.err);
  assert.match(view.out, /warning: atris\/ROSTER\.md line 4 "small build: devin swe-2-max high, backup grok" devin cannot take an effort level/);
  // assign refuses the same way, with a plain sentence and no crash.
  const refused = command(root, ['assign', 'small build', 'devin', '--effort', 'high']);
  assert.equal(refused.exit, 2);
  assert.match(refused.err, /devin cannot take an effort level/);
}));

test('a backup carries its own model and effort and never inherits the primary\'s', () => withRoom((root) => {
  ready(root, 'claude', 'codex');
  setEngineHealth('codex', 'credit_out', root);
  writeRoster(root, '# roster\nreview: codex gpt-6-astra high, backup claude opus 5.5 low\nbuild: codex gpt-6-astra high, backup claude\n');
  const picks = readRosterState(root, { now: NOW }).project.picks;
  assert.deepEqual(
    [picks.validator.backup, picks.validator.backup_model, picks.validator.backup_effort],
    ['claude', 'claude-opus-5-5', 'low'],
  );
  const review = resolveEngineForRoleRanked('validator', root, { now: NOW });
  assert.equal(review.engine.id, 'claude');
  assert.equal(review.engine.roster_model, 'claude-opus-5-5');
  assert.equal(review.engine.roster_effort, 'low');
  const build = resolveEngineForRoleRanked('executor', root, { now: NOW });
  assert.equal(build.engine.id, 'claude');
  assert.equal(build.engine.roster_model, undefined);
  assert.equal(build.engine.roster_effort, undefined);
}));

test('codex settings come from the top of a scratch config.toml, never a section', () => withRoom((root, scratch) => {
  assert.deepEqual(readCodexSettings(), {});
  writeFile(scratch.codexConfig, CODEX_CONFIG);
  assert.deepEqual(readCodexSettings(), { model: 'gpt-6-sol', model_reasoning_effort: 'xhigh' });
  assert.deepEqual(readCodexSettings({ codexConfigPath: path.join(scratch.home, 'missing.toml') }), {});
  writeFile(scratch.codexConfig, '[profiles.fast]\nmodel = "gpt-6-mini"\n');
  assert.deepEqual(readCodexSettings(), {});
  writeFile(scratch.codexConfig, "model = 'gpt-6-astra' # pinned\n");
  assert.deepEqual(readCodexSettings(), { model: 'gpt-6-astra' });
}));

// --- the view -------------------------------------------------------------

test('the owner\'s roster shows the real model and its source on every line, in text and json', () => withRoom((root, scratch) => {
  ready(root, 'atris-fast', 'codex', 'claude', 'devin', 'grok', 'haiku');
  writeFile(scratch.codexConfig, CODEX_CONFIG);
  writeRoster(root, OWNER_ROSTER);
  addMember(root, 'researcher', 'Deep Researcher');
  addMember(root, 'codex-executor', 'Builder');
  const view = command(root, ['roster']);
  assert.equal(view.exit, 0, view.err);
  assert.match(view.out, /^search\s+claude \(haiku\)\s+no backup\s+no end date, this project/m);
  assert.match(view.out, /^build\s+claude \(opus 5\.5\)\s+no backup\s+no end date/m);
  assert.match(view.out, /^review\s+codex \(gpt-6-sol, xhigh, from codex settings\)\s+backup claude \(opus 5\.5\)\s+no end date/m);
  assert.match(view.out, /^small build\s+devin \(swe-2-max\)\s+backup grok \(its own default\)\s+until oct 24/m);
  assert.match(view.out, /^researcher\s+search\s+claude \(opus 5\.5\)\s+from atris\/ROSTER\.md$/m);
  assert.match(view.out, /^codex-executor\s+build\s+codex \(gpt-6-sol, xhigh, from codex settings\)\s+from atris\/ROSTER\.md$/m);
  // Never a bare engine name and never an empty model.
  for (const line of view.out.split('\n').filter((text) => text && text !== 'team' && !text.startsWith('warning') && !text.startsWith('see which tools'))) {
    assert.match(line, /\b[a-z-]+ \([^)]+\)/, line);
    assert.doesNotMatch(line, /\(\)/, line);
  }
  const json = JSON.parse(command(root, ['roster', '--json']).out);
  const review = json.jobs.find((row) => row.job === 'review');
  assert.deepEqual(
    [review.runs.engine, review.runs.model, review.runs.model_source, review.runs.effort, review.runs.effort_source],
    ['codex', 'gpt-6-sol', 'codex settings', 'xhigh', 'codex settings'],
  );
  assert.deepEqual([review.backup_runs.engine, review.backup_runs.model, review.backup_runs.model_source], ['claude', 'claude-opus-5-5', 'roster']);
  for (const row of json.jobs) {
    assert.ok(row.runs && row.runs.text, row.job);
    assert.ok(row.runs.model || row.runs.model_source === 'own default', row.job);
  }
}));

test('with no pin, each engine names where its model comes from', () => withRoom(() => {
  assert.equal(engineRunsView('codex').text, 'codex (its own default)');
  assert.equal(engineRunsView('claude').text, 'claude (opus 5.5, atris default)');
  assert.equal(engineRunsView('haiku').text, 'haiku (haiku 4.5, atris default)');
  assert.equal(engineRunsView('grok').text, 'grok (its own default)');
  assert.equal(engineRunsView('devin').text, 'devin (its own default)');
  assert.equal(engineRunsView('claude', { effort: 'high' }).text, 'claude (opus 5.5 by atris default, high)');
  assert.equal(engineRunsView('codex', { model: 'gpt-6-astra', effort: 'medium' }).text, 'codex (gpt-6-astra, medium)');
}));

// --- time caps ------------------------------------------------------------

test('"max 20 min" is read in every spelling and reaches autopilot, plan review, dispatch, and missions', () => withRoom((root) => {
  ready(root, 'codex', 'claude', 'haiku');
  writeRoster(root, [
    '# roster',
    'review: codex gpt-6-astra medium, max 20 min',
    'build: codex gpt-6-astra high max 90s, backup claude',
    'search: haiku, max 2h',
    'small build: claude, max soon',
    '',
  ].join('\n'));
  const picks = readRosterState(root, { now: NOW }).project.picks;
  assert.equal(picks.validator.max_seconds, 1200);
  assert.equal(picks.executor.max_seconds, 90);
  assert.equal(picks.navigator.max_seconds, 7200);
  assert.deepEqual(warningsOf(root).map((warning) => warning.message), [
    '"max soon" is not a time cap; use max 20 min, max 90s, or max 2h, so small build uses the next pick in line',
  ]);
  const prompt = path.join(root, 'prompt.md');

  // Autopilot's review phase runs the review line with its effort and cap.
  const review = buildPhaseRunner('review', prompt, root);
  assert.match(review.command, /^codex exec --model gpt-6-astra -c model_reasoning_effort=medium /);
  assert.equal(review.timeoutMs, 1200000);

  // Plan review uses the review pick too, not the default runner.
  const planReview = buildPlanReviewRunner(prompt, root);
  assert.match(planReview.command, /^codex exec --model gpt-6-astra -c model_reasoning_effort=medium /);
  assert.equal(planReview.timeoutMs, 1200000);

  // A one-lap build carries the pins into the fleet dispatch backstop.
  const executor = readyExecutor(root);
  assert.equal(executor.id, 'codex');
  const pins = lapModelPins(executor, []);
  assert.deepEqual(pins, { model: 'gpt-6-astra', effort: 'high', maxSeconds: 90, validatorModels: null });
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-roster-models-wt-'));
  try {
    let seen = null;
    fleet.dispatchToEngine({
      task: { display_id: 'CAP-1', title: 'cap test' },
      engine: 'codex',
      worktreePath: worktree,
      skipBriefCapture: true,
      model: pins.model,
      effort: pins.effort,
      maxSeconds: pins.maxSeconds,
      runner: (cmd, options) => {
        seen = { cmd, options };
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    assert.match(seen.cmd, /--max-runtime 90 /);
    assert.match(seen.cmd, /codex exec --model gpt-6-astra -c model_reasoning_effort=high /);
    assert.equal(seen.options.timeoutMs, 150000);
    fleet.dispatchToEngine({
      task: { display_id: 'CAP-2', title: 'cap test' },
      engine: 'claude',
      worktreePath: worktree,
      skipBriefCapture: true,
      maxSeconds: 1200,
      runner: (cmd, options) => {
        seen = { cmd, options };
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(seen.options.timeoutMs, 1200000);
  } finally {
    fs.rmSync(worktree, { recursive: true, force: true });
  }

  // A mission tick on the build pick stops at the line's cap.
  const mission = resolveMissionTickRunner({ runner: 'auto' }, root, { now: NOW }).mission;
  assert.equal(mission.runner, 'codex');
  assert.equal(mission.roster_effort, 'high');
  assert.equal(mission.roster_max_seconds, 90);
  assert.equal(missionTickTimeoutMs(mission, 10 * 60 * 60 * 1000), 90000);
  assert.equal(missionTickTimeoutMs(mission, 5000), 5000);
}));

test('with no roster, autopilot, plan review, dispatch, and missions launch exactly as before', () => withRoom((root) => {
  ready(root, 'atris-fast', 'codex', 'claude', 'haiku');
  const prompt = path.join(root, 'prompt.md');
  const base = buildRunnerCommand({ promptFile: prompt, allowedTools: 'Bash,Read,Write,Edit,Glob,Grep' });
  for (const phase of ['plan', 'do', 'review']) {
    assert.deepEqual(buildPhaseRunner(phase, prompt, root), { command: base, timeoutMs: null }, phase);
  }
  assert.deepEqual(buildPlanReviewRunner(prompt, root), {
    command: buildRunnerCommand({ promptFile: prompt, allowedTools: 'Bash,Read,Grep,Glob' }),
    timeoutMs: 180000,
  });
  assert.match(fleet.buildEngineCommand('codex', '/tmp/p.md'), /--max-runtime 3600 /);
  const mission = resolveMissionTickRunner({ runner: 'auto' }, root, { now: NOW }).mission;
  assert.equal(mission.roster_effort, undefined);
  assert.equal(mission.roster_max_seconds, undefined);
  assert.equal(fs.existsSync(path.join(root, 'atris', 'ROSTER.md')), false);
}));

// --- assign ---------------------------------------------------------------

test('assign writes effort, time cap, and a backup with its own model, and keeps a note at the end of the line', () => withRoom((root) => {
  ready(root, 'codex', 'claude');
  writeRoster(root, '# roster\n\nreview: claude <!-- keep this note -->\nbuild: claude\n');
  const assigned = command(root, ['assign', 'review', 'codex', '--model', 'gpt-6-astra', '--effort', 'medium', '--max', '20 min', '--backup', 'claude opus 5.5']);
  assert.equal(assigned.exit, 0, assigned.err);
  assert.match(readRoster(root), /^## review <!-- keep this note -->\n- codex, model: gpt-6-astra, effort: medium, max: 20 min\n- claude code, model: opus 5\.5, max: 20 min$/m);
  assert.match(readRoster(root), /^## build\n- claude code$/m);
  const pick = readRosterState(root, { now: NOW }).project.picks.validator;
  assert.deepEqual(
    [pick.engine, pick.model, pick.effort, pick.backup, pick.backup_model, pick.max_seconds],
    ['codex', 'gpt-6-astra', 'medium', 'claude', 'claude-opus-5-5', 1200],
  );
  assert.equal(command(root, ['assign', 'build', 'codex', '--max', 'soon']).exit, 2);
  assert.equal(command(root, ['assign', 'build', 'codex', '--effort', 'loud']).exit, 2);
}));

// --- dates, kinds, and member cards ---------------------------------------

test('until needs a year: a year-less date is a bad line that suggests the full date, and the pick counts as expired', () => withRoom((root) => {
  ready(root, 'codex', 'claude');
  addMember(root, 'judge', 'Architect');
  writeRoster(root, '# roster\nbuild: codex, backup claude opus 5.5, until oct 24\nreview: codex, until oct 24 2026\n\n## team\njudge: codex, until oct 24\n');
  const picks = readRosterState(root, { now: NOW }).project.picks;
  assert.equal(picks.validator.until, '2026-10-24');
  const build = resolveEngineForRoleRanked('executor', root, { now: NOW });
  assert.equal(build.engine.id, 'claude');
  assert.equal(build.engine.roster_model, 'claude-opus-5-5');
  assert.match(build.reason, /expired, using backup: claude/);
  const report = command(root, ['roster']);
  assert.equal(report.exit, 0, report.err);
  assert.match(report.out, /line 2 "build: codex, backup claude opus 5\.5, until oct 24" has no year in its until date, so build counts as expired; write until 2026-10-24\./);
  assert.match(report.out, /line 6 "judge: codex, until oct 24" has no year in its until date, so it counts as expired; write until 2026-10-24\./);
  assert.match(report.out, /^build\s+codex \(its own default\).*expired, using backup/m);
  // The judge's own line does not decide; the review line does.
  assert.equal(resolveEngineForMember('judge', root, { now: NOW }).pick_source, 'project');
  // An unrelated edit much later never revives it.
  assert.equal(command(root, ['assign', 'search', 'claude'], new Date('2027-09-01T12:00:00Z')).exit, 0);
  assert.match(readRoster(root), /^## build\n- codex, until oct 24\n- claude code, model: opus 5\.5$/m);
  assert.equal(resolveEngineForRoleRanked('executor', root, { now: NOW }).engine.id, 'claude');
}));

test('a project pick that cannot run does not decide a custom job\'s kind over a ready all-projects pick', () => withRoom((root, scratch) => {
  ready(root, 'claude', 'cursor');
  setEngineHealth('cursor', 'credit_out', root);
  writeRoster(root, '# roster\nodd job (like build): cursor\n');
  writeFile(scratch.machineMd, '# roster\nodd job (like review): claude\n');
  assert.equal(rosterJobRole('odd job', root, { now: NOW }), 'validator');
  const picked = resolveEngineForRoleRanked('validator', root, { now: NOW, job: 'odd job' });
  assert.equal(picked.engine.id, 'claude');
  assert.equal(picked.source, 'machine');
  setEngineHealth('cursor', 'ready', root);
  assert.equal(rosterJobRole('odd job', root, { now: NOW }), 'executor');
}));

test('a worktree reads a member card that only exists in the main checkout', () => withRoom((main) => {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-roster-models-linked-'));
  try {
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'linked')}\n`);
    writeRoster(main, '# roster\nbuild: claude opus 5.5\n');
    addMember(main, 'closer', 'Closer');
    ready(worktree, 'claude');
    const picked = memberRosterEngine('closer', worktree, { now: NOW });
    assert.ok(picked, 'the main checkout card counts from the worktree');
    assert.equal(picked.engine.id, 'claude');
    assert.equal(picked.model, 'claude-opus-5-5');
    assert.equal(memberRosterEngine('nobody', worktree, { now: NOW }), null);
  } finally {
    fs.rmSync(worktree, { recursive: true, force: true });
  }
}));
