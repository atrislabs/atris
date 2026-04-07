const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { normalizeWikiOnlyPrefix } = require('../lib/wiki');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-cmd-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd, input } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    input,
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
    },
  });
  if (result.error) throw result.error;
  return result;
}

function initWorkspace(dir) {
  runCli(['init'], { cwd: dir, input: '\n' });
}

function writeTodayLog(dir, content) {
  const now = new Date();
  const yyyy = now.getFullYear().toString();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const dateStr = `${yyyy}-${mm}-${dd}`;
  const yearDir = path.join(dir, 'atris', 'logs', yyyy);
  fs.mkdirSync(yearDir, { recursive: true });
  const logFile = path.join(yearDir, `${dateStr}.md`);
  fs.writeFileSync(logFile, content, 'utf8');
  return logFile;
}

// ============================================
// version
// ============================================

test('version prints atris v<semver>', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['version'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout.trim(), /^atris v\d+\.\d+\.\d+$/);
  } finally {
    cleanupTempDir(dir);
  }
});

// ============================================
// search
// ============================================

test('search with no keyword prints usage', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const res = runCli(['search'], { cwd: dir });
    assert.equal(res.status, 1);
    assert.match(res.stdout, /Usage: atris search/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('search with no atris/logs prints error', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['search', 'auth'], { cwd: dir });
    assert.equal(res.status, 1);
    assert.match(res.stdout, /atris init/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('search finds matches in journal files', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    writeTodayLog(dir, '# Log\n\n## Inbox\n\n- **I1:** Fix the auth module\n');
    const res = runCli(['search', 'auth'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Found 1 match/);
    assert.match(res.stdout, /auth/i);
  } finally {
    cleanupTempDir(dir);
  }
});

test('search is case-insensitive', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    writeTodayLog(dir, '# Log\n\n## Notes\n\nDebugged the AUTH flow\n');
    const res = runCli(['search', 'auth'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Found 1 match/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('search with no matches prints no matches', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    writeTodayLog(dir, '# Log\n\n## Notes\n\nNothing relevant here\n');
    const res = runCli(['search', 'xyznonexistent'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /No matches found/);
  } finally {
    cleanupTempDir(dir);
  }
});

// ============================================
// analytics
// ============================================

test('analytics exits 1 when no atris/ folder', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['analytics'], { cwd: dir });
    assert.equal(res.status, 1);
    assert.match(res.stdout, /atris init/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('analytics shows zero completions on fresh workspace', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const res = runCli(['analytics'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Total completions:\s+0/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('analytics counts completions in journal', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    writeTodayLog(dir, '# Log\n\n## Completed ✅\n\n- **C1: Shipped auth**\n- **C2: Fixed bug**\n\n## Inbox\n\n');
    const res = runCli(['analytics'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    // Today should show 2 completions
    assert.match(res.stdout, /2/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('analytics counts inbox items when Inbox is last section', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    // Inbox at the end with no ## or --- after it (regression test)
    writeTodayLog(dir, '# Log\n\n## Completed ✅\n\n---\n\n## Inbox\n\n- **I1:** Fix auth\n- **I2:** Add tests\n');
    const res = runCli(['analytics'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Inbox items:\s+2/);
  } finally {
    cleanupTempDir(dir);
  }
});

// ============================================
// visualize
// ============================================

test('visualize exits 1 when no journal exists', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    // Remove any auto-created log
    const logsDir = path.join(dir, 'atris', 'logs');
    if (fs.existsSync(logsDir)) {
      fs.rmSync(logsDir, { recursive: true, force: true });
      fs.mkdirSync(logsDir, { recursive: true });
    }
    const res = runCli(['visualize'], { cwd: dir });
    assert.equal(res.status, 1);
    assert.match(res.stdout, /atris log/i);
  } finally {
    cleanupTempDir(dir);
  }
});

test('visualize exits 1 when inbox is empty', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    writeTodayLog(dir, '# Log\n\n## Inbox\n\n\n## Notes\n\n');
    const res = runCli(['visualize'], { cwd: dir });
    assert.equal(res.status, 1);
    assert.match(res.stdout, /Inbox|inbox/i);
  } finally {
    cleanupTempDir(dir);
  }
});

test('visualize renders breakdown for inbox items', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    writeTodayLog(dir, '# Log\n\n## Inbox\n\n- **I1:** Build the dashboard\n\n## Notes\n\n');
    const res = runCli(['visualize'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Build the dashboard/);
  } finally {
    cleanupTempDir(dir);
  }
});

// ============================================
// clean
// ============================================

test('clean exits 1 when no atris/ folder', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['clean'], { cwd: dir });
    assert.equal(res.status, 1);
    assert.match(res.stdout, /atris init/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('clean reports clean workspace on fresh init', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const res = runCli(['clean'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    // Should complete without crashing
    assert.match(res.stdout, /clean|stale|target/i);
  } finally {
    cleanupTempDir(dir);
  }
});

// ============================================
// verify
// ============================================

test('verify exits 1 when no atris/ folder', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['verify'], { cwd: dir });
    assert.equal(res.status, 1);
    assert.match(res.stdout, /atris init/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('verify detects placeholder MAP.md', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    // init creates a placeholder MAP.md
    const res = runCli(['verify'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    // Should mention MAP issues since it's a placeholder
    assert.match(res.stdout, /MAP\.md/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('verify passes with populated MAP.md', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    // Write a MAP.md with enough file refs (verify regex: `filename.ext` with known extensions)
    const mapContent = [
      '# MAP.md', '',
      '## By-Feature',
      '- auth: `bin/atris.js` line 1',
      '- init: `commands/init.js` line 10',
      '- sync: `commands/sync.js` line 20',
      '- status: `commands/status.js` line 30',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), mapContent, 'utf8');
    const res = runCli(['verify'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /MAP\.md.*Valid/i);
  } finally {
    cleanupTempDir(dir);
  }
});

// ============================================
// sync alias
// ============================================

test('sync command works as alias for update', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const res = runCli(['sync'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /up to date|Updated/i);
  } finally {
    cleanupTempDir(dir);
  }
});

// ============================================
// log sequential IDs
// ============================================

test('log assigns sequential IDs across sessions', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    runCli(['log'], { cwd: dir, input: 'First idea\nexit\n' });
    runCli(['log'], { cwd: dir, input: 'Second idea\nexit\n' });

    const logsDir = path.join(dir, 'atris', 'logs');
    const yearDirs = fs.readdirSync(logsDir).filter(d => /^\d{4}$/.test(d));
    const yearDir = path.join(logsDir, yearDirs[0]);
    const logFiles = fs.readdirSync(yearDir).filter(f => f.endsWith('.md'));
    const content = fs.readFileSync(path.join(yearDir, logFiles[0]), 'utf8');

    assert.match(content, /I1/);
    assert.match(content, /I2/);
    assert.match(content, /First idea/);
    assert.match(content, /Second idea/);
  } finally {
    cleanupTempDir(dir);
  }
});

// ============================================
// status full mode
// ============================================

test('status full mode renders task board', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const todoPath = path.join(dir, 'atris', 'TODO.md');
    fs.writeFileSync(todoPath, [
      '# TODO.md',
      '',
      '## Backlog',
      '',
      '- **T1:** Implement feature X',
      '',
      '## In Progress',
      '',
      '(Empty)',
      '',
      '## Completed',
      '',
      '(Empty)',
    ].join('\n'), 'utf8');

    const res = runCli(['status'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /TASK BOARD|Backlog/i);
  } finally {
    cleanupTempDir(dir);
  }
});

// ============================================
// unknown command warning
// ============================================

test('unknown single-word command shows warning', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), '# MAP.md\n\n## By-Feature\n- example: bin/atris.js:1\n', 'utf8');
    const res = runCli(['foobarxyz'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Unknown command.*foobarxyz/i);
  } finally {
    cleanupTempDir(dir);
  }
});

// ============================================
// wiki
// ============================================

test('ingest is local-first and scaffolds atris/wiki', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['ingest', 'README.md'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Local wiki ingest/);
    assert.match(res.stdout, /Target: atris\/wiki/);
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'wiki', 'wiki.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'wiki', 'index.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'wiki', 'STATUS.md')));
  } finally {
    cleanupTempDir(dir);
  }
});

