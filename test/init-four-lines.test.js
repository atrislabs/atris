const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { extractOpeningLines } = require('../lib/opening-lines');

const repoRoot = path.join(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const sourceBullets = extractOpeningLines(fs.readFileSync(path.join(repoRoot, 'atris.md'), 'utf8'))
  .split('\n');

function runAtris(cwd, home, args) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', HOME: home },
  });
  assert.equal(result.status, 0, `atris ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result;
}

function runInit(cwd, home) {
  return runAtris(cwd, home, ['init', '--yes', '--no-commit']);
}

function assertCarriesLinesOnce(project) {
  for (const file of ['AGENTS.md', 'CLAUDE.md']) {
    const content = fs.readFileSync(path.join(project, file), 'utf8');
    for (const line of sourceBullets) {
      assert.equal(content.split(line).length, 2, `${file} should carry exactly one copy of: ${line}`);
    }
    assert.equal(content.split('Canonical source: `atris/atris.md` `## operating rules`').length, 2, `${file} names its source once`);
    assert.doesNotMatch(content, /four a'?s|4 ?a'?s|## attitude/i, `${file} labels the lines`);
  }
}

// A project set up before the lines existed: its atris.md opens the operating
// rules with the old checklist, and neither adapter carries a copy.
function makeLegacyProject(dir) {
  const home = path.join(dir, 'home');
  const project = path.join(dir, 'project');
  fs.mkdirSync(home);
  fs.mkdirSync(project);
  spawnSync('git', ['init', '-q'], { cwd: project });
  runInit(project, home);

  const atrisMd = path.join(project, 'atris', 'atris.md');
  const legacyAtris = fs.readFileSync(atrisMd, 'utf8')
    .split('\n').filter((line) => !sourceBullets.includes(line)).join('\n');
  assert.equal(extractOpeningLines(legacyAtris), '', 'legacy atris.md has no opening lines');
  assert.match(legacyAtris, /^- the goal$/m, 'legacy atris.md keeps the old checklist');
  fs.writeFileSync(atrisMd, legacyAtris);

  const agentsMd = path.join(project, 'AGENTS.md');
  const agents = fs.readFileSync(agentsMd, 'utf8')
    .replace(/(<!-- ATRIS_OPERATING_RULES:START -->\n)?## Operating rules\n[\s\S]*?if they differ, atris\.md wins\.\n(<!-- ATRIS_OPERATING_RULES:END -->\n)?\n*/, '');
  fs.writeFileSync(agentsMd, `${agents.trimEnd()}\n\n## Team notes\n\nkeep this agents note\n`);

  const claudeMd = path.join(project, 'CLAUDE.md');
  const claude = fs.readFileSync(claudeMd, 'utf8')
    .replace(/\n## Operating rules\n[\s\S]*?if they differ, atris\.md wins\.\n/, '');
  fs.writeFileSync(claudeMd, `${claude.trimEnd()}\n\n# Project notes\n\nkeep this claude note\n`);

  for (const file of ['AGENTS.md', 'CLAUDE.md']) {
    const content = fs.readFileSync(path.join(project, file), 'utf8');
    assert.ok(!sourceBullets.some((line) => content.includes(line)), `legacy ${file} has no copy yet`);
  }
  return { home, project };
}

function assertLegacyUpgraded(project) {
  assertCarriesLinesOnce(project);
  const agents = fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8');
  const claude = fs.readFileSync(path.join(project, 'CLAUDE.md'), 'utf8');
  assert.match(agents, /keep this agents note/);
  assert.match(claude, /keep this claude note/);
  assert.ok(agents.indexOf(sourceBullets[0]) < agents.indexOf('## You translate'), 'AGENTS.md copy sits before the translate section');
  assert.ok(claude.indexOf(sourceBullets[3]) < claude.indexOf('<!-- ATRIS:END -->'), 'CLAUDE.md copy sits inside the managed atris block');
  for (const content of [agents, claude]) {
    assert.doesNotMatch(content, /^- the goal$/m, 'the old checklist is not copied as the opening lines');
  }
}

test('atris.md opens its operating rules with four bullets', () => {
  assert.equal(sourceBullets.length, 4);
  for (const word of ['Acceleration', 'Accuracy', 'Ambition', 'Agency']) {
    assert.ok(sourceBullets.some((line) => line.startsWith(`- **${word}.**`)), `missing ${word}`);
  }
});

test('fresh init copies the four lines into AGENTS.md and CLAUDE.md, sourced and unlabeled', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-init-four-lines-'));
  const home = path.join(dir, 'home');
  const project = path.join(dir, 'project');
  fs.mkdirSync(home);
  fs.mkdirSync(project);
  try {
    spawnSync('git', ['init', '-q'], { cwd: project });
    runInit(project, home);
    runInit(project, home);

    for (const file of ['AGENTS.md', 'CLAUDE.md']) {
      const content = fs.readFileSync(path.join(project, file), 'utf8');
      for (const line of sourceBullets) {
        assert.equal(content.split(line).length, 2, `${file} should carry exactly one copy of: ${line}`);
      }
      assert.match(content, /Canonical source: `atris\/atris\.md` `## operating rules`/, `${file} names its source`);
      assert.doesNotMatch(content, /four a'?s|4 ?a'?s|## attitude/i, `${file} labels the lines`);
    }

    const claude = fs.readFileSync(path.join(project, 'CLAUDE.md'), 'utf8');
    const end = claude.indexOf('<!-- ATRIS:END -->');
    assert.ok(end > claude.indexOf(sourceBullets[3]), 'CLAUDE.md copy sits inside the managed atris block');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('re-init gives a legacy project the four lines in AGENTS.md and CLAUDE.md, once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-init-four-lines-legacy-'));
  try {
    const { home, project } = makeLegacyProject(dir);
    runInit(project, home);
    assertLegacyUpgraded(project);
    runInit(project, home);
    assertLegacyUpgraded(project);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('atris update gives a legacy project the four lines in AGENTS.md and CLAUDE.md, once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-update-four-lines-legacy-'));
  try {
    const { home, project } = makeLegacyProject(dir);
    runAtris(project, home, ['update', '--yes']);
    assertLegacyUpgraded(project);
    assert.deepEqual(
      extractOpeningLines(fs.readFileSync(path.join(project, 'atris', 'atris.md'), 'utf8')).split('\n'),
      sourceBullets,
      'update refreshes atris/atris.md itself',
    );
    runAtris(project, home, ['update', '--yes']);
    assertLegacyUpgraded(project);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an older atris.md with only checklist bullets yields no opening lines', () => {
  const legacy = '## operating rules\n\nYou can move fast.\n\nstate:\n- the goal\n- the files in scope\n\n## values\n';
  assert.equal(extractOpeningLines(legacy), '');
});
