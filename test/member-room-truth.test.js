'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BIN = path.resolve(__dirname, '..', 'bin', 'atris.js');

function runCli(args, cwd) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
}

function writeMember(root, slug, role, description) {
  const dir = path.join(root, 'atris', 'team', slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'MEMBER.md'),
    [
      '---',
      `name: ${slug}`,
      `role: ${role}`,
      `description: ${description}`,
      'version: 1.0.0',
      'skills:',
      '  - verification',
      '---',
      '',
      '## Persona',
      description,
      '',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'MISSION.md'),
    `# Mission\n\n## North Star\n${description}\n`,
    'utf8',
  );
}

test('member room shows real roster engines, all 5 members (busy first, rest one line), no empty commit id, no stdin noise, and plain headings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-room-truth-'));
  try {
    fs.mkdirSync(path.join(root, 'atris', 'team'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'atris', 'ROSTER.md'),
      [
        '# roster',
        '',
        '## build',
        '- codex, model: gpt-6.1-sol',
        '',
        '## review',
        '- claude code, model: fable 5.1',
        '',
        '## team',
        '- release-sentinel: claude code, model: opus 5.5',
        '',
      ].join('\n'),
      'utf8',
    );

    // 5 members: 2 in the legacy core list (validator, architect) and 3 project members.
    writeMember(root, 'validator', 'Review Desk', 'Keep every landing honest.');
    writeMember(root, 'architect', 'Architecture Runner', 'Keep the system design coherent.');
    writeMember(root, 'browser-dev', 'Browser Surface Developer', 'Make browser tabs reliable.');
    writeMember(root, 'health-sentinel', 'App Health', 'Keep morning health checks green.');
    writeMember(root, 'release-sentinel', 'Release Sentinel', 'Keep release archives complete.');

    // Busy member 1: architect has a real finding followed by codex stdin startup noise.
    const architectLogs = path.join(root, 'atris', 'team', 'architect', 'logs');
    fs.mkdirSync(architectLogs, { recursive: true });
    fs.writeFileSync(
      path.join(architectLogs, '2026-10-14.md'),
      [
        '# 2026-10-14',
        '',
        '## 10:15 · System check',
        '- summary: Recovered the release-handoff proposal; patch and context checks passed. Pushed `a1b2c3d4e`.',
        '- verifier: passed',
        '- next_push: Apply the overlay after approval.',
        '',
        '## 11:00 · Follow-up tick',
        '- summary: Reading additional input from stdin...',
        '- verifier: not_run',
        '',
      ].join('\n'),
      'utf8',
    );

    // Busy member 2: health-sentinel has a log line with "committed and pushed as `62d3d7341`."
    const healthLogs = path.join(root, 'atris', 'team', 'health-sentinel', 'logs');
    fs.mkdirSync(healthLogs, { recursive: true });
    fs.writeFileSync(
      path.join(healthLogs, '2026-10-14.md'),
      [
        '# 2026-10-14',
        '',
        '## 12:30 · Design check',
        '- summary: Recorded the failed design check: 368 files checked, 1 critical finding, exit 1. Evidence committed and pushed as `62d3d7341`.',
        '- verifier: failed',
        '- next_push: Resolve the critical design finding.',
        '',
      ].join('\n'),
      'utf8',
    );

    const jsonRes = runCli(['member', 'room', '--json'], root);
    assert.equal(jsonRes.status, 0, jsonRes.stderr || jsonRes.stdout);
    const payload = JSON.parse(jsonRes.stdout);
    assert.equal(payload.standup.length, 5, 'all 5 members should be in the standup');

    const byMember = Object.fromEntries(payload.standup.map((s) => [s.member, s]));
    assert.equal(byMember.validator.engine, 'claude');
    assert.equal(byMember.architect.engine, 'codex');
    assert.equal(byMember['browser-dev'].engine, 'codex');
    assert.equal(byMember['health-sentinel'].engine, 'codex');
    assert.equal(byMember['release-sentinel'].engine, 'claude');

    const res = runCli(['member', 'room'], root);
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const out = res.stdout;

    // Headline names both engines from the roster, not just claude.
    assert.match(out, /Your team runs on codex and claude\.|Your team runs on claude and codex\./);

    // Every member is shown with its real engine.
    assert.match(out, /ARCHITECT \(Architecture Runner\) · active · engine:codex/);
    assert.match(out, /HEALTH-SENTINEL \(App Health\) · active · engine:codex/);
    assert.match(out, /validator \(Review Desk\) · idle · engine:claude/);
    assert.match(out, /browser-dev \(Browser Surface Developer\) · idle · engine:codex/);
    assert.match(out, /release-sentinel \(Release Sentinel\) · idle · engine:claude/);

    // Busy members come first (boxed), then idle members one line each.
    const archIdx = out.indexOf('ARCHITECT (Architecture Runner)');
    const healthIdx = out.indexOf('HEALTH-SENTINEL (App Health)');
    const valIdx = out.indexOf('validator (Review Desk) · idle · engine:claude');
    const browserIdx = out.indexOf('browser-dev (Browser Surface Developer) · idle · engine:codex');
    const releaseIdx = out.indexOf('release-sentinel (Release Sentinel) · idle · engine:claude');
    assert.ok(archIdx > 0 && healthIdx > 0);
    assert.ok(archIdx < valIdx && healthIdx < valIdx, 'busy members must appear before idle members');
    assert.ok(archIdx < browserIdx && healthIdx < releaseIdx);

    const idleMatchingLines = out
      .split('\n')
      .filter((line) => /\b(validator|browser-dev|release-sentinel)\b.*· idle · engine:/.test(line));
    assert.equal(idleMatchingLines.length, 3, 'idle members render one line each');

    // No empty-id clause ("as ``") and no leftover stdin noise.
    assert.doesNotMatch(out, /as ``/);
    assert.doesNotMatch(out, /``/);
    assert.match(out, /Evidence committed and pushed\./);
    assert.doesNotMatch(out, /Reading additional input from stdin/i);
    assert.match(out, /Recovered the release-handoff proposal; patch and context checks passed\. Pushed\./);

    // Plain-word headings replace the old jargon headings.
    assert.match(out, /Who is handing work to whom/);
    assert.match(out, /What happened lately:/);
    assert.doesNotMatch(out, /Live Consequence Feed/);
    assert.doesNotMatch(out, /Handoffs & Baton Passes/);
    assert.doesNotMatch(out, /baton passes/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
