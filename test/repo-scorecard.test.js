'use strict';
require('./helpers/clean-temp');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync, spawnSync } = require('node:child_process');
const sc = require('../lib/repo-scorecard');

const CLI = path.join(__dirname, '..', 'bin', 'atris.js');

function gitEnv() {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[name];
  return env;
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv() }).trim();
}

function commit(repo, files, message) {
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(repo, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  git(repo, 'add', '-A');
  git(repo, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

const ADD = 'exports.add = (a, b) => a + b;\n';
const ADD_AND_SUBTRACT = `${ADD}exports.subtract = (a, b) => a - b;\n`;
const ADD_TEST = [
  "const test = require('node:test');",
  "const assert = require('node:assert');",
  "const m = require('../lib/math');",
  "test('add', () => assert.equal(m.add(2, 3), 5));",
  '',
].join('\n');
const SUBTRACT_TEST = `${ADD_TEST}test('subtract', () => assert.equal(m.subtract(5, 3), 2));\n`;

// A repo with one change its own tests can grade (subtract), one with no
// tests (readme), and one whose tests already passed before it (tidy).
function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-scorecard-repo-'));
  git(repo, 'init', '-q');
  commit(repo, { 'package.json': '{"name":"demo","version":"1.0.0"}\n', 'lib/math.js': ADD, 'test/math.test.js': ADD_TEST },
    'start the math helpers');
  const base = git(repo, 'rev-parse', 'HEAD');
  const fix = commit(repo, { 'lib/math.js': ADD_AND_SUBTRACT, 'test/math.test.js': SUBTRACT_TEST },
    'add a subtract function to lib/math that returns a minus b (#12)\n\nCo-Authored-By: Someone <s@example.com>');
  commit(repo, { 'README.md': '# demo\n' }, 'write a short readme for the demo');
  commit(repo, { 'lib/math.js': `${ADD_AND_SUBTRACT}// tidy\n`, 'test/math.test.js': `${SUBTRACT_TEST}// tidy\n` },
    'tidy the math helpers with a comment');
  return { repo, base, fix };
}

// Stands in for `claude -p`: records what it was given, then acts by mode.
function fakeEngine() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-scorecard-engine-'));
  const bin = path.join(dir, 'fake-claude');
  fs.writeFileSync(bin, `#!${process.execPath}
const fs = require('fs');
const { execFileSync } = require('child_process');
let prompt = '';
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  const say = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
  say({ type: 'system', subtype: 'init', apiKeySource: process.env.FAKE_SOURCE || 'none' });
  if (process.env.FAKE_SOURCE) {
    setTimeout(() => { fs.writeFileSync(process.env.FAKE_MARK, 'worked'); say({ type: 'result', is_error: false }); }, 3000);
    return;
  }
  if (process.env.FAKE_RECORD) {
    fs.writeFileSync(process.env.FAKE_RECORD, JSON.stringify({
      env: process.env, argv: process.argv.slice(2), prompt,
      remotes: execFileSync('git', ['remote'], { encoding: 'utf8' }),
      visibleTest: fs.readFileSync('test/math.test.js', 'utf8'),
    }));
  }
  if (process.env.FAKE_MODE === 'limit') {
    say({ type: 'result', is_error: true, result: 'Claude AI usage limit reached' });
    return;
  }
  if (process.env.FAKE_MODE === 'pass') fs.writeFileSync('lib/math.js', ${JSON.stringify(ADD_AND_SUBTRACT)});
  say({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } });
  say({ type: 'result', total_cost_usd: 0.02, num_turns: 4, is_error: false,
    modelUsage: { 'claude-haiku-5-5': { costUSD: 0.02 } } });
});
`, { mode: 0o755 });
  return bin;
}

function planHome({ extraUsage = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-scorecard-home-'));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    oauthAccount: { accountUuid: 'u-1', organizationType: 'claude_max', hasExtraUsageEnabled: extraUsage },
  }));
  return home;
}

