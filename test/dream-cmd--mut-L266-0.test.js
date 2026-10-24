'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('a successful local runner produces a dream card', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-dream-exit-'));
  const previousEnv = { ...process.env };
  const previousCwd = process.cwd();
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.HOME = root;
    process.env.PATH = `${root}${path.delimiter}/usr/bin${path.delimiter}/bin`;
    process.chdir(root);

    const runner = path.join(root, 'claude');
    const card = {
      title: 'Review the release notes',
      why: 'The release needs a final read.',
      move: 'Read the release notes and check the examples.',
    };
    const cards = [card, {
      title: 'Check the working examples',
      why: 'Readers need examples that work.',
      move: 'Run the examples listed in the release notes.',
    }];
    fs.writeFileSync(runner, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(cards))});\n`, { mode: 0o755 });
    process.env.ATRIS_RUNNER_BIN = runner;
    process.env.ATRIS_CLAUDE_BIN = runner;

    const journalDir = path.join(root, 'atris', 'logs', '2099');
    fs.mkdirSync(journalDir, { recursive: true });
    fs.writeFileSync(path.join(journalDir, '2099-01-01.md'), '# Log\n\n## Completed\n\n- prepared the release notes\n');

    const { dreamCommand } = require('../commands/dream');
    const lines = [];
    await dreamCommand(['--yes'], root, {
      stamp: '2099-01-02T00:00:00.000Z',
      log: (line) => lines.push(String(line)),
    });

    const rows = fs.readFileSync(path.join(root, '.atris', 'state', 'dreams.jsonl'), 'utf8')
      .trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.ok(rows.some((row) => row.source === 'dream' && row.title === card.title),
      `a zero exit status should save the runner's card; output: ${lines.join('\n')}`);
  } finally {
    process.chdir(previousCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previousEnv);
  }
});
