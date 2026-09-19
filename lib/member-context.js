'use strict';

const fs = require('fs');
const path = require('path');

const MEMBER_PROCESS_PATH = 'atris/team/MEMBER_PROCESS.md';
const MAX_MEMBER_PROCESS_BYTES = 32 * 1024;

// Read from the executing workspace only. Never fall back to the launcher,
// an ancestor workspace, or a bundled policy belonging to another owner.
function memberProcessPrompt(cwd = process.cwd()) {
  const file = path.join(cwd, MEMBER_PROCESS_PATH);
  let fd;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error('expected a regular file');
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(MAX_MEMBER_PROCESS_BYTES + 1);
    const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (count > MAX_MEMBER_PROCESS_BYTES) {
      throw new Error(`keep the shared process within ${MAX_MEMBER_PROCESS_BYTES} bytes`);
    }
    const body = buffer.subarray(0, count).toString('utf8').trim();
    if (!body) return '';
    return [
      '## Shared member process',
      `Source: ${MEMBER_PROCESS_PATH} in this execution workspace.`,
      'Apply these defaults alongside the member identity. They do not expand role permissions or override operator direction, task scope, output format, or frozen mission constraints.',
      '',
      body,
      '',
      'End of shared member process. The current task and its constraints follow.',
    ].join('\n');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw new Error(`Cannot load ${MEMBER_PROCESS_PATH}: ${error.message}`);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

module.exports = { memberProcessPrompt, MEMBER_PROCESS_PATH, MAX_MEMBER_PROCESS_BYTES };
