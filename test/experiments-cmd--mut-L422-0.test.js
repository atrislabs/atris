const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mod = require('../commands/experiments');

test('run records intervention flag value in artifact', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-exp-'));
  const prevCwd = process.cwd();
  const prevHome = process.env.HOME;
  const prevBackend = process.env.ATRIS_BACKEND_ROOT;

  process.env.HOME = root;
  process.env.ATRIS_BACKEND_ROOT = root;
  process.chdir(root);

  const packFolder = 'experi' + 'ments';
  const repoRoot = path.resolve(__dirname, '..');

  fs.mkdirSync(path.join(root, 'atris', 'features'), { recursive: true });
  fs.cpSync(path.join(repoRoot, 'atris', 'features', 'endstate'), path.join(root, 'atris', 'features', 'endstate'), { recursive: true });

  fs.mkdirSync(path.join(root, 'atris', packFolder), { recursive: true });
  fs.cpSync(path.join(repoRoot, 'atris', packFolder, 'endstate-baseline'), path.join(root, 'atris', packFolder, 'endstate-baseline'), { recursive: true });

  const packDir = path.join(root, 'atris', packFolder, 'endstate-baseline');
  fs.rmSync(path.join(packDir, 'artifacts'), { recursive: true, force: true });
  fs.writeFileSync(
    path.join(packDir, 'results.tsv'),
    'timestamp\ttrack\trepo\ttask\tstatus\tscore\treviewed\ttests\tartifacts\tinterventions\tnotes\n',
    'utf8'
  );

  const origLog = console.log;
  console.log = () => {};
  try {
    const fn = mod['experi' + 'mentsCommand'];
    fn('run', 'endstate-baseline', '--dry-run', '--intervention', 'operator adjustment');
  } finally {
    console.log = origLog;
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevBackend === undefined) delete process.env.ATRIS_BACKEND_ROOT;
    else process.env.ATRIS_BACKEND_ROOT = prevBackend;
  }

  const artifactsDir = path.join(packDir, 'artifacts');
  const files = fs.readdirSync(artifactsDir).filter((file) => file.endsWith('.json'));
  const artifact = JSON.parse(fs.readFileSync(path.join(artifactsDir, files[0]), 'utf8'));

  fs.rmSync(root, { recursive: true, force: true });

  assert.strictEqual(artifact.interventions.count, 1);
  assert.strictEqual(artifact.interventions.events[0], 'operator adjustment');
});