test('a change hides every test path and runs only real test files', () => {
  const shape = sc.classifyChange(['M\tlib/a.js', 'A\ttest/a.test.js', 'M\ttest/fixtures/data.json', 'M\ttest/helpers/x.js']);
  assert.deepEqual(shape.hidden, ['test/a.test.js', 'test/fixtures/data.json', 'test/helpers/x.js']);
  assert.deepEqual(shape.runnable, ['test/a.test.js']);
  assert.deepEqual(shape.source, ['lib/a.js']);
  assert.equal(shape.deletedTest, false);
  assert.equal(sc.classifyChange(['D\ttest/old.test.js', 'M\tlib/a.js']).deletedTest, true);
  assert.deepEqual(sc.classifyChange(['M\tbackend/tests/test_api.py', 'M\tbackend/api.py']).runnable, ['backend/tests/test_api.py']);
});

test('the ask drops trailers, merge lines and pull request numbers', () => {
  const text = 'Merge pull request #9 from org/branch\n\nadd a flag (#9)\n\nCo-Authored-By: A <a@x.com>\n🤖 Generated with [Claude Code](https://claude.com/claude-code)';
  assert.equal(sc.cleanMessage(text), 'add a flag');
});

test('billing keys and switches never reach a child, the plan token does', () => {
  const env = sc.stripBilling({
    ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_BASE_URL: 'u', OPENAI_API_KEY: 'k',
    AWS_SECRET_ACCESS_KEY: 's', CLAUDE_CODE_USE_BEDROCK: '1', GH_TOKEN: 'g', STRIPE_API_KEY: 'k',
    GIT_DIR: '/x', CLAUDE_CODE_OAUTH_TOKEN: 'plan', PATH: '/bin', HOME: '/h',
  });
  assert.deepEqual(Object.keys(env).sort(), ['CLAUDE_CODE_OAUTH_TOKEN', 'HOME', 'PATH']);
});

test('test commands come from config first, then the nearest project', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-scorecard-runner-'));
  fs.mkdirSync(path.join(root, 'backend', 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'backend', 'requirements.txt'), 'pytest\n');
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  assert.deepEqual(sc.resolveRunner(root, ['backend/tests/test_a.py']), { kind: 'pytest', dir: 'backend' });
  assert.deepEqual(sc.resolveRunner(root, ['test/a.test.js']), { kind: 'node', dir: '' });
  assert.equal(sc.resolveRunner(root, ['backend/tests/test_a.py', 'test/a.test.js']), null);
  const config = { tests: [{ match: '^backend/', dir: 'backend', cmd: 'OFFLINE=1 python -m pytest -q {files}', env: { ENV: 'test' } }] };
  const runner = sc.resolveRunner(root, ['backend/tests/test_a.py'], config);
  assert.equal(runner.kind, 'custom');
  const cmd = sc.runnerCommand(runner, ["backend/tests/test_it's.py"], '/copy');
  assert.equal(cmd.cwd, path.join('/copy', 'backend'));
  assert.equal(cmd.args[1], "OFFLINE=1 python -m pytest -q 'tests/test_it'\\''s.py'");
});

test('finding tasks keeps only changes their own tests grade, with no AI', async () => {
  const { repo, base, fix } = makeRepo();
  const found = await sc.findTasks(repo, { max: 5, workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'atris-scorecard-work-')) });
  assert.equal(found.tasks.length, 1);
  const [task] = found.tasks;
  assert.equal(task.fix, fix);
  assert.equal(task.base, base);
  assert.equal(task.ask, 'add a subtract function to lib/math that returns a minus b');
  assert.deepEqual(task.hidden, ['test/math.test.js']);
  assert.equal(task.runner.kind, 'node');
  assert.equal(found.skipped.no_tests, 1);
  assert.equal(found.skipped.passes_before, 1);
});

