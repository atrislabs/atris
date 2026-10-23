const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The gate runs lesson detectors through the verify runner, which reads these
// ATRIS_* variables. Pin them so the run never depends on the caller's shell.
const ENV_KEYS = ['ATRIS_VERIFY_IN_PROGRESS', 'ATRIS_VERIFY_SPAWN_CAP', 'ATRIS_VERIFY_TIMEOUT_MS'];
const savedEnv = {};
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-policy-gate-home-'));

test.before(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  savedEnv.HOME = process.env.HOME;
  process.env.HOME = fakeHome;
});

test.after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

const { candidatePolicyGate } = require('../lib/auto-accept-certified');

const EM_DASH = String.fromCharCode(0x2014);

function makeWorkspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-policy-gate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  return root;
}

function taskFor(root, files) {
  const metadata = {};
  if (files !== undefined) metadata.changed_files = files;
  return { workspace_root: root, metadata };
}

function writeLessons(root, lessons) {
  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris', 'lessons.json'), JSON.stringify(lessons));
}

test('a task that records no paths or branch stays advisory and passes', (t) => {
  const root = makeWorkspace(t);
  fs.writeFileSync(path.join(root, 'docs', 'old-debt.md'), `old${EM_DASH}debt\n`);

  const result = candidatePolicyGate(taskFor(root));

  assert.deepStrictEqual(result, {
    ok: true,
    gate: {
      scope: 'unknown',
      paths: [],
      advisory_only: true,
      advisories: [{
        reason: 'candidate_scope_unknown',
        detail: 'no exact diff or declared artifact paths were recorded',
      }],
      bypassed: false,
    },
  });
});

test('a clean declared file passes with an exact, non-advisory scope', (t) => {
  const root = makeWorkspace(t);
  fs.writeFileSync(path.join(root, 'docs', 'landing.md'), '# clean candidate\n');

  const result = candidatePolicyGate(taskFor(root, ['docs/landing.md']));

  assert.deepStrictEqual(result, {
    ok: true,
    gate: {
      scope: 'declared',
      paths: ['docs/landing.md'],
      advisory_only: false,
      advisories: [],
      bypassed: false,
    },
  });
});

test('declared paths accept comma or newline lists and drop duplicates', (t) => {
  const root = makeWorkspace(t);
  fs.writeFileSync(path.join(root, 'docs', 'a.md'), '# a\n');
  fs.writeFileSync(path.join(root, 'docs', 'b.md'), '# b\n');

  const result = candidatePolicyGate(taskFor(root, 'docs/a.md, docs/b.md\ndocs/a.md'));

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.gate.paths, ['docs/a.md', 'docs/b.md']);
  assert.strictEqual(result.gate.advisory_only, false);
});

test('an em dash in a touched markdown file is refused with rule and location', (t) => {
  const root = makeWorkspace(t);
  fs.writeFileSync(path.join(root, 'docs', 'landing.md'), `# fixture\nlanding${EM_DASH}proof\n`);

  const result = candidatePolicyGate(taskFor(root, ['docs/landing.md']));

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.eligible, false);
  assert.strictEqual(result.reason, 'slop_gate');
  assert.deepStrictEqual(result.rules, ['em-dash']);
  assert.deepStrictEqual(result.findings, [{
    file: 'docs/landing.md',
    line: 2,
    rule: 'em-dash',
    severity: 'warn',
  }]);
  assert.deepStrictEqual(result.offenders, ['docs/landing.md:2 em-dash']);
  assert.strictEqual(result.next_action, 'fix docs/landing.md:2 em-dash, then re-certify');
  assert.match(result.message, /cannot land yet/);
  assert.strictEqual(result.gate.scope, 'declared');
  assert.deepStrictEqual(result.gate.paths, ['docs/landing.md']);
  assert.strictEqual(result.gate.advisory_only, false);
});

test('slop in a file the task did not touch does not block it', (t) => {
  const root = makeWorkspace(t);
  fs.writeFileSync(path.join(root, 'docs', 'old-debt.md'), `old${EM_DASH}debt\n`);
  fs.writeFileSync(path.join(root, 'docs', 'landing.md'), '# clean candidate\n');

  const result = candidatePolicyGate(taskFor(root, ['docs/landing.md']));

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.gate.paths, ['docs/landing.md']);
});

test('declared paths that escape the workspace or use globs stay advisory', (t) => {
  const root = makeWorkspace(t);
  fs.writeFileSync(path.join(root, 'docs', 'landing.md'), `bad${EM_DASH}copy\n`);

  for (const declared of [['../outside.md'], ['docs/*.md'], ['https://example.com/x.md'], ['docs/landing.md', '.']]) {
    const result = candidatePolicyGate(taskFor(root, declared));

    assert.strictEqual(result.ok, true, JSON.stringify(declared));
    assert.strictEqual(result.gate.scope, 'declared');
    assert.deepStrictEqual(result.gate.paths, []);
    assert.strictEqual(result.gate.advisory_only, true);
    assert.deepStrictEqual(result.gate.advisories, [{
      reason: 'candidate_scope_unknown',
      detail: 'declared candidate paths are ambiguous or outside the workspace',
    }]);
  }
});

