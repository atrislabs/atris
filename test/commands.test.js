const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ensureWikiScaffold, normalizeWikiOnlyPrefix } = require('../lib/wiki');
const { createCanonicalBusinessWorkspace } = require('../commands/business');
const { getScorecardsPath, readScorecards } = require('../lib/scorecard');
const {
  computeTickReward,
  verifyJudgeIntegrity,
  getVerifyCommand,
  getRecentSignals,
  maybeWriteCompletedEndgameScorecard,
  renderHumanSuggestion,
  renderHumanTickIntro,
  scoreEndgameCandidates,
  writeLesson
} = require('../commands/autopilot');
const { REWARD_CONFIG, REWARD_CHECKSUM } = require('../lib/reward-config');

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

function runGit(args, cwd) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
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

test('init scaffolds atris/wiki/briefs instead of syntheses', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'wiki', 'briefs')));
    assert.equal(fs.existsSync(path.join(dir, 'atris', 'wiki', 'syntheses')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('ensureWikiScaffold migrates legacy syntheses pages into briefs', () => {
  const dir = makeTempDir();
  try {
    const wikiDir = path.join(dir, 'atris', 'wiki');
    const legacyDir = path.join(wikiDir, 'syntheses');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(
      path.join(wikiDir, 'index.md'),
      '# Atris Wiki Index\n\n## Syntheses\n\n- [[atris/wiki/syntheses/example.md]]\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(legacyDir, 'example.md'),
      '---\ntype: synthesis\nslug: example\ntitle: Example\n---\n# Example\n',
      'utf8'
    );

    ensureWikiScaffold(dir);

    const briefsPath = path.join(wikiDir, 'briefs', 'example.md');
    assert.ok(fs.existsSync(briefsPath));
    assert.equal(fs.existsSync(legacyDir), false);
    assert.match(fs.readFileSync(path.join(wikiDir, 'index.md'), 'utf8'), /## Briefs/);
    assert.doesNotMatch(fs.readFileSync(path.join(wikiDir, 'index.md'), 'utf8'), /syntheses/);
    assert.match(fs.readFileSync(briefsPath, 'utf8'), /^type: brief$/m);
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

test('getRecentSignals returns empty commit/wiki/lesson signals when sources are missing', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    fs.rmSync(path.join(dir, 'atris', 'wiki', 'STATUS.md'), { force: true });
    fs.rmSync(path.join(dir, 'atris', 'lessons.md'), { force: true });

    const signals = getRecentSignals(dir);
    assert.deepEqual(signals.recentCommits, []);
    assert.equal(signals.wikiHealth, null);
    assert.deepEqual(signals.recentLessons, []);
  } finally {
    cleanupTempDir(dir);
  }
});

test('getRecentSignals reads recent git commits, wiki health, and last 10 lesson lines', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);

    const initResult = runGit(['init'], dir);
    assert.equal(initResult.status, 0, initResult.stderr);
    assert.equal(runGit(['config', 'user.name', 'Test User'], dir).status, 0);
    assert.equal(runGit(['config', 'user.email', 'test@example.com'], dir).status, 0);
    assert.equal(runGit(['add', '.'], dir).status, 0);
    const commitResult = runGit(['commit', '-m', 'seed workspace'], dir);
    assert.equal(commitResult.status, 0, commitResult.stderr);

    const statusPath = path.join(dir, 'atris', 'wiki', 'STATUS.md');
    fs.writeFileSync(statusPath, '# STATUS\n\nHealth: 3/5\nNext move: tighten loop\n', 'utf8');

    const lessonsPath = path.join(dir, 'atris', 'lessons.md');
    const lessonLines = Array.from({ length: 12 }, (_, i) => `- lesson ${i + 1}`);
    fs.writeFileSync(lessonsPath, `${lessonLines.join('\n')}\n`, 'utf8');

    const signals = getRecentSignals(dir);
    assert.equal(signals.recentCommits.length, 1);
    assert.match(signals.recentCommits[0], /seed workspace/);
    assert.match(signals.wikiHealth, /Health: 3\/5/);
    assert.equal(signals.recentLessons.length, 10);
    assert.deepEqual(signals.recentLessons, lessonLines.slice(-10));
  } finally {
    cleanupTempDir(dir);
  }
});

test('renderHumanTickIntro keeps the default autopilot briefing plain and narrow', () => {
  const text = renderHumanTickIntro({
    time: '11:20 a.m.',
    identity: 'Ship one clean step at a time.',
    slug: 'loop-self-seeds-horizons',
    horizon: 'Teach the loop to imagine the next horizon when the queue goes quiet.',
    total: 5,
    done: 2
  }, {
    auto: true,
    durationLabel: 'until clean'
  });

  assert.match(text, /I am starting an autopilot tick in autonomous mode\./);
  assert.match(text, /Progress is 2 of 5 endgame steps\./);
  assert.doesNotMatch(text, /[┌┐└┘│]/);
  for (const line of text.split('\n')) {
    assert.ok(line.length <= 80, `line too wide: ${line.length} "${line}"`);
  }
});

test('renderHumanSuggestion keeps the default suggestion briefing plain and narrow', () => {
  const text = renderHumanSuggestion({
    task: 'Rewrite the autopilot tick output to match the chief-of-staff format.',
    why: 'The current box-heavy output makes it hard for a non-technical reader to decide whether to let the loop continue.',
    kind: 'execute'
  }, 1, 4);

  assert.match(text, /I picked task 1 of 4\./);
  assert.match(text, /Next: approve it, skip it, or stop the loop\./);
  assert.doesNotMatch(text, /[┌┐└┘│]/);
  for (const line of text.split('\n')) {
    assert.ok(line.length <= 80, `line too wide: ${line.length} "${line}"`);
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

test('createCanonicalBusinessWorkspace writes business metadata and canonical atris scaffold into an existing folder', () => {
  const dir = makeTempDir();
  try {
    fs.writeFileSync(path.join(dir, 'BLONDISH_NOTES.md'), '# raw notes\n', 'utf8');

    const result = createCanonicalBusinessWorkspace(dir, {
      business_id: 'biz-123',
      workspace_id: 'ws-456',
      name: 'BLOND:ISH',
      slug: 'blondish',
      owner_email: 'joel@blondish.world',
    }, { here: true });

    assert.equal(result.targetRoot, dir);
    assert.ok(fs.existsSync(path.join(dir, 'BLONDISH_NOTES.md')));
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'business.json')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'MAP.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'TODO.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'goals.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'PERSONA.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'policies', 'REWARD.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'context', 'live-workspace.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'wiki', 'STATUS.md')));

    const meta = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'business.json'), 'utf8'));
    assert.equal(meta.slug, 'blondish');
    assert.equal(meta.business_id, 'biz-123');
    assert.equal(meta.workspace_id, 'ws-456');
    assert.equal(meta.workspace_template, 'business');
    assert.equal(meta.owner_email, 'joel@blondish.world');

    const map = fs.readFileSync(path.join(dir, 'atris', 'MAP.md'), 'utf8');
    assert.match(map, /BLOND:ISH/);

    const persona = fs.readFileSync(path.join(dir, 'atris', 'PERSONA.md'), 'utf8');
    assert.match(persona, /BLOND:ISH/);

    const reward = fs.readFileSync(path.join(dir, 'atris', 'policies', 'REWARD.md'), 'utf8');
    assert.match(reward, /Reward what makes the operator faster/i);

    const liveWorkspace = fs.readFileSync(path.join(dir, 'atris', 'context', 'live-workspace.md'), 'utf8');
    assert.match(liveWorkspace, /biz-123/);
    assert.match(liveWorkspace, /ws-456/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('createCanonicalBusinessWorkspace can scaffold a research lab template', () => {
  const dir = makeTempDir();
  try {
    const result = createCanonicalBusinessWorkspace(dir, {
      business_id: 'biz-r1',
      workspace_id: 'ws-r2',
      name: 'Frontier Lab',
      slug: 'frontier-lab',
      owner_email: 'pi@frontier.lab',
      workspace_template: 'research',
    }, { here: true, templateName: 'research' });

    assert.equal(result.targetRoot, dir);
    assert.equal(result.workspaceTemplate, 'research');
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'business.json')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'team', 'hypothesis', 'MEMBER.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'team', 'eval', 'MEMBER.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'wiki', 'concepts', 'research-loop.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'wiki', 'briefs', 'research-program.md')));

    const meta = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'business.json'), 'utf8'));
    assert.equal(meta.workspace_template, 'research');

    const reward = fs.readFileSync(path.join(dir, 'atris', 'policies', 'REWARD.md'), 'utf8');
    assert.match(reward, /reproducible/i);
    assert.match(reward, /held-out|replayable/i);

    const liveWorkspace = fs.readFileSync(path.join(dir, 'atris', 'context', 'live-workspace.md'), 'utf8');
    assert.match(liveWorkspace, /research/i);
    assert.match(liveWorkspace, /biz-r1/);
    assert.match(liveWorkspace, /ws-r2/);

    const teamReadme = fs.readFileSync(path.join(dir, 'atris', 'team', 'README.md'), 'utf8');
    assert.match(teamReadme, /hypothesis, experiment, eval, literature/i);
  } finally {
    cleanupTempDir(dir);
  }
});

