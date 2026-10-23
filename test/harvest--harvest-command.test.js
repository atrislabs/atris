'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-harvest-command-'));
const repoCwd = process.cwd();
process.env.HOME = home;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}
process.chdir(home);

const { harvestCommand } = require('../commands/harvest');

const HELP_LINES = [
  'Usage: atris harvest [--write] [--json]',
  '',
  'Find plain next actions from mission receipts, run logs, and thinking.md.',
  'Read-only by default. Use --write to append actions to today\'s Inbox.',
];

function capture(fn) {
  const logs = [];
  const log = console.log;
  console.log = (...args) => logs.push(args.map(String).join(' '));
  try {
    return { result: fn(), logs };
  } finally {
    console.log = log;
  }
}

function withTempRoot(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-harvest-command-'));
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return fn(dir);
  } finally {
    process.chdir(previous);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function rel(...parts) {
  return parts.join(path.sep);
}

function plainLines(actions) {
  const lines = [];
  for (const action of actions) {
    lines.push(`- **${action.id}:** ${action.title}`);
    lines.push(`  reason: ${action.reason}`);
    if (action.evidence) lines.push(`  evidence: ${action.evidence}`);
  }
  lines.push('Read-only. Add --write to append these to today\'s Inbox.');
  return lines;
}

test.describe('harvestCommand', { concurrency: false }, () => {
  test.after(() => {
    process.chdir(repoCwd);
  });

  test('help prints usage and does not harvest a failing receipt', () => {
    withTempRoot((dir) => {
      fs.mkdirSync(path.join(dir, 'atris', 'runs'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'atris', 'runs', 'alpha.json'), JSON.stringify({
        schema: 'atris.mission_receipt.v1',
        objective: 'Ship the inbox preview',
        result: { verifier_result: { passed: false } },
      }));

      for (const args of [['--help'], ['-h'], ['help', '--json']]) {
        const seen = capture(() => harvestCommand(args));
        assert.deepStrictEqual(seen.result, { ok: true, action: 'help' });
        assert.deepStrictEqual(seen.logs, HELP_LINES);
      }
    });
  });

  test('an empty workspace and a broken receipt report no actions', () => {
    withTempRoot((dir) => {
      const empty = capture(() => harvestCommand([]));
      assert.deepStrictEqual(empty.result, {
        ok: true,
        action: 'harvest',
        write: false,
        count: 0,
        actions: [],
        writes: [],
      });
      assert.deepStrictEqual(empty.logs, ['No harvest actions found.']);

      const write = capture(() => harvestCommand(['--write']));
      assert.strictEqual(write.result.write, true);
      assert.strictEqual(write.result.count, 0);
      assert.deepStrictEqual(write.result.writes, []);
      assert.deepStrictEqual(write.logs, ['No harvest actions found.']);
      assert.strictEqual(fs.existsSync(path.join(dir, 'atris')), false);

      const json = capture(() => harvestCommand(['--json']));
      assert.deepStrictEqual(JSON.parse(json.logs[0]), json.result);
      assert.strictEqual(json.result.count, 0);

      fs.mkdirSync(path.join(dir, 'atris', 'runs'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'atris', 'logs', 'runs'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'atris', 'runs', 'broken.json'), '{');
      fs.writeFileSync(path.join(dir, 'atris', 'runs', 'other.json'), '{"schema":"nope"}');
      fs.writeFileSync(path.join(dir, 'atris', 'logs', 'runs', 'empty.log'), '');
      fs.writeFileSync(path.join(dir, 'atris', 'logs', 'runs', 'spaces.log'), ' \n\t\n ');
      fs.writeFileSync(path.join(dir, 'atris', 'thinking.md'), '');

      const broken = capture(() => harvestCommand());
      assert.strictEqual(broken.result.count, 0);
      assert.deepStrictEqual(broken.result.actions, []);
      assert.deepStrictEqual(broken.logs, ['No harvest actions found.']);
    });
  });

  test('normal receipts, run logs, and thinking become four actions', () => {
    withTempRoot((dir) => {
      fs.mkdirSync(path.join(dir, 'atris', 'runs'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'atris', 'logs', 'runs'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'atris', 'runs', 'alpha.json'), JSON.stringify({
        schema: 'atris.mission_receipt.v1',
        objective: 'Ship the inbox preview',
        result: {
          verifier_result: { passed: false },
          landing: {
            reason: 'Buried landing reason.',
            proof: 'receipt saved',
          },
        },
      }));
      fs.writeFileSync(
        path.join(dir, 'atris', 'logs', 'runs', 'notes.log'),
        'Checked the runner.\nError: missing proof file.\n',
      );
      fs.writeFileSync(
        path.join(dir, 'atris', 'thinking.md'),
        'People should understand the proof in plain English.\n',
      );

      const actions = [
        {
          id: 'I1',
          title: 'Fix failing verifier for Ship the inbox preview',
          source: 'receipt',
          reason: 'Ship the inbox preview Buried landing reason.',
          evidence: rel('atris', 'runs', 'alpha.json'),
        },
        {
          id: 'I2',
          title: 'Surface buried result landing reasoning in the normal mission view',
          source: 'receipt',
          reason: 'Buried landing reason.',
          evidence: rel('atris', 'runs', 'alpha.json'),
        },
        {
          id: 'I3',
          title: 'Turn recent run-log failures into a bounded fix task with proof',
          source: 'runlog',
          reason: 'Checked the runner. Error: missing proof file.',
          evidence: rel('atris', 'logs', 'runs', 'notes.log'),
        },
        {
          id: 'I4',
          title: 'Make proof and task previews plain enough to understand without opening logs',
          source: 'thinking',
          reason: 'People should understand the proof in plain English.',
          evidence: rel('atris', 'thinking.md'),
        },
      ];
      const expected = {
        ok: true,
        action: 'harvest',
        write: false,
        count: 4,
        actions,
        writes: [],
      };

      const plain = capture(() => harvestCommand([]));
      assert.deepStrictEqual(plain.result, expected);
      assert.deepStrictEqual(plain.logs, plainLines(actions));
      assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'atris', 'logs')), ['runs']);

      const json = capture(() => harvestCommand(['--json']));
      assert.deepStrictEqual(json.result, expected);
      assert.deepStrictEqual(JSON.parse(json.logs[0]), expected);
    });
  });

  test('blank objectives, clipped reasons, and duplicate receipts stay bounded', () => {
    withTempRoot(() => {
      const filler = 'z'.repeat(240);
      const receipt = {
        schema: 'atris.mission_receipt.v1',
        objective: '',
        result: {
          reason: `proof:   null ${filler}`,
          verifier_result: { passed: false },
          landing: {
            changed: '  kept   the   receipt  ',
            reason: 'stop   early',
            proof: null,
          },
        },
      };
      fs.mkdirSync(path.join('atris', 'runs'), { recursive: true });
      fs.mkdirSync(path.join('atris', 'logs', 'runs'), { recursive: true });
      fs.writeFileSync(path.join('atris', 'runs', 'broken.json'), '{');
      fs.writeFileSync(path.join('atris', 'runs', 'note.json'), '{"schema":"nope"}');
      fs.writeFileSync(path.join('atris', 'runs', 'first.json'), JSON.stringify(receipt));
      fs.writeFileSync(path.join('atris', 'runs', 'second.json'), JSON.stringify(receipt));
      fs.writeFileSync(path.join('atris', 'logs', 'runs', 'spaces.log'), ' \n\t\n ');
      fs.writeFileSync(path.join('atris', 'thinking.md'), 'Just a note about the weather.\n');

      const reason = `kept the receipt stop early proof: null ${'z'.repeat(177)}...`;
      const evidence = rel('atris', 'runs', 'first.json');
      const actions = [
        {
          id: 'I1',
          title: 'Improve the next-mission chooser so it explains stopped work and better candidates',
          source: 'receipt',
          reason,
          evidence,
        },
        {
          id: 'I2',
          title: 'Fix failing verifier for latest mission',
          source: 'receipt',
          reason,
          evidence,
        },
        {
          id: 'I3',
          title: 'Repair proof mismatch where proof exists in metadata but renders as null',
          source: 'receipt',
          reason,
          evidence,
        },
      ];
      const expected = {
        ok: true,
        action: 'harvest',
        write: false,
        count: 3,
        actions,
        writes: [],
      };

      const plain = capture(() => harvestCommand([]));
      assert.deepStrictEqual(plain.result, expected);
      assert.deepStrictEqual(plain.logs, plainLines(actions));
      assert.strictEqual(plain.result.actions.some((action) => action.evidence.endsWith('second.json')), false);

      const json = capture(() => harvestCommand(['--json']));
      assert.deepStrictEqual(JSON.parse(json.logs[0]), expected);
    });
  });
});
