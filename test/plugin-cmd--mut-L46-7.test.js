require('./helpers/clean-temp');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pluginCommand } = require('../commands/plugin');

test('build preserves the package version in the generated manifest', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-version-'));
  const cwd = process.cwd();
  const home = process.env.HOME;
  t.after(() => {
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  });
  process.chdir(root);
  process.env.HOME = root;
  t.mock.method(console, 'log', () => {});
  t.mock.method(process, 'exit', (code) => { throw new Error(`unexpected exit: ${code}`); });
  fs.mkdirSync(path.join(root, 'atris', 'skills'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'sample-workspace', version: '4.7.2' }));
  pluginCommand('build', '--output=' + path.join(root, 'built'));
  const zip = fs.readFileSync(path.join(root, 'built'));
  let manifest;
  for (let offset = 0; offset <= zip.length - 46; offset++) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) continue;
    const nameLength = zip.readUInt16LE(offset + 28);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString();
    if (!name.endsWith('.claude-plugin/plugin.json')) continue;
    const local = zip.readUInt32LE(offset + 42);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const compressed = zip.subarray(start, start + zip.readUInt32LE(offset + 20));
    const data = zip.readUInt16LE(offset + 10) === 0
      ? compressed : require('node:zlib').inflateRawSync(compressed);
    manifest = JSON.parse(data.toString());
    break;
  }
  assert.equal(manifest.version, '4.7.2');
});
