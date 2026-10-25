const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { claudeRunnerMcpArgs } = require('../commands/mission');

test('code members start without account-wide tool servers but keep the project ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-runner-mcp-'));
  try {
    assert.deepEqual(claudeRunnerMcpArgs({ owner: 'executor' }, dir, {}), ['--strict-mcp-config']);
    fs.writeFileSync(path.join(dir, '.mcp.json'), '{"mcpServers":{}}');
    assert.deepEqual(claudeRunnerMcpArgs({ owner: 'navigator' }, dir, {}), ['--strict-mcp-config', '--mcp-config', path.join(dir, '.mcp.json')]);
    // Members whose work may use mail or calendar keep everything.
    assert.deepEqual(claudeRunnerMcpArgs({ owner: 'inbox-lead' }, dir, {}), []);
    assert.deepEqual(claudeRunnerMcpArgs({ owner: 'customer-lead' }, dir, {}), []);
    assert.deepEqual(claudeRunnerMcpArgs({ owner: 'executor' }, dir, { ATRIS_MEMBER_KEEP_MCP: '1' }), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
