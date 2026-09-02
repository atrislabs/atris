const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildPrompt } = require('../commands/autopilot');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function findPython() {
  for (const candidate of ['python3', 'python']) {
    const result = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (!result.error && result.status === 0) {
      return candidate;
    }
  }
  return null;
}

const pythonCmd = findPython();

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-experiments-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function copyWorkspacePath(fromRelativePath, dir) {
  const src = path.join(repoRoot, fromRelativePath);
  const dest = path.join(dir, fromRelativePath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

function runCli(args, { cwd, input } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    input,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ...(pythonCmd ? { ATRIS_EXPERIMENTS_PYTHON: pythonCmd } : {}),
    },
  });

  if (result.error) throw result.error;
  return result;
}

function initWorkspace(dir) {
  const result = runCli(['init'], { cwd: dir, input: '\n' });
  assert.equal(result.status, 0, result.stderr);
}

function prepareEndstatePack(dir, slug) {
  initWorkspace(dir);
  copyWorkspacePath('atris/features/endstate', dir);
  copyWorkspacePath(`atris/experiments/${slug}`, dir);
  fs.rmSync(path.join(dir, 'atris', 'experiments', slug, 'artifacts'), { recursive: true, force: true });
  fs.writeFileSync(
    path.join(dir, 'atris', 'experiments', slug, 'results.tsv'),
    'timestamp\ttrack\trepo\ttask\tstatus\tscore\treviewed\ttests\tartifacts\tinterventions\tnotes\n',
    'utf8'
  );
}

function prepareEndstateWorkspace(dir) {
  initWorkspace(dir);
  copyWorkspacePath('atris/features/endstate', dir);

  for (const slug of ['endstate-baseline', 'endstate-stack']) {
    copyWorkspacePath(`atris/experiments/${slug}`, dir);
    fs.rmSync(path.join(dir, 'atris', 'experiments', slug, 'artifacts'), { recursive: true, force: true });
    fs.writeFileSync(
      path.join(dir, 'atris', 'experiments', slug, 'results.tsv'),
      'timestamp\ttrack\trepo\ttask\tstatus\tscore\treviewed\ttests\tartifacts\tinterventions\tnotes\n',
      'utf8'
    );
  }
}

test('init creates experiments framework assets', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);

    const experimentsDir = path.join(dir, 'atris', 'experiments');
    assert.ok(fs.existsSync(path.join(experimentsDir, 'README.md')));
    assert.ok(fs.existsSync(path.join(experimentsDir, 'validate.py')));
    assert.ok(fs.existsSync(path.join(experimentsDir, '_template', 'pack', 'program.md')));
    assert.ok(fs.existsSync(path.join(experimentsDir, '_examples', 'smoke-keep-revert', 'loop.py')));
  } finally {
    cleanupTempDir(dir);
  }
});

test('experiments init scaffolds a new pack', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);

    const result = runCli(['experiments', 'init', 'self-heal'], { cwd: dir });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Created atris\/experiments\/self-heal/);

    const packDir = path.join(dir, 'atris', 'experiments', 'self-heal');
    assert.ok(fs.existsSync(path.join(packDir, 'program.md')));
    assert.ok(fs.existsSync(path.join(packDir, 'measure.py')));
    assert.ok(fs.existsSync(path.join(packDir, 'loop.py')));
    assert.ok(fs.existsSync(path.join(packDir, 'results.tsv')));
  } finally {
    cleanupTempDir(dir);
  }
});

