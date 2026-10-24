require('./helpers/clean-temp');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('cloud tool output displays a file path when no alternate path is supplied', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-tool-argument-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  const lines = [];
  try {
    process.env.HOME = root;
    process.chdir(root);
    fs.mkdirSync(path.join(root, '.atris'));
    fs.writeFileSync(path.join(root, '.atris', 'credentials.json'), JSON.stringify({ token: 'test-token' }));

    const api = require('../utils/api');
    t.mock.method(api, 'apiRequestJson', async (url) => {
      if (url === '/business/') {
        return { ok: true, data: [{ id: 'sample', slug: 'sample', name: 'Sample' }] };
      }
      if (url === '/business/sample/chat') {
        return { ok: true, data: { execution_id: 'test-run' } };
      }
      if (url.startsWith('/business/sample/chat/events?')) {
        return {
          ok: true,
          data: {
            status: 'completed',
            events: [{ type: 'tool_use', tool: 'Read', input: { file_path: 'source-evidence.md' } }],
          },
        };
      }
      throw new Error('Unexpected API request');
    });
    t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
    t.mock.method(process, 'exit', (code) => { throw new Error(`Unexpected exit: ${code}`); });
    const { wikiCommand } = require('../commands/wiki');
    await wikiCommand('ingest', '--cloud', 'sample', 'notes.md');

    assert.ok(lines.some((line) => line.includes('[Read]') && line.includes('source-evidence.md')));
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    t.mock.restoreAll();
  }
});
