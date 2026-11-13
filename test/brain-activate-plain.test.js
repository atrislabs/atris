const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cli = path.resolve(__dirname, '../bin/atris.js');
test('start-up cards are useful and read-only until saved', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-plain-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-home-'));
  const env = { ...process.env, HOME: home, ATRIS_HOME: home, NO_COLOR: '1' };
  const outputs = [];
  const run = (...args) => {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: 'utf8' });
    outputs.push(args.includes('--json') && result.status === 0 ? JSON.parse(result.stdout).card : result.stdout + result.stderr);
    return result;
  };
  try {
    assert.equal(run('brain', 'activate').status, 1);
    fs.mkdirSync(path.join(root, 'atris', 'team', 'navigator'), { recursive: true });
    fs.writeFileSync(path.join(root, 'atris', 'MAP.md'), '# MAP.md\n');
    fs.writeFileSync(path.join(root, 'atris', 'team', 'navigator', 'MEMBER.md'), '# navigator\n');
    fs.writeFileSync(path.join(root, 'atris', 'team', 'navigator', 'START_HERE.md'), 'start here\n');
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: root }).status, 0);
    assert.equal(spawnSync('git', ['add', '.'], { cwd: root }).status, 0);
    assert.equal(spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture'], { cwd: root }).status, 0);
    const assertClean = () => {
      const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' });
      assert.equal(status.status, 0);
      assert.deepEqual(status.stdout.split('\n').filter(Boolean).filter(line => !line.slice(3).startsWith('.atris/')), []);
    };
    const initial = run('brain', 'activate');
    assert.equal(initial.status, 0);
    assert.match(initial.stdout, new RegExp(`${path.basename(root)} is ready`));
    assert.match(initial.stdout, /start-up notes are not saved yet/);
    assert.match(initial.stdout, /read these first:\n  atris\/MAP.md/);
    assert.doesNotMatch(initial.stdout, /  atris\/now.md/);
    assertClean();
    for (const args of [[], ['status'], ['gallery'], ['activate', '--member', 'navigator']]) {
      assert.equal(run('brain', ...args).status, 0);
      assertClean();
    }
    const remembered = JSON.parse(run('brain', '--json').stdout);
    assert.equal(remembered.member, null);
    assert.equal(remembered.remembered_member, 'navigator');
    assert.match(remembered.card, /last role used here: navigator/);
    assert.doesNotMatch(remembered.card, /is ready for navigator/);
    assert.equal(run('brain', 'activate', '--verify').status, 1);
    assert.match(run('brain', 'activate', '--yes', '--verify').stdout, /\n\nchecked: the saved notes are in place/);
    assert.doesNotMatch(run('brain', 'activate').stdout, /notes are .* old|not saved yet/);
    const statePath = path.join(root, 'atris', 'brain', 'state.json');
    const state = JSON.parse(fs.readFileSync(statePath));
    state.generatedAt = new Date(Date.now() - 5 * 86400000).toISOString();
    fs.writeFileSync(statePath, JSON.stringify(state));
    assert.match(run('brain', 'activate').stdout, /notes are 5 days old/);
    const role = run('brain', 'activate', '--member', 'navigator');
    assert.match(role.stdout, /ready for navigator/);
    assert.match(role.stdout, /right now:/);
    assert.match(role.stdout, /read these first:/);
    assert.match(run('brain', 'activate', '--member', 'dana').stdout, /there is no team member by that name/);
    assert.match(run('brain').stdout, /is ready/);
    assert.match(run('brain', 'status').stdout, /is ready/);
    assert.match(run('brain', '--help').stdout, /notes every agent reads/);
    for (const output of outputs) {
      assert.doesNotMatch(output, /^[A-Z][A-Z ]{2,}:/m);
      assert.doesNotMatch(output.replaceAll('atris brain scorecard', ''), /\b(operator|artifact|scorecard|verifier|proof path|work block|bounded|leverage|lane|tick|receipt|XP|endgame|compiled|state rows|episode|reward signal|executable|MAP-backed|ASCII|zero-spend|1% delta)\b/i);
      assert.doesNotMatch(output, /—/);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('foreign folder commands keep their target and role cards keep context', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'brain roots '));
  const root = path.join(parent, "team's notes");
  const elsewhere = path.join(parent, 'elsewhere');
  const bin = path.join(parent, 'bin');
  fs.mkdirSync(path.join(root, 'atris', 'team', 'navigator'), { recursive: true });
  fs.mkdirSync(elsewhere);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(root, 'atris', 'MAP.md'), '# MAP.md\n');
  fs.writeFileSync(path.join(root, 'atris', 'team', 'navigator', 'MEMBER.md'), '# navigator\n');
  fs.writeFileSync(path.join(root, 'atris', 'team', 'navigator', 'START_HERE.md'), 'start here\n');
  fs.mkdirSync(path.join(root, 'atris', 'state'));
  fs.writeFileSync(path.join(root, 'atris', 'state', 'contribution-score.md'), '## navigator\nnext_rep: complete the next step\n');
  fs.writeFileSync(path.join(bin, 'atris'), `#!/bin/sh\nexec '${process.execPath}' '${cli}' "$@"\n`, { mode: 0o755 });
  const env = { ...process.env, HOME: parent, ATRIS_HOME: parent, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const run = (...args) => spawnSync(process.execPath, [cli, 'brain', ...args], { cwd: elsewhere, env, encoding: 'utf8' });
  try {
    const card = run('activate', '--member', 'navigator', '--root', root, '--yes', '--json');
    assert.equal(card.status, 0, card.stderr);
    const data = JSON.parse(card.stdout);
    assert.equal(data.member, 'navigator');
    assert.equal(data.remembered_member, 'navigator');
    assert.match(data.card, /right now:/);
    assert.match(data.card, /read these first:/);
    const local = spawnSync(process.execPath, [cli, 'brain', 'activate', '--member', 'navigator', '--root', root], { cwd: root, env, encoding: 'utf8' });
    assert.equal(local.status, 0, local.stderr);
    assert.match(local.stdout, /how did it go: atris brain yes, atris brain edit/);
    assert.match(data.card, /done when: complete the next step/);
    assert.doesNotMatch(data.card, /next rep: complete the next step/);
    const yes = data.card.match(/how did it go: (.*?), atris brain edit/)[1];
    assert.match(yes, /--root/);
    const feedback = spawnSync('sh', ['-c', yes], { cwd: elsewhere, env, encoding: 'utf8' });
    assert.equal(feedback.status, 0, feedback.stderr);
    assert.equal(fs.existsSync(path.join(root, '.atris', 'state', 'scorecards.jsonl')), true);
    assert.equal(fs.existsSync(path.join(elsewhere, '.atris', 'state', 'scorecards.jsonl')), false);
    const next = run('activate', '--root', root);
    const command = next.stdout.match(/for its next step: (.*)/)[1];
    const rerun = spawnSync('sh', ['-c', command], { cwd: elsewhere, env, encoding: 'utf8' });
    assert.equal(rerun.status, 0, rerun.stderr);
    assert.match(rerun.stdout, /is ready for navigator/);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

// A business file left over from another project once made this card greet
// the wrong workspace. The folder name is always shown; a business name that
// differs from it rides along in brackets.
test('the card always shows the folder name, with a different business name in brackets', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-name-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-home-'));
  const env = { ...process.env, HOME: home, ATRIS_HOME: home, NO_COLOR: '1' };
  const card = (folder, business) => {
    const root = path.join(base, folder);
    fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(root, 'atris', 'MAP.md'), '# MAP.md\n');
    if (business) {
      fs.mkdirSync(path.join(root, '.atris'), { recursive: true });
      fs.writeFileSync(path.join(root, '.atris', 'business.json'), JSON.stringify(business));
    }
    const result = spawnSync(process.execPath, [cli, 'brain', 'activate'], { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  try {
    assert.match(card('tool-shed', null), /^tool-shed is ready\.$/m);
    assert.match(card('my-lab', { name: 'My Lab', slug: 'my-lab' }), /^My Lab is ready\.$/m);
    assert.match(card('real-project', { name: 'Leftover Co', slug: 'leftover-co' }), /^real-project \(Leftover Co\) is ready\.$/m);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
