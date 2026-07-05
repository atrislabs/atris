const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { runTaskOnce } = require('./autopilot');
const {
  appendResultsRow,
  buildRunId,
  buildWikiArtifact,
  compareEndstateArtifacts,
  collectChangedFiles,
  getArtifactScore,
  getGitHead,
  inferTestResults,
  readLatestArtifact,
  readTextIfExists,
  scoreEndstateArtifact,
  summarizeReview,
  writeArtifact,
} = require('../lib/endstate');
const daily = require('../lib/experiments/daily');

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ROOT_FILES = ['README.md', 'validate.py', 'benchmark_validate.py', 'benchmark_runtime.py'];
const SUPPORT_DIRS = ['_fixtures', '_template', '_examples'];

function ensureAtrisWorkspace(workspaceDir = process.cwd()) {
  const atrisDir = path.join(workspaceDir, 'atris');
  if (!fs.existsSync(atrisDir)) {
    console.error('✗ Error: atris/ folder not found. Run "atris init" first.');
    process.exit(1);
  }
  return atrisDir;
}

function copyRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === '.DS_Store' || entry.name === '__pycache__') continue;

    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyRecursive(srcPath, destPath);
      continue;
    }

    if (!fs.existsSync(destPath)) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function ensureExperimentsFramework(workspaceDir = process.cwd(), { silent = false } = {}) {
  const atrisDir = ensureAtrisWorkspace(workspaceDir);
  const packageExperimentsDir = path.join(__dirname, '..', 'atris', 'experiments');
  const experimentsDir = path.join(atrisDir, 'experiments');
  const created = [];

  if (!fs.existsSync(experimentsDir)) {
    fs.mkdirSync(experimentsDir, { recursive: true });
    created.push('atris/experiments/');
  }

  for (const file of ROOT_FILES) {
    const src = path.join(packageExperimentsDir, file);
    const dest = path.join(experimentsDir, file);
    if (!fs.existsSync(dest) && fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
      created.push(`atris/experiments/${file}`);
    }
  }

  for (const dirName of SUPPORT_DIRS) {
    const src = path.join(packageExperimentsDir, dirName);
    const dest = path.join(experimentsDir, dirName);
    if (fs.existsSync(src)) {
      const hadDest = fs.existsSync(dest);
      copyRecursive(src, dest);
      if (!hadDest) {
        created.push(`atris/experiments/${dirName}/`);
      }
    }
  }

  if (!silent) {
    if (created.length > 0) {
      console.log(`✓ Prepared atris/experiments/ (${created.length} item${created.length === 1 ? '' : 's'})`);
    } else {
      console.log('✓ atris/experiments/ already ready');
    }
  }

  return { atrisDir, experimentsDir, created };
}

function resolvePython() {
  const candidates = [
    process.env.ATRIS_EXPERIMENTS_PYTHON,
    'python3',
    'python',
  ].filter(Boolean);

  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0) {
      return candidate;
    }
  }

  return null;
}

function runPython(scriptPath, args = [], cwd = process.cwd()) {
  const python = resolvePython();
  if (!python) {
    console.error('✗ Error: Python not found. Set ATRIS_EXPERIMENTS_PYTHON or install python3.');
    process.exit(1);
  }

  const result = spawnSync(python, [scriptPath, ...args], {
    cwd,
    stdio: 'inherit',
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: '1',
    },
  });

  if (result.error) {
    throw result.error;
  }

  if (typeof result.status === 'number' && result.status !== 0) {
    process.exit(result.status);
  }
}

function experimentsInit(name) {
  const { experimentsDir } = ensureExperimentsFramework();

  if (!name) {
    console.log('');
    console.log('Experiments framework ready.');
    console.log('Next: atris experiments init <slug>');
    console.log('');
    return;
  }

  if (!SLUG_RE.test(name)) {
    console.error('✗ Invalid experiment name. Use lowercase-hyphen slug, for example: self-heal');
    process.exit(1);
  }

  const targetDir = path.join(experimentsDir, name);
  if (fs.existsSync(targetDir)) {
    console.error(`✗ Experiment "${name}" already exists at atris/experiments/${name}/`);
    process.exit(1);
  }

  const templateDir = path.join(experimentsDir, '_template', 'pack');
  copyRecursive(templateDir, targetDir);

  console.log(`✓ Created atris/experiments/${name}/`);
  console.log('  Files: program.md, measure.py, loop.py, results.tsv, reset.py');
}

function experimentsValidate(rootArg) {
  const { experimentsDir } = ensureExperimentsFramework();
  const args = [];

  if (rootArg) {
    args.push(rootArg);
  }

  runPython(path.join(experimentsDir, 'validate.py'), args, experimentsDir);
}

