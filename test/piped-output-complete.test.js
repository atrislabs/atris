'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const cliPath = path.resolve(__dirname, '..', 'bin', 'atris.js');

// On macOS a pipe takes 64KB before node has to wait. Exiting straight after
// the last write cut long --json output off mid-object when piped.
test('long --json output piped to another program arrives whole', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-piped-output-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  const root = path.join(base, 'ws');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  // Enough em dashes that the slop report is far past 64KB.
  fs.writeFileSync(path.join(root, 'docs', 'notes.md'), 'a line — with a dash\n'.repeat(2000), 'utf8');

  const child = spawn(process.execPath, [cliPath, 'slop', 'docs', '--json'], {
    cwd: root,
    env: { ...process.env, HOME: home, CI: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Read slowly so the pipe fills while the CLI is finishing.
  child.stdout.pause();
  const chunks = [];
  const timer = setTimeout(() => child.stdout.resume(), 300);
  child.stdout.on('data', (chunk) => chunks.push(chunk));
  const code = await new Promise((resolve) => child.on('close', resolve));
  clearTimeout(timer);
  const out = Buffer.concat(chunks).toString('utf8');
  assert.ok(out.length > 65536, `expected more than 64KB, got ${out.length} bytes (exit ${code})`);
  const parsed = JSON.parse(out);
  assert.ok(Array.isArray(parsed.findings) && parsed.findings.length > 0);
});
