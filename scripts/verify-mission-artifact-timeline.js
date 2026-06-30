#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function fail(message, extra = '') {
  console.error(`MISSION ARTIFACT TIMELINE VERIFY FAILED: ${message}`);
  if (extra) console.error(extra);
  process.exit(1);
}

function run(args, cwd) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`command failed: atris ${args.join(' ')}`, result.stderr || result.stdout);
  return result.stdout;
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-artifact-timeline-'));

try {
  fs.mkdirSync(path.join(temp, 'atris'), { recursive: true });
  const started = JSON.parse(run([
    'mission',
    'start',
    'prove mission timeline artifacts',
    '--owner',
    'mission-lead',
    '--verify',
    'node -e "process.exit(0)"',
    '--json',
  ], temp));
  const mission = started.mission;
  const tick = JSON.parse(run([
    'mission',
    'tick',
    mission.id,
    '--verify',
    '--summary',
    'Built a chronological list artifact that explains each goal and what it meant.',
    '--json',
  ], temp));
  const completed = JSON.parse(run([
    'mission',
    'complete',
    mission.id,
    '--proof',
    tick.receipt_path,
    '--json',
  ], temp));

  const artifact = completed.artifact || {};
  for (const key of ['index_html', 'index_md', 'blocks_json', 'raw_json']) {
    if (!artifact[key]) fail(`missing artifact.${key}`);
    if (!fs.existsSync(path.join(temp, artifact[key]))) fail(`missing file ${artifact[key]}`);
  }

  const blocks = JSON.parse(fs.readFileSync(path.join(temp, artifact.blocks_json), 'utf8'));
  const timeline = blocks.blocks.find((block) => block.type === 'timeline');
  if (!timeline) fail('blocks.json missing timeline block');
  const titles = timeline.items.map((item) => item.title);
  for (const title of ['Mission started', 'Goal 1 done', 'Verifier passed', 'Mission accomplished']) {
    if (!titles.includes(title)) fail(`timeline missing ${title}`);
  }
  const html = fs.readFileSync(path.join(temp, artifact.index_html), 'utf8');
  if (!html.includes('Mission timeline')) fail('index.html missing Mission timeline');
  if (!html.includes('What it meant')) fail('index.html missing What it meant');

  console.log('MISSION ARTIFACT TIMELINE VERIFIED');
  console.log(`artifact=${artifact.index_html}`);
  console.log(`timeline=${titles.join(' -> ')}`);
  console.log(`next=${blocks.landing.next}`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
