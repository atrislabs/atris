const fs = require('fs');
const path = require('path');

function readBusinessBinding(cwd = process.cwd()) {
  const bindingPath = path.join(cwd, '.atris', 'business.json');
  if (!fs.existsSync(bindingPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(bindingPath, 'utf8'));
  } catch {
    return null;
  }
}

function slugify(value) {
  return String(value || 'business-workflow')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'business-workflow';
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function doctor(cwd = process.cwd()) {
  const binding = readBusinessBinding(cwd);
  console.log('Receipt check');
  console.log(`business binding: ${binding ? `${binding.name || binding.slug || binding.business_id} ready` : 'missing'}`);
  console.log(`receipt folder: ${fs.existsSync(path.join(cwd, '.atris', 'receipts')) ? 'ready' : 'missing'}`);
  console.log('');
  console.log('Next: atris receipt init business-workflow');
}

function init(taskSlug = 'business-workflow', cwd = process.cwd()) {
  const binding = readBusinessBinding(cwd);
  if (!binding) {
    console.error('No business binding found. Run: atris business init <name> --here');
    process.exitCode = 1;
    return;
  }

  const slug = slugify(taskSlug);
  const root = path.join(cwd, '.atris');
  const taskPath = path.join(root, 'tasks', `${slug}.json`);
  const receiptsDir = path.join(root, 'receipts');

  ensureDir(receiptsDir);
  fs.writeFileSync(path.join(receiptsDir, '.gitkeep'), '');
  writeJson(taskPath, {
    schema: 'atris.receipt_task.v1',
    slug,
    goal: 'Run one business-computer task and save what happened.',
    workspace: {
      business_id: binding.business_id || binding.id || null,
      workspace_id: binding.workspace_id || null,
      name: binding.name || null,
      slug: binding.slug || null,
    },
    runtime: {
      proof_command: 'atris computer proof',
      replay_command: 'atris experiments replay endstate',
    },
    verify: [
      'atris computer proof',
      'atris experiments replay endstate',
    ],
  });

  console.log(`Receipt task ready: ${slug}`);
  console.log(`Task: ${path.relative(cwd, taskPath)}`);
  console.log(`Receipts: ${path.relative(cwd, receiptsDir)}`);
}

function run(args = []) {
  const dryRun = args.includes('--dry-run');
  console.log('Receipt run');
  console.log('1. atris computer proof');
  console.log('2. atris experiments replay endstate');
  if (dryRun) {
    console.log('Dry run only; no receipts written.');
    return;
  }
  console.log('Run those commands, then save the receipt under .atris/receipts/.');
}

function proofCommand(subcommand = 'doctor', ...args) {
  switch (subcommand || 'doctor') {
    case 'doctor':
      return doctor();
    case 'init':
      return init(args[0] || 'business-workflow');
    case 'proof':
      return run(args);
    case 'help':
    case '--help':
    case '-h':
      console.log('Usage: atris receipt [doctor|init <slug>|run --dry-run]');
      return;
    case 'run':
      return run(args);
    default:
      console.error(`Unknown receipt command: ${subcommand}`);
      console.log('Usage: atris receipt [doctor|init <slug>|run --dry-run]');
      process.exitCode = 1;
  }
}

module.exports = {
  proofCommand,
};
