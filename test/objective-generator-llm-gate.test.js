const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cliPath = path.resolve(__dirname, '..', 'bin', 'atris.js');

function makeTempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-objgen-gate-'));
  const memberDir = path.join(dir, 'atris', 'team', 'objective-generator');
  fs.mkdirSync(memberDir, { recursive: true });
  fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '# objective-generator\n', 'utf8');
  return dir;
}

function runWake(dir, env = {}) {
  const cleanEnv = { ...process.env };
  delete cleanEnv.ATRIS_OBJECTIVE_GENERATOR_LLM;
  delete cleanEnv.ATRIS_OBJECTIVE_GENERATOR_LLM_JSON;
  return spawnSync(process.execPath, [cliPath, 'member', 'wake', 'objective-generator', '--json'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...cleanEnv, ...env },
  });
}

function receiptFiles(dir) {
  const runsDir = path.join(dir, 'atris', 'runs');
  return fs.existsSync(runsDir)
    ? fs.readdirSync(runsDir).filter((name) => name.startsWith('objective-generator-tick-'))
    : [];
}

test('dry-run wake skips quietly when no objective-generator llm is configured', () => {
  const dir = makeTempProject();
  try {
    const result = runWake(dir);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.reason, 'llm_not_configured');
    assert.equal(payload.executed, false);
    assert.deepEqual(receiptFiles(dir), []);
    const logPath = path.join(dir, 'atris', 'team', 'objective-generator', 'logs');
    assert.equal(fs.existsSync(logPath) && fs.readdirSync(logPath).length > 0, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dry-run wake still writes a receipt when an injected llm proposal is configured', () => {
  const dir = makeTempProject();
  try {
    const injected = JSON.stringify({
      proposed_objective: 'test objective',
      impact_score: 5,
      urgency_score: 5,
      alignment_score: 5,
      justification: 'test',
      suggested_member: 'architect',
    });
    const result = runWake(dir, { ATRIS_OBJECTIVE_GENERATOR_LLM_JSON: injected });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(receiptFiles(dir).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