test('business help exposes default workspace creation', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['business'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /init <name>/);
    assert.match(res.stdout, /create <name>/);
  } finally {
    cleanupTempDir(dir);
  }
});

// research CLI command not yet wired — template exists but no `atris research` subcommand

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

test('status default mode renders human summary', () => {
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
    assert.match(res.stdout, /Where we are:/);
    assert.match(res.stdout, /What is queued:/);
    assert.match(res.stdout, /What is blocking:/);
    assert.doesNotMatch(res.stdout, /TASK BOARD|┌|└|│/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('status verbose mode keeps the legacy task board', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const res = runCli(['status', '--verbose'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /TASK BOARD|Backlog/i);
    assert.match(res.stdout, /┌|└|│/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('status stays local even when .atris/business.json exists', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const metaDir = path.join(dir, '.atris');
    fs.mkdirSync(metaDir, { recursive: true });
    fs.writeFileSync(
      path.join(metaDir, 'business.json'),
      JSON.stringify({ slug: 'pallet' }, null, 2),
      'utf8'
    );

    const res = runCli(['status'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Where we are:/);
    assert.doesNotMatch(res.stdout, /last synced/i);
  } finally {
    cleanupTempDir(dir);
  }
});

test('review default mode renders human validator brief', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const res = runCli(['review'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /I checked the review setup\./);
    assert.match(res.stdout, /Decision: hold/);
    assert.doesNotMatch(res.stdout, /┌|└|│|Validator Agent Activated/);
    for (const line of res.stdout.trimEnd().split('\n')) {
      assert.ok(line.length <= 80, `line too wide: ${line.length} "${line}"`);
    }
  } finally {
    cleanupTempDir(dir);
  }
});

test('review verbose mode keeps the legacy validator board', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const res = runCli(['review', '--verbose'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Atris Review|Validator Agent Activated/);
    assert.match(res.stdout, /┌|└|│/);
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

test('wiki ingest --private scaffolds .atris/presidio', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['wiki', 'ingest', '--private', 'README.md'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Private wiki ingest/);
    assert.match(res.stdout, /Target: \.atris\/presidio/);
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'presidio', 'wiki.md')));
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'presidio', 'index.md')));
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'presidio', 'STATUS.md')));
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