test('experiments validate passes on fresh scaffold', { skip: !pythonCmd }, () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    runCli(['experiments', 'init', 'self-heal'], { cwd: dir });

    const result = runCli(['experiments', 'validate'], { cwd: dir });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PASS:/);
    assert.match(result.stdout, /self-heal/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('experiments validate accepts a single pack path', { skip: !pythonCmd }, () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    runCli(['experiments', 'init', 'self-heal'], { cwd: dir });

    const result = runCli(['experiments', 'validate', 'self-heal'], { cwd: dir });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PASS:/);
    assert.match(result.stdout, /self-heal/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('experiments benchmark runs validate and runtime checks', { skip: !pythonCmd }, () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);

    const result = runCli(['experiments', 'benchmark'], { cwd: dir });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PASS benchmark_validate/);
    assert.match(result.stdout, /PASS benchmark_runtime/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('experiments run dry-run works for generic packs', () => {
  const dir = makeTempDir();
  try {
    initWorkspace(dir);
    runCli(['experiments', 'init', 'self-heal'], { cwd: dir });

    const result = runCli(['experiments', 'run', 'self-heal', '--dry-run'], { cwd: dir });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Dry run: would execute atris\/experiments\/self-heal\/loop\.py/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('experiments run endstate-baseline dry-run writes artifact receipt and results row', () => {
  const dir = makeTempDir();
  try {
    prepareEndstatePack(dir, 'endstate-baseline');

    const result = runCli(['experiments', 'run', 'endstate-baseline', '--dry-run'], { cwd: dir });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Endstate baseline run recorded/);
    assert.match(result.stdout, /score: \d+\/100/);
    assert.match(result.stdout, /review: draft/);

    const packDir = path.join(dir, 'atris', 'experiments', 'endstate-baseline');
    const artifactsDir = path.join(packDir, 'artifacts');
    const artifactFiles = fs.readdirSync(artifactsDir).filter((file) => file.endsWith('.json'));
    assert.equal(artifactFiles.length, 1);

    const artifact = JSON.parse(fs.readFileSync(path.join(artifactsDir, artifactFiles[0]), 'utf8'));
    assert.equal(artifact.track, 'baseline');
    assert.equal(artifact.review.status, 'draft');
    assert.equal(artifact.interventions.count, 0);
    assert.equal(artifact.tests[0].status, 'not_run');
    assert.deepEqual(artifact.changed_files, []);
    assert.ok(typeof artifact.prompt_context === 'string' && artifact.prompt_context.includes('pack: endstate-baseline'));
    assert.ok(artifact.prompt_context.includes('runner: baseline-single'));
    assert.ok(artifact.notes.includes('runner=baseline-single'));

    const results = fs.readFileSync(path.join(packDir, 'results.tsv'), 'utf8').trim().split('\n');
    assert.equal(results.length, 2);
    assert.match(results[0], /^timestamp\ttrack\trepo\ttask\tstatus\tscore\treviewed\ttests\tartifacts\tinterventions\tnotes$/);
    assert.match(results[1], /\tbaseline\t/);
    assert.match(results[1], /\tdraft\t/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('experiments run endstate-stack dry-run writes artifact receipt and results row', () => {
  const dir = makeTempDir();
  try {
    prepareEndstatePack(dir, 'endstate-stack');

    const result = runCli(['experiments', 'run', 'endstate-stack', '--dry-run'], { cwd: dir });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Endstate stack run recorded/);
    assert.match(result.stdout, /score: \d+\/100/);
    assert.match(result.stdout, /review: draft/);

    const packDir = path.join(dir, 'atris', 'experiments', 'endstate-stack');
    const artifactsDir = path.join(packDir, 'artifacts');
    const artifactFiles = fs.readdirSync(artifactsDir).filter((file) => file.endsWith('.json'));
    assert.equal(artifactFiles.length, 1);

    const artifact = JSON.parse(fs.readFileSync(path.join(artifactsDir, artifactFiles[0]), 'utf8'));
    assert.equal(artifact.track, 'stack');
    assert.equal(artifact.review.status, 'draft');
    assert.equal(artifact.interventions.count, 0);
    assert.equal(artifact.tests[0].status, 'not_run');
    assert.deepEqual(artifact.changed_files, []);
    assert.ok(typeof artifact.prompt_context === 'string' && artifact.prompt_context.includes('pack: endstate-stack'));
    assert.ok(artifact.prompt_context.includes('runner: stack-coordinated'));
    assert.ok(artifact.notes.includes('runner=stack-coordinated'));

    const results = fs.readFileSync(path.join(packDir, 'results.tsv'), 'utf8').trim().split('\n');
    assert.equal(results.length, 2);
    assert.match(results[0], /^timestamp\ttrack\trepo\ttask\tstatus\tscore\treviewed\ttests\tartifacts\tinterventions\tnotes$/);
    assert.match(results[1], /\tstack\t/);
    assert.match(results[1], /\tdraft\t/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('benchmark prompts render read files as bullet list', () => {
  const prompt = buildPrompt(
    'plan',
    { task: 'Benchmark task brief', kind: 'benchmark' },
    {
      benchmarkStrategy: 'single',
      runnerName: 'baseline-single',
      extraReadFiles: [
        'atris/features/endstate/contract.md',
        'atris/features/endstate/artifact-schema.json',
      ],
      contextNote: 'Project Endstate track: baseline',
    }
  );

  assert.match(prompt, /Read these files first:\n- atris\/team\/navigator\/MEMBER\.md/);
  assert.match(prompt, /- atris\/features\/endstate\/contract\.md/);
  assert.match(prompt, /- atris\/features\/endstate\/artifact-schema\.json/);
  assert.doesNotMatch(prompt, /,\s*atris\/features\/endstate\/contract\.md/);
  assert.match(prompt, /Runner profile: baseline-single/);
});

test('benchmark prompts differ between baseline and stack strategies', () => {
  const baselinePrompt = buildPrompt(
    'plan',
    { task: 'Benchmark task brief', kind: 'benchmark' },
    { benchmarkStrategy: 'single', runnerName: 'baseline-single' }
  );

  const stackPrompt = buildPrompt(
    'plan',
    { task: 'Benchmark task brief', kind: 'benchmark' },
    { benchmarkStrategy: 'stack', runnerName: 'stack-coordinated' }
  );

  assert.match(baselinePrompt, /pinned single-model baseline run/i);
  assert.doesNotMatch(baselinePrompt, /coordinated stack run/i);
  assert.match(stackPrompt, /coordinated stack run/i);
  assert.match(stackPrompt, /Split the work into explicit repo lanes/i);
});

test('documented benchmark quickstart works from a fresh workspace', { skip: !pythonCmd }, () => {
  const dir = makeTempDir();
  try {
    prepareEndstateWorkspace(dir);

    const baselineValidate = runCli(['experiments', 'validate', 'endstate-baseline'], { cwd: dir });
    const stackValidate = runCli(['experiments', 'validate', 'endstate-stack'], { cwd: dir });
    const baselineRun = runCli(['experiments', 'run', 'endstate-baseline', '--dry-run'], { cwd: dir });
    const stackRun = runCli(['experiments', 'run', 'endstate-stack', '--dry-run'], { cwd: dir });

    assert.equal(baselineValidate.status, 0, baselineValidate.stderr);
    assert.equal(stackValidate.status, 0, stackValidate.stderr);
    assert.equal(baselineRun.status, 0, baselineRun.stderr);
    assert.equal(stackRun.status, 0, stackRun.stderr);

    assert.match(baselineValidate.stdout, /PASS: 1 experiment\(s\) valid/);
    assert.match(stackValidate.stdout, /PASS: 1 experiment\(s\) valid/);
    assert.match(baselineRun.stdout, /Endstate baseline run recorded/);
    assert.match(stackRun.stdout, /Endstate stack run recorded/);

    const baselineArtifacts = fs.readdirSync(path.join(dir, 'atris', 'experiments', 'endstate-baseline', 'artifacts'))
      .filter((file) => file.endsWith('.json'));
    const stackArtifacts = fs.readdirSync(path.join(dir, 'atris', 'experiments', 'endstate-stack', 'artifacts'))
      .filter((file) => file.endsWith('.json'));

    assert.equal(baselineArtifacts.length, 1);
    assert.equal(stackArtifacts.length, 1);
  } finally {
    cleanupTempDir(dir);
  }
});

test('experiments compare endstate summarizes the latest receipts', { skip: !pythonCmd }, () => {
  const dir = makeTempDir();
  try {
    prepareEndstateWorkspace(dir);
    runCli(['experiments', 'run', 'endstate-baseline', '--dry-run'], { cwd: dir });
    runCli(['experiments', 'run', 'endstate-stack', '--dry-run'], { cwd: dir });

    const compare = runCli(['experiments', 'compare', 'endstate'], { cwd: dir });
    assert.equal(compare.status, 0, compare.stderr);
    assert.match(compare.stdout, /Endstate comparison ready/);
    assert.match(compare.stdout, /baseline: 35\/100 \| review: draft \| interventions: 0/);
    assert.match(compare.stdout, /stack: 35\/100 \| review: draft \| interventions: 0/);
    assert.match(compare.stdout, /Decision: no winner yet\./);
    assert.match(compare.stdout, /Scores are tied at 35\/100/);
  } finally {
    cleanupTempDir(dir);
  }
});

function keepRevertNextLine(slug) {
  return `next: atris experiments revert ${slug}`;
}

function assertKeepRevertNext(result, slug) {
  assert.deepEqual(
    result.stdout.split('\n').filter((line) => line.startsWith('next: atris experiments revert')),
    [keepRevertNextLine(slug)]
  );
}

function assertNoKeepRevertNext(result) {
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /next: atris experiments revert/);
}

function revertKeepNextLine(slug) {
  return `next: atris experiments keep ${slug}`;
}

function assertRevertKeepNext(result, slug) {
  assert.deepEqual(
    result.stdout.split('\n').filter((line) => line.startsWith('next: atris experiments keep')),
    [revertKeepNextLine(slug)]
  );
}

function assertNoRevertKeepNext(result) {
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /next: atris experiments keep/);
}

function keepWatchTickNextLine() {
  return 'next: atris youtube watch tick';
}

function assertKeepWatchTickNext(result) {
  assert.deepEqual(
    result.stdout.split('\n').filter((line) => line.startsWith('next: atris youtube watch tick')),
    [keepWatchTickNextLine()]
  );
}

function assertNoKeepWatchTickNext(result) {
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /next: atris youtube watch tick/);
}

function writeTokenMeasurePack(dir, slug, fixtureRel, token) {
  const packDir = path.join(dir, 'atris', 'experiments', slug);
  fs.mkdirSync(packDir, { recursive: true });
  fs.writeFileSync(
    path.join(packDir, 'measure.py'),
    [
      'import json, os',
      'from pathlib import Path',
      `TOKEN = ${JSON.stringify(token)}`,
      `FIXTURE = ${JSON.stringify(fixtureRel)}`,
      'root = Path(os.environ.get("ATRIS_REPO_ROOT") or ".").resolve()',
      'path = root / FIXTURE',
      'text = path.read_text(encoding="utf-8") if path.is_file() else ""',
      'score = 1 if TOKEN.lower() in text.lower() else 0',
      'print(json.dumps({"score": score, "passed": score, "total": 1, "status": "pass" if score == 1 else "fail"}))',
      '',
    ].join('\n')
  );
  return packDir;
}

test('experiments keep without a slug fails cleanly', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const result = runCli(['experiments', 'keep'], { cwd: dir });
    assert.equal(result.status, 2, result.stderr || result.stdout);
    assert.match(`${result.stdout}\n${result.stderr}`, /usage: atris experiments keep <slug>/);
    assertNoKeepRevertNext(result);
    assertNoKeepWatchTickNext(result);
  } finally {
    cleanupTempDir(dir);
  }
});

test('experiments keep help is usage only', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const result = runCli(['experiments', 'keep', '--help'], { cwd: dir });
    assert.equal(result.status, 2, result.stderr || result.stdout);
    assert.match(`${result.stdout}\n${result.stderr}`, /usage: atris experiments keep <slug>/);
    assertNoKeepRevertNext(result);
    assertNoKeepWatchTickNext(result);
  } finally {
    cleanupTempDir(dir);
  }
});

test('experiments keep --json does not print a revert next-step', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const result = runCli(['experiments', 'keep', '--json'], { cwd: dir });
    assert.equal(result.status, 2, result.stderr || result.stdout);
    assert.match(`${result.stdout}\n${result.stderr}`, /invalid experiment name\. use a lowercase-hyphen slug\./);
    assertNoKeepRevertNext(result);
    assertNoKeepWatchTickNext(result);
  } finally {
    cleanupTempDir(dir);
  }
});

test('experiments keep fails cleanly on an invalid slug', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const result = runCli(['experiments', 'keep', 'Teach_Bad'], { cwd: dir });
    assert.equal(result.status, 2, result.stderr || result.stdout);
    assert.match(`${result.stdout}\n${result.stderr}`, /invalid experiment name\. use a lowercase-hyphen slug\./);
    assertNoKeepRevertNext(result);
    assertNoKeepWatchTickNext(result);
  } finally {
    cleanupTempDir(dir);
  }
});

