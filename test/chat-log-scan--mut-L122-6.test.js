const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanChatLogs } = require('../lib/chat-log-scan');

test('cursor user turns ignore non-text parts even when they contain text', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-scan-content-type-'));
  const previousHome = process.env.HOME;
  const previousCursorRoot = process.env.ATRIS_CHAT_SCAN_CURSOR_ROOT;
  try {
    process.env.HOME = root;
    delete process.env.ATRIS_CHAT_SCAN_CURSOR_ROOT;
    const work = path.join(root, 'work');
    const slug = work.replace(/^\/+/, '').split(path.sep).join('-');
    const transcripts = path.join(root, '.cursor', 'projects', slug, 'agent-transcripts');
    fs.mkdirSync(transcripts, { recursive: true });
    fs.writeFileSync(path.join(transcripts, 'session.jsonl'), JSON.stringify({
      role: 'user',
      message: {
        content: [
          { type: 'text', text: 'Keep this user request' },
          { type: 'image', text: 'Ignore this image description' },
        ],
      },
    }));

    const report = scanChatLogs({ cwd: work });
    assert.deepStrictEqual(report.sessions.map((session) => ({
      user_turns: session.user_turns,
      last_user: session.last_user,
      sample_users: session.sample_users,
    })), [{
      user_turns: 1,
      last_user: 'Keep this user request',
      sample_users: ['Keep this user request'],
    }]);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousCursorRoot === undefined) delete process.env.ATRIS_CHAT_SCAN_CURSOR_ROOT;
    else process.env.ATRIS_CHAT_SCAN_CURSOR_ROOT = previousCursorRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
