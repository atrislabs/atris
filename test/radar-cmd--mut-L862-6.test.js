require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('workspace view excludes an agent assigned to a task in another workspace', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-scope-'));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const { collectRadar } = require('../commands/radar');
    const root = path.join(home, 'selected');
    const other = path.join(home, 'other');
    fs.mkdirSync(root);
    const state = path.join(other, '.atris', 'state');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'tasks.projection.json'), JSON.stringify({
      tasks: [{
        display_id: 'OTHER-1',
        title: 'Work in the other project',
        status: 'claimed',
        workspace_root: other,
        claimed_by: 'codex',
      }],
    }));

    const options = {
      root,
      homeDir: home,
      platform: 'linux',
      nowMs: Date.parse('2026-05-19T16:00:00.000Z'),
      readlinkSync: () => other,
      execFileSync(command, args) {
        if (command === 'ps') {
          return '123 1 1.0 0.1 S Mon May 18 12:00:00 2026 codex exec\n';
        }
        if (command === 'git') {
          if (args.includes('branch')) return 'main\n';
          return '';
        }
        throw new Error(`unexpected command: ${command}`);
      },
    };

    // The task workspace is present, but its root is outside the selected root.
    // A global view includes this session; the workspace view must exclude it.
    assert.equal(collectRadar({ ...options, scope: 'global' }).agents.length, 1);
    assert.equal(collectRadar({ ...options, scope: 'workspace' }).agents.length, 0);
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});