test('experiments keep fails cleanly when atris/ is missing', () => {
  const dir = makeTempDir();
  try {
    const result = runCli(['experiments', 'keep', 'teach-keep01-s1'], { cwd: dir });
    assert.equal(result.status, 2, result.stderr || result.stdout);
    assert.match(`${result.stdout}\n${result.stderr}`, /atris\/ folder not found/);
    assertNoKeepRevertNext(result);
    assertNoKeepWatchTickNext(result);
  } finally {
    cleanupTempDir(dir);
  }
});

test('experiments keep fails cleanly when the pack is missing', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'experiments'), { recursive: true });
    const result = runCli(['experiments', 'keep', 'teach-missing-s1'], { cwd: dir });
    assert.equal(result.status, 2, result.stderr || result.stdout);
    assert.match(`${result.stdout}\n${result.stderr}`, /experiment "teach-missing-s1" not found/);
    assertNoKeepRevertNext(result);
    assertNoKeepWatchTickNext(result);
  } finally {
    cleanupTempDir(dir);
  }
});

test('experiments keep fails cleanly when measure.py is missing', () => {
  const dir = makeTempDir();
  try {
    const packDir = path.join(dir, 'atris', 'experiments', 'teach-nometric-s1');
    fs.mkdirSync(packDir, { recursive: true });
    fs.writeFileSync(path.join(packDir, 'program.md'), '# Program\n');
    const result = runCli(['experiments', 'keep', 'teach-nometric-s1'], { cwd: dir });
    assert.equal(result.status, 2, result.stderr || result.stdout);
    assert.match(`${result.stdout}\n${result.stderr}`, /has no measure\.py/);
    assert.equal(fs.existsSync(packDir), true);
    assertNoKeepRevertNext(result);
    assertNoKeepWatchTickNext(result);
  } finally {
    cleanupTempDir(dir);
  }
});

