const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cliPath = path.join(__dirname, '..', 'bin', 'atris.js');

function runCli(args, cwd) {
  const env = { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_TASKS_DB: path.join(cwd, '.atris', 'tasks.db') };
  delete env.ANTHROPIC_API_KEY;
  return spawnSync(process.execPath, [cliPath, ...args], { cwd, env, encoding: 'utf8', timeout: 20000 });
}

function dateDaysAgo(days) {
  return new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
}

// A real workspace has hundreds of member files (skills, missions, months of
// old logs). The scanner used to stop walking after 220 files, so this week's
// member logs were silently skipped and repeat problems counted as zero.
test('auto-improver scan reads recent member logs even when old team files pile up', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-scan-coverage-'));
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'auto-improver', '--description="Finds problems before they grow"'], dir).status, 0);

    const busyLogs = path.join(dir, 'atris', 'team', 'zz-archivist', 'logs');
    fs.mkdirSync(busyLogs, { recursive: true });
    for (let i = 0; i < 300; i += 1) {
      fs.writeFileSync(path.join(busyLogs, `2025-01-${String(i).padStart(3, '0')}-old.md`), '# old\n', 'utf8');
    }

    const recentLogs = path.join(dir, 'atris', 'team', 'builder', 'logs');
    fs.mkdirSync(recentLogs, { recursive: true });
    fs.writeFileSync(path.join(recentLogs, `${dateDaysAgo(1)}.md`), [
      '# builder log',
      '- ERROR worktree push rejected by stale lock',
      '- ERROR worktree push rejected by stale lock',
      '',
    ].join('\n'), 'utf8');

    const wake = runCli(['member', 'wake', 'auto-improver', '--json'], dir);
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const signals = JSON.parse(wake.stdout).auto_improver.scan.log_signals;
    const hit = signals.repeated_failures.find((failure) => /stale lock/.test(failure.pattern));
    assert.ok(hit, `recent member log was not scanned: ${JSON.stringify(signals)}`);
    assert.equal(hit.count, 2);
    assert.equal(hit.evidence[0].path, `atris/team/builder/logs/${dateDaysAgo(1)}.md`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