test('getVerifyCommand finds task-specific verify commands before and after task moves', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const todoPath = path.join(dir, 'atris', 'TODO.md');
    fs.writeFileSync(todoPath, `# TODO.md

## Endgame

**Slug:** verify-loop
**Picked:** 2026-04-09 00:00
**Horizon:** Verify stays attached to the task.
**Source:** test

## Backlog
- **T1:** ship parser fix [endgame]
  **Verify:** node -e "process.exit(0)"

## In Progress

---

## Completed

---
`, 'utf8');

    const result1 = getVerifyCommand(dir, 'ship parser fix');
    assert.equal(result1.cmd, 'node -e "process.exit(0)"');
    assert.equal(result1.explicit, true);

    fs.writeFileSync(todoPath, `# TODO.md

## Endgame

**Slug:** verify-loop
**Picked:** 2026-04-09 00:00
**Horizon:** Verify stays attached to the task.
**Source:** test

## Backlog

## In Progress

---

## Completed
- **T1:** ship parser fix [endgame]
  **Verify:** node -e "process.exit(0)"

---
`, 'utf8');

    const result2 = getVerifyCommand(dir, 'ship parser fix');
    assert.equal(result2.cmd, 'node -e "process.exit(0)"');
    assert.equal(result2.explicit, true);
  } finally {
    cleanupTempDir(dir);
  }
});