test('experiments keep refuses when measure.py stays at baseline 0', { skip: !pythonCmd }, () => {
  const dir = makeTempDir();
  try {
    const fixtureRel = 'atris/wiki/briefs/keep-target.apply.md';
    fs.mkdirSync(path.join(dir, 'atris', 'wiki', 'briefs'), { recursive: true });
    fs.writeFileSync(path.join(dir, fixtureRel), 'change: apply atris/experiments/teach-keep01-s1\n');
    const packDir = writeTokenMeasurePack(dir, 'teach-keep01-s1', fixtureRel, 'omakase model');
    const result = runCli(['experiments', 'keep', 'teach-keep01-s1'], { cwd: dir });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, /revert teach-keep01-s1: measure\.py stayed 0\. refuse keep\./);
    assertKeepRevertNext(result, 'teach-keep01-s1');
    assertNoKeepWatchTickNext(result);
    assert.equal(fs.existsSync(path.join(packDir, 'measure.py')), true);
  } finally {
    cleanupTempDir(dir);
  }
});

test('experiments keep refuses when measure.py fails to print a score', { skip: !pythonCmd }, () => {
  const dir = makeTempDir();
  try {
    const packDir = path.join(dir, 'atris', 'experiments', 'teach-broken-s1');
    fs.mkdirSync(packDir, { recursive: true });
    fs.writeFileSync(path.join(packDir, 'measure.py'), 'print("not a score")\n');
    const result = runCli(['experiments', 'keep', 'teach-broken-s1'], { cwd: dir });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, /revert teach-broken-s1: measure\.py printed no score\. refuse keep\./);
    assertKeepRevertNext(result, 'teach-broken-s1');
    assertNoKeepWatchTickNext(result);
  } finally {
    cleanupTempDir(dir);
  }
});

