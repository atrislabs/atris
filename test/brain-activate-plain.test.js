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
    outputs.push(result.stdout + result.stderr);
    return result;
  };
  try {
    assert.equal(run('brain', 'activate').status, 1);
    fs.mkdirSync(path.join(root, 'atris', 'team', 'navigator'), { recursive: true });
    fs.writeFileSync(path.join(root, 'atris', 'MAP.md'), '# MAP.md\n');
    fs.writeFileSync(path.join(root, 'atris', 'team', 'navigator', 'MEMBER.md'), '# navigator\n');
    fs.writeFileSync(path.join(root, 'atris', 'team', 'navigator', 'START_HERE.md'), 'start here\n');
    fs.mkdirSync(path.join(root, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(root, '.atris', 'business.json'), JSON.stringify({ name: 'stale', business_id: '' }));
    spawnSync('git', ['init', '-q'], { cwd: root });
    spawnSync('git', ['add', '.'], { cwd: root });
    const before = spawnSync('git', ['diff', '--cached'], { cwd: root, encoding: 'utf8' }).stdout;
    const initial = run('brain', 'activate');
    assert.equal(initial.status, 0);
    assert.match(initial.stdout, new RegExp(`${path.basename(root)} is ready`));
    assert.match(initial.stdout, /start-up notes are not saved yet/);
    assert.match(initial.stdout, /read these first:\n  atris\/MAP.md/);
    assert.doesNotMatch(initial.stdout, /  atris\/now.md/);
    assert.equal(spawnSync('git', ['diff'], { cwd: root, encoding: 'utf8' }).stdout, '');
    assert.equal(spawnSync('git', ['diff', '--cached'], { cwd: root, encoding: 'utf8' }).stdout, before);
    assert.equal(run('brain', 'activate', '--verify').status, 1);
    assert.match(run('brain', 'activate', '--yes', '--verify').stdout, /\n\nchecked: the saved notes are in place/);
    assert.doesNotMatch(run('brain', 'activate').stdout, /notes are .* old|not saved yet/);
    const statePath = path.join(root, 'atris', 'brain', 'state.json');
    const state = JSON.parse(fs.readFileSync(statePath));
    state.generatedAt = new Date(Date.now() - 5 * 86400000).toISOString();
    fs.writeFileSync(statePath, JSON.stringify(state));
    assert.match(run('brain', 'activate').stdout, /notes are 5 days old/);
    assert.match(run('brain', 'activate', '--member', 'navigator').stdout, /ready for navigator/);
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
