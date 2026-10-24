require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('workspace task binding preserves the live Claude session identifier', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-session-'));
  const savedHome = process.env.HOME;
  const savedCwd = process.cwd();
  process.env.HOME = root;
  process.chdir(root);
  try {
    const { collectRadar } = require('../commands/radar');
    const state = path.join(root, '.atris', 'state');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'tasks.projection.json'), JSON.stringify({
      tasks: [{
        display_id: 'CLI-825',
        title: 'Preserve process identity',
        status: 'claimed',
        workspace_root: root,
        claimed_by: 'claude',
      }],
    }));
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const data = collectRadar({
      root,
      homeDir: root,
      platform: 'linux',
      nowMs: Date.parse('2026-05-19T16:00:00.000Z'),
      readlinkSync: () => root,
      execFileSync(command, args) {
        if (command === 'ps') {
          return `501 1 1.0 0.1 S Tue May 19 09:00:00 2026 claude -p run --session-id ${sessionId}\n`;
        }
        if (command === 'git' && args.includes('branch')) return 'main\n';
        if (command === 'git' && args.includes('status')) return '';
        if (command === 'git' && args.includes('worktree')) return '';
        throw new Error(`unexpected command: ${command}`);
      },
    });
    const agent = data.agents.find(row => row.pid === '501');
    assert.ok(agent, 'the live process should appear');
    assert.equal(agent.task_source, 'repo_task_projection');
    assert.equal(agent.session_id, sessionId);
  } finally {
    process.chdir(savedCwd);
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});