test('computeTickReward does not award verify points when review failed before verify ran', () => {
  const reward = computeTickReward({
    reviewOutput: 'failed — scope drift',
    verifyPass: false,
    verifyRan: false,
    phaseResults: {
      do: { output: '' }
    }
  }, 'halted', 'npm test');

  assert.equal(reward, -3);
});

test('REWARD_CONFIG is frozen and cannot be mutated', () => {
  assert.ok(Object.isFrozen(REWARD_CONFIG));
  assert.throws(() => { 'use strict'; REWARD_CONFIG.VERIFY_PASS = 999; }, TypeError);
});

test('REWARD_CHECKSUM matches live REWARD_CONFIG + computeTickReward source', () => {
  const crypto = require('crypto');
  const h = crypto.createHash('sha256');
  h.update(JSON.stringify(REWARD_CONFIG));
  h.update(computeTickReward.toString());
  const actual = h.digest('hex');
  assert.strictEqual(actual, REWARD_CHECKSUM);
});

test('verifyJudgeIntegrity returns ok:true on clean state', () => {
  const result = verifyJudgeIntegrity();
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.expected, result.actual);
});

test('maybeWriteCompletedEndgameScorecard writes a scorecard from closed endgame state', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const now = new Date();
    const yyyy = now.getFullYear().toString();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const dateStr = `${yyyy}-${mm}-${dd}`;

    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), `# TODO.md

## Endgame

**Slug:** verify-loop
**Picked:** ${dateStr} 00:00
**Horizon:** Every closed endgame writes a scorecard.
**Source:** test

## Backlog

## In Progress

---

## Completed
- **T1:** ship parser fix [endgame]
  **Verify:** node -e "process.exit(0)"

---
`, 'utf8');

    writeTodayLog(dir, `# Log — ${dateStr}

## Handoff

---

## Completed ✅

---

## In Progress 🔄

---

## Backlog

---

## Notes

### Endgame picked — 12:00 AM PDT

slug: verify-loop

- 12:10 am
  I planned, built, and reviewed "ship parser fix".
  We are still on the verify-loop endgame.
  Next tick will pick the next endgame task.
  Reward: 6

## Inbox

---
`);

    const wrote = maybeWriteCompletedEndgameScorecard(dir, {
      slug: 'verify-loop',
      pickedAt: `${dateStr} 00:00`,
      remaining: 1,
    });

    assert.equal(wrote, true);
    const scorecards = readScorecards(path.join(dir, 'atris'));
    assert.equal(scorecards.length, 1);
    assert.equal(scorecards[0].slug, 'verify-loop');
    assert.equal(scorecards[0].tasksShipped, 1);
    assert.equal(scorecards[0].totalReward, 6);

    const wroteAgain = maybeWriteCompletedEndgameScorecard(dir, {
      slug: 'verify-loop',
      pickedAt: `${dateStr} 00:00`,
      remaining: 1,
    });
    assert.equal(wroteAgain, false);
  } finally {
    cleanupTempDir(dir);
  }
});