function experimentsBenchmark(kind = 'all') {
  const { experimentsDir } = ensureExperimentsFramework();
  const modes = kind === 'all' ? ['validate', 'runtime'] : [kind];

  for (const mode of modes) {
    if (mode === 'validate') {
      console.log('Running experiment validator benchmark...');
      runPython(path.join(experimentsDir, 'benchmark_validate.py'), [], experimentsDir);
      continue;
    }

    if (mode === 'runtime') {
      console.log('Running experiment runtime benchmark...');
      runPython(path.join(experimentsDir, 'benchmark_runtime.py'), [], experimentsDir);
      continue;
    }

    console.error('Usage: atris experiments benchmark [validate|runtime|all]');
    process.exit(1);
  }
}

function parseRunOptions(args) {
  const options = {
    dryRun: false,
    verbose: false,
    backendPath: path.resolve(process.cwd(), '../atrisos-backend'),
    interventions: [],
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--dry-run' || arg === '-n') {
      options.dryRun = true;
      continue;
    }

    if (arg === '--verbose') {
      options.verbose = true;
      continue;
    }

    if (arg === '--backend' && args[i + 1]) {
      options.backendPath = path.resolve(process.cwd(), args[++i]);
      continue;
    }

    if (arg.startsWith('--backend=')) {
      options.backendPath = path.resolve(process.cwd(), arg.split('=')[1]);
      continue;
    }

    if (arg === '--intervention' && args[i + 1]) {
      options.interventions.push(args[++i]);
      continue;
    }

    if (arg.startsWith('--intervention=')) {
      options.interventions.push(arg.split('=')[1]);
      continue;
    }
  }

  return options;
}

function isEndstatePack(name) {
  return name === 'endstate-baseline' || name === 'endstate-stack';
}