test('a branch with no base ref is advisory and never reads git', (t) => {
  const root = makeWorkspace(t);
  const task = taskFor(root);
  task.metadata.branch = 'feature/landing';

  const result = candidatePolicyGate(task);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.gate.scope, 'branch');
  assert.strictEqual(result.gate.advisory_only, true);
  assert.deepStrictEqual(result.gate.advisories, [{
    reason: 'candidate_scope_unknown',
    detail: 'candidate branch has no exact base ref',
  }]);
});

test('a failing detector-backed lesson refuses the work by lesson id', (t) => {
  const root = makeWorkspace(t);
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'landing.md'), '# candidate\n');
  fs.writeFileSync(path.join(root, 'scripts', 'detector.js'), 'process.exit(3);\n');
  writeLessons(root, {
    'plain-landing-copy': {
      applies_to: ['docs/landing.md'],
      detector: 'node scripts/detector.js',
      status: 'resolved',
    },
  });
  const verifyCache = new Map();

  const result = candidatePolicyGate(taskFor(root, ['docs/landing.md']), { verifyCache, executeDetectors: true });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.eligible, false);
  assert.strictEqual(result.reason, 'lesson_gate');
  assert.strictEqual(result.lesson_id, 'plain-landing-copy');
  assert.deepStrictEqual(result.lesson_ids, ['plain-landing-copy']);
  assert.deepStrictEqual(result.lessons, [{
    lesson_id: 'plain-landing-copy',
    detector: 'node scripts/detector.js',
    exit_code: 3,
    matched_path: 'docs/landing.md',
  }]);
  assert.match(result.next_action, /repair lesson plain-landing-copy/);
  assert.strictEqual(verifyCache.size, 1);
});

test('a passing detector lets the work through with no advisories', (t) => {
  const root = makeWorkspace(t);
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'landing.md'), '# candidate\n');
  fs.writeFileSync(path.join(root, 'scripts', 'detector.js'), 'process.exit(0);\n');
  writeLessons(root, {
    'plain-landing-copy': {
      applies_to: ['docs/landing.md'],
      detector: 'node scripts/detector.js',
    },
  });

  const result = candidatePolicyGate(taskFor(root, ['docs/landing.md']));

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.gate.advisories, []);
});

test('lessons that match nothing or have no detector never block', (t) => {
  const root = makeWorkspace(t);
  fs.writeFileSync(path.join(root, 'docs', 'landing.md'), '# candidate\n');
  writeLessons(root, {
    'elsewhere-only': { applies_to: ['lib/other.js'], detector: 'node scripts/never-runs.js' },
    'human-copy-review': { applies_to: ['docs/landing.md'], status: 'observed' },
  });

  const result = candidatePolicyGate(taskFor(root, ['docs/landing.md']));

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.gate.advisories, [{
    reason: 'lesson_has_no_detector',
    lesson_id: 'human-copy-review',
    matched_path: 'docs/landing.md',
  }]);
});

test('executeDetectors false defers the detector instead of running it', (t) => {
  const root = makeWorkspace(t);
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'landing.md'), '# candidate\n');
  fs.writeFileSync(path.join(root, 'scripts', 'detector.js'), 'process.exit(1);\n');
  writeLessons(root, {
    'plain-landing-copy': {
      applies_to: ['docs/landing.md'],
      detector: 'node scripts/detector.js',
    },
  });

  const result = candidatePolicyGate(taskFor(root, ['docs/landing.md']), { executeDetectors: false });

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.gate.advisories, [{
    reason: 'lesson_detector_pending',
    lesson_id: 'plain-landing-copy',
    matched_path: 'docs/landing.md',
  }]);
});

test('a detector the runner refuses is an advisory, not a verdict on the work', (t) => {
  const root = makeWorkspace(t);
  fs.writeFileSync(path.join(root, 'docs', 'landing.md'), '# candidate\n');
  writeLessons(root, {
    'plain-landing-copy': {
      applies_to: ['docs/landing.md'],
      detector: 'curl http://example.invalid/check',
    },
  });

  const result = candidatePolicyGate(taskFor(root, ['docs/landing.md']));

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.gate.advisories, [{
    reason: 'lesson_detector_unrunnable',
    lesson_id: 'plain-landing-copy',
    detector_reason: 'verify_command_not_allowed',
    matched_path: 'docs/landing.md',
  }]);
});

test('slop is reported before any lesson detector runs', (t) => {
  const root = makeWorkspace(t);
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'landing.md'), `a${EM_DASH}b\n`);
  fs.writeFileSync(path.join(root, 'scripts', 'detector.js'), 'process.exit(1);\n');
  writeLessons(root, {
    'plain-landing-copy': {
      applies_to: ['docs/landing.md'],
      detector: 'node scripts/detector.js',
    },
  });
  const verifyCache = new Map();

  const result = candidatePolicyGate(taskFor(root, ['docs/landing.md']), { verifyCache });

  assert.strictEqual(result.reason, 'slop_gate');
  assert.strictEqual(verifyCache.size, 0);
});