// ============================================
// scoreEndgameCandidates
// ============================================

test('scoreEndgameCandidates returns best by confidence when no atris folder', () => {
  const dir = makeTempDir();
  try {
    const candidates = [
      { title: 'wiki-search', confidence: 0.9, rationale: 'High confidence' },
      { title: 'verify-tests', confidence: 0.7, rationale: 'Medium confidence' },
      { title: 'refactor-cli', confidence: 0.5, rationale: 'Low confidence' }
    ];
    const result = scoreEndgameCandidates(dir, candidates);
    assert.equal(result.title, 'wiki-search', 'should pick highest confidence');
    assert.equal(result.confidence, 0.9);
    assert.equal(result.scored, false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('scoreEndgameCandidates returns best by confidence when no scorecards', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    const candidates = [
      { title: 'wiki-search', confidence: 0.6, rationale: 'Medium confidence' },
      { title: 'verify-tests', confidence: 0.8, rationale: 'High confidence' },
      { title: 'refactor-cli', confidence: 0.4, rationale: 'Low confidence' }
    ];
    const result = scoreEndgameCandidates(dir, candidates);
    assert.equal(result.title, 'verify-tests', 'should pick highest confidence');
    assert.equal(result.confidence, 0.8);
    assert.equal(result.scored, false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('scoreEndgameCandidates scores candidates by historical reward with adaptive explore rate', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);

    // Create scorecards with diverse types (wiki, verify, refactor, harden)
    const scorecardsPath = getScorecardsPath(path.join(dir, 'atris'));
    const content = `# scorecards.md — Endgame Results

> Append-only. One line per closed endgame.

---

- **[2026-04-01] wiki-search-v1** — shipped: 3/3 — wall-clock: 2.5h — halt: 10% — reward: 50 — lessons: 5
- **[2026-04-02] verify-tests** — shipped: 2/3 — wall-clock: 3.0h — halt: 20% — reward: 40 — lessons: 3
- **[2026-04-03] refactor-api** — shipped: 4/4 — wall-clock: 1.5h — halt: 5% — reward: 55 — lessons: 6
- **[2026-04-04] harden-loop** — shipped: 1/2 — wall-clock: 4.0h — halt: 30% — reward: 30 — lessons: 2
- **[2026-04-05] ship-release** — shipped: 2/2 — wall-clock: 1.0h — halt: 0% — reward: 45 — lessons: 1
`;
    fs.writeFileSync(scorecardsPath, content, 'utf8');

    const candidates = [
      { title: 'wiki-new-feature', confidence: 0.7, rationale: 'New wiki work' },
      { title: 'verify-edge-cases', confidence: 0.6, rationale: 'Test edge cases' },
      { title: 'refactor-api', confidence: 0.8, rationale: 'Refactor API' }
    ];

    // 5 unique types in last 5 → exploreRate = 0.2 (max diversity)
    let exploitCount = 0, exploreCount = 0;
    for (let i = 0; i < 100; i++) {
      const result = scoreEndgameCandidates(dir, candidates);
      assert.equal(result.scored, true);
      assert.ok(result.reason, 'should have scoring reason');
      assert.ok(result.exploreRate !== undefined, 'should expose exploreRate');
      // With 5 unique types, exploreRate should be 0.2
      assert.ok(Math.abs(result.exploreRate - 0.2) < 0.01, `explore rate ${result.exploreRate} should be ~0.2`);
      if (result.reason.includes('exploit')) exploitCount++;
      else if (result.reason.includes('explore')) exploreCount++;
    }

    // ~80/20 split with diverse history
    assert.ok(exploitCount >= 60 && exploitCount <= 100, `exploit count ${exploitCount} should be ~80`);
    assert.ok(exploreCount >= 0 && exploreCount <= 40, `explore count ${exploreCount} should be ~20`);
  } finally {
    cleanupTempDir(dir);
  }
});

test('scoreEndgameCandidates boosts explore to 50% when last 5 are same type', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);

    // All 5 scorecards are wiki-* type
    const scorecardsPath = getScorecardsPath(path.join(dir, 'atris'));
    const content = `# scorecards.md — Endgame Results

> Append-only. One line per closed endgame.

---

- **[2026-04-01] wiki-search** — shipped: 3/3 — wall-clock: 2.5h — halt: 10% — reward: 50 — lessons: 5
- **[2026-04-02] wiki-ingest** — shipped: 2/3 — wall-clock: 3.0h — halt: 20% — reward: 40 — lessons: 3
- **[2026-04-03] wiki-lint** — shipped: 4/4 — wall-clock: 1.5h — halt: 5% — reward: 55 — lessons: 6
- **[2026-04-04] wiki-status** — shipped: 3/3 — wall-clock: 2.0h — halt: 0% — reward: 45 — lessons: 2
- **[2026-04-05] wiki-compile** — shipped: 2/2 — wall-clock: 1.0h — halt: 0% — reward: 48 — lessons: 1
`;
    fs.writeFileSync(scorecardsPath, content, 'utf8');

    const candidates = [
      { title: 'wiki-new-feature', confidence: 0.7, rationale: 'More wiki work' },
      { title: 'verify-edge-cases', confidence: 0.6, rationale: 'Test edge cases' },
      { title: 'refactor-api', confidence: 0.5, rationale: 'Refactor API' }
    ];

    let exploitCount = 0, exploreCount = 0;
    for (let i = 0; i < 200; i++) {
      const result = scoreEndgameCandidates(dir, candidates);
      assert.equal(result.scored, true);
      // All same type → exploreRate should be 0.5
      assert.ok(Math.abs(result.exploreRate - 0.5) < 0.01, `explore rate ${result.exploreRate} should be 0.5`);
      if (result.reason.includes('exploit')) exploitCount++;
      else if (result.reason.includes('explore')) exploreCount++;
    }

    // ~50/50 split: explore should be significantly higher than 20%
    assert.ok(exploreCount >= 60, `explore count ${exploreCount} should be >= 60 out of 200 (50% rate)`);
  } finally {
    cleanupTempDir(dir);
  }
});

