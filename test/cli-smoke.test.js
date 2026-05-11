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

    const wikiDir = path.join(dir, 'atris', 'wiki');
    assert.ok(fs.existsSync(path.join(wikiDir, 'wiki.md')));
    assert.ok(fs.existsSync(path.join(wikiDir, 'index.md')));
    assert.ok(fs.existsSync(path.join(wikiDir, 'log.md')));
    assert.ok(fs.existsSync(path.join(wikiDir, 'STATUS.md')));

    const agents = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
    assert.match(agents, /## Mission Autonomy/);
    assert.match(agents, /atris mission status --status active --json/);

    const claude = fs.readFileSync(path.join(dir, 'atris', 'CLAUDE.md'), 'utf8');
    assert.match(claude, /## Mission Autonomy/);
    assert.match(claude, /atris mission tick <id> --verify --summary/);
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
    assert.match(res.stdout, /atris[\\/]+wiki[\\/]+STATUS\.md/);
    assert.match(res.stdout, /Wiki:/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('loop refreshes wiki STATUS and appends wiki log entries', () => {
  const dir = makeTempDir();
  try {
    fs.writeFileSync(path.join(dir, 'README.md'), '# Temp Repo\n', 'utf8');
    runCli(['init'], { cwd: dir, input: '\n' });

    const res = runCli(['loop'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Wiki Loop/);
    assert.match(res.stdout, /Health:/);
    assert.match(res.stdout, /Next move:/);

    const statusPath = path.join(dir, 'atris', 'wiki', 'STATUS.md');
    const logPath = path.join(dir, 'atris', 'wiki', 'log.md');
    const status = fs.readFileSync(statusPath, 'utf8');
    const log = fs.readFileSync(logPath, 'utf8');

    assert.match(status, /Last loop: \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    assert.match(status, /Health:/);
    assert.match(status, /Next move:/);
    assert.match(log, /LOOP/);
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
    // Clear the bootstrap backlog task so only inbox items remain
    const logDir = path.join(dir, 'atris', 'logs');
    const yearDirs = fs.readdirSync(logDir).filter(d => /^\d{4}$/.test(d));
    if (yearDirs.length > 0) {
      const yearDir = path.join(logDir, yearDirs[0]);
      const logFiles = fs.readdirSync(yearDir).filter(f => f.endsWith('.md'));
      if (logFiles.length > 0) {
        let content = fs.readFileSync(path.join(yearDir, logFiles[0]), 'utf8');
        content = content.replace(/## Backlog\n[\s\S]*?(?=\n---|\n##)/, '## Backlog\n\n');
        fs.writeFileSync(path.join(yearDir, logFiles[0]), content, 'utf8');
      }
    }
    // Also clear TODO.md backlog
    const todoPath = path.join(dir, 'atris', 'TODO.md');
    if (fs.existsSync(todoPath)) {
      let todo = fs.readFileSync(todoPath, 'utf8');
      todo = todo.replace(/## Backlog\n[\s\S]*?(?=\n---|\n##)/, '## Backlog\n\n(Empty)\n\n');
      fs.writeFileSync(todoPath, todo, 'utf8');
    }
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

test('default entry treats completed-only TODO rows as history', () => {
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
    assert.match(res.stdout, /Completed \(history\):/);
    assert.match(res.stdout, /Completed tasks are history, not pending review\./);
    assert.doesNotMatch(res.stdout, /Next: atris review|I checked the review setup\./);
  } finally {
    cleanupTempDir(dir);
  }
});

test('default entry routes active work before completed history', () => {
  const dir = makeTempDir();
  try {
    runCli(['init'], { cwd: dir, input: '\n' });
    fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), '# MAP.md\n\n## By-Feature\n- example: bin/atris.js:1\n', 'utf8');

    const todoPath = path.join(dir, 'atris', 'TODO.md');
    fs.writeFileSync(
      todoPath,
      `# TODO.md\n\n## Backlog\n\n- build the useful thing\n\n## In Progress\n\n(Empty)\n\n## Completed\n\n- validate old thing\n`,
      'utf8'
    );

    const res = runCli([], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Completed \(history\):/);
    assert.match(res.stdout, /Backlog \(preview\):/);
    assert.match(res.stdout, /Next: atris do \(work ready to execute\)/);
    assert.doesNotMatch(res.stdout, /Next: atris review|I checked the review setup\./);
  } finally {
    cleanupTempDir(dir);
  }
});

test('help lists essential commands', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['help'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /atris init/);
    assert.match(res.stdout, /atris run/);
    assert.match(res.stdout, /atris soul/);
    assert.match(res.stdout, /atris fleet/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('--help flag shows help', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['--help'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /atris/);
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
    assert.match(res.stdout, /📋\s+\d+\s+\|\s+🔨\s+\d+\s+\|\s+✅\s+\d+\s+\|\s+📥\s+\d+/);

    runCli(['log'], { cwd: dir, input: 'Idea one\nexit\n' });
    res = runCli(['status', '--quick'], { cwd: dir });
    assert.match(res.stdout, /📥\s+1/);
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
    assert.match(res.stdout, /I checked the review setup\./);
    assert.match(res.stdout, /refresh the task\s+projection\/TODO view/);
    assert.doesNotMatch(res.stdout, /clear completed tasks out of TODO/);
    assert.match(res.stdout, /Decision:/);
    assert.doesNotMatch(res.stdout, /COPY\/PASTE PROMPT/);
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
    assert.match(res.stdout, /Confirm active task state is clean/);
    assert.doesNotMatch(res.stdout, /delete completed tasks|DELETE completed tasks/);
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

// ── Soul tests ──────────────────────────────────────────

test('soul displays project identity after init', () => {
  const dir = makeTempDir();
  try {
    runCli(['init'], { cwd: dir, input: '\n' });
    const res = runCli(['soul'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /SOUL/);
    assert.match(res.stdout, /IDENTITY/);
    assert.match(res.stdout, /KNOWLEDGE/);
    assert.match(res.stdout, /LEARNED/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('soul snapshot exports JSON and auto-gitignores', () => {
  const dir = makeTempDir();
  try {
    runCli(['init'], { cwd: dir, input: '\n' });
    const res = runCli(['soul', 'snapshot'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);

    const snapshotPath = path.join(dir, 'atris', 'soul-snapshot.json');
    assert.ok(fs.existsSync(snapshotPath), 'soul-snapshot.json should exist');

    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    assert.ok(snapshot.timestamp, 'snapshot should have timestamp');
    assert.ok(snapshot.identity, 'snapshot should have identity');
    assert.ok(snapshot.knowledge, 'snapshot should have knowledge');

    // Check gitignore was updated
    const gitignorePath = path.join(dir, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
      const gitignore = fs.readFileSync(gitignorePath, 'utf8');
      assert.match(gitignore, /soul-snapshot\.json/);
    }
  } finally {
    cleanupTempDir(dir);
  }
});

test('soul fork copies persona and policies to target', () => {
  const source = makeTempDir();
  const target = makeTempDir();
  try {
    runCli(['init'], { cwd: source, input: '\n' });
    runCli(['init'], { cwd: target, input: '\n' });

    const res = runCli(['soul', 'fork', target], { cwd: source });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Soul forked/);

    // Genealogy should exist in target
    const genealogyPath = path.join(target, 'atris', 'genealogy.json');
    assert.ok(fs.existsSync(genealogyPath), 'genealogy.json should exist in target');
    const genealogy = JSON.parse(fs.readFileSync(genealogyPath, 'utf8'));
    assert.ok(genealogy.forked_from, 'genealogy should record source');
    assert.ok(genealogy.forked_at, 'genealogy should record timestamp');
  } finally {
    cleanupTempDir(source);
    cleanupTempDir(target);
  }
});

// ── Fleet tests ─────────────────────────────────────────

test('fleet command loads without error (hub may be down)', () => {
  const res = runCli(['fleet', 'status']);
  // May fail with "hub not running" but should not crash
  assert.ok(res.status === 0 || res.status === 1, 'fleet should exit cleanly');
});

test('help shows 6 essential commands', () => {
  const res = runCli(['help']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /atris init/);
  assert.match(res.stdout, /atris run/);
  assert.match(res.stdout, /atris soul/);
  assert.match(res.stdout, /atris fleet/);
  assert.match(res.stdout, /atris status/);
  assert.match(res.stdout, /--all/);
});
