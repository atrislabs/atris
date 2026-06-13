const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { extractLayerFromReceiptText, classifyPathsByLayer } = require('../commands/mission');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function runCli(args, cwd) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
  if (result.error) throw result.error;
  return result;
}

test('extractLayerFromReceiptText: explicit parse finds layer in last non-empty line', () => {
  const text = `some work done

layer: identity`;
  const result = extractLayerFromReceiptText(text);
  assert.equal(result.layer, 'identity');
  assert.equal(result.source, 'explicit');
});

test('extractLayerFromReceiptText: case-insensitive layer parsing', () => {
  const text = `final status

LAYER: BELIEFS`;
  const result = extractLayerFromReceiptText(text);
  assert.equal(result.layer, 'beliefs');
  assert.equal(result.source, 'explicit');
});

test('extractLayerFromReceiptText: recovers mid-text tag as explicit-inline', () => {
  const text = `layer: capabilities
some work
other changes`;
  const result = extractLayerFromReceiptText(text);
  assert.equal(result.layer, 'capabilities');
  assert.equal(result.source, 'explicit-inline');
});

test('extractLayerFromReceiptText: inline scan takes the last matching line', () => {
  const text = `layer: beliefs
more work
layer: behaviors
closing note for the human`;
  const result = extractLayerFromReceiptText(text);
  assert.equal(result.layer, 'behaviors');
  assert.equal(result.source, 'explicit-inline');
});

test('extractLayerFromReceiptText: one-line summary with trailing "; layer: x" matches', () => {
  const text = 'pipeline tick: 5 features built; suite 917->950; layer: capabilities';
  const result = extractLayerFromReceiptText(text);
  assert.equal(result.layer, 'capabilities');
  assert.equal(result.source, 'explicit');
});

test('extractLayerFromReceiptText: enum docs and quoted log lines never match', () => {
  const text = `the contract says: layer: identity|beliefs|capabilities|behaviors|environment
- layer: capabilities
done`;
  const paths = ['commands/mission.js'];
  const result = extractLayerFromReceiptText(text, paths);
  assert.equal(result.layer, 'behaviors');
  assert.equal(result.source, 'fallback');
});

test('extractLayerFromReceiptText: all five layers recognized', () => {
  const layers = ['identity', 'beliefs', 'capabilities', 'behaviors', 'environment'];
  for (const layer of layers) {
    const text = `work completed\n\nlayer: ${layer}`;
    const result = extractLayerFromReceiptText(text);
    assert.equal(result.layer, layer, `failed for layer ${layer}`);
    assert.equal(result.source, 'explicit');
  }
});

test('extractLayerFromReceiptText: whitespace handling in regex', () => {
  const text = `done\n  layer:  behaviors  `;
  const result = extractLayerFromReceiptText(text);
  assert.equal(result.layer, 'behaviors');
  assert.equal(result.source, 'explicit');
});

test('extractLayerFromReceiptText: fallback when no explicit layer', () => {
  const text = 'just some work output without layer marker';
  const paths = ['commands/mission.js', 'bin/atris.js', 'package.json'];
  const result = extractLayerFromReceiptText(text, paths);
  assert.equal(result.layer, 'behaviors');
  assert.equal(result.source, 'fallback');
});

test('extractLayerFromReceiptText: fallback with empty text uses paths', () => {
  const paths = ['atris/team/navigator/MEMBER.md', 'other/file.txt'];
  const result = extractLayerFromReceiptText('', paths);
  assert.equal(result.layer, 'identity');
  assert.equal(result.source, 'fallback');
});

test('extractLayerFromReceiptText: no paths and no explicit returns unknown', () => {
  const result = extractLayerFromReceiptText('some random text');
  assert.equal(result.layer, null);
  assert.equal(result.source, 'unknown');
});

test('classifyPathsByLayer: atris/team/ -> identity', () => {
  const result = classifyPathsByLayer(['atris/team/navigator/MEMBER.md', 'other.txt']);
  assert.equal(result.layer, 'identity');
});