test('a try works in a sealed copy on the plan login and is graded by the hidden tests', async () => {
  const { repo, fix } = makeRepo();
  const head = git(repo, 'rev-parse', 'HEAD');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-scorecard-work-'));
  const [task] = (await sc.findTasks(repo, { workDir: work })).tasks;
  const record = path.join(work, 'record.json');
  const env = {
    ...process.env, FAKE_MODE: 'pass', FAKE_RECORD: record, ATRIS_SCORECARD_ENGINE: fakeEngine(),
    ANTHROPIC_API_KEY: 'sk-test', AWS_SECRET_ACCESS_KEY: 'aws', CLAUDE_CODE_USE_BEDROCK: '1', GH_TOKEN: 'ghp',
  };
  const row = await sc.runTry(repo, task, 'claude-haiku-5-5', { env, workDir: work });
  assert.equal(row.passed, true, row.test_tail || row.harness_error || row.engine_tail);
  assert.equal(row.cost_usd, 0.02);
  assert.equal(row.model_used, 'claude-haiku-5-5');
  assert.deepEqual(row.files_changed, ['lib/math.js']);

  const seen = JSON.parse(fs.readFileSync(record, 'utf8'));
  for (const name of ['ANTHROPIC_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'GH_TOKEN']) {
    assert.equal(seen.env[name], undefined, `${name} reached the engine`);
  }
  assert.equal(seen.env.GIT_CONFIG_KEY_0, 'url.no-push://atris-scorecard-blocked/.pushInsteadOf');
  assert.equal(seen.remotes.trim(), '');
  assert.ok(seen.prompt.startsWith('add a subtract function to lib/math'));
  assert.ok(!seen.visibleTest.includes('subtract'), 'the grading test was visible to the AI');
  assert.equal(row.billing, 'plan');
  assert.ok(seen.argv.includes('--no-session-persistence'));
  assert.ok(seen.argv.includes('Bash(git push:*)'));

  assert.equal(git(repo, 'status', '--porcelain'), '');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
  assert.ok(fix);
});

test('a try that changes nothing fails and shows up as not done', async () => {
  const { repo } = makeRepo();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-scorecard-work-'));
  const { tasks } = await sc.findTasks(repo, { workDir: work });
  const env = { ...process.env, FAKE_MODE: 'nothing', ATRIS_SCORECARD_ENGINE: fakeEngine() };
  const { rows } = await sc.runAll(repo, tasks, { models: ['claude-haiku-5-5'], env, workDir: work, jobs: 1 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].passed, false);
  assert.ok(rows[0].test_tail);
  const summary = sc.summarize(tasks, rows, ['claude-haiku-5-5']);
  assert.equal(summary.models[0].passes, 0);
  assert.equal(summary.no_model.length, 1);
  const text = sc.renderScorecard(summary, { repo: 'demo', plan: 'Claude max plan' });
  assert.match(text, /not done from what was written/);
  assert.match(text, /billed \$0/);
});

test('a plan that runs out stops the run, and finished tries are not run again', async () => {
  const { repo } = makeRepo();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-scorecard-work-'));
  const { tasks } = await sc.findTasks(repo, { workDir: work });
  const env = { ...process.env, FAKE_MODE: 'limit', ATRIS_SCORECARD_ENGINE: fakeEngine() };
  const limited = await sc.runAll(repo, tasks, { models: ['claude-haiku-5-5'], tries: 3, jobs: 1, env, workDir: work });
  assert.equal(limited.stopped, true);
  assert.equal(limited.rows.length, 1);
  assert.equal(limited.rows[0].engine_error, true);

  const done = [{ id: tasks[0].id, model: 'claude-haiku-5-5', n: 0, passed: true }];
  const again = await sc.runAll(repo, tasks, { models: ['claude-haiku-5-5'], tries: 1, done, env, workDir: work });
  assert.equal(again.planned, 0);
  assert.equal(again.rows.length, 0);
});

test('a run about to bill a key instead of the plan is stopped before it works', async () => {
  const { repo } = makeRepo();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-scorecard-work-'));
  const { tasks } = await sc.findTasks(repo, { workDir: work });
  const mark = path.join(work, 'worked');
  const env = { ...process.env, FAKE_SOURCE: 'ANTHROPIC_API_KEY', FAKE_MARK: mark, ATRIS_SCORECARD_ENGINE: fakeEngine() };
  const started = Date.now();
  const out = await sc.runAll(repo, tasks, { models: ['claude-haiku-5-5'], tries: 2, jobs: 1, env, workDir: work });
  assert.equal(out.stopped, true);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].not_plan, true);
  assert.equal(out.rows[0].billing, 'ANTHROPIC_API_KEY');
  assert.ok(Date.now() - started < 3000);
  assert.equal(fs.existsSync(mark), false);
});

