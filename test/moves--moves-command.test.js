'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function withWorkspace(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-moves-command-'));
  const savedHome = process.env.HOME;
  const savedAtris = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => key.startsWith('ATRIS_')));
  const savedLog = console.log;
  const output = [];
  try {
    process.env.HOME = root;
    for (const key of Object.keys(savedAtris)) delete process.env[key];
    console.log = (...args) => output.push(args.join(' '));
    const { movesCommand } = require('../commands/moves');
    await run({ root, output, movesCommand });
  } finally {
    console.log = savedLog;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    Object.assign(process.env, savedAtris);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeRoadmap(root) {
  fs.writeFileSync(path.join(root, 'ROADMAP.md'), [
    '# Roadmap', '', '## Open loop items', '',
    '- [ ] Fix search', '- [x] Already shipped', '- [~] In progress',
    '- [ ] Improve export', '- [ ] Add shortcuts', '- [ ] Update help',
    '', '## Later', '- [ ] Outside the queue', '',
  ].join('\n'));
}

// No dreams or approval fixtures: those paths use the current date.
test('movesCommand prints the default three open roadmap moves as JSON', async () => {
  await withWorkspace(async ({ root, output, movesCommand }) => {
    writeRoadmap(root);
    assert.strictEqual(await movesCommand(['--json'], root), 0);
    assert.strictEqual(output.length, 1);
    const { moves } = JSON.parse(output[0]);
    assert.deepStrictEqual(moves.map((move) => move.title), [
      'Fix search', 'Improve export', 'Add shortcuts',
    ]);
    for (const move of moves) {
      assert.strictEqual(move.source, 'roadmap');
      assert.strictEqual(move.weight, 100);
      assert.strictEqual(move.why, 'open item in ROADMAP.md, the goal the loop pursues');
      assert.match(move.id, /^m_[a-z0-9]+$/);
    }
    assert.strictEqual(new Set(moves.map((move) => move.id)).size, 3);
  });
});

test('movesCommand clamps a zero limit and falls back for an invalid limit', async () => {
  await withWorkspace(async ({ root, output, movesCommand }) => {
    writeRoadmap(root);
    assert.strictEqual(await movesCommand(['--json', '--limit', '0'], root), 0);
    const first = JSON.parse(output.pop()).moves;
    assert.deepStrictEqual(first.map((move) => move.title), ['Fix search']);
    assert.strictEqual(await movesCommand(['--json', '--limit', 'invalid'], root), 0);
    const fallback = JSON.parse(output.pop()).moves;
    assert.strictEqual(fallback.length, 3);
    assert.deepStrictEqual(fallback[0], first[0]);
  });
});

test('movesCommand reports an empty workspace without prompting or writing files', async () => {
  await withWorkspace(async ({ root, output, movesCommand }) => {
    assert.strictEqual(await movesCommand(['--json'], root), 0);
    assert.deepStrictEqual(JSON.parse(output.pop()), { moves: [] });
    assert.strictEqual(await movesCommand([], root), 0);
    assert.strictEqual(output.pop(), [
      '', 'your next moves', '',
      '  nothing queued. add an item to ROADMAP.md under "## Open loop items",',
      '  or jot an idea with `atris log`.', '',
    ].join('\n'));
    assert.deepStrictEqual(fs.readdirSync(root), []);
  });
});

test('movesCommand reports unmatched selections without recording a decision', async () => {
  await withWorkspace(async ({ root, output, movesCommand }) => {
    writeRoadmap(root);
    const original = fs.readFileSync(path.join(root, 'ROADMAP.md'), 'utf8');
    assert.strictEqual(await movesCommand(['--kill', '0,999,m_missing,bogus'], root), 0);
    assert.deepStrictEqual(output, ['no matching move for that id or number.']);
    assert.strictEqual(fs.readFileSync(path.join(root, 'ROADMAP.md'), 'utf8'), original);
    assert.deepStrictEqual(fs.readdirSync(root), ['ROADMAP.md']);
  });
});
