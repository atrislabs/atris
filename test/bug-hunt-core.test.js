'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir(t, prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runCli(args, { cwd, env = {}, timeout = 15000 } = {}) {
  const merged = {
    ...scrubAgentEnv(),
    ATRIS_SKIP_UPDATE_CHECK: '1',
    ATRIS_NO_INTERACTIVE: '1',
    ATRIS_NONINTERACTIVE: '1',
    NODE_NO_WARNINGS: '1',
    ...env,
  };
  if (!Object.prototype.hasOwnProperty.call(env, 'ATRIS_TASKS_DB')) {
    delete merged.ATRIS_TASKS_DB;
  }
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    env: merged,
    encoding: 'utf8',
    timeout,
  });
  assert.ifError(result.error);
  return result;
}

function gitOk(cwd, args) {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'tester',
      GIT_AUTHOR_EMAIL: 'tester@example.com',
      GIT_COMMITTER_NAME: 'tester',
      GIT_COMMITTER_EMAIL: 'tester@example.com',
    },
  });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  return res;
}

// Bug 1 [P0]: taskProjection drops events past row 10,000; listTaskEvents drops worktree events.
test('bug 1: taskProjection retains newest task events past 10,000 historical events and listTaskEvents includes linked worktrees', (t) => {
  const root = makeTempDir(t, 'atris-bug1-');
  const mainRepo = path.join(root, 'main');
  const worktreeRepo = path.join(root, 'wt');
  const dbPath = path.join(root, 'tasks.db');
  fs.mkdirSync(mainRepo, { recursive: true });
  gitOk(mainRepo, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(mainRepo, 'README.md'), '# test\n');
  gitOk(mainRepo, ['add', 'README.md']);
  gitOk(mainRepo, ['commit', '-qm', 'init']);
  gitOk(mainRepo, ['worktree', 'add', '-q', '-b', 'wt-branch', worktreeRepo]);

  const taskDb = require('../lib/task-db');
  const db = taskDb.open(dbPath);
  t.after(() => taskDb.close());

  const mainWs = taskDb.workspaceRoot(mainRepo);
  const wtWs = taskDb.workspaceRoot(worktreeRepo);

  // Create one archived task and flood 10,050 historical events onto it in a single transaction.
  const oldTask = taskDb.addTask(db, { title: 'Ancient archived task', workspaceRoot: mainWs, status: 'archived' });
  const insertEvent = db.prepare(`
    INSERT INTO task_events (event_id, task_id, version, workspace_root, actor, event_type, payload, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.exec('BEGIN');
  try {
    const baseTs = Date.now() - 20_000_000;
    for (let i = 0; i < 10_050; i += 1) {
      insertEvent.run(
        `EV_${String(i).padStart(6, '0')}`,
        oldTask.id,
        i + 2,
        mainWs,
        'history-bot',
        'message',
        JSON.stringify({ content: `hist-${i}` }),
        baseTs + i,
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  // Create a fresh open task whose events sit well past row 10,000.
  const freshTask = taskDb.addTask(db, { title: 'Fresh visible task', workspaceRoot: mainWs });
  taskDb.noteTask(db, { id: freshTask.id, actor: 'alice', content: 'recent note past 10k rows' });

  // Create a task in the linked worktree and append an event to it.
  const wtTask = taskDb.addTask(db, { title: 'Linked worktree task', workspaceRoot: wtWs });
  taskDb.noteTask(db, { id: wtTask.id, actor: 'bob', content: 'worktree note' });

  const proj = taskDb.taskProjection(db, { workspaceRoot: mainWs, doneLimit: 0 });
  const freshProj = proj.tasks.find((item) => item.id === freshTask.id);
  assert.ok(freshProj, 'fresh open task must be in projection');
  assert.ok(
    freshProj.messages.some((m) => m.content === 'recent note past 10k rows'),
    'taskProjection must include events for visible tasks even when >10,000 older events exist',
  );

  const wtProj = proj.tasks.find((item) => item.id === wtTask.id);
  assert.ok(wtProj, 'linked worktree task must be in projection');
  assert.ok(
    wtProj.messages.some((m) => m.content === 'worktree note'),
    'taskProjection must include events for linked worktree tasks',
  );

  const wtEvents = taskDb.listTaskEvents(db, { workspaceRoot: mainWs, order: 'desc', limit: 20 });
  assert.ok(
    wtEvents.some((e) => e.task_id === wtTask.id && e.payload && e.payload.content === 'worktree note'),
    'listTaskEvents(workspaceRoot) must include events from linked worktrees',
  );
});

// Bug 2 [P0]: Stored XSS in atris task serve board HTML template.
test('bug 2: taskBoardHtml escapes actor, status, claimed_by, and display_id in innerHTML', () => {
  const { taskBoardHtml } = require('../lib/task-core');
  const html = taskBoardHtml();
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, 'board HTML must contain inline script');

  // Execute the board script in a sandbox with a minimal DOM stub and trigger render().
  const elements = new Map();
  function makeEl(id = '') {
    const el = {
      id,
      className: '',
      _innerHTML: '',
      textContent: '',
      value: '',
      disabled: false,
      style: { setProperty() {} },
      children: [],
      onclick: null,
      onsubmit: null,
      focus() {},
      appendChild(child) { this.children.push(child); return child; },
      querySelector() { return makeEl(); },
      querySelectorAll(sel) {
        if (sel === '.goalitem') return [];
        if (sel === '.chainbox .chainitem strong') return [makeEl(), makeEl()];
        if (sel === '.stream h2' || sel === '.stream' || sel === '.streamtask strong' || sel === '.msg div:last-child') return [makeEl()];
        if (sel === '.pill') return [makeEl(), makeEl(), makeEl()];
        return [];
      },
      get innerHTML() { return this._innerHTML; },
      set innerHTML(v) { this._innerHTML = String(v); },
    };
    if (id) elements.set(id, el);
    return el;
  }

  for (const id of [
    'board', 'room', 'overview', 'streams', 'activity', 'heartbeat', 'create', 'refresh',
    'title', 'tag', 'note', 'proof', 'lesson', 'nextTask', 'claim', 'saveNote',
    'requestChange', 'finish', 'taskWhatChanges', 'taskWhyItMatters', 'taskDoneLooksLike',
    'taskApproval', 'taskTechnicalDetails', 'taskGoal', 'taskLineage', 'taskHappened',
    'taskChecked', 'taskTested', 'taskDecision', 'taskProof',
  ]) {
    makeEl(id);
  }

  const xssPayload = '<img src=x onerror=alert(1)>';
  const task = {
    id: '01XSS000000000000000000000',
    display_id: xssPayload,
    title: 'Safe title',
    status: xssPayload,
    claimed_by: xssPayload,
    current_version: 1,
    latest_event_type: 'reviewed',
    messages: [{ actor: xssPayload, version: 1, content: 'hello' }],
    review: { next_task: 'next' },
    explanation: { what_changes: 'changes' },
    approval: {},
  };

  const sandbox = {
    document: {
      getElementById: (id) => elements.get(id) || makeEl(id),
      createElement: () => makeEl(),
    },
    location: { search: '' },
    URLSearchParams,
    fetch: async () => ({
      ok: true,
      json: async () => ({
        projection: {
          tasks: [task],
          goals: { items: [] },
          streams: [{
            objective: 'Stream 1',
            active_count: 1,
            done_count: 0,
            open_count: 1,
            doing_count: 0,
            review_count: 0,
            blocked_count: 0,
            tasks: [task],
          }],
        },
        heartbeat: {},
        events: [],
      }),
    }),
    setInterval: () => 0,
  };

  const scriptBody = scriptMatch[1].replace(/\bload\(\);\s*setInterval\(load,\s*2500\);/, '');
  const wrapped = `${scriptBody}\n;globalThis.__testHooks = { render, renderRoom, renderOverview, renderStreams, setState: (s, sel) => { state = s; selected = sel; } };`;
  vm.runInNewContext(wrapped, sandbox);
  sandbox.__testHooks.setState({
    tasks: [task],
    goals: { items: [] },
    streams: [{
      objective: 'Stream 1',
      active_count: 1,
      done_count: 0,
      open_count: 1,
      doing_count: 0,
      review_count: 0,
      blocked_count: 0,
      tasks: [task],
    }],
  }, task.id);
  sandbox.__testHooks.render();

  for (const id of ['room', 'overview', 'streams']) {
    const rendered = elements.get(id).innerHTML;
    assert.ok(!rendered.includes('<img'), `${id} innerHTML must not contain unescaped <img tag: ${rendered}`);
    assert.ok(rendered.includes('&lt;img'), `${id} innerHTML must HTML-escape injected payload: ${rendered}`);
  }
});

// Bug 3 [P1]: Global ~/.atris/ hijacks workspace detection for fresh folders under $HOME.
test('bug 3: global ~/.atris does not hijack findWorkspaceRoot or doctor detectWorkspaceRoot for fresh subfolders', (t) => {
  const root = makeTempDir(t, 'atris-bug3-');
  const fakeHome = path.join(root, 'home');
  const freshFolder = path.join(fakeHome, 'Desktop', 'fresh-folder');
  const gitRepo = path.join(fakeHome, 'projects', 'app');
  const gitSub = path.join(gitRepo, 'src');

  fs.mkdirSync(path.join(fakeHome, '.atris'), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, '.atris', 'tasks.db'), '');
  fs.mkdirSync(freshFolder, { recursive: true });
  fs.mkdirSync(path.join(gitRepo, '.git'), { recursive: true });
  fs.mkdirSync(gitSub, { recursive: true });

  const prevHome = process.env.HOME;
  const prevStateDir = process.env.ATRIS_TEST_STATE_DIR;
  process.env.HOME = fakeHome;
  delete process.env.ATRIS_TEST_STATE_DIR;
  t.after(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevStateDir === undefined) delete process.env.ATRIS_TEST_STATE_DIR;
    else process.env.ATRIS_TEST_STATE_DIR = prevStateDir;
  });

  const { findWorkspaceRoot } = require('../lib/workspace-root');
  const { collectDoctor } = require('../commands/doctor');

  assert.equal(findWorkspaceRoot(freshFolder), path.resolve(freshFolder));
  assert.equal(
    collectDoctor({ cwd: freshFolder, binInstalled: () => false }).workspace_root,
    path.resolve(freshFolder),
  );
  assert.equal(
    collectDoctor({ cwd: gitSub, binInstalled: () => false }).workspace_root,
    path.resolve(gitRepo),
  );

  // If $HOME actually has atris/atris.md, it IS a real workspace spine.
  fs.mkdirSync(path.join(fakeHome, 'atris'), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, 'atris', 'atris.md'), '# home workspace\n');
  assert.equal(findWorkspaceRoot(freshFolder), path.resolve(fakeHome));
  assert.equal(
    collectDoctor({ cwd: freshFolder, binInstalled: () => false }).workspace_root,
    path.resolve(fakeHome),
  );
});

// Bug 4 [P1]: atris task flag parser swallows positionals after boolean flags, writes ./true or ./--json, ignores --flag=value.
test('bug 4: task flag() supports --flag=value and missing values, positional() preserves args after boolean flags, and export rejects bad --out', (t) => {
  const { flag, positional } = require('../lib/task-core');

  assert.equal(flag(['--out=custom.json'], '--out'), 'custom.json');
  assert.equal(flag(['--out', '--json'], '--out'), null);
  assert.equal(flag(['--out'], '--out'), null);
  assert.equal(flag(['--limit', '-1'], '--limit'), '-1');

  assert.deepEqual(positional(['--json', 'CLI-1']), ['CLI-1']);
  assert.deepEqual(positional(['--all', '--claim', '--human', 'CLI-2']), ['CLI-2']);
  assert.deepEqual(positional(['--as=alice', 'CLI-3']), ['CLI-3']);
  assert.deepEqual(positional(['--dry-run', '--force', '--yes', 'CLI-4']), ['CLI-4']);

  const dir = makeTempDir(t, 'atris-bug4-');
  const dbPath = path.join(dir, 'tasks.db');
  const env = { HOME: dir, ATRIS_TASKS_DB: dbPath };
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'atris', 'atris.md'), '# atris\n');

  const added = runCli(['task', 'add', 'Check flag parsing', '--json'], { cwd: dir, env });
  assert.equal(added.status, 0, added.stderr || added.stdout);
  const ref = JSON.parse(added.stdout).task.display_id;

  // Boolean flag before positional ref must not swallow ref.
  const shown = runCli(['task', 'show', '--json', ref], { cwd: dir, env });
  assert.equal(shown.status, 0, shown.stderr || shown.stdout);
  assert.equal(JSON.parse(shown.stdout).display_id, ref);

  // Missing --out value or --out followed by --json must fail cleanly without creating ./true or ./--json.
  const badOutJson = runCli(['task', 'export', '--out', '--json'], { cwd: dir, env });
  assert.equal(badOutJson.status, 2, badOutJson.stdout + badOutJson.stderr);
  assert.equal(JSON.parse(badOutJson.stdout).ok, false);
  assert.equal(fs.existsSync(path.join(dir, '--json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'true')), false);

  const badOutBare = runCli(['task', 'export', '--out'], { cwd: dir, env });
  assert.equal(badOutBare.status, 2, badOutBare.stdout + badOutBare.stderr);
  assert.equal(fs.existsSync(path.join(dir, 'true')), false);

  // --out=value must work.
  const goodOut = runCli(['task', 'export', '--out=custom.json', '--json'], { cwd: dir, env });
  assert.equal(goodOut.status, 0, goodOut.stderr || goodOut.stdout);
  assert.equal(fs.existsSync(path.join(dir, 'custom.json')), true);
});

// Bug 5 [P1]: atris init --minimal --help ignores --help and writes/commits files.
test('bug 5: atris init --minimal --help prints usage and creates no files', (t) => {
  const dir = makeTempDir(t, 'atris-bug5-');
  const env = { HOME: dir };

  for (const args of [
    ['init', '--minimal', '--help'],
    ['init', '--yes', '-h'],
    ['init', '--minimal', '--no-commit', '--help'],
  ]) {
    const res = runCli(args, { cwd: dir, env });
    assert.equal(res.status, 0, `${args.join(' ')}: ${res.stderr}`);
    assert.match(res.stdout, /Usage: atris init/);
    assert.deepEqual(fs.readdirSync(dir), [], `${args.join(' ')} must not create any files`);
  }
});

// Bug 6 [P1]: --json stdout corruption & wiki loop --dry-run disk mutation.
test('bug 6: --json stays valid JSON on task landing, task ready, wiki loop, and bogus top-level flag; wiki loop --dry-run writes nothing', (t) => {
  const freshDir = makeTempDir(t, 'atris-bug6-fresh-');
  const envFresh = { HOME: freshDir, ATRIS_TASKS_DB: path.join(freshDir, 'tasks.db') };

  // wiki loop --dry-run --json must emit pure JSON and touch zero files on disk.
  const loopJson = runCli(['wiki', 'loop', '--dry-run', '--json'], { cwd: freshDir, env: envFresh });
  assert.equal(loopJson.status, 0, loopJson.stderr || loopJson.stdout);
  assert.doesNotMatch(loopJson.stdout, /ACTION TAKEN/);
  const loopPayload = JSON.parse(loopJson.stdout);
  assert.equal(loopPayload.pageCount, 0);
  assert.equal(fs.existsSync(path.join(freshDir, 'atris')), false, 'wiki loop --dry-run must not scaffold atris/');

  const loopText = runCli(['wiki', 'loop', '--dry-run'], { cwd: freshDir, env: envFresh });
  assert.equal(loopText.status, 0, loopText.stderr || loopText.stdout);
  assert.doesNotMatch(loopText.stdout, /ACTION TAKEN/);
  assert.equal(fs.existsSync(path.join(freshDir, 'atris')), false, 'wiki loop --dry-run must remain read-only');

  // atris --json --bogus in a fresh folder must emit valid JSON + exit 2.
  const bogusFresh = runCli(['--json', '--bogus'], { cwd: freshDir, env: envFresh });
  assert.equal(bogusFresh.status, 2, bogusFresh.stdout + bogusFresh.stderr);
  const bogusFreshBody = JSON.parse(bogusFresh.stdout);
  assert.equal(bogusFreshBody.ok, false);

  // Now initialize a workspace for task landing, task ready, and initialized --json --bogus.
  const wsDir = makeTempDir(t, 'atris-bug6-ws-');
  const envWs = { HOME: wsDir, ATRIS_TASKS_DB: path.join(wsDir, 'tasks.db') };
  fs.mkdirSync(path.join(wsDir, 'atris'), { recursive: true });
  fs.writeFileSync(path.join(wsDir, 'atris', 'atris.md'), '# atris\n');
  fs.writeFileSync(path.join(wsDir, 'atris', 'MAP.md'), '# MAP.md\n\n- entry: bin/atris.js:1\n');

  const landing = runCli(['task', 'landing', '--json'], { cwd: wsDir, env: envWs });
  assert.equal(landing.status, 0, landing.stderr || landing.stdout);
  assert.doesNotMatch(landing.stdout, /land everything certified above/);
  const landingBody = JSON.parse(landing.stdout);
  assert.equal(landingBody.ok, true);

  const readyMissing = runCli(['task', 'ready', '--json'], { cwd: wsDir, env: envWs });
  assert.equal(readyMissing.status, 2, readyMissing.stdout + readyMissing.stderr);
  const readyBody = JSON.parse(readyMissing.stdout);
  assert.equal(readyBody.ok, false);

  const bogusWs = runCli(['--json', '--bogus'], { cwd: wsDir, env: envWs });
  assert.equal(bogusWs.status, 2, bogusWs.stdout + bogusWs.stderr);
  const bogusWsBody = JSON.parse(bogusWs.stdout);
  assert.equal(bogusWsBody.ok, false);
});

// Bug 7 [P1]: Unvalidated --limit interpolated directly into SQL.
test('bug 7: listTasks/listTaskEvents bind validated LIMIT ? and task events rejects invalid --limit cleanly', (t) => {
  const dir = makeTempDir(t, 'atris-bug7-');
  const dbPath = path.join(dir, 'tasks.db');
  const env = { HOME: dir, ATRIS_TASKS_DB: dbPath };
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'atris', 'atris.md'), '# atris\n');

  const taskDb = require('../lib/task-db');
  const db = taskDb.open(dbPath);
  t.after(() => taskDb.close());
  const ws = taskDb.workspaceRoot(dir);
  taskDb.addTask(db, { title: 'Task one', workspaceRoot: ws });
  taskDb.addTask(db, { title: 'Task two', workspaceRoot: ws });
  taskDb.addTask(db, { title: 'Task three', workspaceRoot: ws });

  // Direct API must never throw on invalid limits and must floor positive floats.
  for (const badLimit of ['abc', Infinity, -1, NaN, '1; DROP TABLE tasks; --']) {
    assert.doesNotThrow(() => taskDb.listTasks(db, { workspaceRoot: ws, limit: badLimit }));
    assert.doesNotThrow(() => taskDb.listTaskEvents(db, { workspaceRoot: ws, limit: badLimit }));
  }
  assert.equal(taskDb.listTasks(db, { workspaceRoot: ws, limit: 2 }).length, 2);
  assert.equal(taskDb.listTasks(db, { workspaceRoot: ws, limit: 1.9 }).length, 1);
  assert.equal(taskDb.listTaskEvents(db, { workspaceRoot: ws, limit: 2 }).length, 2);
  assert.equal(taskDb.listTaskEvents(db, { workspaceRoot: ws, limit: 1.9 }).length, 1);

  // CLI task events --limit must fail cleanly with JSON on invalid values.
  for (const bad of ['1.5', 'Infinity', '-1', 'abc', '0']) {
    const res = runCli(['task', 'events', '--limit', bad, '--json'], { cwd: dir, env });
    assert.equal(res.status, 2, `--limit ${bad}: ${res.stdout}\n${res.stderr}`);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.ok, false);
  }
});

// Bug 8 [P1]: atris wiki search and wiki log drop the first word of unquoted multi-word local queries.
test('bug 8: local wiki search keeps all words of unquoted multi-word queries and wiki log keeps local slug/limit', (t) => {
  const dir = makeTempDir(t, 'atris-bug8-');
  const env = { HOME: dir };
  const wikiDir = path.join(dir, 'atris', 'wiki');
  fs.mkdirSync(wikiDir, { recursive: true });
  fs.writeFileSync(
    path.join(wikiDir, 'index.md'),
    [
      '# Index',
      '',
      '- [[atris/wiki/concepts/a.md]] - orchard irrigation schedule',
      '- [[atris/wiki/concepts/b.md]] - winter irrigation schedule',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(wikiDir, 'log.md'),
    [
      '# Log',
      '',
      '## 2026-04-07',
      '- 09:00 INGEST first.md',
      '- 10:00 INGEST second.md',
      '',
    ].join('\n'),
  );

  // Unquoted multi-word search must keep the first word ("orchard") instead of treating it as a cloud slug.
  const search = runCli(['wiki', 'search', 'orchard', 'irrigation'], { cwd: dir, env });
  assert.equal(search.status, 0, search.stderr || search.stdout);
  assert.match(search.stdout, /orchard irrigation schedule/);
  assert.doesNotMatch(search.stdout, /winter irrigation schedule/);

  const log = runCli(['wiki', 'log', '1'], { cwd: dir, env });
  assert.equal(log.status, 0, log.stderr || log.stdout);
  assert.match(log.stdout, /second\.md/);
  assert.doesNotMatch(log.stdout, /first\.md/);
});

// Audit Fix 5: parser regressions (flag prose values, -- terminator, --details, done/finish --failed) & board XSS defense-in-depth.
test('audit fix 5: flag/positional keep dashed prose values, honor --, support --details and done/finish --failed, and harden board XSS', (t) => {
  const { flag, hasEmptyFlagValue, positional, taskBoardTemplate, taskBoardHtml } = require('../lib/task-core');

  // Prose values starting with flags (containing whitespace) must be preserved and never leak into positionals.
  assert.equal(flag(['--result', '--json now prints valid JSON'], '--result'), '--json now prints valid JSON');
  assert.equal(flag(['--proof', '-v all tests passed'], '--proof'), '-v all tests passed');
  assert.equal(flag(['--note', '--limit rejects bad values'], '--note'), '--limit rejects bad values');
  assert.deepEqual(
    positional(['--result', '--json now prints valid JSON', '--proof', '-v all tests passed', 'CLI-1']),
    ['CLI-1'],
  );

  // Stop scanning at `--` in flag(), hasEmptyFlagValue(), and positional().
  assert.deepEqual(positional(['--', '--tag', 'weird']), ['--tag', 'weird']);
  assert.equal(flag(['--', '--tag', 'weird'], '--tag'), null);
  assert.equal(hasEmptyFlagValue(['--', '--out='], '--out'), false);
  assert.equal(hasEmptyFlagValue(['--', '--out', ''], '--out'), false);
  assert.equal(hasEmptyFlagValue(['--out='], '--out'), true);

  // --details is a boolean flag; verb-specific booleanFlags work in positional().
  assert.deepEqual(positional(['--details', 'CLI-5']), ['CLI-5']);
  assert.deepEqual(positional(['--failed', 'CLI-6'], { booleanFlags: ['--failed'] }), ['CLI-6']);

  // CLI: `atris task done --failed <id>` and `atris task finish --failed <id>` parse the task ref cleanly.
  const dir = makeTempDir(t, 'atris-audit5-');
  const dbPath = path.join(dir, 'tasks.db');
  const env = { HOME: dir, ATRIS_TASKS_DB: dbPath };
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'atris', 'atris.md'), '# atris\n');

  const added1 = runCli(['task', 'add', 'Fail via done flag first', '--json'], { cwd: dir, env });
  assert.equal(added1.status, 0, added1.stderr || added1.stdout);
  const ref1 = JSON.parse(added1.stdout).task.display_id;
  const doneFailed = runCli(['task', 'done', '--failed', ref1, '--json'], { cwd: dir, env });
  assert.equal(doneFailed.status, 0, doneFailed.stderr || doneFailed.stdout);
  assert.equal(JSON.parse(doneFailed.stdout).action, 'failed');

  const added2 = runCli(['task', 'add', 'Fail via finish flag first', '--json'], { cwd: dir, env });
  assert.equal(added2.status, 0, added2.stderr || added2.stdout);
  const ref2 = JSON.parse(added2.stdout).task.display_id;
  const finishFailed = runCli(['task', 'finish', '--failed', ref2, '--json'], { cwd: dir, env });
  assert.equal(finishFailed.status, 0, finishFailed.stderr || finishFailed.stdout);
  assert.equal(JSON.parse(finishFailed.stdout).task.status, 'failed');

  // Defense-in-depth: script-embedded planTags escapes `<` and renderHeartbeat/renderActivity escape XSS + encodeURIComponent(task.id).
  const templated = taskBoardTemplate({ planTags: ['</script><script>alert(1)</script>'] });
  assert.ok(!templated.includes('</script><script>alert(1)</script>'), 'planTags must not break out of <script>');
  assert.ok(templated.includes('\\u003c/script>'), 'planTags must escape < as \\u003c');

  const html = taskBoardHtml();
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch);
  const elements = new Map();
  const fetchedUrls = [];
  function makeEl(id = '') {
    const el = {
      id,
      className: '',
      _innerHTML: '',
      textContent: '',
      value: '',
      disabled: false,
      style: { setProperty() {} },
      children: [],
      onclick: null,
      onsubmit: null,
      focus() {},
      appendChild(child) { this.children.push(child); return child; },
      querySelector() { return makeEl(); },
      querySelectorAll() { return []; },
      get innerHTML() { return this._innerHTML; },
      set innerHTML(v) { this._innerHTML = String(v); },
    };
    if (id) elements.set(id, el);
    return el;
  }
  for (const id of [
    'board', 'room', 'overview', 'streams', 'activity', 'heartbeat', 'create', 'refresh',
    'title', 'tag', 'note', 'proof', 'lesson', 'nextTask', 'claim', 'saveNote',
    'requestChange', 'finish', 'taskWhatChanges', 'taskWhyItMatters', 'taskDoneLooksLike',
    'taskApproval', 'taskTechnicalDetails', 'taskGoal', 'taskLineage', 'taskHappened',
    'taskChecked', 'taskTested', 'taskDecision', 'taskProof',
  ]) {
    makeEl(id);
  }
  const sandbox = {
    document: {
      getElementById: (id) => elements.get(id) || makeEl(id),
      createElement: () => makeEl(),
    },
    location: { search: '' },
    URLSearchParams,
    encodeURIComponent,
    fetch: async (url) => {
      fetchedUrls.push(url);
      return { ok: true, json: async () => ({ ok: true, projection: { tasks: [] } }) };
    },
    setInterval: () => 0,
  };
  const scriptBody = scriptMatch[1].replace(/\bload\(\);\s*setInterval\(load,\s*2500\);/, '');
  const wrapped = `${scriptBody}\n;globalThis.__hooks = { renderHeartbeat, renderActivity, renderRoom, setState: (s, sel) => { state = s; selected = sel; } };`;
  vm.runInNewContext(wrapped, sandbox);

  const payload = '<img src=x onerror=alert(1)>';
  sandbox.__hooks.renderHeartbeat({ state: 'stale', stale_reason: payload, total_ticks: 3 });
  assert.ok(!elements.get('heartbeat').innerHTML.includes('<img'), 'stale heartbeat must escape HTML');
  assert.ok(elements.get('heartbeat').innerHTML.includes('&lt;img'));

  sandbox.__hooks.renderHeartbeat({ state: 'alive', last_tick_age_min: 1, last_what: payload, total_ticks: 2, reward_sum: 1 });
  assert.ok(!elements.get('heartbeat').innerHTML.includes('<img'), 'alive heartbeat must escape HTML');
  assert.ok(elements.get('heartbeat').innerHTML.includes('&lt;img'));

  sandbox.__hooks.renderActivity([{ ms: Date.now(), source: payload, title: payload, detail: payload, reward: 1 }]);
  assert.ok(!elements.get('activity').innerHTML.includes('<img'), 'activity feed must escape HTML');
  assert.ok(elements.get('activity').innerHTML.includes('&lt;img'));

  const weirdId = '../evil?foo=1#bar';
  sandbox.__hooks.setState({
    tasks: [{ id: weirdId, title: 'Weird', status: 'open', current_version: 1, messages: [], metadata: {}, approval: {} }],
  }, weirdId);
  sandbox.__hooks.renderRoom();
  elements.get('claim').onclick();
  assert.equal(fetchedUrls[0], `/api/tasks/${encodeURIComponent(weirdId)}/claim`);
});

// Audit Fix 6: --flag= validation bypass in sweep + cmdReady unapproved-plan guard for worker envs.
test('audit fix 6: sweep rejects empty --flag= forms and task ready blocks worker on unapproved plan', (t) => {
  const dir = makeTempDir(t, 'atris-audit6-');
  const dbPath = path.join(dir, 'tasks.db');
  const env = { HOME: dir, ATRIS_TASKS_DB: dbPath };
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'atris', 'atris.md'), '# atris\n');

  const badStale = runCli(['task', 'sweep', '--stale-days=', '--dry-run', '--json'], { cwd: dir, env });
  assert.notEqual(badStale.status, 0, 'empty --stale-days= must fail validation');

  const badClaimer = runCli(['task', 'sweep', '--claimer=', '--dry-run', '--json'], { cwd: dir, env });
  assert.notEqual(badClaimer.status, 0, 'empty --claimer= must fail validation');

  const badHeldAs = runCli(['task', 'sweep', '--held', '--as=', '--dry-run', '--json'], { cwd: dir, env });
  assert.equal(badHeldAs.status, 2, badHeldAs.stdout + badHeldAs.stderr);
  assert.equal(JSON.parse(badHeldAs.stdout).reason, 'missing_actor');

  const badHeldConflict = runCli(['task', 'sweep', '--held', '--stale-days=1', '--dry-run', '--json'], { cwd: dir, env });
  assert.equal(badHeldConflict.status, 2, badHeldConflict.stdout + badHeldConflict.stderr);
  assert.equal(JSON.parse(badHeldConflict.stdout).reason, 'held_flags_conflict');

  // Create an open stage=plan task and verify worker env cannot mark it ready before human plan approval.
  const taskDb = require('../lib/task-db');
  const db = taskDb.open(dbPath);
  t.after(() => taskDb.close());
  const ws = taskDb.workspaceRoot(dir);
  const planTask = taskDb.addTask(db, {
    title: 'Approve deployment rollout plan',
    workspaceRoot: ws,
    status: 'open',
    metadata: { stage: 'plan' },
  });

  for (const markerEnv of [{ CLAUDECODE: '1' }, { OPENCODE_SESSION_ID: 'oc-42' }]) {
    const blocked = runCli(
      [
        'task', 'ready', planTask.id,
        '--verify', 'node -e "process.exit(0)"',
        '--no-falsify-check',
        '--result', 'Operators can now read the whole team day on one page instead of scrolling raw logs.',
        '--json',
      ],
      { cwd: dir, env: { ...env, ...markerEnv } },
    );
    assert.equal(blocked.status, 2, `${Object.keys(markerEnv)[0]}: ${blocked.stdout}\n${blocked.stderr}`);
    const payload = JSON.parse(blocked.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.reason, 'agent_proof_only_plan_approval_blocked');
    assert.equal(taskDb.getTask(db, planTask.id).status, 'open');
  }

  // Same command succeeds when run by a human (no worker env markers).
  const humanReady = runCli(
    [
      'task', 'ready', planTask.id,
      '--verify', 'node -e "process.exit(0)"',
      '--no-falsify-check',
      '--result', 'Operators can now read the whole team day on one page instead of scrolling raw logs.',
      '--json',
    ],
    { cwd: dir, env },
  );
  assert.equal(humanReady.status, 0, humanReady.stdout + humanReady.stderr);
  assert.equal(taskDb.getTask(db, planTask.id).status, 'review');
});

// Audit Fix 7: normalizeSqlLimit sub-1 positive floats (0.5) must not produce LIMIT 0.
test('audit fix 7: sub-1 float limits return all rows instead of LIMIT 0', (t) => {
  const dir = makeTempDir(t, 'atris-audit7-');
  const dbPath = path.join(dir, 'tasks.db');
  const taskDb = require('../lib/task-db');
  const db = taskDb.open(dbPath);
  t.after(() => taskDb.close());
  const ws = taskDb.workspaceRoot(dir);
  taskDb.addTask(db, { title: 'Sub-1 limit task A', workspaceRoot: ws });
  taskDb.addTask(db, { title: 'Sub-1 limit task B', workspaceRoot: ws });
  taskDb.addTask(db, { title: 'Sub-1 limit task C', workspaceRoot: ws });

  assert.equal(taskDb.listTasks(db, { workspaceRoot: ws, limit: 0.5 }).length, 3);
  assert.equal(taskDb.listTasks(db, { workspaceRoot: ws, limit: 0.99 }).length, 3);
  assert.ok(taskDb.listTaskEvents(db, { workspaceRoot: ws, limit: 0.5 }).length >= 3);
});

// Audit Fix 9: `atris --json <known-command>` fails cleanly without side effects & flag-like answers fail in initialized workspaces.
test('audit fix 9: leading --json before known command refuses without creating tasks and flag-like input refuses in initialized workspace', (t) => {
  const freshDir = makeTempDir(t, 'atris-audit9-fresh-');
  const freshEnv = { HOME: freshDir, ATRIS_TASKS_DB: path.join(freshDir, 'tasks.db') };

  const ledJsonFresh = runCli(['--json', 'doctor'], { cwd: freshDir, env: freshEnv });
  assert.equal(ledJsonFresh.status, 2, ledJsonFresh.stdout + ledJsonFresh.stderr);
  const freshPayload = JSON.parse(ledJsonFresh.stdout);
  assert.equal(freshPayload.ok, false);
  assert.match(freshPayload.error, /place flags after the command/i);
  assert.equal(fs.existsSync(path.join(freshDir, 'atris')), false, 'must not init atris/ in fresh folder');
  assert.equal(fs.existsSync(path.join(freshDir, '.atris')), false, 'must not create .atris/ in fresh folder');

  const wsDir = makeTempDir(t, 'atris-audit9-ws-');
  const wsEnv = { HOME: wsDir, ATRIS_TASKS_DB: path.join(wsDir, 'tasks.db') };
  fs.mkdirSync(path.join(wsDir, 'atris'), { recursive: true });
  fs.writeFileSync(path.join(wsDir, 'atris', 'atris.md'), '# atris\n');
  fs.writeFileSync(path.join(wsDir, 'atris', 'MAP.md'), '# MAP.md\n\n- entry: bin/atris.js:1\n');
  fs.mkdirSync(path.join(wsDir, '.atris', 'state'), { recursive: true });
  fs.writeFileSync(
    path.join(wsDir, '.atris', 'state', 'context_profile.json'),
    JSON.stringify({ schema: 'atris.context_profile.v1', first_answer: 'maintain the cli' }) + '\n',
  );

  const ledJsonWs = runCli(['--json', 'doctor'], { cwd: wsDir, env: wsEnv });
  assert.equal(ledJsonWs.status, 2, ledJsonWs.stdout + ledJsonWs.stderr);
  assert.equal(JSON.parse(ledJsonWs.stdout).ok, false);

  const flagLikeWs = runCli(['--foo --bar', '--json'], { cwd: wsDir, env: wsEnv });
  assert.equal(flagLikeWs.status, 2, flagLikeWs.stdout + flagLikeWs.stderr);
  const flagLikeBody = JSON.parse(flagLikeWs.stdout);
  assert.equal(flagLikeBody.ok, false);
  assert.match(flagLikeBody.error, /unknown option/i);
  assert.equal(fs.existsSync(path.join(wsDir, '.atris', 'state', 'wishes.jsonl')), false, 'flag-like input must not start one-lap');
});
