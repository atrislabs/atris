'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loopsCommand } = require('../commands/loops');

const TEMPLATE_ROOT = path.join(__dirname, '..', 'templates', 'loops');

// loopsCommand works on process.cwd() and the heartbeat registry, and only
// prints and returns an exit code. Run it in-process inside a temp project
// with HOME and the heartbeat dir pointed at temp folders, console captured.
function makeSandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-loops-test-'));
  const project = path.join(root, 'project');
  const home = path.join(root, 'home');
  const heartbeat = path.join(root, 'heartbeat');
  for (const dir of [project, home, heartbeat]) fs.mkdirSync(dir, { recursive: true });

  const saved = {
    cwd: process.cwd(),
    HOME: process.env.HOME,
    ATRIS_HEARTBEAT_DIR: process.env.ATRIS_HEARTBEAT_DIR,
  };
  process.env.HOME = home;
  process.env.ATRIS_HEARTBEAT_DIR = heartbeat;
  process.chdir(project);

  t.after(() => {
    process.chdir(saved.cwd);
    for (const key of ['HOME', 'ATRIS_HEARTBEAT_DIR']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  // Realpath so comparisons survive /var -> /private/var on macOS.
  return { root, project: fs.realpathSync(project), heartbeat };
}

function run(t, ...args) {
  const out = [];
  const err = [];
  t.mock.method(console, 'log', (...parts) => out.push(parts.join(' ')));
  t.mock.method(console, 'error', (...parts) => err.push(parts.join(' ')));
  let exitCode = null;
  t.mock.method(process, 'exit', (code) => {
    exitCode = code;
    throw new Error(`process.exit(${code})`);
  });
  let code;
  try {
    code = loopsCommand(...args);
  } catch (error) {
    if (exitCode === null) throw error;
  }
  return { code, exitCode, out: out.join('\n'), err: err.join('\n') };
}

function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function snapshot(dir) {
  const found = [];
  (function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else found.push(path.relative(dir, full));
    }
  })(dir);
  return found.sort();
}

test('help flags and unknown subcommands print usage and exit 0 without touching files', (t) => {
  const { project } = makeSandbox(t);
  const cases = [
    ['--help'],
    ['-h'],
    ['help'],
    ['nonsense'],
    ['init', '--help'],
    ['tick', '-h'],
    ['stop', '--help'],
  ];
  for (const args of cases) {
    const result = run(t, ...args);
    assert.strictEqual(result.code, 0, `exit code for ${args.join(' ')}`);
    assert.match(result.out, /^Usage: atris loops \[audit\|init\|tick\|board\|start\|stop\]/, args.join(' '));
    assert.match(result.out, /atris loops init\s+- scaffold atris\/loops \+ loop wiki/);
    assert.match(result.out, /atris loops stop <id>\s+- disable a registry job or stop a launchd agent/);
    t.mock.restoreAll();
  }
  assert.deepStrictEqual(snapshot(project), [], 'help must not create any project files');
});

test('audit with no atris/loops folder says how to start and exits 1', (t) => {
  makeSandbox(t);
  const bare = run(t);
  assert.strictEqual(bare.code, 1);
  assert.match(bare.out, /^No atris\/loops directory found\./);
  assert.match(bare.out, /Run: atris loops init/);
  assert.match(bare.out, /SELF-IMPROVING: NOT YET, 1 open$/);
  t.mock.restoreAll();

  // An existing folder holding only the protocol files has no loops to audit.
  const project = process.cwd();
  write(path.join(project, 'atris', 'loops', 'LOOPS.md'), '# loops\n');
  write(path.join(project, 'atris', 'loops', 'TICK.md'), '# tick\n');
  const empty = run(t, 'audit');
  assert.strictEqual(empty.code, 1);
  assert.match(empty.out, /^No loop files found in atris\/loops\./);
  assert.match(empty.out, /SELF-IMPROVING: NOT YET, 1 open$/);
});