test('experiments keep succeeds only after the fixture contains check tokens', { skip: !pythonCmd }, () => {
  const dir = makeTempDir();
  try {
    const fixtureRel = 'atris/wiki/briefs/keep-target.apply.md';
    const fixturePath = path.join(dir, fixtureRel);
    fs.mkdirSync(path.join(dir, 'atris', 'wiki', 'briefs'), { recursive: true });
    fs.writeFileSync(fixturePath, 'change: apply atris/experiments/teach-keep01-s1\n');
    writeTokenMeasurePack(dir, 'teach-keep01-s1', fixtureRel, 'omakase model');

    const refused = runCli(['experiments', 'keep', 'teach-keep01-s1'], { cwd: dir });
    assert.equal(refused.status, 1, refused.stderr || refused.stdout);
    assertKeepRevertNext(refused, 'teach-keep01-s1');
    assertNoKeepWatchTickNext(refused);

    fs.appendFileSync(fixturePath, 'keep the omakase model as the default stack\n');
    const kept = runCli(['experiments', 'keep', 'teach-keep01-s1'], { cwd: dir });
    assert.equal(kept.status, 0, kept.stderr || kept.stdout);
    assert.match(kept.stdout, /keep teach-keep01-s1: measure\.py moved 0→1/);
    assertNoKeepRevertNext(kept);
    assertKeepWatchTickNext(kept);
  } finally {
    cleanupTempDir(dir);
  }
});

