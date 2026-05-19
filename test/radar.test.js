const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  agentTopPayload,
  agentTypeForCommand,
  collectRadar,
  parsePsOutput,
  parseWorktrees,
  renderAgentTop,
  renderRadar,
} = require('../commands/radar');

test('agentTypeForCommand detects supported coding agents', () => {
  assert.equal(agentTypeForCommand('/opt/codex/codex exec'), 'codex');
  assert.equal(agentTypeForCommand('claude -p run this'), 'claude');
  assert.equal(agentTypeForCommand('/usr/local/bin/opencode'), 'opencode');
  assert.equal(agentTypeForCommand('devin --workspace repo'), 'devin');
  assert.equal(agentTypeForCommand('node ./bin/atris.js radar'), null);
});

test('parsePsOutput handles ps lstart rows', () => {
  const rows = parsePsOutput('123 1 1.2 0.5 S Mon May 18 12:00:00 2026 /opt/codex/codex exec\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pid, '123');
  assert.equal(rows[0].ppid, '1');
  assert.equal(rows[0].command, '/opt/codex/codex exec');
});

test('parseWorktrees reads porcelain worktree output', () => {
  const rows = parseWorktrees([
    'worktree /repo',
    'HEAD abc',
    'branch refs/heads/main',
    '',
    'worktree /repo-wt',
    'HEAD def',
    'branch refs/heads/agent/test',
    '',
  ].join('\n'));
  assert.deepEqual(rows.map(row => [row.path, row.branch]), [['/repo', 'main'], ['/repo-wt', 'agent/test']]);
});

test('collectRadar joins live agents with task, mission, and worktree state', () => {
  const root = '/tmp/atris-radar';
  const otherRoot = '/tmp/other';
  const taskFile = path.join(root, '.atris', 'state', 'tasks.projection.json');
  const otherTaskFile = path.join(otherRoot, '.atris', 'state', 'tasks.projection.json');
  const missionFile = path.join(root, '.atris', 'state', 'missions.jsonl');
  const xpFile = path.join(root, '.atris', 'state', 'career_xp.projection.json');
  const receiptsFile = path.join(root, '.atris', 'state', 'career_xp_receipts.jsonl');
  const scorecardsFile = path.join(root, '.atris', 'state', 'scorecards.jsonl');
  const missionEventsFile = path.join(root, '.atris', 'state', 'mission_events.jsonl');
  const codexGoalFile = path.join(root, '.atris', 'state', 'codex_goal.json');
  const businessFile = path.join(root, '.atris', 'business.json');
  const runtimeFile = path.join(root, '.atris', 'state', 'runtime.json');
  const syncFile = path.join(root, '.atris', 'state', '_sync.json');
  const eventsFile = path.join(root, '.atris', 'state', 'events.jsonl');
  const episodesFile = path.join(root, '.atris', 'state', 'episodes.jsonl');
  const reportsDir = path.join(root, 'atris', 'reports');
  const ingestDir = path.join(root, 'atris', 'context', '_ingest');
  const briefsDir = path.join(root, 'atris', 'wiki', 'briefs');
  const conceptsDir = path.join(root, 'atris', 'wiki', 'concepts');
  const computersDir = path.join(root, 'atris', 'computers');
  const teamDir = path.join(root, 'atris', 'team');
  const memberFile = path.join(teamDir, 'mission-lead', 'MEMBER.md');
  const memberGoalsFile = path.join(teamDir, 'mission-lead', 'goals.json');
  const memberNowFile = path.join(teamDir, 'mission-lead', 'now.md');
  const files = new Map([
    [taskFile, JSON.stringify({
      tasks: [
        { display_id: 'CLI-95', title: 'Add live operator radar command', status: 'review', workspace_root: root, claimed_by: 'codex', metadata: { agent_review_pass_count: 1 } },
        { display_id: 'CLI-90', title: 'Old certified work', status: 'review', workspace_root: root, metadata: { agent_certified: true, assigned_to: 'mission-lead', delegate_via: 'swarlo', swarlo_channel: 'ops' } },
      ],
    })],
    [otherTaskFile, JSON.stringify({
      tasks: [
        { display_id: 'BCK-298', title: 'Backend old open task', status: 'open', workspace_root: otherRoot },
        { display_id: 'BCK-294', title: 'Backend lease safety', status: 'claimed', workspace_root: otherRoot, claimed_by: 'computer-lead' },
      ],
    })],
    [missionFile, `${JSON.stringify({
      id: 'mission-stale',
      status: 'running',
      verifier: '',
      last_tick_at: '2026-05-01T00:00:00.000Z',
      next_action: 'define verifier',
    })}\n`],
    [xpFile, JSON.stringify({ metric_label: 'AgentXP', total_agent_xp: 42, today_agent_xp: 5, level: 1, integrity_status: 'verified', leaderboard_eligible: true, generated_at: '2026-05-18T12:00:00.000Z' })],
    [receiptsFile, '{"receipt_id":"one"}\n{"receipt_id":"two"}\n'],
    [scorecardsFile, '{"type":"scorecard","reward":5,"next_task_suggestion":"Ship the next proof loop"}\n'],
    [missionEventsFile, '{"type":"mission_tick","at":"2026-05-18T12:00:00.000Z"}\n'],
    [codexGoalFile, JSON.stringify({ goal: { objective: 'Advance the mission loop', mission_id: 'mission-stale' } })],
    [businessFile, JSON.stringify({ business_id: 'biz-42', workspace_id: 'ws-42', name: 'Cashmere AI', slug: 'cashmere-ai', workspace_template: 'business' })],
    [runtimeFile, JSON.stringify({ scope: 'local-business-computer', install_status: 'local_cli_present', sync_status: 'templates_seeded' })],
    [syncFile, JSON.stringify({ workspace_slug: 'cashmere-ai', business_id: 'biz-42', workspace_id: 'ws-42', workspace_template: 'business' })],
    [eventsFile, '{"type":"report_recorded"}\n'],
    [episodesFile, '{"type":"episode"}\n'],
    [memberFile, '# Mission Lead\n'],
    [memberGoalsFile, JSON.stringify({ updated_at: '2026-05-18T12:00:00.000Z', goals: [{ status: 'active', title: 'Keep loops healthy' }] })],
    [memberNowFile, '# Now\n'],
  ]);
  const dirs = new Set([
    path.join(root, 'atris'),
    path.join(root, 'atris', 'context'),
    ingestDir,
    path.join(root, 'atris', 'wiki'),
    briefsDir,
    conceptsDir,
    reportsDir,
    computersDir,
    teamDir,
    path.join(teamDir, 'mission-lead'),
    path.join(root, '.atris', 'state', 'operator-scorecards'),
  ]);
  const psOutput = '110 1 0.1 0.2 S Mon May 18 12:00:00 2026 node /opt/homebrew/bin/codex\n'
    + '111 110 0.1 0.2 S Mon May 18 12:00:00 2026 /opt/codex/codex exec\n'
    + '222 1 2.5 0.2 S Mon May 18 12:01:00 2026 claude -p run\n'
    + '223 1 1.5 0.3 S Mon May 18 12:01:30 2026 codex exec backend\n'
    + '333 1 0.0 0.1 S Mon May 18 12:02:00 2026 devin --workspace none\n';
  const worktreeOutput = [
    `worktree ${root}`,
    'HEAD aaa',
    'branch refs/heads/master',
    '',
    'worktree /tmp/agent-radar',
    'HEAD bbb',
    'branch refs/heads/agent/radar',
    '',
  ].join('\n');

  function execFileSync(cmd, args) {
    if (cmd === 'ps') return psOutput;
    if (cmd === 'lsof') {
      const cwd = args[2] === '111' ? root : ['222', '223'].includes(args[2]) ? otherRoot : '/tmp/no-proj';
      return `p${args[2]}\nn${cwd}\n`;
    }
    if (cmd === 'git' && args[1] === root && args[2] === 'worktree') return worktreeOutput;
    if (cmd === 'git' && args[2] === 'branch') return args[1] === root ? 'master\n' : 'other\n';
    if (cmd === 'git' && args[2] === 'status') return args[1] === root ? ' M bin/atris.js\n' : '';
    throw new Error(`unexpected command ${cmd} ${args.join(' ')}`);
  }

  const data = collectRadar({
    root,
    platform: 'darwin',
    nowMs: Date.parse('2026-05-18T12:00:00.000Z'),
    execFileSync,
    existsSync: file => files.has(file) || dirs.has(file) || ['MAP.md', 'TODO.md', 'PERSONA.md'].some(name => file === path.join(root, 'atris', name)),
    readFileSync: file => files.get(file),
    readdirSync: dir => {
      if (dir === teamDir) return ['mission-lead'];
      if (dir === path.join(root, '.atris', 'state', 'operator-scorecards')) return ['keshav.json'];
      if (dir === ingestDir) return ['2026-05-18-onboarding'];
      if (dir === briefsDir) return ['cashmere-ai-starter-brief.md'];
      if (dir === conceptsDir) return ['cashmere-ai-first-loop.md'];
      if (dir === reportsDir) return ['2026-05-18-cashmere-ai-operator-one-pager.md'];
      if (dir === computersDir) return ['default'];
      return [];
    },
  });

  assert.equal(data.summary.agents.total, 4);
  assert.equal(data.summary.tasks.claimed, 0);
  assert.equal(data.summary.tasks.certifiedReview, 1);
  assert.equal(data.summary.missions.stale, 1);
  assert.equal(data.summary.worktrees.dirty, 1);
  assert.equal(data.os.xp.total, 42);
  assert.equal(data.os.xp.receipts, 2);
  assert.equal(data.os.team.total, 1);
  assert.equal(data.os.team.active_goal_members, 1);
  assert.equal(data.os.brain.scorecards, 1);
  assert.equal(data.os.swarlo.swarlo_leases, 1);
  assert.equal(data.os.loop.ticks, 1);
  assert.equal(data.os.loop.codex_goal, 'Advance the mission loop');
  assert.equal(data.os.business.slug, 'cashmere-ai');
  assert.equal(data.os.business.share_ready, true);
  assert.equal(data.os.business.onboarding.packs, 1);
  assert.equal(data.os.business.onboarding.starter_briefs, 1);
  assert.equal(data.os.business.onboarding.first_loops, 1);
  assert.equal(data.os.business.proof.scorecards, 1);
  assert.equal(data.os.business.proof.events, 1);
  assert.equal(data.os.business.computers, 1);
  assert.equal(data.agents[0].task, 'CLI-95');
  assert.equal(data.agents[1].task, 'BCK-294');
  assert.equal(data.agents[1].task_workspace, 'tmp/other');
  assert.equal(data.agents[2].task, 'BCK-294');
  const untaskedAgent = data.agents.find(agent => agent.task === '-');
  assert.equal(untaskedAgent.task_reason, 'no task projection');
  assert.equal(untaskedAgent.task_action, 'inspect /tmp/no-proj for missing Atris task plane or close pid 333 if idle');
  assert.match(data.next_action, /review CLI-95/);
  assert.match(renderRadar(data), /Operator radar/);
  assert.match(renderRadar(data), /CLI-95/);
  assert.match(renderRadar(data), /Stale mission candidates/);
  assert.match(renderRadar(data), /Review queue/);
  assert.match(renderRadar(data), /Dirty worktrees/);
  assert.match(renderRadar(data), /OS: AgentXP 42 L1/);
  assert.match(renderRadar(data), /business cashmere-ai share-ready/);
  assert.match(renderRadar(data), /Team goals/);
  assert.match(renderRadar(data), /Delegation\/Swarlo/);
  assert.match(renderRadar(data), /Business: Cashmere AI \(cashmere-ai\)/);
  assert.match(renderRadar(data), /Business ready: yes; team 1\/1 active-goal; onboarding 1 packs\/1 briefs\/1 loops; proof 1 scorecards\/1 events; computers 1/);
  assert.match(renderRadar(data), /AgentXP: 42 total, 5 today, 2 receipts/);
  assert.match(renderRadar(data), /Codex goal: Advance the mission loop/);
  const top = renderAgentTop(data);
  assert.match(top, /Agent process top/);
  assert.match(top, /CPU/);
  assert.match(top, /MEM/);
  assert.match(top, /CLI-95/);
  assert.match(top, /BCK-294/);
  assert.match(top, /1 untasked/);
  assert.match(top, /Next: close or hand off 1 session still bound to review task CLI-95/);
  assert.match(top, /Untasked: 1 sessions \(1 no task projection\)/);
  assert.match(top, /333 .*no task projection -> inspect \/tmp\/no-proj for missing Atris task plane or close pid 333 if idle/);
  assert.match(top, /Task load: 1 pileup, 1 review-bound task/);
  assert.match(top, /BCK-294: 2 sessions, 4\.0% CPU, claimed, tmp\/other/);
  assert.match(top, /CLI-95: 1 sessions, 0\.1% CPU, review, tmp\/atris-radar/);
  assert.ok(top.indexOf('222') < top.indexOf('111'), 'higher CPU agent should sort first');
  const payload = agentTopPayload(data);
  assert.equal(payload.summary.task_pileups, 1);
  assert.equal(payload.summary.review_bound_tasks, 1);
  assert.deepEqual(payload.task_load.map(row => [row.task, row.sessions, row.attention]).slice(0, 2), [
    ['BCK-294', 2, true],
    ['CLI-95', 1, true],
  ]);
  assert.match(payload.next_action, /close or hand off 1 session still bound to review task CLI-95/);
});

test('renderAgentTop explains workspaces with no active task', () => {
  const data = {
    root: '/tmp/root',
    generated_at: '2026-05-19T00:00:00.000Z',
    next_action: 'fallback',
    agents: [
      {
        pid: '44',
        agent: 'codex',
        status: 'active',
        cwd: '/tmp/web',
        repo: 'tmp/web',
        branch: 'main',
        cpu: 0,
        mem: 0,
        task: '-',
        task_status: null,
        owner: '-',
        task_workspace: 'tmp/web',
        task_reason: 'no active task',
        task_action: "cd '/tmp/web' && atris task next --as codex",
      },
    ],
  };
  const top = renderAgentTop(data);
  assert.match(top, /Next: resolve 1 untasked session: 1 no active task/);
  assert.match(top, /44 tmp\/web: no active task -> cd '\/tmp\/web' && atris task next --as codex/);
});

test('renderAgentTop prioritizes pileups before untasked cleanup', () => {
  const data = {
    root: '/tmp/root',
    generated_at: '2026-05-19T00:00:00.000Z',
    next_action: 'fallback',
    agents: [
      { pid: '1', agent: 'codex', status: 'active', repo: 'tmp/app', branch: 'main', cpu: 2, mem: 0.1, task: 'APP-1', task_status: 'claimed', owner: 'codex' },
      { pid: '2', agent: 'claude', status: 'active', repo: 'tmp/app', branch: 'main', cpu: 3, mem: 0.2, task: 'APP-1', task_status: 'claimed', owner: 'claude' },
      { pid: '3', agent: 'codex', status: 'active', repo: 'tmp/loose', branch: 'main', cpu: 1, mem: 0.1, task: '-', task_reason: 'no active task', task_action: "cd '/tmp/loose' && atris task next --as codex" },
    ],
  };
  const top = renderAgentTop(data);
  assert.match(top, /Next: inspect 2 sessions on APP-1 \(5\.0% CPU\)/);
  assert.match(top, /Untasked: 1 sessions \(1 no active task\)/);
  assert.match(top, /Task load: 1 pileup, 0 review-bound tasks/);
});
