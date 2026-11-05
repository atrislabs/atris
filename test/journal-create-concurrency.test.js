'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const cli = path.resolve(__dirname, '../bin/atris.js');

test('a concurrently created daily journal is preserved by the real log command', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-journal-create-race-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  const injector = path.join(root, 'inject.cjs');
  const marker = path.join(root, 'competing-writer-ran');
  fs.writeFileSync(injector, `
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const write = fs.writeFileSync;
const link = fs.linkSync;
let inserted = false;
function insert(s) {
  if (!inserted && /[\\\\/]atris[\\\\/]logs[\\\\/]\\d{4}[\\\\/]\\d{4}-\\d{2}-\\d{2}\\.md$/.test(s)) {
    inserted = true;
    const env = { ...process.env }; delete env.NODE_OPTIONS;
    const result = cp.spawnSync(process.execPath, ['-e', 'require("fs").writeFileSync(process.argv[1], "# Log, other process\\\\n\\\\n## Inbox\\\\n\\\\n- **I1:** existing work\\\\n")', s], { env, encoding:'utf8' });
    if (result.status !== 0) throw new Error('competing writer failed');
    write(process.env.ATRIS_TEST_JOURNAL_MARKER, 'done');
  }
}
fs.writeFileSync = function(file, data, options) {
  if (typeof data === 'string' && data.startsWith('# Log,')) insert(String(file));
  return write.apply(this, arguments);
};
fs.linkSync = function(source, dest) {
  insert(String(dest));
  return link.apply(this, arguments);
};
`);
  const out = spawnSync(process.execPath, [cli, 'log', 'new note'], { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: `--require=${injector}`, ATRIS_TEST_JOURNAL_MARKER: marker, ATRIS_SKIP_UPDATE_CHECK: '1' } });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'done');
  const date = new Date();
  const name = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}.md`;
  const log = fs.readFileSync(path.join(root, 'atris', 'logs', String(date.getFullYear()), name), 'utf8');
  assert.match(log, /existing work/);
  assert.match(log, /new note/);
});