test('scoreEndgameCandidates filters easy-win candidates when harder ones exist', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);

    // wiki type: high success rate (9/10 = 90%) and high mean reward (50)
    // verify type: low success rate (3/6 = 50%) and low mean reward (10)
    const scorecardsPath = getScorecardsPath(path.join(dir, 'atris'));
    const content = `# scorecards.md — Endgame Results

> Append-only. One line per closed endgame.

---

- **[2026-04-01] wiki-a** — shipped: 3/3 — wall-clock: 1.0h — halt: 0% — reward: 50 — lessons: 2
- **[2026-04-02] verify-a** — shipped: 1/2 — wall-clock: 3.0h — halt: 30% — reward: 10 — lessons: 3
- **[2026-04-03] wiki-b** — shipped: 3/3 — wall-clock: 1.0h — halt: 0% — reward: 50 — lessons: 1
- **[2026-04-04] verify-b** — shipped: 1/2 — wall-clock: 4.0h — halt: 40% — reward: 10 — lessons: 4
- **[2026-04-05] wiki-c** — shipped: 3/4 — wall-clock: 1.5h — halt: 5% — reward: 50 — lessons: 2
- **[2026-04-06] verify-c** — shipped: 1/2 — wall-clock: 3.5h — halt: 35% — reward: 10 — lessons: 3
`;
    fs.writeFileSync(scorecardsPath, content, 'utf8');

    const candidates = [
      { title: 'wiki-easy', confidence: 0.9, rationale: 'Easy wiki task' },
      { title: 'verify-hard', confidence: 0.7, rationale: 'Hard verify task' },
      { title: 'refactor-new', confidence: 0.5, rationale: 'New refactor work' }
    ];

    // Run many times — exploit picks should never be wiki-easy (filtered by difficulty floor)
    let wikiExploitCount = 0;
    for (let i = 0; i < 100; i++) {
      const result = scoreEndgameCandidates(dir, candidates);
      if (result.reason.includes('exploit') && result.title === 'wiki-easy') {
        wikiExploitCount++;
      }
    }

    // wiki type has >80% success rate and mean reward 50 (>5), so it should be filtered
    // from the exploit pool. Exploit picks should not select wiki-easy.
    assert.equal(wikiExploitCount, 0, 'easy-win wiki should be filtered from exploit pool');
  } finally {
    cleanupTempDir(dir);
  }
});

