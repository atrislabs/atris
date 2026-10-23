'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.resolve(__dirname, '..', 'bin', 'atris.js');
const provenance = () => require('../lib/mission-code-provenance');

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function write(root, name, content = 'real product change\n') {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function commit(root, message) {
  git(root, 'add', '--all');
  git(root, 'commit', '-qm', message);
  return git(root, 'rev-parse', 'HEAD');
}

function repository(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-code-provenance-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test User');
  write(root, '.gitignore', '/atris/team/\n');
  write(root, 'base.txt', 'baseline\n');
  write(root, 'old\nname.js');
  write(root, 'deleted\tname.js');
  commit(root, 'baseline');
  return fs.realpathSync(root);
}

function changeManyFiles(root) {
  const files = ['base.txt', 'old\nname.js', 'renamed\tname.js', 'deleted\tname.js', '.atris/state/committed.json'];
  write(root, 'base.txt');
  fs.renameSync(path.join(root, 'old\nname.js'), path.join(root, 'renamed\tname.js'));
  fs.unlinkSync(path.join(root, 'deleted\tname.js'));
  write(root, '.atris/state/committed.json');
  for (let i = 0; i < 32; i += 1) {
    const name = `src/change-${String(i).padStart(2, '0')}.js`;
    files.push(name);
    write(root, name);
  }
  files.push('strange λ.js', '-leading.js');
  write(root, 'strange λ.js');
  write(root, '-leading.js');
  commit(root, 'complete product change');
  return files.sort();
}

function cli(root, ...args) {
  const result = spawnSync(process.execPath, [CLI, 'mission', ...args, '--json', '--full'], {
    cwd: root, encoding: 'utf8', timeout: 20000,
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_BACKEND_INSTALL_SIBLING: '0' },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test('real mission receipts keep complete committed evidence before the baseline is pruned', (t) => {
  const root = repository(t);
  const base = git(root, 'rev-parse', 'HEAD');
  const started = cli(root, 'start', 'Record the actual committed change', '--owner', 'builder', '--no-verify');
  const sidecar = path.join(root, '.atris', 'state', 'mission-baselines', `${started.mission.id}.json`);
  const savedBaseline = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
  assert.equal(savedBaseline.code?.status, 'complete');
  assert.equal(savedBaseline.code.base_commit, base);
  const files = changeManyFiles(root);
  files.push(
    `.atris/state/mission-baselines/${started.mission.id}.json`,
    '.atris/state/mission_events.jsonl', '.atris/state/missions.jsonl', 'atris/status/now.md',
  );
  files.sort();
  const head = git(root, 'rev-parse', 'HEAD');
  const ticked = cli(root, 'tick', started.mission.id, '--summary', 'The complete change is committed.');
  const tickReceipt = JSON.parse(fs.readFileSync(path.join(root, ticked.receipt_path), 'utf8'));
  assert.equal(tickReceipt.code_provenance.status, 'complete');
  assert.deepEqual(tickReceipt.code_provenance.files, files);
  const stopped = cli(root, 'stop', started.mission.id, '--reason', 'the committed slice is ready for review');
  const receipt = JSON.parse(fs.readFileSync(path.join(root, stopped.receipt_path), 'utf8'));
  assert.equal(receipt.code_provenance?.schema, 'atris.mission_code_provenance.v1');
  assert.equal(receipt.code_provenance.status, 'complete');
  assert.equal(receipt.code_provenance.base_commit, base);
  assert.equal(receipt.code_provenance.head_commit, head);
  assert.deepEqual(receipt.code_provenance.files, files);
  assert.equal(fs.existsSync(sidecar), false);
});

test('complete Git evidence includes every changed path, both rename paths, and bookkeeping commits', (t) => {
  const root = repository(t);
  const { captureCodeBaseline, collectCodeProvenance, verifyCodeProvenance } = provenance();
  write(root, '.atris/loose.json');
  write(root, 'atris/runs/loose.json');
  write(root, 'atris/status/loose.md');
  const baseline = captureCodeBaseline(root);
  assert.equal(baseline.status, 'complete');
  const files = changeManyFiles(root);
  files.push('.atris/loose.json', 'atris/runs/loose.json', 'atris/status/loose.md');
  files.sort();
  const evidence = collectCodeProvenance(root, baseline);
  assert.equal(evidence.status, 'complete');
  assert.equal(evidence.repo_root, fs.realpathSync(root));
  assert.deepEqual(evidence.files, files);
  assert.deepEqual(verifyCodeProvenance(root, evidence), { ok: true });
  write(root, 'later.js');
  commit(root, 'a later change');
  write(root, 'current-uncommitted.js');
  assert.deepEqual(verifyCodeProvenance(root, evidence), { ok: true }, 'historical receipts do not require the current head or current cleanliness');
  assert.equal(verifyCodeProvenance(root, { ...evidence, files: evidence.files.slice(0, 25) }).ok, false);
  assert.equal(verifyCodeProvenance(root, { ...evidence, files: [...evidence.files, 'invented.js'] }).ok, false);
  assert.equal(verifyCodeProvenance(root, { ...evidence, head_commit: '0'.repeat(40) }).ok, false);
});

test('missing or dirty baselines and dirty product endings do not claim complete code evidence', (t) => {
  const root = repository(t);
  const { captureCodeBaseline, collectCodeProvenance } = provenance();
  assert.equal(collectCodeProvenance(root, null).status, 'unavailable');
  const clean = captureCodeBaseline(root);
  assert.deepEqual(collectCodeProvenance(root, clean).files, [], 'an unchanged committed tree has an empty complete list');
  write(root, 'untracked/deep/product.js');
  const dirty = captureCodeBaseline(root);
  assert.equal(dirty.status, 'unavailable');
  assert.equal(collectCodeProvenance(root, clean).status, 'unavailable');
  commit(root, 'commit the product');
  assert.equal(collectCodeProvenance(root, dirty).status, 'unavailable', 'committing inherited dirt cannot create a clean starting point');
  write(root, 'atris/wiki/product.md');
  assert.equal(collectCodeProvenance(root, clean).status, 'unavailable', 'the whole atris folder is not bookkeeping');
});

test('a rename into bookkeeping cannot hide a dirty product source path', (t) => {
  const root = repository(t);
  const { captureCodeBaseline } = provenance();
  fs.mkdirSync(path.join(root, '.atris'), { recursive: true });
  git(root, 'mv', 'base.txt', '.atris/moved.txt');
  assert.equal(captureCodeBaseline(root).status, 'unavailable');
});

test('foreign repositories, nested roots, and unrelated histories cannot reuse a baseline', (t) => {
  const root = repository(t);
  const other = repository(t);
  const { captureCodeBaseline, collectCodeProvenance, verifyCodeProvenance } = provenance();
  const baseline = captureCodeBaseline(root);
  assert.equal(collectCodeProvenance(other, baseline).status, 'unavailable');
  const evidence = collectCodeProvenance(root, baseline);
  assert.equal(verifyCodeProvenance(other, evidence).ok, false);
  fs.mkdirSync(path.join(root, 'nested'));
  assert.equal(captureCodeBaseline(path.join(root, 'nested')).status, 'unavailable');
  git(root, 'checkout', '--orphan', 'unrelated');
  git(root, 'rm', '-rf', '.');
  write(root, 'other-history.txt');
  commit(root, 'unrelated history');
  assert.equal(collectCodeProvenance(root, baseline).status, 'unavailable');
  assert.equal(verifyCodeProvenance(root, { ...evidence, head_commit: git(root, 'rev-parse', 'HEAD') }).ok, false);
});

test('local or inherited grafts cannot turn unrelated commits into source evidence', (t) => {
  const root = repository(t);
  const { captureCodeBaseline, collectCodeProvenance, verifyCodeProvenance } = provenance();
  const baseline = captureCodeBaseline(root);
  write(root, 'base.txt', 'committed product improvement\n');
  commit(root, 'genuine improvement');
  const genuine = collectCodeProvenance(root, baseline);
  assert.equal(genuine.status, 'complete');
  const tree = git(root, 'rev-parse', 'HEAD^{tree}');
  const unrelated = git(root, 'commit-tree', tree, '-m', 'physically unrelated root');
  assert.equal(git(root, 'cat-file', '-p', unrelated).split('\n\n')[0].includes('\nparent '), false);
  git(root, 'checkout', '-q', '--detach', unrelated);
  const invented = { ...genuine, head_commit: unrelated };
  const reject = () => {
    assert.equal(collectCodeProvenance(root, baseline).reason, 'base_not_ancestor');
    assert.deepEqual(verifyCodeProvenance(root, invented), { ok: false, reason: 'base_not_ancestor' });
  };
  reject();
  const local = path.join(root, '.git', 'info', 'grafts');
  fs.writeFileSync(local, `${unrelated} ${baseline.base_commit}\n`);
  reject();
  fs.unlinkSync(local);
  reject();
  const inherited = path.join(root, '.git', 'alternate-grafts');
  fs.writeFileSync(inherited, `${unrelated} ${baseline.base_commit}\n`);
  const saved = process.env.GIT_GRAFT_FILE;
  try {
    process.env.GIT_GRAFT_FILE = inherited;
    reject();
  } finally {
    if (saved === undefined) delete process.env.GIT_GRAFT_FILE;
    else process.env.GIT_GRAFT_FILE = saved;
  }
  assert.equal(git(root, 'rev-parse', 'HEAD'), unrelated);
  assert.equal(git(root, 'rev-parse', 'HEAD^{tree}'), tree);
});

test('graft views cannot hide a real descendant from complete source evidence', (t) => {
  const root = repository(t);
  const { captureCodeBaseline, collectCodeProvenance, verifyCodeProvenance } = provenance();
  const baseline = captureCodeBaseline(root);
  const files = changeManyFiles(root);
  const actual = collectCodeProvenance(root, baseline);
  assert.equal(actual.status, 'complete');
  assert.deepEqual(actual.files, files);
  const check = () => {
    assert.deepEqual(collectCodeProvenance(root, baseline), actual);
    assert.deepEqual(verifyCodeProvenance(root, actual), { ok: true });
  };
  const local = path.join(root, '.git', 'info', 'grafts');
  fs.writeFileSync(local, `${actual.head_commit}\n`);
  check();
  fs.unlinkSync(local);
  const inherited = path.join(root, '.git', 'alternate-grafts');
  fs.writeFileSync(inherited, `${actual.head_commit}\n`);
  const saved = process.env.GIT_GRAFT_FILE;
  try {
    process.env.GIT_GRAFT_FILE = inherited;
    check();
  } finally {
    if (saved === undefined) delete process.env.GIT_GRAFT_FILE;
    else process.env.GIT_GRAFT_FILE = saved;
  }
  check();
});

test('missing Git history or unreadable full status leaves evidence unavailable', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-code-no-git-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { captureCodeBaseline, collectCodeProvenance } = provenance();
  assert.equal(captureCodeBaseline(root).status, 'unavailable');
  assert.equal(collectCodeProvenance(root, null).status, 'unavailable');
  git(root, 'init', '-q');
  assert.equal(captureCodeBaseline(root).status, 'unavailable');
  const repo = repository(t);
  const baseline = captureCodeBaseline(repo);
  fs.writeFileSync(path.join(repo, '.git', 'index'), 'unreadable git index');
  assert.equal(captureCodeBaseline(repo).status, 'unavailable');
  assert.equal(collectCodeProvenance(repo, baseline).status, 'unavailable');
});

test('a caller Git environment cannot redirect evidence to another repository', (t) => {
  const root = repository(t);
  const other = repository(t);
  write(other, 'foreign.js');
  commit(other, 'foreign repository change');
  const head = git(root, 'rev-parse', 'HEAD');
  const saved = Object.fromEntries(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].map((key) => [key, process.env[key]]));
  try {
    process.env.GIT_DIR = path.join(other, '.git');
    process.env.GIT_WORK_TREE = other;
    process.env.GIT_INDEX_FILE = path.join(other, '.git', 'index');
    const baseline = provenance().captureCodeBaseline(root);
    assert.equal(baseline.status, 'complete');
    assert.equal(baseline.repo_root, root);
    assert.equal(baseline.base_commit, head);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
