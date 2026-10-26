'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { engineVerifierLineup } = require('../commands/mission');
const { setEngineHealth } = require('../lib/engine-registry');

// Member lab 10/26: codex hung on every review and each job waited out the
// full five minutes. The roster's review backup now steps in, a benched
// reviewer goes behind it, and the builder never grades its own work.
test('the review backup steps in, never as the builder grading itself', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-review-backup-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-review-home-'));
  const previous = process.env.ATRIS_MACHINE_ROSTER_PATH;
  process.env.ATRIS_MACHINE_ROSTER_PATH = path.join(home, '.atris', 'roster.json');
  try {
    spawnSync('git', ['init', '-q'], { cwd: root });
    fs.mkdirSync(path.join(root, 'atris'));
    fs.mkdirSync(path.join(home, '.atris'));
    fs.writeFileSync(path.join(home, '.atris', 'ROSTER.md'), [
      '# roster', '',
      '## review',
      '- codex, model: gpt-6.1-sol',
      '- claude code, model: opus 5.5', '',
    ].join('\n'));
    setEngineHealth('codex', 'ready', root);
    setEngineHealth('claude', 'ready', root);
    const lineup = (mission, named = '') => engineVerifierLineup(mission, root, named, { healthRoot: root })
      .map(({ engine, model }) => `${engine} ${model}`.trim());

    assert.deepEqual(lineup({ runner: 'claude', model: 'claude-sonnet-5-5' }), ['codex', 'claude claude-opus-5-5']);
    // Opus built it, so opus may not review it.
    assert.deepEqual(lineup({ runner: 'claude', model: 'claude-opus-5-5' }), ['codex']);
    // A named reviewer is never swapped.
    assert.deepEqual(lineup({ runner: 'claude', model: 'claude-sonnet-5-5' }, 'codex'), ['codex']);
    // A benched reviewer waits behind its backup.
    setEngineHealth('codex', 'cooling', root);
    assert.deepEqual(lineup({ runner: 'claude', model: 'claude-sonnet-5-5' }), ['claude claude-opus-5-5', 'codex']);
  } finally {
    if (previous === undefined) delete process.env.ATRIS_MACHINE_ROSTER_PATH;
    else process.env.ATRIS_MACHINE_ROSTER_PATH = previous;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