test('scoreEndgameCandidates returns fallback when scoring fails', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);

    // Write malformed scorecards to trigger parsing error
    const scorecardsPath = getScorecardsPath(path.join(dir, 'atris'));
    fs.writeFileSync(scorecardsPath, '# scorecards\n\nmalformed line that won\'t parse', 'utf8');

    const candidates = [
      { title: 'wiki-work', confidence: 0.9, rationale: 'High confidence' },
      { title: 'verify-work', confidence: 0.5, rationale: 'Low confidence' }
    ];

    const result = scoreEndgameCandidates(dir, candidates);
    // Should fall back to best by confidence
    assert.equal(result.title, 'wiki-work');
    assert.equal(result.confidence, 0.9);
    // scored flag tells us it fell back (if there was an error)
  } finally {
    cleanupTempDir(dir);
  }
});

// ─── writeLesson ───────────────────────────────────────────

test('writeLesson appends a lesson line to existing lessons.md', () => {
  const dir = makeTempDir();
  try {
    const atrisDir = path.join(dir, 'atris');
    fs.mkdirSync(atrisDir, { recursive: true });
    const lessonsPath = path.join(atrisDir, 'lessons.md');
    fs.writeFileSync(lessonsPath, '# lessons.md — What We Learned\n\n> Append-only.\n\n---\n\n', 'utf8');

    const before = fs.readFileSync(lessonsPath, 'utf8').split('\n').length;
    writeLesson(dir, 'test-slug', 'fail', 'Test explanation');
    const after = fs.readFileSync(lessonsPath, 'utf8').split('\n').length;

    assert.ok(after > before, `Expected line count to grow: ${before} → ${after}`);
    const content = fs.readFileSync(lessonsPath, 'utf8');
    assert.ok(content.includes('test-slug'), 'Lesson should contain slug');
    assert.ok(content.includes('fail'), 'Lesson should contain status');
    assert.ok(content.includes('Test explanation'), 'Lesson should contain explanation');
  } finally {
    cleanupTempDir(dir);
  }
});

test('writeLesson creates lessons.md if it does not exist', () => {
  const dir = makeTempDir();
  try {
    const atrisDir = path.join(dir, 'atris');
    fs.mkdirSync(atrisDir, { recursive: true });

    writeLesson(dir, 'new-file-slug', 'pass', 'Created from scratch');

    const lessonsPath = path.join(atrisDir, 'lessons.md');
    assert.ok(fs.existsSync(lessonsPath), 'lessons.md should be created');
    const content = fs.readFileSync(lessonsPath, 'utf8');
    assert.ok(content.includes('new-file-slug'), 'Lesson should contain slug');
  } finally {
    cleanupTempDir(dir);
  }
});
