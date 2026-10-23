'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { whoCommand } = require('../commands/who');

test('who includes a process whose lsof working directory is inside the workspace', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-who-cwd-'));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  let output = '';
  const calls = [];
  try {
    // Exercise the lsof path on every host, including Linux.
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
    const result = whoCommand([], {
      root,
      now: () => Date.parse('2026-01-01T00:00:00Z'),
      tasks: [],
      missions: [],
      receipts: [],
      execFile(command, args) {
        calls.push([command, args]);
        if (command === 'ps') {
          // An invalid start date keeps the rendered age independent of timezone.
          return '321 1 Xxx Xxx xx xx:xx:xx xxxx /usr/local/bin/codex exec\n';
        }
        assert.equal(command, 'lsof');
        return `p321\nfcwd\nn${path.join(root, 'child')}\n`;
      },
      write(text) { output += text; },
    });
    assert.equal(result, 0);
    assert.deepEqual(calls, [
      ['ps', ['-eo', 'pid=,ppid=,lstart=,command=']],
      ['lsof', ['-a', '-d', 'cwd', '-Fn', '-p', '321']],
    ]);
    assert.equal(output, [
      'working:',
      '  none',
      'waiting:',
      '  none',
      'done:',
      '  none',
      'stale:',
      '  none',
      'unowned:',
      '  codex pid 321 (age unknown), no matching claim, mission, or run receipt',
      'totals: 0 working, 0 waiting, 0 done, 0 stale, 1 unowned',
      '',
    ].join('\n'));
  } finally {
    Object.defineProperty(process, 'platform', platform);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
