const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { withMissionFullJson } = require('./helpers/mission-json');
const { scrubAgentEnv } = require('./helpers/agent-env');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const RUNNER_ENV = [
  'ATRIS_RUNNER_PROFILE', 'ATRIS_RUNNER_MODEL', 'ATRIS_RUNNER_BIN', 'ATRIS_RUNNER_COMMAND_TEMPLATE',
  'ATRIS_CLAUDE_MODEL', 'ATRIS_CLAUDE_BIN', 'ATRIS_CLAUDE_COMMAND_TEMPLATE',
];

function runCli(args, cwd, env) {
  const clean = scrubAgentEnv(process.env);
  for (const name of RUNNER_ENV) delete clean[name];
  const home = path.join(cwd, 'home');
  fs.mkdirSync(home, { recursive: true });
  return spawnSync(process.execPath, [cliPath, ...withMissionFullJson(args)], {
    cwd,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...clean,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      HOME: home,
      ATRIS_TASKS_DB: path.join(cwd, '.atris', 'tasks.db'),
      CODEX_HOME: path.join(home, '.codex'),
      ATRIS_MACHINE_ROSTER_PATH: path.join(home, 'roster.json'),
      ATRIS_MACHINE_ROSTER_MD_PATH: path.join(home, 'roster.md'),
      ATRIS_ROSTER_SESSIONS_DIR: path.join(home, 'roster-sessions'),
      ATRIS_PROGRESS_DIR: path.join(cwd, 'progress'),
      ...env,
    },
  });
}

// One codex tick through the real mission run; the fake codex prints the
// report file it is handed, with or without the last-message flag.
function runCodexTick(dir, reportFile, { lastMessageFlag }) {
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const help = lastMessageFlag ? 'echo "      --json"; echo "  -o, --output-last-message <FILE>"' : 'echo "  -m, --model <MODEL>"';
  const body = [
    `if [ "$1" = "exec" ] && [ "$2" = "--help" ]; then ${help}; exit 0; fi`,
    'out=""; prev=""',
    'for a in "$@"; do if [ "$prev" = "--output-last-message" ]; then out="$a"; fi; prev="$a"; done',
    `if [ -n "$out" ]; then cat "${reportFile}" > "$out"; else cat "${reportFile}"; fi`,
  ].join('\n');
  fs.writeFileSync(path.join(binDir, 'codex'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const env = { PATH: `${binDir}${path.delimiter}/usr/bin${path.delimiter}/bin` };
  const start = runCli(['mission', 'start', 'write the long report', '--owner', 'growth', '--runner', 'codex', '--no-verify', '--json'], dir, env);
  assert.equal(start.status, 0, start.stderr || start.stdout);
  const mission = JSON.parse(start.stdout).mission;
  const run = runCli(['mission', 'run', mission.id, '--max-ticks', '1', '--max-wall', '60', '--no-verify', '--json'], dir, env);
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const runsDir = path.join(dir, 'atris', 'runs');
  const receipts = fs.readdirSync(runsDir)
    .filter((name) => /^mission-.*\.json$/.test(name))
    .map((name) => JSON.parse(fs.readFileSync(path.join(runsDir, name), 'utf8')))
    .filter((receipt) => receipt.result && receipt.result.kind === 'mission_run_tick');
  assert.equal(receipts.length, 1, 'one tick receipt');
  return receipts[0].result.tick.claude;
}

function longReport() {
  const lines = ['Rewrote the readme intro and checked every link.'];
  for (let i = 1; i <= 120; i += 1) lines.push(`- step ${i}: checked section ${i} and kept what reads well.`);
  lines.push('next_push: split the install section into its own page');
  lines.push('layer: environment');
  return lines.join('\n');
}

for (const lastMessageFlag of [true, false]) {
  const label = lastMessageFlag ? 'a codex member' : 'an older codex member';
  test(`${label} saves its full written report beside the receipt`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-codex-report-'));
    try {
      const report = longReport();
      assert.ok(report.length > 4000, 'the report is longer than the receipt keeps');
      const reportFile = path.join(dir, 'report.txt');
      fs.writeFileSync(reportFile, `${report}\n`);
      const claude = runCodexTick(dir, reportFile, { lastMessageFlag });
      assert.match(claude.receipt_text, /\.\.\.\[truncated\]$/, 'the receipt copy stays capped');
      assert.ok(!claude.receipt_text.includes('layer: environment'));
      assert.ok(claude.report_path, 'the receipt points at the full report');
      const saved = fs.readFileSync(path.join(dir, claude.report_path), 'utf8');
      assert.ok(saved.includes(report), 'every line the member wrote is kept');
      assert.match(saved, /next_push: split the install section/);
      assert.match(saved, /layer: environment\n$/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('a short codex report stays in the receipt with no extra file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-codex-report-short-'));
  try {
    const reportFile = path.join(dir, 'report.txt');
    fs.writeFileSync(reportFile, 'Tidied the readme.\nlayer: environment\n');
    const claude = runCodexTick(dir, reportFile, { lastMessageFlag: true });
    assert.equal(claude.receipt_text, 'Tidied the readme.\nlayer: environment');
    assert.equal(claude.report_path, null);
    const extras = fs.readdirSync(path.join(dir, 'atris', 'runs')).filter((name) => name.endsWith('-report.md'));
    assert.deepEqual(extras, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