test('init scaffolds every file once, fills in the date, and skips existing files on a rerun', (t) => {
  const { project } = makeSandbox(t);
  const expected = [
    'atris/loops/LOOPS.md',
    'atris/loops/TICK.md',
    'atris/loops/feedback.md',
    'atris/loops/quality.md',
    'atris/wiki/systems/loops.md',
  ];

  const first = run(t, 'init');
  assert.strictEqual(first.code, 0);
  assert.match(first.out, /^atris loops init/);
  const createdBlock = first.out.split('created:\n')[1].split('\n\nskipped:')[0];
  assert.deepStrictEqual(createdBlock.split('\n').map((line) => line.trim()), expected);
  assert.match(first.out, /skipped:\n {2}none/);
  assert.match(first.out, /Next: fill Owner\/Wiki\/Runner TODOs, then run atris loops audit$/);
  assert.deepStrictEqual(snapshot(project), [...expected].sort());

  for (const rel of expected) {
    const text = fs.readFileSync(path.join(project, rel), 'utf8');
    assert.ok(!text.includes('{{DATE}}'), `${rel} still has a raw date placeholder`);
  }
  const template = fs.readFileSync(path.join(TEMPLATE_ROOT, 'atris/loops/quality.md'), 'utf8');
  assert.ok(template.includes('{{DATE}}'), 'quality template is expected to carry the placeholder');
  const rendered = fs.readFileSync(path.join(project, 'atris/loops/quality.md'), 'utf8');
  assert.strictEqual(rendered, template.split('{{DATE}}').join(localToday()));
  t.mock.restoreAll();

  // Edit one file, rerun: nothing is overwritten and everything is skipped.
  const edited = path.join(project, 'atris/loops/LOOPS.md');
  fs.writeFileSync(edited, 'my own notes\n');
  const second = run(t, 'init');
  assert.strictEqual(second.code, 0);
  assert.match(second.out, /created:\n {2}none/);
  const skippedBlock = second.out.split('skipped:\n')[1].split('\n\nNext:')[0];
  assert.deepStrictEqual(skippedBlock.split('\n').map((line) => line.trim()), expected);
  assert.strictEqual(fs.readFileSync(edited, 'utf8'), 'my own notes\n');
});

test('audit passes a complete loop and reports each problem on a broken one', (t) => {
  const { project } = makeSandbox(t);
  const today = localToday();

  write(path.join(project, 'atris', 'team', 'builder', 'MEMBER.md'), '# builder\n');
  write(path.join(project, 'atris', 'wiki', 'systems', 'good.md'), '# good\n');
  write(path.join(project, 'atris', 'loops', 'good.md'), [
    '# good loop',
    '',
    '**Owner:** `team/builder`',
    '**Wiki:** [good](../wiki/systems/good.md#how)',
    '**Runner:** `atris tick`',
    '**Protects:** the build stays green',
    '**Signal:** failing builds per week',
    '**Cadence:** daily',
    '**Check:** `exit 0`',
    '',
    '## Log',
    `- ${today}: ran clean`,
    '',
  ].join('\n'));

  const healthy = run(t, 'audit');
  assert.strictEqual(healthy.code, 0);
  assert.match(healthy.out, /^atris loops audit/);
  assert.match(healthy.out, /✅ good\n/);
  assert.match(healthy.out, /↳ check: `exit 0` exit 0/);
  assert.match(healthy.out, /SELF-IMPROVING: YES$/);
  t.mock.restoreAll();

  write(path.join(project, 'atris', 'loops', 'bad.md'), '# bad loop\n\nnothing filled in\n');
  write(path.join(project, 'atris', 'loops', 'ghost.md'), [
    '**Owner:** `team/nobody`',
    '**Wiki:** [gone](../wiki/systems/gone.md)',
    '**Runner:** `atris tick`',
    '**Protects:** x',
    '**Signal:** y',
    '**Cadence:** daily',
    '**Check:** `exit 3`',
    '- 2020-01-01: ancient entry',
    '',
  ].join('\n'));

  const broken = run(t, 'audit');
  assert.strictEqual(broken.code, 1);
  assert.match(broken.out, /✅ good\n/);
  assert.match(broken.out, /❌ bad\n/);
  for (const problem of [
    'no Owner field',
    'no Wiki field',
    'no Runner field',
    'no Protects field',
    'no Signal field',
    'no Cadence field',
    'no dated Log entries',
  ]) {
    assert.ok(broken.out.includes(`   ↳ ${problem}`), `bad loop should report: ${problem}`);
  }
  assert.match(broken.out, /❌ ghost\n/);
  assert.ok(broken.out.includes('   ↳ owner team/nobody does not exist'));
  assert.ok(broken.out.includes('   ↳ wiki page ../wiki/systems/gone.md missing'));
  assert.ok(broken.out.includes('   ↳ log stale: newest 2020-01-01'));
  assert.ok(broken.out.includes('   ↳ check failed: exit 3'));
  assert.match(broken.out, /SELF-IMPROVING: NOT YET, 2 open$/);
});

