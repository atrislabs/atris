const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readFirstJsonLine } = require('../lib/agent-today');

test('readFirstJsonLine returns null when the byte cap is zero', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-today-mut-L46-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const file = path.join(dir, 'session.jsonl');
  const row = { type: 'session_meta', payload: { cwd: '/work/app' } };
  fs.writeFileSync(file, `${JSON.stringify(row)}\n{"type":"later"}\n`);

  assert.deepStrictEqual(readFirstJsonLine(file, 1), row);
  assert.strictEqual(readFirstJsonLine(file, 0), null);
});