test('classifyPathsByLayer: atris/lessons.md -> beliefs', () => {
  const result = classifyPathsByLayer(['atris/lessons.md', 'other.txt']);
  assert.equal(result.layer, 'beliefs');
});

test('classifyPathsByLayer: atris/wiki/ -> beliefs', () => {
  const result = classifyPathsByLayer(['atris/wiki/concepts/something.md', 'file.txt']);
  assert.equal(result.layer, 'beliefs');
});

test('classifyPathsByLayer: test/ -> capabilities', () => {
  const result = classifyPathsByLayer(['test/mission.test.js', 'other.ts']);
  assert.equal(result.layer, 'capabilities');
});

test('classifyPathsByLayer: skills/ -> capabilities', () => {
  const result = classifyPathsByLayer(['skills/compiler.js', 'readme.md']);
  assert.equal(result.layer, 'capabilities');
});

test('classifyPathsByLayer: commands/ -> behaviors', () => {
  const result = classifyPathsByLayer(['commands/mission.js', 'other.txt']);
  assert.equal(result.layer, 'behaviors');
});

test('classifyPathsByLayer: bin/ -> behaviors', () => {
  const result = classifyPathsByLayer(['bin/atris.js', 'other.txt']);
  assert.equal(result.layer, 'behaviors');
});

test('classifyPathsByLayer: unmatched paths -> environment', () => {
  const result = classifyPathsByLayer(['src/index.js', 'lib/util.js', 'README.md']);
  assert.equal(result.layer, 'environment');
});

test('classifyPathsByLayer: majority voting selects dominant layer', () => {
  const result = classifyPathsByLayer([
    'atris/team/file1.md',
    'atris/team/file2.md',
    'commands/single.js',
  ]);
  assert.equal(result.layer, 'identity');
});

test('classifyPathsByLayer: tie-break favors identity > beliefs > capabilities > behaviors > environment', () => {
  const identityVsBehaviors = classifyPathsByLayer(['atris/team/x.md', 'commands/y.js']);
  assert.equal(identityVsBehaviors.layer, 'identity');

  const beliefsVsCapabilities = classifyPathsByLayer(['atris/lessons.md', 'test/x.js']);
  assert.equal(beliefsVsCapabilities.layer, 'beliefs');

  const capabilitiesVsBehaviors = classifyPathsByLayer(['test/x.js', 'commands/y.js']);
  assert.equal(capabilitiesVsBehaviors.layer, 'capabilities');
});

test('classifyPathsByLayer: empty paths returns unknown', () => {
  const result = classifyPathsByLayer([]);
  assert.equal(result.layer, null);
  assert.equal(result.source, 'unknown');
});

test('classifyPathsByLayer: non-array returns unknown', () => {
  const result = classifyPathsByLayer(null);
  assert.equal(result.layer, null);
  assert.equal(result.source, 'unknown');
});

test('manual mission tick records layer from --summary in receipt and mission state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-layer-tick-test-'));
  try {
    const started = runCli(['mission', 'start', 'layer tick mission', '--owner', 'mission-lead', '--json'], dir);
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const mission = JSON.parse(started.stdout).mission;
    const ticked = runCli(['mission', 'tick', mission.id, '--summary', 'wrote the lesson down; layer: beliefs', '--json'], dir);
    assert.equal(ticked.status, 0, ticked.stderr || ticked.stdout);
    const out = JSON.parse(ticked.stdout);
    assert.equal(out.tick.layer, 'beliefs');
    assert.equal(out.tick.layer_source, 'explicit');
    assert.equal(out.mission.last_tick_layer, 'beliefs');
    const receipt = JSON.parse(fs.readFileSync(path.join(dir, out.receipt_path), 'utf8'));
    assert.equal(receipt.result.tick.layer, 'beliefs');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