function writeRestoreResetPack(dir, slug, fixtureRel, baseline, { crash = false, includeMeasure = true } = {}) {
  const packDir = path.join(dir, 'atris', 'experiments', slug);
  fs.mkdirSync(packDir, { recursive: true });
  const resetLines = crash
    ? [
      'raise SystemExit("reset crashed")',
      '',
    ]
    : [
      'import os',
      'from pathlib import Path',
      `FIXTURE = ${JSON.stringify(fixtureRel)}`,
      `BASELINE = ${JSON.stringify(baseline)}`,
      'root = Path(os.environ.get("ATRIS_REPO_ROOT") or ".").resolve()',
      'path = root / FIXTURE',
      'path.parent.mkdir(parents=True, exist_ok=True)',
      'path.write_text(BASELINE, encoding="utf-8")',
      'print("reset restored baseline")',
      '',
    ];
  fs.writeFileSync(path.join(packDir, 'reset.py'), resetLines.join('\n'));
  if (includeMeasure) {
    writeTokenMeasurePack(dir, slug, fixtureRel, 'omakase model');
  }
  return packDir;
}

test('experiments revert without a slug fails cleanly', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const result = runCli(['experiments', 'revert'], { cwd: dir });
    assert.equal(result.status, 2, result.stderr || result.stdout);
    assert.match(`${result.stdout}\n${result.stderr}`, /usage: atris experiments revert <slug>/);
    assertNoRevertKeepNext(result);
  } finally {
    cleanupTempDir(dir);
  }
});

