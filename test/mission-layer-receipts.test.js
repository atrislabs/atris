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
    const started = runCli(['mission', 'start', '--no-verify', 'layer tick mission', '--owner', 'mission-lead', '--json'], dir);
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

test('mission layers rolls up tick receipts by layer with provenance and skew flag', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-layers-test-'));
  try {
    const runsDir = path.join(dir, 'atris', 'runs');
    fs.mkdirSync(runsDir, { recursive: true });
    const writeReceiptFile = (name, tick) => {
      fs.writeFileSync(path.join(runsDir, name), JSON.stringify({
        schema: 'atris.mission_receipt.v1',
        mission_id: 'mission-x',
        result: { kind: 'mission_run_tick', tick },
      }) + '\n', 'utf8');
    };
    for (let i = 0; i < 5; i++) {
      writeReceiptFile(`mission-x-${i}.json`, { layer: 'behaviors', layer_source: 'explicit' });
    }
    writeReceiptFile('mission-x-cap.json', { layer: 'capabilities', layer_source: 'explicit-inline' });
    writeReceiptFile('mission-x-untagged.json', { summary: 'no tag' });
    writeReceiptFile('mission-y-other.json', { layer: 'beliefs', layer_source: 'fallback' });
    // summary receipts (no result.tick) are ignored
    fs.writeFileSync(path.join(runsDir, 'mission-x-summary.json'), JSON.stringify({
      schema: 'atris.mission_receipt.v1',
      result: { kind: 'mission_run_summary' },
    }) + '\n', 'utf8');

    const all = runCli(['mission', 'layers', '--json'], dir);
    assert.equal(all.status, 0, all.stderr || all.stdout);
    const rollup = JSON.parse(all.stdout);
    assert.equal(rollup.total, 8);
    assert.equal(rollup.tagged, 7);
    assert.equal(rollup.untagged, 1);
    assert.equal(rollup.by_layer.behaviors, 5);
    assert.equal(rollup.by_layer.capabilities, 1);
    assert.equal(rollup.by_layer.beliefs, 1);
    assert.equal(rollup.by_source.explicit, 5);
    assert.equal(rollup.by_source['explicit-inline'], 1);
    assert.equal(rollup.by_source.fallback, 1);
    assert.equal(rollup.dominant, 'behaviors');
    assert.equal(rollup.skewed, false);

    // filtered to mission-y, behaviors drops out
    const filtered = JSON.parse(runCli(['mission', 'layers', '--mission', 'mission-y', '--json'], dir).stdout);
    assert.equal(filtered.total, 1);
    assert.equal(filtered.by_layer.beliefs, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mission layers flags skew when one layer dominates tagged ticks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-layers-skew-test-'));
  try {
    const runsDir = path.join(dir, 'atris', 'runs');
    fs.mkdirSync(runsDir, { recursive: true });
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(runsDir, `mission-z-${i}.json`), JSON.stringify({
        schema: 'atris.mission_receipt.v1',
        result: { kind: 'mission_tick', tick: { layer: 'environment', layer_source: 'explicit' } },
      }) + '\n', 'utf8');
    }
    const out = runCli(['mission', 'layers'], dir);
    assert.equal(out.status, 0, out.stderr || out.stdout);
    assert.match(out.stdout, /rebalance: 100% of tagged ticks are "environment"/);
    const json = JSON.parse(runCli(['mission', 'layers', '--json'], dir).stdout);
    assert.equal(json.skewed, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mission layers handles a missing runs directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-layers-empty-test-'));
  try {
    const out = runCli(['mission', 'layers', '--json'], dir);
    assert.equal(out.status, 0, out.stderr || out.stdout);
    const json = JSON.parse(out.stdout);
    assert.equal(json.total, 0);
    assert.equal(json.skewed, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mission layers --since filters tick receipts by the receipt at-stamp', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-layers-since-test-'));
  try {
    const runsDir = path.join(dir, 'atris', 'runs');
    fs.mkdirSync(runsDir, { recursive: true });
    const writeReceiptFile = (name, at, layer) => {
      fs.writeFileSync(path.join(runsDir, name), JSON.stringify({
        schema: 'atris.mission_receipt.v1',
        mission_id: 'mission-s',
        at,
        result: { kind: 'mission_run_tick', tick: { layer, layer_source: 'explicit' } },
      }) + '\n', 'utf8');
    };
    writeReceiptFile('mission-s-old1.json', '2026-06-10T08:00:00.000Z', 'behaviors');
    writeReceiptFile('mission-s-old2.json', '2026-06-11T08:00:00.000Z', 'behaviors');
    writeReceiptFile('mission-s-new1.json', '2026-06-13T08:00:00.000Z', 'beliefs');
    writeReceiptFile('mission-s-new2.json', '2026-06-13T20:00:00.000Z', 'capabilities');

    const all = JSON.parse(runCli(['mission', 'layers', '--json'], dir).stdout);
    assert.equal(all.tagged, 4, 'no filter counts every receipt');

    const since = JSON.parse(runCli(['mission', 'layers', '--since', '2026-06-13', '--json'], dir).stdout);
    assert.equal(since.since, '2026-06-13');
    assert.equal(since.tagged, 2, 'only the two 06-13 receipts survive the window');
    assert.equal(since.by_layer.beliefs, 1);
    assert.equal(since.by_layer.capabilities, 1);
    assert.equal(since.by_layer.behaviors, 0);

    // a window past every receipt yields an empty curve, not an error
    const none = JSON.parse(runCli(['mission', 'layers', '--since', '2026-12-31', '--json'], dir).stdout);
    assert.equal(none.tagged, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mission layers --since rejects an unparseable date with a nonzero exit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-layers-since-bad-test-'));
  try {
    const out = runCli(['mission', 'layers', '--since', 'notadate'], dir);
    assert.equal(out.status, 1, out.stdout);
    assert.match(out.stderr + out.stdout, /not a parseable date/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