test('query alias uses local wiki by default', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'wiki', 'index.md'), '# Atris Wiki Index\n', 'utf8');
    const res = runCli(['query', 'what is the system state'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Local wiki query/);
    assert.match(res.stdout, /what is the system state/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('wiki search reads canonical atris/wiki index', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'wiki'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'atris', 'wiki', 'index.md'),
      '# Atris Wiki Index\n\n## Concepts\n\n- [[atris/wiki/concepts/local-first.md]] - local-first wiki routing\n',
      'utf8'
    );
    const res = runCli(['wiki', 'search', 'local-first'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /local-first wiki routing/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('wiki log reads canonical atris/wiki log', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'wiki'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'atris', 'wiki', 'log.md'),
      '# Atris Wiki Log\n\n## 2026-04-07\n- 10:00 INGEST README.md\n  - created local-first page\n',
      'utf8'
    );
    const res = runCli(['wiki', 'log'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /2026-04-07/);
    assert.match(res.stdout, /INGEST README\.md/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('wiki sync alias normalizes --only wiki to atris/wiki', () => {
  assert.equal(normalizeWikiOnlyPrefix('wiki'), 'atris/wiki/');
  assert.equal(normalizeWikiOnlyPrefix('wiki/'), 'atris/wiki/');
  assert.equal(normalizeWikiOnlyPrefix('atris/wiki'), 'atris/wiki/');
});

test('loop flags stale wiki pages and refreshes status/log', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    fs.writeFileSync(path.join(dir, 'README.md'), '# Repo\n', 'utf8');
    const pagePath = path.join(dir, 'atris', 'wiki', 'concepts', 'stale-page.md');
    fs.mkdirSync(path.dirname(pagePath), { recursive: true });
    fs.writeFileSync(pagePath, [
      '---',
      'type: concept',
      'slug: stale-page',
      'title: Stale Page',
      'sources:',
      '  - README.md',
      'last_compiled: 2000-01-01',
      'created: 2000-01-01',
      'updated: 2000-01-01',
      'tags:',
      '  - test',
      '---',
      '# Stale Page',
      '',
      'Body.',
      '',
    ].join('\n'), 'utf8');

    const res = runCli(['loop'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Wiki Loop/);
    assert.match(res.stdout, /Stale: 1/);

    const status = fs.readFileSync(path.join(dir, 'atris', 'wiki', 'STATUS.md'), 'utf8');
    assert.match(status, /Last loop:/);
    assert.match(status, /recompile atris\/wiki\/concepts\/stale-page\.md from README\.md/);

    const log = fs.readFileSync(path.join(dir, 'atris', 'wiki', 'log.md'), 'utf8');
    assert.match(log, /LOOP/);
    assert.match(log, /stale atris\/wiki\/concepts\/stale-page\.md <- README\.md/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('loop suggests next ingest candidates when wiki is clean', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    fs.writeFileSync(path.join(dir, 'README.md'), '# Repo\n', 'utf8');
    const res = runCli(['loop', '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    const report = JSON.parse(res.stdout);
    assert.ok(report.nextSources.includes('README.md'));
    assert.match(report.health, /ready for ingest|stable/i);
  } finally {
    cleanupTempDir(dir);
  }
});

test('wiki loop alias runs the same upkeep analysis', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    fs.writeFileSync(path.join(dir, 'README.md'), '# Repo\n', 'utf8');
    const res = runCli(['wiki', 'loop'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Wiki Loop/);
  } finally {
    cleanupTempDir(dir);
  }
});