test('experiments revert fails cleanly on an invalid slug', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const result = runCli(['experiments', 'revert', 'Teach_Bad'], { cwd: dir });
    assert.equal(result.status, 2, result.stderr || result.stdout);
    assert.match(`${result.stdout}\n${result.stderr}`, /invalid experiment name\. use a lowercase-hyphen slug\./);
    assertNoRevertKeepNext(result);
  } finally {
    cleanupTempDir(dir);
  }
});

test('experiments revert fails cleanly when the pack is missing', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'experiments'), { recursive: true });
    const result = runCli(['experiments', 'revert', 'teach-missing-s1'], { cwd: dir });
    assert.equal(result.status, 2, result.stderr || result.stdout);
    assert.match(`${result.stdout}\n${result.stderr}`, /experiment "teach-missing-s1" not found/);
    assertNoRevertKeepNext(result);
  } finally {
    cleanupTempDir(dir);
  }
});

test('experiments revert fails cleanly when reset.py is missing', () => {
  const dir = makeTempDir();
  try {
    const packDir = path.join(dir, 'atris', 'experiments', 'teach-noreset-s1');
    fs.mkdirSync(packDir, { recursive: true });
    fs.writeFileSync(path.join(packDir, 'program.md'), '# Program\n');
    const result = runCli(['experiments', 'revert', 'teach-noreset-s1'], { cwd: dir });
    assert.equal(result.status, 2, result.stderr || result.stdout);
    assert.match(`${result.stdout}\n${result.stderr}`, /has no reset\.py/);
    assert.equal(fs.existsSync(packDir), true);
    assertNoRevertKeepNext(result);
  } finally {
    cleanupTempDir(dir);
  }
});

test('experiments revert restores a baseline file after a refused keep', { skip: !pythonCmd }, () => {
  const dir = makeTempDir();
  try {
    const fixtureRel = 'atris/wiki/briefs/revert-target.apply.md';
    const fixturePath = path.join(dir, fixtureRel);
    fs.mkdirSync(path.join(dir, 'atris', 'wiki', 'briefs'), { recursive: true });
    fs.writeFileSync(fixturePath, 'dirty: keep the omakase model as the default stack\n');
    writeRestoreResetPack(dir, 'teach-revert01-s1', fixtureRel, 'change: apply atris/experiments/teach-revert01-s1\n');

    const keptDirty = runCli(['experiments', 'keep', 'teach-revert01-s1'], { cwd: dir });
    assert.equal(keptDirty.status, 0, keptDirty.stderr || keptDirty.stdout);
    assert.match(keptDirty.stdout, /keep teach-revert01-s1: measure\.py moved 0→1/);
    assertKeepWatchTickNext(keptDirty);

    const reverted = runCli(['experiments', 'revert', 'teach-revert01-s1'], { cwd: dir });
    assert.equal(reverted.status, 0, reverted.stderr || reverted.stdout);
    assert.match(reverted.stdout, /revert teach-revert01-s1: reset\.py ran/);
    assertRevertKeepNext(reverted, 'teach-revert01-s1');
    assert.equal(fs.readFileSync(fixturePath, 'utf8'), 'change: apply atris/experiments/teach-revert01-s1\n');

    const refused = runCli(['experiments', 'keep', 'teach-revert01-s1'], { cwd: dir });
    assert.equal(refused.status, 1, refused.stderr || refused.stdout);
    assert.match(refused.stderr, /revert teach-revert01-s1: measure\.py stayed 0\. refuse keep\./);
    assertKeepRevertNext(refused, 'teach-revert01-s1');
    assertNoKeepWatchTickNext(refused);
  } finally {
    cleanupTempDir(dir);
  }
});