function readTaskBrief(packDir) {
  const programPath = path.join(packDir, 'program.md');
  const content = fs.readFileSync(programPath, 'utf8');
  return content.replace(/^# Program\s*/i, '').trim();
}

function readRunnerConfig(packDir, name) {
  const runnerPath = path.join(packDir, 'runner.json');
  const fallback = name.endsWith('stack')
    ? {
        name: 'stack-coordinated',
        strategy: 'stack',
        summary: 'Coordinated stack benchmark run.',
        context_note: 'Runner profile: stack-coordinated\nProtocol: coordinated stack run',
      }
    : {
        name: 'baseline-single',
        strategy: 'single',
        summary: 'Single-model direct benchmark run.',
        context_note: 'Runner profile: baseline-single\nProtocol: single-model direct run',
      };

  if (!fs.existsSync(runnerPath)) return fallback;

  try {
    const parsed = JSON.parse(fs.readFileSync(runnerPath, 'utf8'));
    return {
      ...fallback,
      ...parsed,
      name: parsed.name || fallback.name,
      strategy: parsed.strategy || fallback.strategy,
      summary: parsed.summary || fallback.summary,
      context_note: parsed.context_note || fallback.context_note,
    };
  } catch {
    return fallback;
  }
}

function buildPromptContext(name, runnerConfig, taskBrief, phaseResults) {
  const sections = [
    `pack: ${name}`,
    `runner: ${runnerConfig.name}`,
    `runner strategy: ${runnerConfig.strategy}`,
    `runner summary:\n${runnerConfig.summary}`,
    `task brief:\n${taskBrief}`,
  ];

  if (phaseResults) {
    for (const phase of ['plan', 'do', 'review']) {
      if (!phaseResults[phase]) continue;
      sections.push(`${phase} prompt:\n${phaseResults[phase].prompt}`);
      sections.push(`${phase} output:\n${phaseResults[phase].output || ''}`);
    }
  }

  return sections.join('\n\n');
}

function buildBenchmarkArtifact(name, packDir, options) {
  const track = name.endsWith('stack') ? 'stack' : 'baseline';
  const cwd = process.cwd();
  const backendPath = options.backendPath;
  const taskBrief = readTaskBrief(packDir);
  const runnerConfig = readRunnerConfig(packDir, name);
  const runId = buildRunId(track);
  const beforeCli = getGitHead(cwd);
  const beforeBackend = getGitHead(backendPath);
  const wikiBefore = readTextIfExists(path.join(cwd, 'atris', 'wiki', 'STATUS.md'));

  let execution = null;
  let reviewStatus = options.dryRun ? 'draft' : 'fail';
  let reviewSummary = options.dryRun ? 'dry run — benchmark task not executed' : 'benchmark run failed before review';
  let tests = [{
    command: options.dryRun ? 'benchmark dry-run' : '(no explicit test command captured)',
    status: 'not_run',
  }];
  let notes = options.dryRun ? 'dry-run artifact only' : '';

  if (!options.dryRun) {
    try {
      execution = runTaskOnce(
        { task: taskBrief, kind: 'benchmark' },
        {
          verbose: options.verbose,
          benchmarkStrategy: runnerConfig.strategy,
          runnerName: runnerConfig.name,
          extraReadFiles: [
            'atris/features/endstate/contract.md',
            'atris/features/endstate/artifact-schema.json',
            path.relative(cwd, path.join(packDir, 'program.md')),
            '../atrisos-backend/atris/MAP.md',
            '../atrisos-backend/atris/TODO.md',
          ],
          contextNote: [
            `Project Endstate track: ${track}`,
            `Pack: atris/experiments/${name}/program.md`,
            runnerConfig.context_note,
            'Stay within the exact Level 1 contract. The outer runner records the receipt.',
          ].join('\n'),
        }
      );

      reviewStatus = execution.verifyPass ? 'pass' : 'fail';
      reviewSummary = summarizeReview(execution.reviewOutput);
      tests = inferTestResults(execution.reviewOutput);
    } catch (error) {
      reviewStatus = 'fail';
      reviewSummary = summarizeReview(error.message || String(error));
      notes = 'runner threw before completion';
    }
  }

  const afterCli = getGitHead(cwd);
  const afterBackend = getGitHead(backendPath);
  const changedFiles = options.dryRun
    ? []
    : [
        ...collectChangedFiles(cwd, beforeCli, afterCli),
        ...collectChangedFiles(backendPath, beforeBackend, afterBackend, '../atrisos-backend/'),
      ];
  const wikiAfter = readTextIfExists(path.join(cwd, 'atris', 'wiki', 'STATUS.md'));

  const artifact = {
    run_id: runId,
    track,
    repo_commits: {
      atris_cli: beforeCli || 'missing',
      atrisos_backend: beforeBackend || 'missing',
    },
    repo_commits_after: {
      atris_cli: afterCli || 'missing',
      atrisos_backend: afterBackend || 'missing',
    },
    task_brief: taskBrief,
    prompt_context: buildPromptContext(name, runnerConfig, taskBrief, execution?.phaseResults),
    changed_files: changedFiles,
    tests,
    review: {
      status: reviewStatus,
      summary: reviewSummary,
    },
    wiki: buildWikiArtifact(wikiBefore, wikiAfter),
    elapsed_seconds: execution?.elapsedSeconds || 0,
    interventions: {
      count: options.interventions.length,
      events: options.interventions,
    },
    notes: [notes, `runner=${runnerConfig.name}`].filter(Boolean).join(' | '),
  };

  const score = scoreEndstateArtifact(artifact);
  artifact.score = score.total;
  artifact.score_breakdown = score.breakdown;

  return { artifact, score };
}

function experimentsRun(name, ...args) {
  const { experimentsDir } = ensureExperimentsFramework();

  if (!name) {
    console.error('Usage: atris experiments run <slug> [--dry-run] [--verbose]');
    process.exit(1);
  }

  const packDir = path.join(experimentsDir, name);
  if (!fs.existsSync(packDir)) {
    console.error(`✗ Experiment "${name}" not found at atris/experiments/${name}/`);
    process.exit(1);
  }

  const options = parseRunOptions(args);

  if (!isEndstatePack(name)) {
    const loopPath = path.join(packDir, 'loop.py');
    if (!fs.existsSync(loopPath)) {
      console.error(`✗ Experiment "${name}" has no loop.py to run.`);
      process.exit(1);
    }
    if (options.dryRun) {
      console.log(`✓ Dry run: would execute atris/experiments/${name}/loop.py`);
      return;
    }
    runPython(loopPath, [], packDir);
    return;
  }

  const schemaPath = path.join(process.cwd(), 'atris', 'features', 'endstate', 'artifact-schema.json');
  const contractPath = path.join(process.cwd(), 'atris', 'features', 'endstate', 'contract.md');
  if (!fs.existsSync(schemaPath) || !fs.existsSync(contractPath)) {
    console.error('✗ Endstate contract missing. Expected atris/features/endstate/{contract.md,artifact-schema.json}.');
    process.exit(1);
  }

  const { artifact, score } = buildBenchmarkArtifact(name, packDir, options);
  const artifactPath = writeArtifact(packDir, artifact);
  appendResultsRow(path.join(packDir, 'results.tsv'), artifactPath, artifact, score);

  console.log(`✓ Endstate ${artifact.track} run recorded`);
  console.log(`  artifact: ${path.relative(process.cwd(), artifactPath)}`);
  console.log(`  score: ${score.total}/100`);
  console.log(`  review: ${artifact.review.status}`);
  console.log(`  interventions: ${artifact.interventions.count}`);

  if (artifact.review.status === 'fail' && !options.dryRun) {
    process.exit(1);
  }
}

function formatCompareLine(label, entry) {
  const artifact = entry.artifact;
  const score = getArtifactScore(artifact);
  const review = artifact.review?.status || 'unknown';
  const interventions = artifact.interventions?.count || 0;
  return `  ${label}: ${score}/100 | review: ${review} | interventions: ${interventions} | artifact: ${path.relative(process.cwd(), entry.filePath)}`;
}

function experimentsCompare(target = 'endstate') {
  const { experimentsDir } = ensureExperimentsFramework(process.cwd(), { silent: true });

  if (target !== 'endstate') {
    console.error('Usage: atris experiments compare endstate');
    process.exit(1);
  }

  const baselineDir = path.join(experimentsDir, 'endstate-baseline');
  const stackDir = path.join(experimentsDir, 'endstate-stack');

  try {
    const baselineEntry = readLatestArtifact(baselineDir);
    const stackEntry = readLatestArtifact(stackDir);
    const comparison = compareEndstateArtifacts(baselineEntry, stackEntry);

    console.log('✓ Endstate comparison ready');
    console.log(formatCompareLine('baseline', baselineEntry));
    console.log(formatCompareLine('stack', stackEntry));
    console.log('');
    if (comparison.winner === 'stack') {
      console.log('Decision: stack wins.');
    } else {
      console.log('Decision: no winner yet.');
    }
    console.log(`Reason: ${comparison.reason}`);
  } catch (error) {
    console.error(`✗ ${error.message || error}`);
    process.exit(1);
  }
}

function experimentsReplay(target = 'endstate') {
  if (target !== 'endstate') {
    console.error('Usage: atris experiments replay endstate');
    process.exit(1);
  }

  console.log('Replay: validate baseline pack');
  experimentsValidate('endstate-baseline');
  console.log('');
  console.log('Replay: validate stack pack');
  experimentsValidate('endstate-stack');
  console.log('');
  console.log('Replay: baseline dry run');
  experimentsRun('endstate-baseline', '--dry-run');
  console.log('');
  console.log('Replay: stack dry run');
  experimentsRun('endstate-stack', '--dry-run');
  console.log('');
  console.log('Replay: compare latest receipts');
  experimentsCompare('endstate');
}

function experimentsDaily(...args) {
  ensureAtrisWorkspace();
  const code = daily.runDaily(process.cwd(), args);
  if (code) process.exit(code);
}

function experimentsQueue(subcommand, ...args) {
  ensureAtrisWorkspace();
  const root = process.cwd();
  let code = 1;
  if (subcommand === 'add') code = daily.queueAdd(root, args);
  else if (subcommand === 'list') code = daily.queueList(root, args);
  else {
    console.error('Usage: atris experiments queue <add|list> ...');
    code = 1;
  }
  if (code) process.exit(code);
}

function experimentsCommand(subcommand, ...args) {
  switch (subcommand) {
    case 'daily':
      return experimentsDaily(...args);
    case 'queue':
      return experimentsQueue(args[0], ...args.slice(1));
    case 'init':
    case 'new':
      return experimentsInit(args[0]);
    case 'validate':
      return experimentsValidate(args[0]);
    case 'benchmark':
      return experimentsBenchmark(args[0] || 'all');
    case 'compare':
      return experimentsCompare(args[0] || 'endstate');
    case 'replay':
      return experimentsReplay(args[0] || 'endstate');
    case 'run':
      return experimentsRun(args[0], ...args.slice(1));
    default:
      console.log('');
      console.log('Usage: atris experiments <subcommand> [name]');
      console.log('');
      console.log('Subcommands:');
      console.log('  init [slug]          Prepare atris/experiments/ or scaffold a new pack');
      console.log('  validate [path|slug] Run structural validation on packs or a single pack');
      console.log('  run <slug>           Execute a pack or record an Endstate benchmark receipt');
      console.log('  compare endstate     Compare the latest baseline and stack receipts');
      console.log('  replay endstate      Validate, dry-run, and compare the public benchmark flow');
      console.log('  benchmark [mode]     Run validate/runtime/all benchmark harness');
      console.log('  daily [--dry-run] [--force] [--json]');
      console.log('  queue add|list       Manage the daily experiment queue');
      console.log('');
      console.log('Examples:');
      console.log('  atris experiments init');
      console.log('  atris experiments init self-heal');
      console.log('  atris experiments validate');
      console.log('  atris experiments run endstate-baseline --dry-run');
      console.log('  atris experiments compare endstate');
      console.log('  atris experiments replay endstate');
      console.log('  atris experiments benchmark runtime');
      console.log('');
  }
}

module.exports = {
  experimentsCommand,
  ensureExperimentsFramework,
  buildBenchmarkArtifact,
  parseRunOptions,
  experimentsDaily,
  experimentsQueue,
};
