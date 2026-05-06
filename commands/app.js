/**
 * atris app — manage APP.md manifests in the current workspace.
 *
 * Subcommands:
 *   atris app init <slug> [--runtime ec2|local|webhook|external|web|ios|template]
 *     Scaffolds apps/<slug>/{APP.md, README.md, data/, logs/}.
 *
 *   atris app list
 *     Lists every apps/<slug>/APP.md in the current workspace.
 *
 *   atris app show <slug>
 *     Prints the APP.md for a given app.
 *
 * APP.md is the third agent-native primitive alongside MEMBER.md and
 * SKILL.md. One file, any runtime, every agent. See github.com/atrislabs/app.md.
 */

const fs = require('fs');
const path = require('path');

const RUNTIMES = [
  'local',
  'subprocess',
  'ec2',
  'webhook',
  'external',
  'web',
  'ios',
  'template',
];

function workspaceRoot() {
  // An Atris workspace has either .atris/business.json (business workspace)
  // or atris/atris.md (repo workspace). Walk up until we find one.
  let cur = process.cwd();
  while (cur !== path.dirname(cur)) {
    if (
      fs.existsSync(path.join(cur, '.atris', 'business.json')) ||
      fs.existsSync(path.join(cur, 'atris', 'atris.md'))
    ) {
      return cur;
    }
    cur = path.dirname(cur);
  }
  return process.cwd();
}

function parseRuntimeFlag(args) {
  const idx = args.findIndex((a) => a === '--runtime' || a === '-r');
  if (idx === -1) return 'local';
  const val = args[idx + 1];
  if (!RUNTIMES.includes(val)) {
    console.error(`✗ --runtime must be one of: ${RUNTIMES.join(', ')}`);
    process.exit(1);
  }
  return val;
}

function templateFor(slug, runtime) {
  const header = [
    '---',
    'schema_version: 1',
    `name: ${slug}`,
    `slug: ${slug}`,
    `description: One-line description of what ${slug} does.`,
    'access: business',
    `runtime: ${runtime}`,
    'vault: atris-kms',
    'runtime_auth: jwt',
  ];

  const body = [
    `# ${slug}`,
    '',
    'What this app does, step by step.',
    '',
    '1. First action (reference secrets by name like `MY_API_KEY`).',
    '2. Second action.',
    '3. Where the output goes.',
    '',
    '## Guardrails',
    '',
    '- What this app will never do.',
    '- What happens when a secret is missing.',
    '',
  ].join('\n');

  if (runtime === 'ec2' || runtime === 'subprocess' || runtime === 'local') {
    header.push(
      'block_pipeline_id: null',
      'secrets: []',
      '# schedule: "0 9 * * *"  # uncomment for cron',
      '# member: treasury        # optional inherit',
      '# skills: []              # optional inherit',
      'surfaces: [web]',
      'render: inline',
      'monetization:',
      '  price_credits: 0',
      '  creator_share: 0.0',
      '---',
      '',
    );
  } else if (runtime === 'webhook') {
    header.push(
      'endpoints:',
      '  webhook: https://example.com/hook',
      'auth:',
      '  type: hmac',
      '  secret_ref: HOOK_SECRET',
      'secrets: [HOOK_SECRET]',
      'surfaces: [web]',
      'render: none',
      '---',
      '',
    );
  } else if (runtime === 'external') {
    header.push(
      'endpoints:',
      '  api: https://api.example.com',
      '  frontend: https://app.example.com',
      '  mcp: https://example.com/mcp',
      'auth:',
      '  type: oauth',
      '  issuer: https://auth.example.com',
      'capabilities: []',
      'secrets: []',
      'surfaces: [web, slack, mcp]',
      'render: inline',
      '---',
      '',
    );
  } else if (runtime === 'web') {
    header.push(
      'endpoints:',
      '  frontend: https://example.com',
      '  mcp: https://example.com/mcp',
      'auth:',
      '  type: none',
      'capabilities: []',
      'surfaces: [web, mcp]',
      'render: embed',
      '---',
      '',
    );
  } else if (runtime === 'ios') {
    header.push(
      'endpoints:',
      '  bundle_id: com.example.app',
      '  deep_link_scheme: example',
      'capabilities: []',
      'secrets: []',
      'surfaces: [mobile]',
      'render: fullscreen',
      '---',
      '',
    );
  } else if (runtime === 'template') {
    header.push(
      'access: public',
      'secrets: []',
      'surfaces: [web]',
      'render: none',
      'monetization:',
      '  price_credits: 5',
      '  creator_share: 0.8',
      '---',
      '',
    );
  }

  return header.join('\n') + body;
}