test('experiments revert succeeds on reset alone when measure.py is missing', { skip: !pythonCmd }, () => {
  const dir = makeTempDir();
  try {
    const fixtureRel = 'atris/wiki/briefs/revert-nometric.apply.md';
    const fixturePath = path.join(dir, fixtureRel);
    fs.mkdirSync(path.join(dir, 'atris', 'wiki', 'briefs'), { recursive: true });
    fs.writeFileSync(fixturePath, 'dirty\n');
    writeRestoreResetPack(dir, 'teach-nometric-s1', fixtureRel, 'baseline\n', { includeMeasure: false });

    const reverted = runCli(['experiments', 'revert', 'teach-nometric-s1'], { cwd: dir });
    assert.equal(reverted.status, 0, reverted.stderr || reverted.stdout);
    assert.match(reverted.stdout, /revert teach-nometric-s1: reset\.py ran/);
    assert.doesNotMatch(reverted.stdout, /measure\.py/);
    assertRevertKeepNext(reverted, 'teach-nometric-s1');
    assert.equal(fs.readFileSync(fixturePath, 'utf8'), 'baseline\n');
  } finally {
    cleanupTempDir(dir);
  }
});

test('experiments revert refuses when reset.py crashes', { skip: !pythonCmd }, () => {
  const dir = makeTempDir();
  try {
    const fixtureRel = 'atris/wiki/briefs/revert-crash.apply.md';
    const fixturePath = path.join(dir, fixtureRel);
    fs.mkdirSync(path.join(dir, 'atris', 'wiki', 'briefs'), { recursive: true });
    fs.writeFileSync(fixturePath, 'dirty\n');
    writeRestoreResetPack(dir, 'teach-crash-s1', fixtureRel, 'baseline\n', { crash: true, includeMeasure: false });

    const result = runCli(['experiments', 'revert', 'teach-crash-s1'], { cwd: dir });
    assert.notEqual(result.status, 0, result.stderr || result.stdout);
    assert.match(`${result.stdout}\n${result.stderr}`, /revert teach-crash-s1:.*refuse revert\./);
    assertNoRevertKeepNext(result);
    assert.equal(fs.readFileSync(fixturePath, 'utf8'), 'dirty\n');
  } finally {
    cleanupTempDir(dir);
  }
});

test('experiments help lists revert next to keep', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const bare = runCli(['experiments'], { cwd: dir });
    assert.match(bare.stdout, /keep <slug>[\s\S]*revert <slug>/);
    assertNoKeepRevertNext(bare);
    const help = runCli(['experiments', '--help'], { cwd: dir });
    assert.match(help.stdout, /keep <slug>[\s\S]*revert <slug>/);
    assertNoKeepRevertNext(help);
  } finally {
    cleanupTempDir(dir);
  }
});

test('experiments replay endstate runs the public rehearsal flow', { skip: !pythonCmd }, () => {
  const dir = makeTempDir();
  try {
    prepareEndstateWorkspace(dir);

    const replay = runCli(['experiments', 'replay', 'endstate'], { cwd: dir });
    assert.equal(replay.status, 0, replay.stderr);
    assert.match(replay.stdout, /Replay: validate baseline pack/);
    assert.match(replay.stdout, /Replay: validate stack pack/);
    assert.match(replay.stdout, /Replay: baseline dry run/);
    assert.match(replay.stdout, /Replay: stack dry run/);
    assert.match(replay.stdout, /Replay: compare latest receipts/);
    assert.match(replay.stdout, /Decision: no winner yet\./);

    const baselineArtifacts = fs.readdirSync(path.join(dir, 'atris', 'experiments', 'endstate-baseline', 'artifacts'))
      .filter((file) => file.endsWith('.json'));
    const stackArtifacts = fs.readdirSync(path.join(dir, 'atris', 'experiments', 'endstate-stack', 'artifacts'))
      .filter((file) => file.endsWith('.json'));

    assert.equal(baselineArtifacts.length, 1);
    assert.equal(stackArtifacts.length, 1);
  } finally {
    cleanupTempDir(dir);
  }
});