test('no AI starts without a plan login, with extra usage on, or past haiku without a yes', () => {
  const engine = fakeEngine();
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-scorecard-home-'));
  assert.throws(() => sc.preflight(['claude-haiku-5-5'], { env: { HOME: empty, PATH: '' } }), /log in first/);

  const extra = planHome({ extraUsage: true });
  assert.throws(() => sc.preflight(['claude-haiku-5-5'], { env: { HOME: extra, PATH: '', ATRIS_SCORECARD_ENGINE: engine } }), /extra usage is on/);
  assert.equal(sc.preflight(['claude-haiku-5-5'], {
    env: { HOME: extra, PATH: '', ATRIS_SCORECARD_ENGINE: engine }, allowExtraUsage: true,
  }).bin, engine);

  const home = planHome();
  const env = { HOME: home, PATH: '', ATRIS_SCORECARD_ENGINE: engine };
  assert.throws(() => sc.preflight(['claude-haiku-5-5', 'claude-opus-5-5'], { env }), /ATRIS_CLAUDE_SPEND_OK=claude-opus-5-5/);
  const ok = sc.preflight(['claude-opus-5-5'], { env: { ...env, ATRIS_CLAUDE_SPEND_OK: 'claude-opus-5-5' } });
  assert.equal(ok.plan, 'Claude max plan');
});

test('cheapest first counts the pricier model only where the cheaper one failed', () => {
  const tasks = [{ id: 't1', fix: 'a'.repeat(40), ask: 'one', hidden: [] }, { id: 't2', fix: 'b'.repeat(40), ask: 'two', hidden: [] }];
  const rows = [
    { id: 't1', model: 'claude-haiku-5-5', n: 0, passed: true, cost_usd: 0.05, minutes: 2 },
    { id: 't2', model: 'claude-haiku-5-5', n: 0, passed: false, cost_usd: 0.05, minutes: 3 },
    { id: 't1', model: 'claude-opus-5-5', n: 0, passed: true, cost_usd: 0.8, minutes: 5 },
    { id: 't2', model: 'claude-opus-5-5', n: 0, passed: true, cost_usd: 0.8, minutes: 6 },
    { id: 'gone', model: 'claude-opus-5-5', n: 0, passed: true, cost_usd: 9 },
  ];
  const summary = sc.summarize(tasks, rows, ['claude-haiku-5-5', 'claude-opus-5-5']);
  assert.deepEqual(summary.ladder.order, ['claude-haiku-5-5', 'claude-opus-5-5']);
  assert.equal(summary.ladder.done, 2);
  assert.ok(Math.abs(summary.ladder.cost_per_pass - 0.45) < 1e-9);
  assert.equal(summary.models[1].cost_per_pass, 0.8);
  assert.equal(summary.no_model.length, 0);
  assert.match(sc.renderScorecard(summary, { repo: 'demo' }), /cheapest first \(haiku 5\.5, then opus 5\.5/);
});

test('atris scorecard finds, runs and shows from the command line', () => {
  const { repo } = makeRepo();
  const home = planHome();
  const env = {
    ...process.env, HOME: home, ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_NO_UPDATE_CHECK: '1',
    ATRIS_SCORECARD_ENGINE: fakeEngine(), FAKE_MODE: 'pass',
  };
  const cli = (...args) => spawnSync(process.execPath, [CLI, 'scorecard', ...args], { cwd: repo, env, encoding: 'utf8' });

  const found = cli('find');
  assert.equal(found.status, 0, found.stderr);
  assert.match(found.stdout, /found 1 task in 3 past changes/);
  assert.match(cli().stdout, /1 tasks found, none tried yet/);

  const ran = cli('run');
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, /pass {2}haiku 5\.5/);
  assert.match(ran.stdout, /1 of 1/);
  assert.match(ran.stdout, /on your Claude max plan/);

  const shown = cli('show', '--json');
  assert.equal(JSON.parse(shown.stdout).models[0].passes, 1);
  assert.equal(git(repo, 'status', '--porcelain'), '');
});
