'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gameCommand } = require('../commands/game');

// Each call owns its workspace and restores the process globals before returning.
async function inWorkspace(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-game-command-'));
  const cwd = process.cwd();
  const log = console.log;
  const error = console.error;
  const output = [];
  const errors = [];
  try {
    process.chdir(root);
    console.log = value => output.push(value);
    console.error = value => errors.push(value);
    await run({ root, output, errors });
  } finally {
    console.log = log;
    console.error = error;
    process.chdir(cwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function publisher(root, payload, expectedArgs) {
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'venv', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'game_state_sync.py'), '# supports --storyline\n');
  // A real, bounded executable supplies deterministic publisher output without Python.
  fs.writeFileSync(path.join(root, 'venv', 'bin', 'python'),
    `#!${process.execPath}\n` +
    `require('node:assert').deepStrictEqual(process.argv.slice(3), ${JSON.stringify(expectedArgs)});\n` +
    `process.stdout.write(${JSON.stringify(JSON.stringify(payload))});\n`,
    { mode: 0o755 });
}

function plain(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

test('gameCommand renders a selected storyline using the publisher arguments', async () => {
  await inWorkspace(async ({ root, output, errors }) => {
    fs.mkdirSync(path.join(root, 'atris', 'storylines'), { recursive: true });
    fs.writeFileSync(path.join(root, 'atris', 'storylines', 'launch.md'), 'launch');
    publisher(root, {
      storyline: { name: 'Launch', destination: 'Release', chapters: [],
        mission: { title: 'Ship', status: 'active' },
        streak: { current: 2, target: 3, label: 'wins' } },
      missions: { active: [], recent_complete: 4 },
    }, ['--json', '--storyline', 'launch']);
    assert.strictEqual(await gameCommand(['--storyline', 'launch']), true);
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(output.length, 1);
    const dashboard = plain(output[0]);
    assert.match(dashboard, /^Launch\nDESTINATION: Release\n/);
    assert.match(dashboard, /STATUS: ACTIVE/);
    assert.match(dashboard, /STREAK: 2 \/ 3 \| wins/);
    assert.match(dashboard, /No active missions\./);
    assert.match(dashboard, /RECENT COMPLETES: 4/);
  });
});

test('gameCommand renders fallback fields for an empty published object', async () => {
  await inWorkspace(async ({ root, output, errors }) => {
    publisher(root, {}, ['--json']);
    assert.strictEqual(await gameCommand(), true);
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(output.length, 1);
    const dashboard = plain(output[0]);
    assert.match(dashboard, /^No storyline loaded\n/);
    assert.match(dashboard, /No current mission/);
    assert.match(dashboard, /NEXT MOVE: No active mission$/);
  });
});

test('gameCommand reports missing data and honors silentMissing', async () => {
  await inWorkspace(async ({ output, errors }) => {
    assert.strictEqual(await gameCommand([]), false);
    assert.deepStrictEqual(output, ['no game state in this workspace (needs atris/storylines/)']);
    output.length = 0;
    assert.strictEqual(await gameCommand([], { silentMissing: true }), false);
    assert.deepStrictEqual(output, []);
    assert.deepStrictEqual(errors, []);
  });
});

test('gameCommand rejects malformed arguments and lists only available storylines', async () => {
  await inWorkspace(async ({ root, output, errors }) => {
    const directory = path.join(root, 'atris', 'storylines');
    fs.mkdirSync(directory, { recursive: true });
    for (const name of ['zebra.md', 'alpha.md', 'resume-log.md', 'notes.txt']) {
      fs.writeFileSync(path.join(directory, name), '');
    }
    fs.mkdirSync(path.join(directory, 'folder.md'));
    for (const args of [['--storyline'], ['../escape'], ['alpha', 'zebra'], ['--unknown'], ['missing']]) {
      assert.strictEqual(await gameCommand(args), 1);
    }
    assert.deepStrictEqual(errors, [
      'missing storyline slug',
      'invalid storyline slug: ../escape',
      'choose one storyline',
      'unknown game option: --unknown',
      'storyline not found: missing. available: alpha, zebra',
    ]);
    assert.deepStrictEqual(output, []);
  });
});
