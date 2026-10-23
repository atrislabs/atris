const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOfficialCliCommand } = require('../lib/official-cli-integration');

test('doctor reports the trimmed first nonempty version line', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'official-cli-version-'));
  const originalLog = console.log;
  const output = [];
  try {
    const fixture = path.join(directory, 'version.js');
    fs.writeFileSync(fixture, 'process.stdout.write("\\r\\n   Sample CLI v2.7.4   \\r\\nignored second line\\n");\n');
    const command = createOfficialCliCommand({
      name: 'sample',
      binary: process.execPath,
      versionArgs: [fixture],
      commands: [],
    });
    console.log = (line) => output.push(line);
    assert.equal(command(['doctor']), 0);
    assert.deepEqual(output, [
      'sample integration',
      `binary: found ${process.execPath}`,
      'version: sample cli v2.7.4',
      'auth: not checked',
    ]);
  } finally {
    console.log = originalLog;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
