'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-fleet-'));
}

// Copy the tracked member files into a throwaway folder so live runtime
// state (goals.json, logs, missions) in the repo or in a parent checkout
// cannot change what go, card, or day return.
const MEMBER_RUNTIME_FILES = new Set(['goals.json', 'goals.md', 'now.md', 'logs']);
function makeTeamWorkspace() {
  const root = makeTempWorkspace();
  fs.cpSync(path.join(repoRoot, 'atris', 'team'), path.join(root, 'atris', 'team'), {
    recursive: true,
    filter: (src) => !MEMBER_RUNTIME_FILES.has(path.basename(src)),
  });
  return root;
}

function runCli(args, cwd) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...scrubAgentEnv(),
      ATRIS_SKIP_UPDATE_CHECK: '1',
    },
  });
  if (result.error) throw result.error;
  return result;
}

function writeMember(root, name) {
  const dir = path.join(root, 'atris', 'team', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'MEMBER.md'), [
    '---',
    `name: ${name}`,
    'role: Test Member',
    '---',
    '',
    `# ${name}`,
    '',
  ].join('\n'), 'utf8');
  return dir;
}

function writeGoal(root, name) {
  const dir = path.join(root, 'atris', 'team', name);
  fs.writeFileSync(path.join(dir, 'goals.json'), JSON.stringify({
    schema: 'atris.member_goals.v1',
    member: name,
    goals: [
      {
        id: `goal-${name}`,
        title: `Goal for ${name}`,
        status: 'active',
        experiments: [],
      },
    ],
  }, null, 2));
}

function isoAgo(ms) {
  return new Date(Date.now() - ms).toISOString();
}

function writeMissions(root, missions) {
  const stateDir = path.join(root, '.atris', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'missions.jsonl'),
    missions.map((mission) => JSON.stringify(mission)).join('\n') + '\n',
    'utf8',
  );
}