test('tick prints the project TICK.md when present and the packaged one otherwise', (t) => {
  const { project } = makeSandbox(t);
  const packaged = fs.readFileSync(path.join(TEMPLATE_ROOT, 'atris/loops/TICK.md'), 'utf8').trimEnd();

  const fallback = run(t, 'tick');
  assert.strictEqual(fallback.code, 0);
  assert.strictEqual(fallback.out, packaged);
  t.mock.restoreAll();

  write(path.join(project, 'atris', 'loops', 'TICK.md'), '# custom tick\n\nstep one\n\n\n');
  const local = run(t, 'tick');
  assert.strictEqual(local.code, 0);
  assert.strictEqual(local.out, '# custom tick\n\nstep one');
});

test('stop and start flip a registry job, write a backup, and reject bad ids', (t) => {
  const { heartbeat } = makeSandbox(t);
  const registryFile = path.join(heartbeat, 'registry.json');
  const original = {
    jobs: [
      { id: 'night-sweep', cadence_minutes: 120, purpose: 'sweep', enabled: true },
      { id: 'other-job', cadence_minutes: 15, purpose: 'other' },
    ],
  };
  fs.writeFileSync(registryFile, `${JSON.stringify(original, null, 2)}\n`);

  const stopped = run(t, 'stop', 'night-sweep');
  assert.strictEqual(stopped.code, 0);
  assert.strictEqual(stopped.out, 'Disabled night-sweep in the heartbeat registry (backup written).');
  const afterStop = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
  const sweep = afterStop.jobs.find((job) => job.id === 'night-sweep');
  assert.strictEqual(sweep.enabled, false);
  assert.strictEqual(sweep.disabled, true);
  assert.strictEqual(sweep.disabled_reason, `stopped via atris loops ${localToday()}`);
  assert.deepStrictEqual(afterStop.jobs.find((job) => job.id === 'other-job'), original.jobs[1]);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(`${registryFile}.bak`, 'utf8')), original);
  t.mock.restoreAll();

  const started = run(t, 'start', 'night-sweep');
  assert.strictEqual(started.code, 0);
  assert.strictEqual(started.out, 'Enabled night-sweep in the heartbeat registry (backup written).');
  const revived = JSON.parse(fs.readFileSync(registryFile, 'utf8')).jobs.find((job) => job.id === 'night-sweep');
  assert.strictEqual(revived.enabled, true);
  assert.ok(!('disabled' in revived));
  assert.ok(!('disabled_reason' in revived));
  t.mock.restoreAll();

  const unknown = run(t, 'stop', 'no-such-job');
  assert.strictEqual(unknown.exitCode, 1);
  assert.strictEqual(unknown.err, 'No registry job named "no-such-job". Run: atris loops board');
  t.mock.restoreAll();

  const missing = run(t, 'start');
  assert.strictEqual(missing.exitCode, 1);
  assert.strictEqual(missing.err, 'Usage: atris loops start <id>');
});
