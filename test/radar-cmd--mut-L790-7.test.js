const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectRadar } = require('../commands/radar');

test('workspace advice calls out a live session with no task', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-untasked-advice-'));
  const savedHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const state = path.join(root, '.atris', 'state');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'tasks.projection.json'), JSON.stringify({ tasks: [] }));
    fs.writeFileSync(path.join(state, 'career_xp.projection.json'), JSON.stringify({
      integrity_status: 'verified',
    }));
    const data = collectRadar({
      root,
      homeDir: root,
      platform: 'linux',
      nowMs: Date.parse('2026-05-19T16:00:00.000Z'),
      execFileSync(command, args) {
        if (command === 'ps') return '777 1 0.2 0.1 S Tue May 19 09:00:00 2026 claude\n';
        if (command === 'git' && args.includes('branch')) return 'main\n';
        if (command === 'git') return '';
        throw new Error(`unexpected command: ${command}`);
      },
      readlinkSync: () => root,
    });
    assert.match(data.next_action, /untasked live agents/);
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});
