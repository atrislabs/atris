'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('the feed excludes work from checkouts beyond its discovery depth', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-discovery-depth-'));
  const root = path.join(home, 'main');
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { collectStreamEvents } = require('../commands/stream');
    const runs = path.join(root, 'atris', 'runs');
    const copy = path.join(home, '.agent-worktrees', 'main', 'group', 'nested', 'copy');
    const archive = path.join(copy, 'atris', 'runs');
    fs.mkdirSync(path.join(copy, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(copy, '.atris', 'agent-worktree.json'), '{}');
    fs.mkdirSync(runs, { recursive: true });
    fs.mkdirSync(archive, { recursive: true });
    for (const [dir, name] of [[runs, 'visible'], [archive, 'archived']]) {
      fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({
        schema: 'atris.mission_receipt.v1',
        mission_id: name,
        owner: 'mina',
        objective: name,
        at: '2026-07-06T08:06:00.000Z',
        result: {
          kind: 'mission_run_tick',
          tick: {
            status: 'ran',
            summary: `${name} release check`,
            verifier_passed: true,
            started_at: '2026-07-06T08:05:00.000Z',
            finished_at: '2026-07-06T08:06:00.000Z',
          },
        },
      }));
    }
    // The nested directory is real, but is beyond the discovery depth.
    // Searching it would add unrelated work to the feed.
    const events = collectStreamEvents({
      root,
      sinceMs: Date.parse('2026-07-06T08:00:00.000Z'),
      nowMs: Date.parse('2026-07-06T09:00:00.000Z'),
      skipLanding: true,
      deps: {
        listWorktrees: () => [],
        runGit: () => ({ status: 1, stdout: '', stderr: '' }),
      },
    });
    assert.equal(events.some((event) => event.summary.includes('visible release check')), true);
    assert.equal(events.some((event) => event.summary.includes('archived release check')), false);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