function readmeFor(slug) {
  return [
    `# ${slug}`,
    '',
    'One-line description.',
    '',
    'See `APP.md` for the manifest.',
    '',
    '## Files',
    '',
    '- `APP.md` — app manifest (frontmatter + instructions). Source of truth.',
    '- `data/` — per-run outputs.',
    '- `logs/` — stdout/stderr per trigger.',
    '',
    '## Secrets',
    '',
    'Values live in the workspace vault, not this folder. Rotate with',
    '`atris secrets set <NAME>` once that command lands.',
    '',
  ].join('\n');
}

async function init(slug, runtime) {
  if (!slug) {
    console.error('✗ usage: atris app init <slug> [--runtime <kind>]');
    process.exit(1);
  }
  if (!/^[a-z0-9-]+$/.test(slug)) {
    console.error(`✗ slug must be lowercase alphanumerics + hyphens (got: ${slug})`);
    process.exit(1);
  }

  const root = workspaceRoot();
  const appsDir = path.join(root, 'apps');
  const slugDir = path.join(appsDir, slug);
  if (fs.existsSync(slugDir)) {
    console.error(`✗ ${slugDir} already exists`);
    process.exit(1);
  }

  fs.mkdirSync(path.join(slugDir, 'data'), { recursive: true });
  fs.mkdirSync(path.join(slugDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(slugDir, 'APP.md'), templateFor(slug, runtime), 'utf8');
  fs.writeFileSync(path.join(slugDir, 'README.md'), readmeFor(slug), 'utf8');

  console.log(`✓ scaffolded ${path.relative(process.cwd(), slugDir)}`);
  console.log(`  runtime: ${runtime}`);
  console.log('  next:');
  console.log(`    1. edit ${path.join('apps', slug, 'APP.md')}`);
  console.log('    2. atris app show ' + slug);
  console.log('    3. (coming) atris app sync ' + slug);
}

function findApps(root) {
  const appsDir = path.join(root, 'apps');
  if (!fs.existsSync(appsDir)) return [];
  return fs
    .readdirSync(appsDir)
    .filter((name) => {
      const f = path.join(appsDir, name, 'APP.md');
      return fs.existsSync(f);
    })
    .map((name) => ({
      slug: name,
      path: path.join(appsDir, name),
    }));
}

async function list() {
  const root = workspaceRoot();
  const apps = findApps(root);
  if (apps.length === 0) {
    console.log(`no apps in ${path.relative(process.cwd(), path.join(root, 'apps')) || 'apps/'}`);
    console.log('create one: atris app init <slug>');
    return;
  }
  console.log(`apps in ${path.relative(process.cwd(), root) || '.'}:`);
  for (const a of apps) {
    const md = fs.readFileSync(path.join(a.path, 'APP.md'), 'utf8');
    const runtime = (md.match(/^runtime:\s*(\S+)/m) || [])[1] || '?';
    const access = (md.match(/^access:\s*(\S+)/m) || [])[1] || '?';
    console.log(`  ${a.slug.padEnd(28)} runtime=${runtime.padEnd(10)} access=${access}`);
  }
}

async function show(slug) {
  if (!slug) {
    console.error('✗ usage: atris app show <slug>');
    process.exit(1);
  }
  const root = workspaceRoot();
  const file = path.join(root, 'apps', slug, 'APP.md');
  if (!fs.existsSync(file)) {
    console.error(`✗ ${file} not found`);
    process.exit(1);
  }
  process.stdout.write(fs.readFileSync(file, 'utf8'));
}

async function help() {
  console.log('atris app — manage APP.md manifests');
  console.log('');
  console.log('Subcommands:');
  console.log('  init <slug> [--runtime <kind>]  Scaffold a new app folder');
  console.log('  list                            List apps in this workspace');
  console.log('  show <slug>                     Print the APP.md for an app');
  console.log('');
  console.log(`Runtimes: ${RUNTIMES.join(', ')}`);
  console.log('');
  console.log('APP.md is the third agent-native primitive alongside MEMBER.md');
  console.log('and SKILL.md. Spec: https://github.com/atrislabs/app.md');
}

async function appCommand(subcommand, ...args) {
  try {
    switch (subcommand) {
      case 'init':
        await init(args[0], parseRuntimeFlag(args));
        break;
      case 'list':
      case 'ls':
        await list();
        break;
      case 'show':
      case 'cat':
        await show(args[0]);
        break;
      case 'help':
      case '-h':
      case '--help':
      case undefined:
        await help();
        break;
      default:
        console.error(`✗ unknown subcommand: ${subcommand}`);
        await help();
        process.exit(1);
    }
  } catch (err) {
    console.error(`✗ ${err.message || err}`);
    process.exit(1);
  }
}

module.exports = { appCommand };
