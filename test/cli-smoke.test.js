const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-cli-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd, input } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    input,
    encoding: 'utf8',
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
    },
  });

  if (result.error) {
    throw result.error;
  }

  return result;
}

test('init creates structured TODO and feature templates', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['init'], { cwd: dir, input: '\n' });
    assert.equal(res.status, 0, res.stderr);

    const todoPath = path.join(dir, 'atris', 'TODO.md');
    assert.ok(fs.existsSync(todoPath), 'TODO.md should exist');
    const todo = fs.readFileSync(todoPath, 'utf8');
    assert.match(todo, /## Backlog/);
    assert.match(todo, /## In Progress/);
    assert.match(todo, /## Completed/);

    const templatesDir = path.join(dir, 'atris', 'features', '_templates');
    assert.ok(fs.existsSync(path.join(templatesDir, 'idea.md.template')));
    assert.ok(fs.existsSync(path.join(templatesDir, 'build.md.template')));
    assert.ok(fs.existsSync(path.join(templatesDir, 'validate.md.template')));
  } finally {
    cleanupTempDir(dir);
  }
});

test('log writes numbered inbox items (I#)', () => {
  const dir = makeTempDir();
  try {
    runCli(['init'], { cwd: dir, input: '\n' });

    const res = runCli(['log'], { cwd: dir, input: 'First idea\nexit\n' });
    assert.equal(res.status, 0, res.stderr);

    const logsDir = path.join(dir, 'atris', 'logs');
    const yearDirs = fs.readdirSync(logsDir);
    assert.ok(yearDirs.length > 0, 'logs year directory should exist');

    const yearDir = path.join(logsDir, yearDirs[0]);
    const logFiles = fs.readdirSync(yearDir).filter((f) => f.endsWith('.md'));
    assert.ok(logFiles.length > 0, 'a log file should be created');

    const content = fs.readFileSync(path.join(yearDir, logFiles[0]), 'utf8');
    assert.match(content, /- \*\*I1:\*\*\s+First idea/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('activate prints core file paths', () => {
  const dir = makeTempDir();
  try {
    runCli(['init'], { cwd: dir, input: '\n' });

    const res = runCli(['activate'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Atris Activate — Context Loaded/);
    assert.match(res.stdout, /atris[\\/]+TODO\.md/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('natural-language entry passes request into plan output', () => {
  const dir = makeTempDir();
  try {
    runCli(['init'], { cwd: dir, input: '\n' });
    fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), '# MAP.md\n\n## By-Feature\n- example: bin/atris.js:1\n', 'utf8');

    const res = runCli(['build', 'a', 'thing'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /DIRECT REQUEST/);
    assert.match(res.stdout, /build a thing/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('default entry auto-advances to plan when inbox has items', () => {
  const dir = makeTempDir();
  try {
    runCli(['init'], { cwd: dir, input: '\n' });
    fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), '# MAP.md\n\n## By-Feature\n- example: bin/atris.js:1\n', 'utf8');
    runCli(['log'], { cwd: dir, input: 'Idea one\nexit\n' });

    const res = runCli([], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Atris Plan — Navigator Agent Activated/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('default entry prompts for MAP bootstrap when MAP.md is placeholder', () => {
  const dir = makeTempDir();
  try {
    runCli(['init'], { cwd: dir, input: '\n' });

    const res = runCli([], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /BOOTSTRAP/i);
    assert.match(res.stdout, /MAP\.md/i);
  } finally {
    cleanupTempDir(dir);
  }
});

test('default entry auto-advances to do when backlog tasks exist', () => {
  const dir = makeTempDir();
  try {
    runCli(['init'], { cwd: dir, input: '\n' });
    fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), '# MAP.md\n\n## By-Feature\n- example: bin/atris.js:1\n', 'utf8');

    const todoPath = path.join(dir, 'atris', 'TODO.md');
    fs.writeFileSync(
      todoPath,
      `# TODO.md\n\n## Backlog\n\n- implement thing\n\n## In Progress\n\n(Empty)\n\n## Completed\n\n(Empty)\n`,
      'utf8'
    );

    const res = runCli([], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Atris Do — Executor Agent Activated/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('default entry auto-advances to review when completed tasks exist', () => {
  const dir = makeTempDir();
  try {
    runCli(['init'], { cwd: dir, input: '\n' });
    fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), '# MAP.md\n\n## By-Feature\n- example: bin/atris.js:1\n', 'utf8');

    const todoPath = path.join(dir, 'atris', 'TODO.md');
    fs.writeFileSync(
      todoPath,
      `# TODO.md\n\n## Backlog\n\n(Empty)\n\n## In Progress\n\n(Empty)\n\n## Completed\n\n- validate thing\n`,
      'utf8'
    );

    const res = runCli([], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Atris Review — Validator Agent Activated/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('help lists activate command', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['help'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /\bactivate\b/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('--help flag shows help', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['--help'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /atrisDev/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('status --quick reflects inbox count', () => {
  const dir = makeTempDir();
  try {
    runCli(['init'], { cwd: dir, input: '\n' });

    let res = runCli(['status', '--quick'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /📥\s+\d+\s+\|\s+📋\s+\d+\s+\|\s+🔨\s+\d+\s+\|\s+✅\s+\d+/);

    runCli(['log'], { cwd: dir, input: 'Idea one\nexit\n' });
    res = runCli(['status', '--quick'], { cwd: dir });
    assert.match(res.stdout, /📥\s+1\s+\|/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('plan suggests brainstorm when uncertainty detected', () => {
  const dir = makeTempDir();
  try {
    runCli(['init'], { cwd: dir, input: '\n' });
    runCli(['log'], { cwd: dir, input: "not sure what to build yet\nexit\n" });

    const res = runCli(['plan'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Try `atris brainstorm` first/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('do prints concise executor prompt by default', () => {
  const dir = makeTempDir();
  try {
    runCli(['init'], { cwd: dir, input: '\n' });

    const res = runCli(['do'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /COPY\/PASTE PROMPT/);
    assert.match(res.stdout, /You are the Executor/);
    assert.doesNotMatch(res.stdout, /EXECUTOR SPEC — How to Build/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('do --full includes full executor dumps', () => {
  const dir = makeTempDir();
  try {
    runCli(['init'], { cwd: dir, input: '\n' });

    const res = runCli(['do', '--full'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /EXECUTOR SPEC \(full\)/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('review prints concise validator prompt by default', () => {
  const dir = makeTempDir();
  try {
    runCli(['init'], { cwd: dir, input: '\n' });

    const res = runCli(['review'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /COPY\/PASTE PROMPT/);
    assert.match(res.stdout, /You are the Validator/);
    assert.doesNotMatch(res.stdout, /📋 AGENT SPEC/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('review --full includes full validator dumps', () => {
  const dir = makeTempDir();
  try {
    runCli(['init'], { cwd: dir, input: '\n' });

    const res = runCli(['review', '--full'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /VALIDATOR SPEC \(full\)/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('update migrates TASK_CONTEXTS.md to TODO.md', () => {
  const dir = makeTempDir();
  try {
    runCli(['init'], { cwd: dir, input: '\n' });

    const atrisDir = path.join(dir, 'atris');
    const todoPath = path.join(atrisDir, 'TODO.md');
    const legacyPath = path.join(atrisDir, 'TASK_CONTEXTS.md');

    fs.writeFileSync(legacyPath, '# TASK_CONTEXTS.md\n\n## Backlog\n\n- legacy task\n', 'utf8');
    fs.rmSync(todoPath);

    const res = runCli(['update'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.ok(fs.existsSync(todoPath), 'TODO.md should exist after migration');
    assert.ok(!fs.existsSync(legacyPath), 'TASK_CONTEXTS.md should be migrated away');
  } finally {
    cleanupTempDir(dir);
  }
});
