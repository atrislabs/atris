'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');

const cliPath = path.resolve(__dirname, '..', 'bin', 'atris.js');

function snapshotTree(root) {
  if (!fs.existsSync(root)) return [];
  const rows = [];
  const walk = (dir, rel = '') => {
    for (const entry of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, entry);
      const childRel = rel ? path.join(rel, entry) : entry;
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) {
        rows.push(`link:${childRel}:${fs.readlinkSync(full)}`);
      } else if (stat.isDirectory()) {
        rows.push(`dir:${childRel}`);
        walk(full, childRel);
      } else {
        rows.push(`file:${childRel}:${fs.readFileSync(full).toString('hex')}`);
      }
    }
  };
  walk(root);
  return rows;
}

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-update-dry-run-'));
  const workspace = path.join(root, 'workspace');
  const home = path.join(root, 'home');
  const projectSkill = path.join(workspace, 'atris', 'skills', 'improve', 'SKILL.md');
  const globalSkill = path.join(home, '.codex', 'skills', 'improve', 'SKILL.md');
  fs.mkdirSync(path.dirname(projectSkill), { recursive: true });
  fs.mkdirSync(path.dirname(globalSkill), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'atris', 'atris.md'), 'operator atris spec\n', 'utf8');
  fs.writeFileSync(projectSkill, 'operator project skill\n', 'utf8');
  fs.writeFileSync(globalSkill, 'operator global skill\n', 'utf8');
  return { root, workspace, home };
}

function makeBusinessFixture() {
  const fixture = makeFixture();
  const metaDir = path.join(fixture.workspace, '.atris');
  fs.mkdirSync(metaDir, { recursive: true });
  fs.writeFileSync(path.join(metaDir, 'business.json'), JSON.stringify({
    slug: 'preview-co',
    name: 'Preview Co',
    workspace_template: 'business',
  }), 'utf8');
  return fixture;
}

test('single-project update and sync dry-run write nothing', () => {
  for (const command of ['update', 'sync']) {
    const fixture = makeFixture();
    try {
      const beforeWorkspace = snapshotTree(fixture.workspace);
      const beforeHome = snapshotTree(fixture.home);
      const result = spawnSync(process.execPath, [cliPath, command, '--dry-run'], {
        cwd: fixture.workspace,
        encoding: 'utf8',
        timeout: 15000,
        env: {
          ...scrubAgentEnv(),
          HOME: fixture.home,
          ATRIS_SKIP_UPDATE_CHECK: '1',
        },
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /dry.run|no changes made/i);
      assert.deepEqual(snapshotTree(fixture.workspace), beforeWorkspace, `${command} changed workspace files`);
      assert.deepEqual(snapshotTree(fixture.home), beforeHome, `${command} changed global files`);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test('business update dry-run reports stale skill changes without writing', () => {
  const fixture = makeBusinessFixture();
  try {
    const beforeWorkspace = snapshotTree(fixture.workspace);
    const beforeHome = snapshotTree(fixture.home);
    const result = spawnSync(process.execPath, [cliPath, 'update', '--dry-run'], {
      cwd: fixture.workspace,
      encoding: 'utf8',
      timeout: 15000,
      env: {
        ...scrubAgentEnv(),
        HOME: fixture.home,
        ATRIS_SKIP_UPDATE_CHECK: '1',
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Skills:\s+[1-9]\d* would update from atris-cli\/atris\/skills\//);
    assert.deepEqual(snapshotTree(fixture.workspace), beforeWorkspace, 'business update changed workspace files');
    assert.deepEqual(snapshotTree(fixture.home), beforeHome, 'business update changed global files');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
