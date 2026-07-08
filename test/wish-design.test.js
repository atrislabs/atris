const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { detectDesignContext, isFrontendWish } = require('../lib/wish-design');
const { startWishDelegation } = require('../lib/wish-delegate');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-wish-design-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function hasNodeSqlite() {
  const result = spawnSync(process.execPath, ['-e', 'require("node:sqlite")'], {
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  return result.status === 0;
}

function writeFile(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, 'utf8');
}

function writeDesignFixture(dir) {
  writeFile(path.join(dir, 'atris', 'skills', 'design', 'SKILL.md'), '# design skill\n');
  writeFile(path.join(dir, 'atris', 'policies', 'atris-design.md'), '# design policy\n');
  writeFile(path.join(dir, '.atris', 'theme.json'), JSON.stringify({ color: 'blue' }) + '\n');
  writeFile(path.join(dir, 'package.json'), JSON.stringify({
    scripts: {
      'audit:design': 'node scripts/audit-design.js',
    },
  }, null, 2) + '\n');
}

function withProcessEnv(overrides, fn) {
  const previous = {};
  for (const key of Object.keys(overrides)) previous[key] = process.env[key];
  Object.assign(process.env, overrides);
  try {
    return fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

test('detectDesignContext reports design brief paths and audit command from a workspace', () => {
  const dir = makeTempDir();
  try {
    assert.deepEqual(detectDesignContext(dir), {
      hasDesign: false,
      briefPaths: [],
      auditCommand: null,
    });

    writeDesignFixture(dir);
    assert.deepEqual(detectDesignContext(dir), {
      hasDesign: true,
      briefPaths: [
        'atris/skills/design/SKILL.md',
        'atris/policies/atris-design.md',
        '.atris/theme.json',
        'package.json',
      ],
      auditCommand: 'npm run audit:design',
    });
  } finally {
    cleanupTempDir(dir);
  }
});

test('isFrontendWish detects frontend-shaped wishes with word boundaries', () => {
  assert.equal(isFrontendWish('build a landing page hero'), true);
  assert.equal(isFrontendWish('tighten the CSS button style'), true);
  assert.equal(isFrontendWish('fix database sync for invoices'), false);
  assert.equal(isFrontendWish('navigate the release backlog'), false);
});

test('startWishDelegation writes a design brief into the mission room and task note', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    writeDesignFixture(dir);
    const expectedPaths = [
      'atris/skills/design/SKILL.md',
      'atris/policies/atris-design.md',
      '.atris/theme.json',
      'package.json',
    ];

    const result = withProcessEnv({
      ATRIS_AGENT_ID: 'codex',
      ATRIS_TASKS_DB: path.join(dir, 'tasks.db'),
      NODE_NO_WARNINGS: '1',
    }, () => startWishDelegation({
      id: 'wish-design-1',
      text: 'build a landing page hero with polished buttons',
    }, {
      ok: true,
      executor: { id: 'claude' },
      validator: { id: 'validator' },
      budget: 'quick',
      questions: [],
    }, dir));

    assert.equal(result.verifyPlan.command, 'npm run audit:design');
    assert.equal(result.verifyPlan.status, 'design');
    assert.equal(result.mission.verifier, 'npm run audit:design');
    assert.deepEqual(result.record.design_brief_paths, expectedPaths);

    const receipt = readJson(path.join(dir, result.record.mission_room_receipt_path));
    assert.equal(receipt.room.design_brief.title, 'design brief');
    assert.deepEqual(receipt.room.design_brief.paths, expectedPaths);
    assert.ok(receipt.room.design_brief.lines.includes('- atris/skills/design/SKILL.md'));
    assert.ok(receipt.room.design_brief.lines.includes('- read these before writing any ui code'));
    assert.ok(receipt.room.design_brief.lines.includes('- run the design gate before claiming done'));

    const projection = readJson(path.join(dir, '.atris', 'state', 'tasks.projection.json'));
    const task = projection.tasks.find((row) => row.id === result.taskPayload.task_id);
    assert.ok(task);
    const note = task.messages.map((message) => message.content).join('\n');
    assert.match(note, /design brief:/);
    for (const briefPath of expectedPaths) assert.match(note, new RegExp(briefPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(note, /run the design gate before claiming done/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('startWishDelegation keeps a supplied verify command for frontend wishes', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    writeDesignFixture(dir);

    const result = withProcessEnv({
      ATRIS_AGENT_ID: 'codex',
      ATRIS_TASKS_DB: path.join(dir, 'tasks.db'),
      NODE_NO_WARNINGS: '1',
    }, () => startWishDelegation({
      id: 'wish-design-explicit-verify',
      text: 'build a dashboard layout',
    }, {
      ok: true,
      executor: { id: 'claude' },
      validator: { id: 'validator' },
      budget: 'quick',
      questions: [],
    }, dir, {
      verifyPlan: {
        command: 'npm run custom-verify',
        outcome: 'the custom verifier passes',
        status: 'explicit',
      },
    }));

    assert.equal(result.verifyPlan.command, 'npm run custom-verify');
    assert.equal(result.mission.verifier, 'npm run custom-verify');
    assert.deepEqual(result.record.design_brief_paths, [
      'atris/skills/design/SKILL.md',
      'atris/policies/atris-design.md',
      '.atris/theme.json',
      'package.json',
    ]);
  } finally {
    cleanupTempDir(dir);
  }
});
