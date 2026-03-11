const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

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

function experimentsCommand(subcommand, ...args) {
  switch (subcommand) {
    case 'init':
    case 'new':
      return experimentsInit(args[0]);
    case 'validate':
      return experimentsValidate(args[0]);
    case 'benchmark':
      return experimentsBenchmark(args[0] || 'all');
    default:
      console.log('');
      console.log('Usage: atris experiments <subcommand> [name]');
      console.log('');
      console.log('Subcommands:');
      console.log('  init [slug]          Prepare atris/experiments/ or scaffold a new pack');
      console.log('  validate [path|slug] Run structural validation on packs or a single pack');
      console.log('  benchmark [mode]     Run validate/runtime/all benchmark harness');
      console.log('');
      console.log('Examples:');
      console.log('  atris experiments init');
      console.log('  atris experiments init self-heal');
      console.log('  atris experiments validate');
      console.log('  atris experiments benchmark runtime');
      console.log('');
  }
}

module.exports = {
  experimentsCommand,
  ensureExperimentsFramework,
};