test('member status --all merges goal, mission, and activity planes', () => {
  const root = makeTempWorkspace();
  try {
    writeMember(root, 'live-empty-goal');
    writeMember(root, 'goal-recent');
    writeMember(root, 'captain');
    writeMember(root, '_archive');
    writeGoal(root, 'goal-recent');
    writeMissions(root, [
      {
        id: 'mission-live-empty-goal',
        slug: 'mission-live-empty-goal',
        owner: 'live-empty-goal',
        status: 'running',
        last_tick_at: isoAgo(60 * 60 * 1000),
        updated_at: isoAgo(60 * 60 * 1000),
      },
      {
        id: 'mission-goal-recent',
        slug: 'mission-goal-recent',
        owner: 'goal-recent',
        status: 'complete',
        last_tick_at: isoAgo(30 * 60 * 60 * 1000),
        updated_at: isoAgo(30 * 60 * 60 * 1000),
      },
    ]);
    const runsDir = path.join(root, 'atris', 'runs');
    fs.mkdirSync(runsDir, { recursive: true });
    const recentRun = path.join(runsDir, 'member-loop-goal-recent-proof.json');
    fs.writeFileSync(recentRun, '{}\n', 'utf8');
    const recent = new Date(Date.now() - 30 * 60 * 60 * 1000);
    fs.utimesSync(recentRun, recent, recent);

    const result = runCli(['member', 'status', '--all'], root);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Member fleet status/);
    assert.match(result.stdout, /^live-empty-goal\s+no_goal\s+mission-live-empty-goal\s+running\s+\S+\s+\S+\s+ACTIVE/m);
    assert.match(result.stdout, /^goal-recent\s+ready\s+mission-goal-recent\s+complete\s+\S+\s+\S+\s+RECENT/m);
    assert.match(result.stdout, /^captain\s+no_goal\s+-\s+-\s+-\s+-\s+IDLE/m);
    assert.doesNotMatch(result.stdout, /_archive/);

    const single = runCli(['member', 'status', 'live-empty-goal'], root);
    assert.equal(single.status, 0, single.stderr || single.stdout);
    assert.match(single.stdout, /mission {3}mission-live-empty-goal \(running, last tick \S+\)/);
    assert.match(single.stdout, /live-empty-goal .*active, last activity/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('member alive --all skips members with no goal and no active mission while previewing cron lines', () => {
  const root = makeTempWorkspace();
  try {
    writeMember(root, 'live-empty-goal');
    writeMember(root, 'goal-member');
    writeMember(root, 'idle-member');
    writeMember(root, 'stopped-member');
    writeGoal(root, 'goal-member');
    writeMissions(root, [
      {
        id: 'mission-live-empty-goal',
        slug: 'mission-live-empty-goal',
        owner: 'live-empty-goal',
        status: 'running',
        last_tick_at: isoAgo(60 * 60 * 1000),
        updated_at: isoAgo(60 * 60 * 1000),
      },
      {
        id: 'mission-stopped-member',
        slug: 'mission-stopped-member',
        owner: 'stopped-member',
        status: 'stopped',
        last_tick_at: isoAgo(60 * 60 * 1000),
        updated_at: isoAgo(60 * 60 * 1000),
      },
    ]);

    const result = runCli(['member', 'alive', '--all', '--install', '--hourly', '--forever', '--dry-run'], root);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Activate goal-member: goal/);
    assert.match(result.stdout, /Activate live-empty-goal: mission mission-live-empty-goal/);
    assert.match(result.stdout, /Skip idle-member: no goal and no active mission\./);
    assert.match(result.stdout, /Skip stopped-member: no goal and no active mission\./);
    assert.match(result.stdout, /Would install hourly alive loop: goal-member/);
    assert.match(result.stdout, /Cron: .*ATRIS_MEMBER_ALIVE_GOAL_MEMBER/);
    assert.match(result.stdout, /Cron: .*ATRIS_MEMBER_ALIVE_LIVE_EMPTY_GOAL/);
    assert.match(result.stdout, /Summary: 2 activated, 2 skipped \(no_goal_and_no_active_mission x2\)\./);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('member run --ignite executes in isolated worktree and member status --all --json exposes worktree fleet HUD fields', () => {
  const base = makeTempWorkspace();
  const root = path.join(base, 'repo');
  const binDir = path.join(base, 'bin');
  try {
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    const fakeCodex = path.join(binDir, 'codex');
    fs.writeFileSync(
      fakeCodex,
      '#!/bin/sh\nprintf "%s\\n" "$2" > ignited-prompt.txt\necho "codex completed subagent shell tick"\n',
      'utf8'
    );
    fs.chmodSync(fakeCodex, 0o755);

    const git = (args, cwd = root) => {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr || r.stdout);
      return r.stdout.trim();
    };
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test User']);
    writeMember(root, 'navigator');
    fs.writeFileSync(
      path.join(root, 'atris', 'team', 'navigator', 'SOUL.md'),
      '# SOUL.md\n\nSteer the fleet with calm precision.\n',
      'utf8'
    );
    git(['add', '.']);
    git(['commit', '-qm', 'baseline']);

    const runRes = spawnSync(
      process.execPath,
      [
        cliPath,
        'member',
        'run',
        'navigator',
        'Prove subagent shell ignition',
        '--engine',
        'codex',
        '--ignite',
        // This proves the worktree and status view, not the review; skip the
        // default second-engine review so no real engine starts.
        '--no-referee',
        '--verify',
        'test -s ignited-prompt.txt',
        '--json',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 30000,
        env: {
          ...process.env,
          ATRIS_SKIP_UPDATE_CHECK: '1',
          PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
        },
      }
    );
    assert.equal(runRes.status, 0, runRes.stderr || runRes.stdout);
    const runPayload = JSON.parse(runRes.stdout);
    assert.equal(runPayload.ok, true);
    assert.equal(runPayload.mission.status, 'complete');
    assert.equal(runPayload.started_mission.owner, 'navigator');
    assert.equal(runPayload.started_mission.runner, 'codex');
    assert.ok(runPayload.worktree?.path, 'ignited member run should execute inside its isolated worktree');

    const receivedPrompt = fs.readFileSync(path.join(runPayload.worktree.path, 'ignited-prompt.txt'), 'utf8');
    assert.match(receivedPrompt, /## Preloaded Member & Task Context/);
    assert.match(receivedPrompt, /Steer the fleet with calm precision\./);

    const fleetRes = runCli(['member', 'status', '--all', '--json'], root);
    assert.equal(fleetRes.status, 0, fleetRes.stderr || fleetRes.stdout);
    const fleetPayload = JSON.parse(fleetRes.stdout);
    assert.equal(fleetPayload.action, 'status_all');
    const nav = fleetPayload.members.find((m) => m.member === 'navigator');
    assert.ok(nav, 'navigator should appear in fleet status');
    assert.ok(nav.mission, 'navigator worktree mission should roll up into fleet status');
    assert.equal(nav.mission.id, runPayload.mission.id);
    assert.equal(nav.mission.state, 'complete');
    assert.equal(nav.mission.runner, 'codex');
    assert.ok(nav.mission.worktree_root, 'worktree_root should be exposed for HUD interfaces');
    assert.ok(nav.mission.driver && typeof nav.mission.driver.alive === 'boolean', 'driver health should be exposed for HUD interfaces');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('member run infers test checks from goal text and runs a second-model referee after the check passes', () => {
  const { inferMemberRunVerifier, buildMemberRunStartArgs } = require('../commands/member');
  const { pickCrossEngineVerifier } = require('../commands/mission');

  // Verifier inference and engine lookup read and seed state under the root
  // they are given, so point them at scratch instead of the live repo.
  const base = makeTempWorkspace();
  fs.mkdirSync(path.join(base, 'test'), { recursive: true });
  fs.writeFileSync(path.join(base, 'test', 'member-fleet.test.js'), '', 'utf8');
  assert.equal(
    inferMemberRunVerifier('Fix regression in test/member-fleet.test.js', [], base),
    'node --test test/member-fleet.test.js'
  );
  const startArgs = buildMemberRunStartArgs('navigator', 'Fix regression in test/member-fleet.test.js', [], base);
  assert.ok(startArgs.includes('--verify'));
  assert.ok(startArgs.includes('node --test test/member-fleet.test.js'));
  assert.ok(!startArgs.includes('--no-verify'));

  assert.equal(pickCrossEngineVerifier({ runner: 'claude' }, base), 'codex');
  assert.equal(pickCrossEngineVerifier({ runner: 'codex' }, base), 'claude');

  const root = path.join(base, 'repo');
  const binDir = path.join(base, 'bin');
  try {
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    const fakeCodex = path.join(binDir, 'codex');
    fs.writeFileSync(
      fakeCodex,
      '#!/bin/sh\necho "worker touched artifact" > work.txt\necho "Wrote work.txt with the worker artifact."\necho "next_push: Add automated speed check for work.txt"\necho "VERDICT: PASS"\n',
      'utf8'
    );
    fs.chmodSync(fakeCodex, 0o755);

    const git = (args, cwd = root) => {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr || r.stdout);
      return r.stdout.trim();
    };
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test User']);
    writeMember(root, 'navigator');
    git(['add', '.']);
    git(['commit', '-qm', 'baseline']);

    const res = spawnSync(
      process.execPath,
      [
        cliPath,
        'member',
        'run',
        'navigator',
        'Build work.txt and verify with referee',
        '--engine',
        'codex',
        '--referee',
        '--referee-engine',
        'codex',
        '--ignite',
        '--verify',
        'test -s work.txt',
        '--json',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 30000,
        env: {
          ...process.env,
          ATRIS_SKIP_UPDATE_CHECK: '1',
          PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
        },
      }
    );
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.mission.status, 'complete');
    assert.equal(payload.ticks[0].verifier_passed, true);
    assert.equal(payload.ticks[0].next_push, 'Add automated speed check for work.txt');
    assert.ok(payload.ticks[0].referee_result, 'second-model referee result should be recorded on the tick');
    assert.equal(payload.ticks[0].referee_result.passed, true);
    assert.equal(payload.ticks[0].referee_result.mode, 'engine');

    const parentLogsDir = path.join(root, 'atris', 'team', 'navigator', 'logs');
    assert.ok(fs.existsSync(parentLogsDir), 'worktree run should persist member logs back to parent workspace');
    const logFiles = fs.readdirSync(parentLogsDir).filter((f) => f.endsWith('.md'));
    assert.ok(logFiles.length > 0, 'parent member logs dir should contain dated log');

    const autoSkillPath = path.join(root, 'atris', 'team', 'navigator', 'skills', 'auto-learned', 'SKILL.md');
    assert.ok(fs.existsSync(autoSkillPath), 'verified tick should crystallize lesson into skills/auto-learned/SKILL.md');
    const autoSkillText = fs.readFileSync(autoSkillPath, 'utf8');
    assert.match(autoSkillText, /Add automated speed check for work\.txt/);

    const goalsPath = path.join(root, 'atris', 'team', 'navigator', 'goals.json');
    assert.ok(fs.existsSync(goalsPath), 'verified tick with next_push should queue next_push into member goals.json');
    const goalsStore = JSON.parse(fs.readFileSync(goalsPath, 'utf8'));
    assert.equal(goalsStore.goals[0].next_push, 'Add automated speed check for work.txt');

    const { loadRouterHistory } = require('../lib/router-brain');
    const routerObs = loadRouterHistory(root);
    assert.ok(
      routerObs.some((obs) => obs.engine === 'codex' && obs.verified_passed === true),
      'Moneyball router should receive verified_passed observation from worktree mission tick'
    );

    const feedRes = runCli(['member', 'feed'], root);
    assert.equal(feedRes.status, 0, feedRes.stderr || feedRes.stdout);
    assert.match(feedRes.stdout, /Team work feed/);
    assert.match(feedRes.stdout, /navigator: Wrote work\.txt with the worker artifact\./);
    assert.match(feedRes.stdout, /checked: its check passed · next: Add automated speed check for work\.txt/);

    // Start a live mission on navigator, steer it mid-run with natural `atris member "prompt"`, then put it to sleep
    writeMissions(root, [{
      id: 'mission-2026-10-13-live-nav',
      owner: 'navigator',
      objective: 'Keep mapping the repo',
      status: 'running',
      runner: 'codex',
      verifier: 'true',
      created_at: '2026-10-13T16:50:00.000Z',
      updated_at: '2026-10-13T16:55:00.000Z',
    }]);

    const steerRes = runCli(['member', 'navigator', 'Focus on speed bottlenecks first', '--json'], root);
    assert.equal(steerRes.status, 0, steerRes.stderr || steerRes.stdout);
    const steerPayload = JSON.parse(steerRes.stdout);
    assert.equal(steerPayload.action, 'member_steered');
    assert.equal(steerPayload.mode, 'steered_live');
    assert.equal(steerPayload.member, 'navigator');

    const sleepRes = runCli(['member', 'sleep', 'navigator', '--json'], root);
    assert.equal(sleepRes.status, 0, sleepRes.stderr || sleepRes.stdout);
    const sleepPayload = JSON.parse(sleepRes.stdout);
    assert.equal(sleepPayload.action, 'member_sleep');
    assert.equal(sleepPayload.slept_count, 1);

    writeMember(root, 'executor', {
      goalTitle: 'Execute slices',
      northStar: 'Ship clean diffs.',
    });
    const handoffRes = runCli(['member', 'handoff', 'navigator', 'executor', 'Build speed check for work.txt', '--json'], root);
    assert.equal(handoffRes.status, 0, handoffRes.stderr || handoffRes.stdout);
    const handoffPayload = JSON.parse(handoffRes.stdout);
    assert.equal(handoffPayload.action, 'member_handoff');
    assert.equal(handoffPayload.handoff.from, 'navigator');
    assert.equal(handoffPayload.handoff.to, 'executor');
    assert.match(handoffPayload.handoff.summary, /Build speed check for work\.txt/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('member dispatch prefers the core team over an experiment member unless the idea names it', () => {
  const { pickMemberForIdea } = require('../commands/member');
  const root = makeTempWorkspace();
  try {
    writeMember(root, 'executor');
    fs.writeFileSync(path.join(root, 'atris', 'team', 'executor', 'MISSION.md'), 'Build and test concrete product changes.\n');
    // The experiment member's mission happens to share many words with the idea,
    // which is how a scoreboard fix landed on opus-overnight.
    const experimentDir = writeMember(root, 'opus-overnight');
    fs.writeFileSync(path.join(experimentDir, 'MISSION.md'), [
      'Run the overnight mission loop: count commits today on every branch,',
      'fix the scoreboard repo line, check the remote default branch, the current',
      'checkout, local branches, and json output, add a test, dedupe by hash.',
    ].join('\n'));

    const idea = "Fix the 'atris scoreboard' repo line: it counts only commits on the current branch. "
      + 'Count today\'s commits across every local and remote branch, deduped by hash, same for json. Add a test.';
    const buildPick = pickMemberForIdea(idea, root);
    assert.equal(buildPick.member, 'executor');

    const namedPick = pickMemberForIdea('Have opus-overnight rerun the scoreboard check tonight', root);
    assert.equal(namedPick.member, 'opus-overnight');
    assert.equal(namedPick.reason, 'named in the idea');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('member dispatch, natural prompt, go, card, and room unite members, skills, and engines', () => {
  const { pickMemberForIdea } = require('../commands/member');
  const root = makeTeamWorkspace();
  try {
    const fixPick = pickMemberForIdea('Fix repeat broken test error in member check', root);
    assert.equal(fixPick.member, 'auto-improver');

    const reviewPick = pickMemberForIdea('Audit and review diff quality for slop', root);
    assert.equal(reviewPick.member, 'validator');

    const buildPick = pickMemberForIdea('Build and wire the new timeline export feature', root);
    assert.equal(buildPick.member, 'executor');

    const dryRun = runCli(['member', 'dispatch', 'Fix repeat broken test error in member check', '--dry-run', '--json'], root);
    assert.equal(dryRun.status, 0, dryRun.stderr || dryRun.stdout);
    const parsed = JSON.parse(dryRun.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.member, 'auto-improver');
    assert.match(parsed.command, /atris member run auto-improver/);

    const goDryRun = runCli(['member', 'go', '--dry-run', '--json'], root);
    assert.equal(goDryRun.status, 0, goDryRun.stderr || goDryRun.stdout);
    const goPayload = JSON.parse(goDryRun.stdout);
    assert.equal(goPayload.ok, true);
    assert.ok(goPayload.engine);
    assert.ok(goPayload.prompt);

    const cardRes = runCli(['member', 'card', 'auto-improver', '--json'], root);
    assert.equal(cardRes.status, 0, cardRes.stderr || cardRes.stdout);
    const cardPayload = JSON.parse(cardRes.stdout);
    assert.equal(cardPayload.ok, true);
    assert.equal(cardPayload.card.member, 'auto-improver');
    assert.equal(cardPayload.card.version, '2.0.0');
    assert.ok(cardPayload.card.skills.includes('repeat-error-surgeon'));
    assert.ok(cardPayload.card.roadmap.active_goal);
    assert.ok(cardPayload.card.engine_seat && cardPayload.card.engine_seat.engine_id);
    assert.ok(cardPayload.card.actions && cardPayload.card.actions.go);
    assert.ok(cardPayload.card.impact_chain && cardPayload.card.impact_chain.arrow.includes('->'));
    assert.ok(cardPayload.card.next_push);

    const roomRes = runCli(['member', 'day', '--json'], root);
    assert.equal(roomRes.status, 0, roomRes.stderr || roomRes.stdout);
    const roomPayload = JSON.parse(roomRes.stdout);
    assert.equal(roomPayload.ok, true);
    assert.equal(roomPayload.schema, 'atris.member.room.v1');
    assert.equal(roomPayload.utopia.percent, 100);
    assert.ok(Array.isArray(roomPayload.members) && roomPayload.members.length >= 7);
    assert.ok(Array.isArray(roomPayload.standup) && roomPayload.standup.length >= 7);
    assert.ok(Array.isArray(roomPayload.handoffs));
    assert.ok(Array.isArray(roomPayload.one_on_ones));
    assert.ok(Array.isArray(roomPayload.engines));
    assert.ok(roomPayload.controls && roomPayload.controls.go === 'atris member go');
    assert.ok(roomPayload.controls && roomPayload.controls.day === 'atris member day');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('member room text names only the engines this team uses and drops the loop jargon line', () => {
  const root = makeTeamWorkspace();
  try {
    const json = JSON.parse(runCli(['member', 'room', '--json'], root).stdout);
    const used = [...new Set(json.standup.map((s) => s.engine).filter((e) => e && e !== 'auto'))];

    const res = runCli(['member', 'room'], root);
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.doesNotMatch(res.stdout, /Loop: ACTION:/);
    assert.doesNotMatch(res.stdout, /Engines ready:/);
    const engineLine = res.stdout.split('\n')[1];
    assert.match(engineLine, /^Your team (runs on .+\.|picks an engine for each job\.)$/);
    for (const engine of used) assert.match(engineLine, new RegExp(`\\b${engine}\\b`));
    for (const unused of ['devin', 'grok', 'opencode', 'commandcode'].filter((e) => !used.includes(e))) {
      assert.doesNotMatch(engineLine, new RegExp(`\\b${unused}\\b`));
    }
    assert.match(res.stdout, /Member-by-Member Standup/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
