const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ensureWorkspaceBrain, workspaceBrainPresent } = require('../lib/workspace-scaffold');

// Local time on purpose: the journal name follows the local calendar day.
const FIXED_NOW = new Date(2026, 9, 23, 9, 0, 0);

function withTempWorkspace(run) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-workspace-scaffold-'));
  const saved = { HOME: process.env.HOME, ATRIS_TASKS_DB: process.env.ATRIS_TASKS_DB };
  process.env.HOME = path.join(sandbox, 'home');
  process.env.ATRIS_TASKS_DB = path.join(sandbox, 'home', 'tasks.db');
  const projectRoot = path.join(sandbox, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  try {
    return run(projectRoot);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

test('ensureWorkspaceBrain builds the brain in an empty project and reports each new file', () => {
  withTempWorkspace((projectRoot) => {
    assert.strictEqual(workspaceBrainPresent(projectRoot), false);

    const result = ensureWorkspaceBrain(projectRoot, { now: FIXED_NOW });

    assert.strictEqual(result.atrisDir, path.join(projectRoot, 'atris'));
    assert.deepStrictEqual([...result.created].sort(), [
      'atris/MAP.md',
      'atris/TODO.md',
      'atris/atris.md',
      'atris/logs/2026/2026-10-23.md',
      'atris/now.md',
      'atris/team/',
      'atris/wiki/index.md',
    ]);
    assert.strictEqual(workspaceBrainPresent(projectRoot), true);

    const mapText = fs.readFileSync(path.join(projectRoot, 'atris', 'MAP.md'), 'utf8');
    assert.ok(mapText.startsWith('# MAP.md\n'));

    const journal = fs.readFileSync(path.join(projectRoot, 'atris', 'logs', '2026', '2026-10-23.md'), 'utf8');
    assert.ok(journal.startsWith('# Log: 2026-10-23\n'));
    assert.match(journal, /## Inbox/);
  });
});

test('ensureWorkspaceBrain keeps the user edits and creates nothing on a second run', () => {
  withTempWorkspace((projectRoot) => {
    ensureWorkspaceBrain(projectRoot, { now: FIXED_NOW });
    const mapFile = path.join(projectRoot, 'atris', 'MAP.md');
    fs.writeFileSync(mapFile, '# My real map\n');

    const second = ensureWorkspaceBrain(projectRoot, { now: FIXED_NOW });

    assert.deepStrictEqual(second.created, []);
    assert.strictEqual(fs.readFileSync(mapFile, 'utf8'), '# My real map\n');
    assert.strictEqual(second.taskSeed.ok, true, second.taskSeed.error);
    assert.strictEqual(second.taskSeed.inserted, 0);
  });
});

test('ensureWorkspaceBrain seeds the task plane from the starter TODO and writes the projection', () => {
  withTempWorkspace((projectRoot) => {
    const first = ensureWorkspaceBrain(projectRoot, { now: FIXED_NOW });

    assert.strictEqual(first.taskSeed.ok, true, first.taskSeed.error);
    assert.ok(first.taskSeed.inserted >= 1, `expected at least one seeded task, got ${first.taskSeed.inserted}`);

    const projectionPath = path.join(projectRoot, '.atris', 'state', 'tasks.projection.json');
    assert.strictEqual(first.taskSeed.projectionPath, projectionPath);
    const projectionText = fs.readFileSync(projectionPath, 'utf8');
    assert.doesNotThrow(() => JSON.parse(projectionText));
    assert.ok(projectionText.includes('Generate MAP.md, scan codebase'));
  });
});

test('workspaceBrainPresent is false as soon as one required piece is missing', () => {
  withTempWorkspace((projectRoot) => {
    ensureWorkspaceBrain(projectRoot, { now: FIXED_NOW });
    assert.strictEqual(workspaceBrainPresent(projectRoot), true);

    const nowFile = path.join(projectRoot, 'atris', 'now.md');
    fs.rmSync(nowFile);
    assert.strictEqual(workspaceBrainPresent(projectRoot), false);

    fs.writeFileSync(nowFile, '# now\n');
    fs.rmSync(path.join(projectRoot, 'atris', 'team'), { recursive: true });
    assert.strictEqual(workspaceBrainPresent(projectRoot), false);
  });
});
