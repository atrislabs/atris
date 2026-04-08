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
});
