// Part 2 of 8 of the commands suite, split so node --test runs them in parallel.
// Shared imports and fixture helpers live in test/helpers/commands-fixtures.js.
const test = require('node:test');
const {
  assert,
  fs,
  path,
  http,
  spawn,
  buildManifest,
  computeLocalHashes,
  threeWayCompare,
  formatLocalDate,
  collectSnapshot,
  parseLiveOptions,
  shouldIgnore,
  snapshotsDiffer,
  analyzePushSafety,
  basenameOfManifestPath,
  buildCloudHashMap,
  buildPushChangePlan,
  isBusinessWorkspaceRoot,
  resolvePushSourceDir,
  shouldRetrySyncIndividually,
  buildBusinessSyncPlan,
  collectConflictResolutionEntries,
  parseBusinessSyncArgs,
  resolveLatestConflict,
  resolveBusinessSyncOptions,
  scrubAgentEnv,
  cliPath,
  makeTempDir,
  recentLogDate,
  recentLogYear,
  cleanupTempDir,
  runCli,
  seedSupervisorWakeFixture,
  runGit,
} = require('./helpers/commands-fixtures');

test('auto-improver repeated failure ties favor newest evidence', () => {
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, '.atris', 'tasks.db') };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'auto-improver', '--description="Finds problems before they grow"'], { cwd: dir, env }).status, 0);

    const oldLogsDir = path.join(dir, 'atris', 'logs', '2026');
    fs.mkdirSync(oldLogsDir, { recursive: true });
    fs.writeFileSync(path.join(oldLogsDir, '2026-05-07.md'), [
      '# old log',
      'ERROR recurring alpha failure',
      'ERROR recurring alpha failure',
      '',
    ].join('\n'), 'utf8');

    const recentLogsDir = path.join(dir, 'atris', 'team', 'mission-lead', 'logs');
    fs.mkdirSync(recentLogsDir, { recursive: true });
    const recentDate = recentLogDate();
    fs.writeFileSync(path.join(recentLogsDir, `${recentDate}.md`), [
      '# recent log',
      'ERROR recurring beta failure',
      'ERROR recurring beta failure',
      '',
    ].join('\n'), 'utf8');

    const wake = runCli(['member', 'wake', 'auto-improver', '--json'], { cwd: dir, env });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    // Old May alpha log is dropped by the recency filter; only beta survives.
    const failures = payload.auto_improver.scan.log_signals.repeated_failures;
    assert.equal(failures.length, 1);
    assert.match(failures[0].pattern, /beta/);
    assert.equal(failures[0].count, 2);
    assert.equal(failures[0].evidence[0].date, recentDate);
  } finally {
    cleanupTempDir(dir);
  }
});

test('auto-improver wake ignores its own summary log residue', () => {
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, '.atris', 'tasks.db') };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'auto-improver', '--description="Finds problems before they grow"'], { cwd: dir, env }).status, 0);

    const logsDir = path.join(dir, 'atris', 'team', 'auto-improver', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, `${recentLogDate()}.md`), [
      '# auto-improver log',
      ...Array.from({ length: 11 }, (_, index) => `- summary: CLI-275 adds auto-improver unclear log evidence ${index + 1}`),
      '',
    ].join('\n'), 'utf8');

    const wake = runCli(['member', 'wake', 'auto-improver', '--json'], { cwd: dir, env });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    const scan = payload.auto_improver.scan;
    assert.equal(scan.log_signals.unclear_next_action_count, 0);
    assert.deepEqual(scan.log_signals.unclear_next_actions, []);
    assert.deepEqual(scan.findings.filter((finding) => finding.source === 'unclear_next_actions'), []);
    assert.equal(payload.decision, 'scan_clean');
  } finally {
    cleanupTempDir(dir);
  }
});

test('auto-improver wake ignores blocked-to-ready receipt text', () => {
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, '.atris', 'tasks.db') };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'auto-improver', '--description="Finds problems before they grow"'], { cwd: dir, env }).status, 0);

    const logsDir = path.join(dir, 'atris', 'logs', recentLogYear());
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, `${recentLogDate()}.md`), [
      '# test log',
      ...Array.from({ length: 11 }, (_, index) => `inspected blocked→ready receipt pair ${index + 1}`),
      'blocked until owner chooses next step',
      '',
    ].join('\n'), 'utf8');

    const wake = runCli(['member', 'wake', 'auto-improver', '--json'], { cwd: dir, env });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    const scan = payload.auto_improver.scan;
    assert.equal(scan.log_signals.unclear_next_action_count, 1);
    assert.equal(scan.log_signals.unclear_next_actions.length, 1);
    assert.equal(scan.log_signals.unclear_next_actions[0].date, recentLogDate());
    assert.match(scan.log_signals.unclear_next_actions[0].text, /blocked until owner/);
    assert.deepEqual(scan.findings.filter((finding) => finding.source === 'unclear_next_actions'), []);
    assert.equal(payload.decision, 'scan_clean');
  } finally {
    cleanupTempDir(dir);
  }
});

test('auto-improver wake skips journal append on identical no-op repeat', () => {
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, '.atris', 'tasks.db') };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'auto-improver', '--description="Finds problems before they grow"'], { cwd: dir, env }).status, 0);

    // Fixture named on the same local clock the wake journal uses
    // (todayLogName in commands/member.js): UTC-yesterday equals local-today
    // for hours each evening behind UTC, which made the fixture share the
    // journal's filename and get filtered out of the scan below.
    const fixtureDate = new Date();
    // A local day can be 25 hours when daylight saving time ends.
    fixtureDate.setDate(fixtureDate.getDate() - 1);
    const fixtureLogName = `${formatLocalDate(fixtureDate)}.md`;
    const fixtureLogRel = path.join(String(fixtureDate.getFullYear()), fixtureLogName);
    const logsDir = path.join(dir, 'atris', 'logs', String(fixtureDate.getFullYear()));
    fs.mkdirSync(logsDir, { recursive: true });
    const pattern = 'ERROR rsi client expected /api/rsi/improve but backend exposed /api/rsi/tick';
    // Yesterday's date: inside the scanner's 7-day recency window, but distinct
    // from today's journal file where wake appends dogfood-scan entries.
    fs.writeFileSync(path.join(logsDir, fixtureLogName), [
      '# test log',
      `- ${pattern}`,
      `- ${pattern}`,
      `- ${pattern}`,
      '',
    ].join('\n'), 'utf8');

    const wakeOnce = () => {
      const wake = runCli(['member', 'wake', 'auto-improver', '--execute', '--confirm-autonomy-policy', '--json'], { cwd: dir, env });
      assert.equal(wake.status, 0, wake.stderr || wake.stdout);
      return JSON.parse(wake.stdout);
    };

    const first = wakeOnce();   // creates the task → journaled
    assert.equal(first.decision, 'task_created');
    const second = wakeOnce();  // existing actionable task, prevented 0 → journaled (state changed)
    const third = wakeOnce();   // identical no-op repeat → receipt yes, journal no
    assert.equal(third.decision, second.decision);
    assert.equal(third.journal_skipped, 'duplicate_noop');
    assert.equal(third.log_path, null);
    assert.ok(fs.existsSync(third.receipt_path), 'receipt must still be written on skipped journal');

    // Scan every year dir: at the year boundary the journal lands in the new
    // year's dir while yesterday's fixture stays in the old one.
    const logsRoot = path.join(dir, 'atris', 'logs');
    const projectLogs = fs.readdirSync(logsRoot).flatMap((entry) => {
      const entryPath = path.join(logsRoot, entry);
      if (!fs.statSync(entryPath).isDirectory()) {
        return entry.endsWith('.md') ? [entryPath] : [];
      }
      return fs.readdirSync(entryPath)
        .filter((f) => f.endsWith('.md') && path.join(entry, f) !== fixtureLogRel)
        .map((f) => path.join(entryPath, f));
    });
    const journalText = projectLogs
      .map((f) => fs.readFileSync(f, 'utf8'))
      .join('\n');
    const entryCount = (journalText.match(/## .* · Auto-improver dogfood scan/g) || []).length;
    assert.equal(entryCount, 2, `expected 2 journal entries (got ${entryCount}):\n${journalText}`);
  } finally {
    cleanupTempDir(dir);
  }
});

test('auto-improver wake ignores declared check verification lines (CLI-199)', () => {
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, '.atris', 'tasks.db') };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'auto-improver', '--description="Finds problems before they grow"'], { cwd: dir, env }).status, 0);

    // Wiki upkeep sweeps log one verification receipt per recompiled page.
    // These are success records — even when they contain failure-adjacent
    // words — and must never become recurring-failure candidates.
    const wikiDir = path.join(dir, 'atris', 'wiki');
    fs.mkdirSync(wikiDir, { recursive: true });
    const checkLine = '- check: `node bin/atris.js loop --dry-run --json` reports 0 failed pages instead of 13';
    fs.writeFileSync(path.join(wikiDir, 'log.md'), [
      '# wiki log',
      checkLine,
      checkLine,
      checkLine,
      checkLine,
      '',
    ].join('\n'), 'utf8');

    const wake = runCli(['member', 'wake', 'auto-improver', '--json'], { cwd: dir, env });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    const repeated = payload.auto_improver.scan.log_signals.repeated_failures || [];
    assert.deepEqual(
      repeated.filter((failure) => /loop --dry-run/.test(failure.pattern)),
      [],
      'check: verification lines must not count as repeated failures',
    );
  } finally {
    cleanupTempDir(dir);
  }
});

test('simple member alias reuses legacy problem-finding runtime', () => {
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, '.atris', 'tasks.db') };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'signal-scout', '--description="Turn repeated errors into bounded tasks"'], { cwd: dir, env }).status, 0);
    assert.equal(runCli(['member', 'goal-from-mission', 'problem-finder', '--json'], { cwd: dir, env }).status, 0);

    const logsDir = path.join(dir, 'atris', 'logs', '2026');
    fs.mkdirSync(logsDir, { recursive: true });
    const pattern = 'ERROR alias path failed before problem-finder could scan logs';
    fs.writeFileSync(path.join(logsDir, '2026-06-07.md'), [
      '# test log',
      `- ${pattern}`,
      `- ${pattern}`,
      `- ${pattern}`,
      '',
    ].join('\n'), 'utf8');

    const scriptPath = path.join(dir, 'scripts', 'scan-errors.mjs');
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, `
import { readFileSync } from 'node:fs';
import path from 'node:path';
const rootIndex = process.argv.indexOf('--root');
const root = rootIndex >= 0 ? process.argv[rootIndex + 1] : process.cwd();
const filePath = path.join(root, 'atris', 'logs', '2026', '2026-06-07.md');
const lines = readFileSync(filePath, 'utf8').split(/\\r?\\n/);
const matches = lines.map((line, index) => ({ line, index })).filter((row) => /error|failed|crashed/i.test(row.line));
const selected = { pattern: '${pattern}', count: matches.length, evidence: matches.map((row) => ({ path: 'atris/logs/2026/2026-06-07.md', line: row.index + 1, text: row.line })) };
console.log(JSON.stringify({ ok: true, schema: 'atris.error_scan.v1', threshold: 3, selected, scanned: { files: 1, lines: lines.length, matching_lines: matches.length } }));
`, 'utf8');

    const wake = runCli(['member', 'wake', 'problem-finder', '--execute', '--dry-run', '--json'], { cwd: dir, env });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.mode, 'dry_run');
    assert.equal(payload.decision, 'create_task');
    assert.equal(payload.reason, 'autonomous_error_discovery:log_error_scan');
    assert.match(payload.next_command, /atris task new 'Fix recurring error:/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('wiki-miner wake builds wiki graph and wiki graph queries read it', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'team', 'wiki-miner'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'wiki-miner', 'MEMBER.md'), [
      '---',
      'name: wiki-miner',
      'role: Knowledge Graph Builder',
      'description: Extracts entities and relationships from wiki using LLM',
      'skills: []',
      'permissions:',
      '  can-read: true',
      '  can-execute: true',
      '  can-approve: false',
      '---',
      '',
      '# Wiki Miner',
      '',
      'Extract entities and relationships from wiki pages.',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'wiki-miner', 'MISSION.md'), [
      '# Mission',
      '',
      '## North Star',
      '',
      'Maintain cross-domain knowledge graph for AGI reasoning.',
      '',
    ].join('\n'), 'utf8');
    fs.mkdirSync(path.join(dir, 'atris', 'wiki', 'systems'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'wiki', 'systems', 'signals.md'), [
      '# Signal Loop',
      '',
      'signal-scout owns inbound feedback and uses the wiki graph to route AGI work.',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'wiki', '.causal.json'), JSON.stringify({
      schema: 'atris.causal_patterns.v1',
      patterns: [
        { id: 'causal:signal', action: 'signal-scout proof packet', outcome: 'validator accepted proof', outcome_type: 'success' },
      ],
    }, null, 2), 'utf8');

    const wake = runCli(['member', 'wake', 'wiki-miner', '--execute', '--json'], {
      cwd: dir,
      env: {
        ATRIS_WIKI_MINER_LLM_JSON: JSON.stringify({
          entities: [
            { type: 'system', name: 'signal-scout' },
            { type: 'concept', name: 'wiki graph' },
          ],
          relationships: [
            { from: 'signal-scout', to: 'wiki graph', type: 'uses' },
          ],
        }),
      },
    });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.decision, 'wiki_mine');
    assert.equal(payload.executed, true);
    assert.equal(payload.wiki_miner.llm_successful_pages, 1);
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'wiki', '.graph.json')));
    assert.ok(fs.existsSync(payload.receipt_path));
    const receipt = JSON.parse(fs.readFileSync(payload.receipt_path, 'utf8'));
    assert.equal(receipt.schema, 'atris.wiki_miner_tick.v1');
    assert.equal(receipt.pages_succeeded, 1);
    assert.equal(receipt.pages[0].llm_source, 'env_json');

    const graph = JSON.parse(fs.readFileSync(path.join(dir, 'atris', 'wiki', '.graph.json'), 'utf8'));
    assert.ok(graph.entities.some((entity) => entity.name === 'signal-scout' && entity.type === 'system'));
    assert.ok(graph.relationships.some((relationship) => relationship.from === 'signal-scout' && relationship.to === 'wiki graph'));
    assert.equal(graph.causal_patterns.length, 1);
    assert.equal(payload.wiki_miner.causal_pattern_count, 1);

    const related = runCli(['wiki', 'related', 'signal-scout', '--json'], { cwd: dir });
    assert.equal(related.status, 0, related.stderr || related.stdout);
    const relatedPayload = JSON.parse(related.stdout);
    assert.equal(relatedPayload.relationships.length, 1);
    assert.equal(relatedPayload.relationships[0].to, 'wiki graph');

    const entities = runCli(['wiki', 'entities', '--type', 'system', '--json'], { cwd: dir });
    assert.equal(entities.status, 0, entities.stderr || entities.stdout);
    const entitiesPayload = JSON.parse(entities.stdout);
    assert.deepEqual(entitiesPayload.entities.map((entity) => entity.name), ['signal-scout']);

    fs.writeFileSync(path.join(dir, 'atris', 'wiki', 'SECURITY.md'), [
      '# Security Readiness',
      '',
      'It uses Electron and IPC for release checks. They depend on canonical-root. What changed Here, and Everything points back to Security Readiness.',
      '',
    ].join('\n'), 'utf8');
    const heuristicWake = runCli(['member', 'wake', 'wiki-miner', '--execute', '--json'], { cwd: dir });
    assert.equal(heuristicWake.status, 0, heuristicWake.stderr || heuristicWake.stdout);
    const heuristicGraph = JSON.parse(fs.readFileSync(path.join(dir, 'atris', 'wiki', '.graph.json'), 'utf8'));
    const pronouns = new Set(['it', 'they']);
    const stopwords = new Set(['here', 'there', 'what', 'who', 'which', 'everything', 'nothing', 'something', 'anything', 'anyone', 'someone']);
    assert.equal(heuristicGraph.entities.some((entity) => pronouns.has(entity.name.toLowerCase()) || stopwords.has(entity.name.toLowerCase())), false);
    assert.equal(heuristicGraph.relationships.some((relationship) => (
      pronouns.has(relationship.from.toLowerCase()) || pronouns.has(relationship.to.toLowerCase())
    )), false);
    assert.equal(heuristicGraph.relationships.some((relationship) => (
      stopwords.has(relationship.from.toLowerCase()) || stopwords.has(relationship.to.toLowerCase())
      || relationship.from.toLowerCase() === relationship.to.toLowerCase()
    )), false);
    assert.ok(heuristicGraph.relationships.some((relationship) => (
      relationship.from === 'Security Readiness' && relationship.to === 'Electron'
    )));
  } finally {
    cleanupTempDir(dir);
  }
});

test('supervisor wake writes recommendations and query reads them', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'team', 'supervisor'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'supervisor', 'MEMBER.md'), [
      '---',
      'name: supervisor',
      'role: Meta-cognition Layer',
      'description: Monitors member performance and adjusts coordination',
      'skills: []',
      'permissions:',
      '  can-read: true',
      '  can-execute: true',
      '  can-approve: false',
      '---',
      '',
      '# Supervisor',
      '',
      'Monitor all member performance, identify patterns, suggest coordination adjustments.',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'supervisor', 'MISSION.md'), [
      '# Mission',
      '',
      '## North Star',
      '',
      'Optimize member coordination through data-driven meta-cognition.',
      '',
    ].join('\n'), 'utf8');
    fs.mkdirSync(path.join(dir, 'atris', 'team', 'signal-scout', 'logs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'signal-scout', 'logs', '2026-06-04.md'), [
      '## 09:00 - Wake',
      '- status: shipped two clean receipts',
      '',
    ].join('\n'), 'utf8');
    fs.mkdirSync(path.join(dir, 'atris', 'runs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'runs', 'member-wake-signal-scout-2026-06-04T09-00-00-000Z.json'), JSON.stringify({
      schema: 'atris.member_wake.v1',
      created_at: new Date().toISOString(),
      member: 'signal-scout',
      ok: true,
      decision: 'wait',
      reason: 'tick_executed_experiment_proposed',
      duration_ms: 1200,
    }, null, 2), 'utf8');

    const wake = runCli(['member', 'wake', 'supervisor', '--execute', '--json'], {
      cwd: dir,
      env: {
        ATRIS_SUPERVISOR_LLM_JSON: JSON.stringify({
          top_performers: [
            { member: 'signal-scout', reason: 'Recent receipt succeeded quickly and log shows clean handoff.' },
          ],
          bottlenecks: [
            { issue: 'validator waits on proof packets', suggestion: 'Route proof-ready work through signal-scout first.' },
          ],
          recommendations: [
            { type: 'assignment', from: 'validator', to: 'signal-scout', reason: 'Let signal-scout preflight proof packets before validation.' },
          ],
        }),
      },
    });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.decision, 'supervise');
    assert.equal(payload.executed, true);
    assert.equal(payload.supervisor.llm_successful, true);
    assert.equal(payload.supervisor.llm_source, 'env_json');
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'team', 'supervisor', 'recommendations.json')));
    assert.ok(fs.existsSync(payload.receipt_path));

    const receipt = JSON.parse(fs.readFileSync(payload.receipt_path, 'utf8'));
    assert.equal(receipt.schema, 'atris.supervisor_tick.v1');
    assert.equal(receipt.recommendation_count, 1);
    assert.equal(receipt.analysis.top_performers[0].member, 'signal-scout');

    const recommendations = JSON.parse(fs.readFileSync(path.join(dir, 'atris', 'team', 'supervisor', 'recommendations.json'), 'utf8'));
    assert.equal(recommendations.status, 'ok');
    assert.equal(recommendations.recommendations[0].to, 'signal-scout');

    const query = runCli(['member', 'supervisor', 'recommendations', '--json'], { cwd: dir });
    assert.equal(query.status, 0, query.stderr || query.stdout);
    const queryPayload = JSON.parse(query.stdout);
    assert.equal(queryPayload.ok, true);
    assert.equal(queryPayload.recommendations.recommendations[0].reason, 'Let signal-scout preflight proof packets before validation.');
  } finally {
    cleanupTempDir(dir);
  }
});

test('supervisor wake keeps fallback recommendations when the llm call fails', () => {
  const dir = makeTempDir();
  try {
    seedSupervisorWakeFixture(dir);

    const wake = runCli(['member', 'wake', 'supervisor', '--execute', '--json'], {
      cwd: dir,
      env: {
        ATRIS_SUPERVISOR_LLM_JSON: '{not valid json',
      },
    });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.supervisor.llm_successful, false);
    assert.equal(payload.supervisor.llm_error, 'invalid_json');

    const recommendations = JSON.parse(fs.readFileSync(path.join(dir, 'atris', 'team', 'supervisor', 'recommendations.json'), 'utf8'));
    assert.equal(recommendations.status, 'parse_error');
    assert.equal(recommendations.llm_source, 'env_json');
    assert.equal(recommendations.llm_error, 'invalid_json');
    assert.ok(recommendations.top_performers.length > 0, 'fallback analysis should keep heuristic content');
  } finally {
    cleanupTempDir(dir);
  }
});

test('supervisor llm call downgrades to the cloud endpoint when no local backend runs', async () => {
  // The supervisor postTurn used to pin route:'local', which made
  // pinLocalCheckout return true and skipped the local->cloud downgrade, so
  // any machine without a local backend died ECONNREFUSED. This stub stands
  // in for the cloud endpoint; the wake only reaches it if the downgrade fires.
  const dir = makeTempDir();
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({
        type: 'result',
        result: JSON.stringify({
          top_performers: [{ member: 'signal-scout', reason: 'stub cloud analysis' }],
          bottlenecks: [],
          recommendations: [{ type: 'priority', from: 'supervisor', to: 'signal-scout', reason: 'stub recommendation' }],
        }),
      }) + '\n\n');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const cloudPort = server.address().port;
  // Bind then close a port so the local health probe has a guaranteed dead target.
  const deadPort = await new Promise((resolve) => {
    const probe = http.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
  try {
    seedSupervisorWakeFixture(dir);

    const child = spawn(process.execPath, [cliPath, 'member', 'wake', 'supervisor', '--execute', '--json'], {
      cwd: dir,
      env: {
        ...scrubAgentEnv(),
        ATRIS_SKIP_UPDATE_CHECK: '1',
        ATRIS_SUPERVISOR_LLM: '1',
        OBELISK_LOCAL_ATRIS2_BACKEND_URL: `http://127.0.0.1:${deadPort}`,
        OBELISK_ATRIS2_BACKEND_URL: `http://127.0.0.1:${cloudPort}`,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(code, 0, stderr || stdout);
    assert.ok(
      requests.some((entry) => entry.method === 'POST' && entry.url === '/api/atris2/turn'),
      'expected the supervisor turn to reach the cloud stub via the downgrade',
    );

    const payload = JSON.parse(stdout);
    assert.equal(payload.supervisor.llm_source, 'atris2_backend');
    assert.equal(payload.supervisor.llm_successful, true);

    const recommendations = JSON.parse(fs.readFileSync(path.join(dir, 'atris', 'team', 'supervisor', 'recommendations.json'), 'utf8'));
    assert.equal(recommendations.status, 'ok');
    assert.equal(recommendations.top_performers[0].member, 'signal-scout');
  } finally {
    server.close();
    cleanupTempDir(dir);
  }
});

test('objective-generator wake writes scored proposal and query reads it', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'team', 'objective-generator'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'objective-generator', 'MEMBER.md'), [
      '---',
      'name: objective-generator',
      'role: Autonomous Objective Setter',
      'description: Identifies high-value problems from world model and proposes objectives',
      'skills: []',
      'permissions:',
      '  can-read: true',
      '  can-execute: true',
      '  can-approve: false',
      '---',
      '',
      '# Objective Generator',
      '',
      'Use world model to identify valuable problems and propose objectives.',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'objective-generator', 'MISSION.md'), [
      '# Mission',
      '',
      '## North Star',
      '',
      'Identify and prioritize high-value problems autonomously.',
      '',
    ].join('\n'), 'utf8');
    fs.mkdirSync(path.join(dir, 'atris', 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'wiki', '.graph.json'), JSON.stringify({
      schema: 'atris.wiki_graph.v1',
      entities: [
        { type: 'system', name: 'signal-scout' },
        { type: 'concept', name: 'proof routing' },
      ],
      relationships: [
        { from: 'signal-scout', to: 'proof routing', type: 'uses' },
      ],
    }, null, 2), 'utf8');
    fs.mkdirSync(path.join(dir, 'atris', 'team', 'supervisor'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'supervisor', 'recommendations.json'), JSON.stringify({
      schema: 'atris.supervisor_recommendations.v1',
      status: 'ok',
      recommendations: [
        { type: 'assignment', from: 'validator', to: 'signal-scout', reason: 'Preflight proof packets before review.' },
      ],
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'wiki', '.patterns.json'), JSON.stringify({
      schema: 'atris.transfer_patterns.v1',
      patterns: [
        {
          id: 'transfer:proof-routing',
          pattern: 'world graph signal -> proof packet preflight -> validator handoff',
          from_domain: 'coordination',
          transfer_score: 12,
          steps: ['world graph signal', 'proof packet preflight', 'validator handoff'],
        },
      ],
    }, null, 2), 'utf8');

    const wake = runCli(['member', 'wake', 'objective-generator', '--execute', '--json'], {
      cwd: dir,
      env: {
        ATRIS_OBJECTIVE_GENERATOR_LLM_JSON: JSON.stringify({
          proposed_objective: 'Repair proof routing gaps around signal-scout',
          impact_score: 9,
          urgency_score: 8,
          alignment_score: 9,
          justification: 'signal-scout connects world graph evidence to validator handoff quality.',
          suggested_member: 'signal-scout',
          suggested_patterns: [
            { pattern: 'world graph signal -> proof packet preflight -> validator handoff', reason: 'matches proof routing' },
          ],
        }),
      },
    });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.decision, 'generate_objective');
    assert.equal(payload.executed, true);
    assert.equal(payload.objective_generator.llm_successful, true);
    assert.equal(payload.objective_generator.llm_source, 'env_json');
    assert.equal(payload.objective_generator.world_model_used, true);
    assert.equal(payload.objective_generator.transfer_pattern_count, 1);
    assert.equal(payload.objective_generator.task_created, true);
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'team', 'objective-generator', 'proposals.json')));
    assert.ok(fs.existsSync(payload.receipt_path));

    const receipt = JSON.parse(fs.readFileSync(payload.receipt_path, 'utf8'));
    assert.equal(receipt.schema, 'atris.objective_generator_tick.v1');
    assert.equal(receipt.proposal.proposed_objective, 'Repair proof routing gaps around signal-scout');
    assert.equal(receipt.proposal.overall_score, 8.67);
    assert.equal(receipt.proposal.suggested_patterns[0].pattern, 'world graph signal -> proof packet preflight -> validator handoff');
    assert.equal(receipt.created_task.tag, 'auto-objective');

    const proposals = JSON.parse(fs.readFileSync(path.join(dir, 'atris', 'team', 'objective-generator', 'proposals.json'), 'utf8'));
    assert.equal(proposals.status, 'ok');
    assert.equal(proposals.suggested_member, 'signal-scout');
    assert.equal(proposals.suggested_patterns[0].reason, 'matches proof routing');
    assert.equal(proposals.created_task.tag, 'auto-objective');

    const query = runCli(['member', 'objective-generator', 'proposals', '--json'], { cwd: dir });
    assert.equal(query.status, 0, query.stderr || query.stdout);
    const queryPayload = JSON.parse(query.stdout);
    assert.equal(queryPayload.ok, true);
    assert.equal(queryPayload.proposal.proposed_objective, 'Repair proof routing gaps around signal-scout');
  } finally {
    cleanupTempDir(dir);
  }
});

test('objective-generator wake falls back to scored heuristic proposal without llm', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'team', 'objective-generator'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'objective-generator', 'MEMBER.md'), [
      '---',
      'name: objective-generator',
      'role: Autonomous Objective Setter',
      'description: Identifies high-value problems from world model and proposes objectives',
      'skills: []',
      'permissions:',
      '  can-read: true',
      '  can-execute: true',
      '  can-approve: false',
      '---',
      '',
      '# Objective Generator',
      '',
    ].join('\n'), 'utf8');
    fs.mkdirSync(path.join(dir, 'atris', 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'wiki', '.graph.json'), JSON.stringify({
      schema: 'atris.wiki_graph.v1',
      entities: [
        { type: 'concept', name: 'wiki graph' },
        { type: 'system', name: 'signal-scout' },
      ],
      relationships: [
        { from: 'signal-scout', to: 'wiki graph', type: 'uses' },
      ],
    }, null, 2), 'utf8');
    fs.mkdirSync(path.join(dir, 'atris', 'team', 'supervisor'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'supervisor', 'recommendations.json'), JSON.stringify({
      schema: 'atris.supervisor_recommendations.v1',
      status: 'ok',
      top_performers: [
        { member: 'signal-scout', reason: 'Recent member receipts succeeded and logs show clean handoffs.' },
      ],
      bottlenecks: [
        { issue: 'Review-ready work waits on proof packet routing', suggestion: 'Route proof packet preflight through signal-scout before validator review.' },
      ],
      recommendations: [
        { type: 'assignment', from: 'validator', to: 'signal-scout', reason: 'Let signal-scout preflight proof packets before validation.' },
      ],
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'wiki', '.patterns.json'), JSON.stringify({
      schema: 'atris.transfer_patterns.v1',
      patterns: [
        {
          id: 'transfer:proof-routing',
          pattern: 'world graph signal -> proof packet preflight -> validator handoff',
          from_domain: 'coordination',
          transfer_score: 12,
          steps: ['world graph signal', 'proof packet preflight', 'validator handoff'],
        },
      ],
    }, null, 2), 'utf8');

    const wake = runCli(['member', 'wake', 'objective-generator', '--execute', '--json'], { cwd: dir });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.reason, 'heuristic_objective_proposal_written');
    assert.equal(payload.objective_generator.llm_successful, false);
    assert.equal(payload.objective_generator.llm_error, 'llm_not_configured');
    assert.equal(payload.objective_generator.task_created, false);

    const proposals = JSON.parse(fs.readFileSync(path.join(dir, 'atris', 'team', 'objective-generator', 'proposals.json'), 'utf8'));
    assert.equal(proposals.status, 'ok');
    assert.equal(proposals.proposed_objective, 'Repair proof routing gaps around signal-scout wiki graph handoffs');
    assert.equal(proposals.overall_score, 7);
    assert.equal(proposals.suggested_member, 'signal-scout');
    assert.equal(proposals.suggested_patterns[0].pattern, 'world graph signal -> proof packet preflight -> validator handoff');
  } finally {
    cleanupTempDir(dir);
  }
});

test('objective-generator wake handles empty world model without task creation', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'team', 'objective-generator'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'objective-generator', 'MEMBER.md'), [
      '---',
      'name: objective-generator',
      'role: Autonomous Objective Setter',
      'description: Identifies high-value problems from world model and proposes objectives',
      'skills: []',
      'permissions:',
      '  can-read: true',
      '  can-execute: true',
      '  can-approve: false',
      '---',
      '',
      '# Objective Generator',
      '',
    ].join('\n'), 'utf8');

    const wake = runCli(['member', 'wake', 'objective-generator', '--execute', '--json'], { cwd: dir });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.reason, 'insufficient_world_model_data');
    assert.equal(payload.objective_generator.world_model_used, false);
    assert.equal(payload.objective_generator.task_created, false);

    const proposals = JSON.parse(fs.readFileSync(path.join(dir, 'atris', 'team', 'objective-generator', 'proposals.json'), 'utf8'));
    assert.equal(proposals.status, 'insufficient_world_model_data');
    assert.match(proposals.justification, /Insufficient world model data/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('generalist wake solves a restaurant domain without project-specific world model', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'team', 'generalist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'generalist', 'MEMBER.md'), [
      '---',
      'name: generalist',
      'role: Cross-Domain Problem Solver',
      'description: Applies AGI capabilities to any domain',
      '---',
      '',
      '# Generalist',
      '',
      'Use world model, causal reasoning, and transfer learning to solve problems in any domain.',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'generalist', 'MISSION.md'), [
      '# Mission',
      '',
      '## North Star',
      '',
      'Prove cross-domain generalization by solving unfamiliar domains with the same AGI loop.',
      '',
      '## How To Choose Goals',
      '',
      '- Pick the next domain proof or reusable operating bottleneck.',
      '',
    ].join('\n'), 'utf8');
    fs.mkdirSync(path.join(dir, 'atris', 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'wiki', '.patterns.json'), JSON.stringify({
      schema: 'atris.transfer_patterns.v1',
      patterns: [
        {
          id: 'transfer:ops-bottleneck',
          pattern: 'bottleneck signal -> small controlled intervention -> outcome receipt',
          from_domain: 'operations',
          transfer_score: 11,
          steps: ['measure bottleneck', 'pilot one reversible change', 'review outcome receipt'],
        },
      ],
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(dir, 'restaurant-domain.md'), [
      '# Restaurant Operations',
      '',
      'A 90-seat neighborhood restaurant has slow seating during Friday dinner.',
      'Hosts manage walk-ins and reservations, servers cover uneven sections, and the kitchen gets order spikes.',
      'The team wants fewer guest complaints, lower wait time, less inventory waste, and no drop in service quality.',
      '',
    ].join('\n'), 'utf8');

    const wake = runCli([
      'member', 'wake', 'generalist',
      '--execute',
      '--domain-file', 'restaurant-domain.md',
      '--domain-name', 'restaurant operations',
      '--json',
    ], { cwd: dir });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.decision, 'cross_domain_generalize');
    assert.equal(payload.executed, true);
    assert.equal(payload.reason, 'heuristic_cross_domain_proof_written');
    assert.equal(payload.generalist.domain_name, 'restaurant operations');
    assert.equal(payload.generalist.domain_agnostic, true);
    assert.equal(payload.generalist.atris_specific_code_required, false);
    assert.equal(payload.generalist.capabilities_used.length, 8);
    assert.equal(payload.generalist.world_model_entities > 0, true);
    assert.equal(payload.generalist.world_model_relationships > 0, true);
    assert.equal(payload.generalist.objective_count > 0, true);
    assert.ok(fs.existsSync(payload.receipt_path));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'team', 'generalist', 'proofs', 'latest.json')));

    const receipt = JSON.parse(fs.readFileSync(payload.receipt_path, 'utf8'));
    assert.equal(receipt.schema, 'atris.generalist_tick.v1');
    assert.equal(receipt.proof.world_model.entities.some((entity) => entity.name === 'kitchen staff'), true);
    assert.match(receipt.top_objective.objective, /Reduce peak-service wait time/);
    assert.equal(receipt.proof.transfer_patterns[0].source_pattern, 'bottleneck signal -> small controlled intervention -> outcome receipt');
    assert.equal(/signal-scout|wiki-miner|objective-generator|Atris/.test(JSON.stringify(receipt.proof)), false);

    const query = runCli(['member', 'generalist', 'proof', '--json'], { cwd: dir });
    assert.equal(query.status, 0, query.stderr || query.stdout);
    const queryPayload = JSON.parse(query.stdout);
    assert.equal(queryPayload.ok, true);
    assert.equal(queryPayload.proof.domain.name, 'restaurant operations');
    assert.equal(queryPayload.proof.capabilities_used.length, 8);
  } finally {
    cleanupTempDir(dir);
  }
});

test('generalist dry-run wake receipt does not name a proof file that was never written', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'team', 'generalist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'generalist', 'MEMBER.md'), [
      '---',
      'name: generalist',
      'role: Cross-Domain Problem Solver',
      'description: Applies AGI capabilities to any domain',
      '---',
      '',
      '# Generalist',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'generalist', 'MISSION.md'), [
      '# Mission',
      '',
      '## North Star',
      '',
      'Prove cross-domain generalization.',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'restaurant-domain.md'), [
      '# Restaurant Operations',
      '',
      'A 90-seat neighborhood restaurant has slow seating during Friday dinner.',
      '',
    ].join('\n'), 'utf8');

    const wake = runCli([
      'member', 'wake', 'generalist',
      '--domain-file', 'restaurant-domain.md',
      '--domain-name', 'restaurant operations',
      '--json',
    ], { cwd: dir });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.decision, 'cross_domain_generalize');
    assert.equal(payload.executed, false);
    assert.ok(fs.existsSync(payload.receipt_path));

    const receipt = JSON.parse(fs.readFileSync(payload.receipt_path, 'utf8'));
    assert.equal(receipt.schema, 'atris.generalist_tick.v1');
    assert.equal(receipt.proof_path, null);
    assert.equal(receipt.cross_domain_learning.run.proof_path, null);
    assert.match(receipt.cross_domain_learning.run.receipt_path, /^atris\/runs\/generalist-tick-.+\.json$/);

    const proofsDir = path.join(dir, 'atris', 'team', 'generalist', 'proofs');
    const writtenProofs = fs.existsSync(proofsDir) ? fs.readdirSync(proofsDir) : [];
    assert.deepEqual(writtenProofs, []);
  } finally {
    cleanupTempDir(dir);
  }
});

test('generalist wake scans domain files before existing task evidence', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'team', 'generalist', 'domains'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'generalist', 'MEMBER.md'), [
      '---',
      'name: generalist',
      'role: Cross-Domain Problem Solver',
      'description: Applies AGI capabilities to any domain',
      '---',
      '',
      '# Generalist',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'generalist', 'MISSION.md'), [
      '# Mission',
      '',
      '## North Star',
      '',
      'Prove cross-domain generalization by solving unfamiliar domains with the same AGI loop.',
      '',
      '## How To Choose Goals',
      '',
      '- Pick the next domain proof or reusable operating bottleneck.',
      '',
    ].join('\n'), 'utf8');
    assert.equal(runCli(['member', 'goal-from-mission', 'generalist', '--json'], { cwd: dir }).status, 0);
    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
      schema: 'atris.task_projection.v1',
      generated_at: '2026-06-05T00:00:00.000Z',
      tasks: [
        {
          id: 'bakery-blocking-task',
          display_id: 'OBL-777',
          title: 'Existing task should wait until bakery domain proof is written',
          status: 'claimed',
          claimed_by: 'generalist',
          metadata: { assigned_to: 'generalist' },
          updated_at: Date.now(),
        },
      ],
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'generalist', 'domains', 'bakery-operations.md'), [
      '# Bakery Operations',
      '',
      'A neighborhood bakery handles morning pastry demand, custom cake orders, wholesale pickups, oven capacity, proofing time, ingredient inventory, and front-counter queues.',
      'The bakery wants shorter morning wait time, fewer sold-out staples, lower waste, and calmer handoffs between bakers and counter staff.',
      '',
    ].join('\n'), 'utf8');

    const wake = runCli(['member', 'wake', 'generalist', '--execute', '--json'], { cwd: dir });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.decision, 'cross_domain_generalize');
    assert.equal(payload.executed, true);
    assert.equal(payload.generalist.domain_source_path, 'atris/team/generalist/domains/bakery-operations.md');
    assert.match(payload.generalist.domain_name, /Bakery Operations/i);
    assert.equal(payload.generalist.proof.domain.source_path, 'atris/team/generalist/domains/bakery-operations.md');
    assert.equal(payload.generalist.proof.world_model.entities.length > 0, true);
    assert.equal(payload.generalist.proof.objectives.length > 0, true);
    assert.match(payload.generalist.proof_path, /atris\/team\/generalist\/proofs\/bakery-operations-/);
    assert.ok(fs.existsSync(path.join(dir, payload.generalist.proof_path)));
    assert.doesNotMatch(payload.next_command, /task (delegate|note|show|review)/);

    const secondWake = runCli(['member', 'wake', 'generalist', '--json'], { cwd: dir });
    assert.equal(secondWake.status, 0, secondWake.stderr || secondWake.stdout);
    const secondPayload = JSON.parse(secondWake.stdout);
    assert.equal(secondPayload.decision, 'close_loop');
    assert.equal(secondPayload.reason, 'nearest_open_loop:task_projection:OBL-777');
  } finally {
    cleanupTempDir(dir);
  }
});

test('generalist wake learns restaurant pattern and reuses it for healthcare', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'team', 'generalist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'generalist', 'MEMBER.md'), [
      '---',
      'name: generalist',
      'role: Cross-Domain Problem Solver',
      'description: Applies AGI capabilities to any domain',
      '---',
      '',
      '# Generalist',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'team', 'generalist', 'MISSION.md'), [
      'North Star: Prove cross-domain generalization by solving unfamiliar domains with the same AGI loop.',
      '',
    ].join('\n'), 'utf8');
    fs.mkdirSync(path.join(dir, 'atris', 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'restaurant-domain.md'), [
      '# Restaurant Operations',
      '',
      'A 90-seat restaurant has slow seating during Friday dinner.',
      'Hosts manage walk-ins and reservations, servers cover uneven sections, and the kitchen gets order spikes.',
      'The team wants fewer guest complaints, lower wait time, less inventory waste, and stable service quality.',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'healthcare-domain.md'), [
      '# Healthcare Scheduling',
      '',
      'An outpatient clinic has long waits for urgent follow-ups.',
      'Schedulers balance provider calendars, room availability, authorization, urgency, no-show risk, and phone queues.',
      'The clinic wants faster access for high-risk patients, fewer idle slots, and lower staff stress.',
      '',
    ].join('\n'), 'utf8');

    const restaurant = runCli([
      'member', 'wake', 'generalist',
      '--execute',
      '--domain-file', 'restaurant-domain.md',
      '--domain-name', 'restaurant operations',
      '--json',
    ], { cwd: dir });
    assert.equal(restaurant.status, 0, restaurant.stderr || restaurant.stdout);
    const restaurantPayload = JSON.parse(restaurant.stdout);
    assert.equal(restaurantPayload.generalist.cross_domain_learning.reused_pattern_count, 0);
    assert.equal(restaurantPayload.generalist.cross_domain_learning.after_metrics.domains_solved_count, 1);
    assert.equal(restaurantPayload.generalist.cross_domain_learning.after_metrics.pattern_count, 1);
    assert.equal(restaurantPayload.generalist.cross_domain_learning.after_metrics.cross_domain_success_rate, 0);

    const libraryPath = path.join(dir, 'atris', 'wiki', '.cross_domain_patterns.json');
    assert.ok(fs.existsSync(libraryPath));
    const firstLibrary = JSON.parse(fs.readFileSync(libraryPath, 'utf8'));
    assert.equal(firstLibrary.patterns.length, 1);
    assert.deepEqual(firstLibrary.patterns[0].domains, ['restaurant operations']);

    const healthcare = runCli([
      'member', 'wake', 'generalist',
      '--execute',
      '--domain-file', 'healthcare-domain.md',
      '--domain-name', 'healthcare scheduling',
      '--json',
    ], { cwd: dir });
    assert.equal(healthcare.status, 0, healthcare.stderr || healthcare.stdout);
    const healthcarePayload = JSON.parse(healthcare.stdout);
    assert.equal(healthcarePayload.generalist.cross_domain_patterns_scanned, 1);
    assert.equal(healthcarePayload.generalist.cross_domain_pattern_matches.length, 1);
    assert.equal(healthcarePayload.generalist.cross_domain_learning.reused_pattern_count, 1);
    assert.equal(healthcarePayload.generalist.cross_domain_learning.learning_improved, true);
    assert.equal(healthcarePayload.generalist.cross_domain_learning.after_metrics.domains_solved_count, 2);
    assert.equal(healthcarePayload.generalist.cross_domain_learning.after_metrics.cross_domain_pattern_count, 1);
    assert.equal(healthcarePayload.generalist.cross_domain_learning.after_metrics.pattern_reuse_rate, 0.5);
    assert.equal(healthcarePayload.generalist.cross_domain_learning.after_metrics.cross_domain_success_rate, 1);
    assert.match(healthcarePayload.generalist.proof.transfer_patterns[0].reason, /Reused cross-domain pattern/);
    assert.deepEqual(healthcarePayload.generalist.cross_domain_learning.reused_patterns[0].domains_before, ['restaurant operations']);

    const secondLibrary = JSON.parse(fs.readFileSync(libraryPath, 'utf8'));
    assert.equal(secondLibrary.metrics.domains_solved_count, 2);
    assert.equal(secondLibrary.metrics.pattern_reuse_rate, 0.5);
    assert.equal(secondLibrary.metrics.cross_domain_success_rate, 1);
    assert.deepEqual(secondLibrary.patterns[0].domains, ['healthcare scheduling', 'restaurant operations']);
    assert.equal(secondLibrary.patterns[0].domain_count, 2);
    assert.equal(secondLibrary.patterns[0].success_rate, 1);

    const query = runCli(['member', 'generalist', 'patterns', '--json'], { cwd: dir });
    assert.equal(query.status, 0, query.stderr || query.stdout);
    const queryPayload = JSON.parse(query.stdout);
    assert.equal(queryPayload.ok, true);
    assert.equal(queryPayload.library.metrics.domains_solved_count, 2);
    assert.equal(queryPayload.library.patterns[0].domain_count, 2);
  } finally {
    cleanupTempDir(dir);
  }
});

test('member wake picks nearest open loop from task projection evidence', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'command-leader', '--description="Keep command loops controlled"'], { cwd: dir }).status, 0);
    assert.equal(runCli(['member', 'goal-from-mission', 'command-leader', '--json'], { cwd: dir }).status, 0);
    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
      schema: 'atris.task_projection.v1',
      generated_at: '2026-05-06T00:00:00.000Z',
      tasks: [
        {
          id: '01TESTOPENLOOP',
          display_id: 'OBL-999',
          title: 'Close the nearest member loop',
          status: 'claimed',
          claimed_by: 'command-leader',
          metadata: { assigned_to: 'command-leader' },
          updated_at: 1778058000000,
        },
      ],
    }), 'utf8');

    const picked = runCli(['member', 'wake', 'command-leader', '--json'], { cwd: dir });
    assert.equal(picked.status, 0, picked.stderr || picked.stdout);
    const payload = JSON.parse(picked.stdout);
    assert.equal(payload.decision, 'close_loop');
    assert.equal(payload.reason, 'nearest_open_loop:task_projection:OBL-999');
    assert.equal(payload.checks.has_open_loop_evidence, true);
    assert.equal(payload.checks.open_loop_source, 'task_projection');
    assert.equal(payload.evidence.nearest_open_loop.task_ref, 'OBL-999');
    assert.match(payload.next_command, /atris task note OBL-999/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('member wake scores strategic objective above low-value nearby loop', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'atris', 'context'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'context', 'agi.md'), 'Cross-domain world model and transfer learning target.\n', 'utf8');
    assert.equal(runCli(['member', 'create', 'command-leader', '--description="Coordinate autonomous AGI foundation loops"'], { cwd: dir }).status, 0);
    assert.equal(runCli([
      'member', 'goal', 'command-leader',
      'Build AGI cross-domain world model from atris/context/agi.md',
      '--acceptance', 'Use atris/context/agi.md to set the next autonomous objective.',
      '--json',
    ], { cwd: dir }).status, 0);
    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
      schema: 'atris.task_projection.v1',
      generated_at: '2026-05-06T00:00:00.000Z',
      tasks: [
        {
          id: 'tiny-loop',
          display_id: 'OBL-301',
          title: 'Rename a small helper',
          status: 'claimed',
          claimed_by: 'command-leader',
          metadata: { assigned_to: 'command-leader' },
          updated_at: 1778057000000,
        },
      ],
    }, null, 2), 'utf8');

    const wake = runCli(['member', 'wake', 'command-leader', '--json'], { cwd: dir });
    assert.equal(wake.status, 0, wake.stderr || wake.stdout);
    const payload = JSON.parse(wake.stdout);
    assert.equal(payload.decision, 'tick');
    assert.equal(payload.reason, 'safe_next_bounded_step');
    assert.equal(payload.evidence.nearest_open_loop.task_ref, 'OBL-301');
    assert.equal(payload.evidence.selected_wake_candidate.decision, 'tick');
    assert.equal(payload.evidence.wake_candidate_scores[0].decision, 'tick');
    assert.ok(payload.evidence.wake_candidate_scores.find((candidate) => candidate.task_ref === 'OBL-301'));
  } finally {
    cleanupTempDir(dir);
  }
});

test('member loop repeats wake quickly and skips an active lease', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'mission-lead', '--description="Make Missions loop safely"'], { cwd: dir }).status, 0);
    assert.equal(runCli([
      'mission', 'start', '--no-verify', 'Make Missions loop safely',
      '--owner', 'mission-lead',
      '--json',
    ], { cwd: dir }).status, 0);
    assert.equal(runCli(['member', 'goal-from-mission', 'mission-lead', '--json'], { cwd: dir }).status, 0);
    const loop = runCli([
      'member', 'loop', 'mission-lead',
      '--ticks', '2',
      '--interval', '0',
      '--execute',
      '--confirm-autonomy-policy',
      '--json',
    ], { cwd: dir });
    assert.equal(loop.status, 0, loop.stderr || loop.stdout);
    const payload = JSON.parse(loop.stdout);
    assert.equal(payload.action, 'loop');
    assert.equal(payload.status, 'completed');
    assert.equal(payload.ticks, 2);
    assert.equal(payload.mode, 'execute');
    // Fallback proposals are unreviewable, so tick 2 does not wait on tick
    // 1's proposal (that deadlocked members for weeks); it proposes again and
    // the stale fallback is superseded. One open proposal stays the invariant.
    assert.equal(payload.decisions['wait:tick_executed_experiment_proposed'], 2);
    assert.equal(payload.decisions['wait:open_experiment_proposed'], undefined);
    assert.ok(fs.existsSync(payload.receipt_path));
    assert.ok(fs.existsSync(payload.log_path));
    assert.ok(fs.existsSync(payload.latest_path));
    const latest = JSON.parse(fs.readFileSync(payload.latest_path, 'utf8'));
    assert.equal(latest.receipt_path, payload.receipt_path);
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'atris', 'team', 'mission-lead', 'goals.json'), 'utf8'));
    const experiments = state.goals[0].experiments;
    assert.equal(experiments.length, 2);
    assert.equal(experiments.filter((experiment) => experiment.status === 'proposed').length, 1, 'exactly one open proposal');
    assert.equal(experiments[0].status, 'superseded');
    assert.equal(experiments[0].superseded_reason, 'unreviewable_fallback_replaced_by_next_proposal');

    const status = runCli(['member', 'loop', 'mission-lead', '--status', '--json'], { cwd: dir });
    assert.equal(status.status, 0, status.stderr || status.stdout);
    const statusPayload = JSON.parse(status.stdout);
    assert.equal(statusPayload.active, false);
    assert.equal(statusPayload.latest.receipt_path, payload.receipt_path);

    const loopStateDir = path.join(dir, '.atris', 'state', 'member-loops');
    fs.mkdirSync(loopStateDir, { recursive: true });
    fs.writeFileSync(path.join(loopStateDir, 'mission-lead.lock.json'), JSON.stringify({
      schema: 'atris.member_loop_lease.v1',
      member: 'mission-lead',
      run_id: 'active-run',
      pid: process.pid,
      started_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
      expires_at_ms: Date.now() + 60000,
    }, null, 2));

    const skipped = runCli(['member', 'loop', 'mission-lead', '--ticks', '1', '--interval', '0', '--json'], { cwd: dir });
    assert.equal(skipped.status, 0, skipped.stderr || skipped.stdout);
    const skippedPayload = JSON.parse(skipped.stdout);
    assert.equal(skippedPayload.status, 'skipped');
    assert.equal(skippedPayload.reason, 'loop_already_active');
    assert.equal(skippedPayload.ticks, 0);
    assert.ok(fs.existsSync(skippedPayload.receipt_path));

    fs.rmSync(path.join(loopStateDir, 'mission-lead.lock.json'), { force: true });
    fs.writeFileSync(path.join(loopStateDir, 'mission-lead.lock.json'), JSON.stringify({
      schema: 'atris.member_loop_lease.v1',
      member: 'mission-lead',
      run_id: 'dead-run',
      pid: 99999999,
      started_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
      expires_at_ms: Date.now() + 60000,
    }, null, 2));

    const recovered = runCli(['member', 'loop', 'mission-lead', '--ticks', '1', '--interval', '0', '--json'], { cwd: dir });
    assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
    const recoveredPayload = JSON.parse(recovered.stdout);
    assert.notEqual(recoveredPayload.status, 'skipped');
    assert.notEqual(recoveredPayload.reason, 'loop_already_active');
  } finally {
    cleanupTempDir(dir);
  }
});

test('member loop early-exits after two identical ask decisions in dry-run mode', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'architect'], { cwd: dir }).status, 0);
    // Overwrite MISSION.md with the literal placeholder North Star so every wake tick returns
    // the same ask:mission_missing_or_placeholder decision — this used to burn all 10 ticks
    // re-asking (live bug OBL 2026-07-16) because the idle early-exit only ran under --execute.
    fs.writeFileSync(
      path.join(dir, 'atris', 'team', 'architect', 'MISSION.md'),
      '# Mission\n\n## North Star\n\nDefine why this member exists and how it chooses goals.\n\n## How To Choose Goals\n\n- placeholder\n',
      'utf8',
    );

    const loop = runCli([
      'member', 'loop', 'architect',
      '--ticks', '10',
      '--interval', '0',
      '--json',
    ], { cwd: dir });
    assert.equal(loop.status, 0, loop.stderr || loop.stdout);
    const payload = JSON.parse(loop.stdout);
    assert.equal(payload.action, 'loop');
    assert.equal(payload.mode, 'dry_run');
    assert.equal(payload.ticks, 2, 'should stop after the 2nd identical ask, not run all 10 ticks');
    assert.equal(payload.status, 'blocked_on_human');
    assert.equal(payload.blocked_on_human, true);
    assert.equal(payload.early_exit.stop, 'repeated_identical_ask');
    assert.equal(payload.early_exit.reason, 'mission_missing_or_placeholder');
    assert.ok(payload.next_command);
    assert.equal(payload.decisions['ask:mission_missing_or_placeholder'], 2);
  } finally {
    cleanupTempDir(dir);
  }
});

test('member alive supports hourly forever contract with a stop command', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'mission-lead', '--description="Make Missions loop safely"'], { cwd: dir }).status, 0);
    assert.equal(runCli([
      'mission', 'start', '--no-verify', 'Make Missions loop safely',
      '--owner', 'mission-lead',
      '--json',
    ], { cwd: dir }).status, 0);

    const alive = runCli([
      'member', 'alive', 'mission-lead',
      '--hourly',
      '--forever',
      '--ticks', '1',
      '--json',
    ], { cwd: dir });
    assert.equal(alive.status, 0, alive.stderr || alive.stdout);
    const payload = JSON.parse(alive.stdout);
    assert.equal(payload.action, 'alive');
    assert.equal(payload.cadence, 'hourly');
    assert.equal(payload.forever, true);
    assert.equal(payload.interval_ms, 3600000);
    assert.equal(payload.ticks_requested, 1);
    assert.equal(payload.stop_command, 'atris member alive mission-lead --stop');
    assert.match(payload.operating_contract, /choose useful work/);
    assert.match(payload.operating_contract, /instead of faking activity/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('member alive install dry-run writes hourly cron plan without touching crontab', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'mission-lead', '--description="Make Missions loop safely"'], { cwd: dir }).status, 0);

    const install = runCli([
      'member', 'alive', 'mission-lead',
      '--install',
      '--dry-run',
      '--hourly',
      '--forever',
      '--execute',
      '--confirm-autonomy-policy',
      '--json',
    ], { cwd: dir });
    assert.equal(install.status, 0, install.stderr || install.stdout);
    const payload = JSON.parse(install.stdout);
    assert.equal(payload.action, 'alive_install');
    assert.equal(payload.dry_run, true);
    assert.equal(payload.installed, false);
    assert.equal(payload.cadence, 'hourly');
    assert.equal(payload.forever, true);
    assert.match(payload.crontab_line, /ATRIS_MEMBER_ALIVE_MISSION_LEAD/);
    assert.match(payload.crontab_line, /23 \* \* \* \*/);
    assert.equal(payload.preview.member, 'mission-lead');
    assert.equal(payload.preview.cadence, '23 * * * *');
    assert.match(payload.preview.mission_text, /Run mission-lead on meaningful work/);
    assert.match(payload.preview.run, /member' 'alive' 'mission-lead'/);
    assert.equal(payload.preview.verify, 'atris member alive mission-lead --status --json');
    assert.match(payload.preview.stop_when, /atris member alive mission-lead --uninstall/);
    assert.match(payload.preview.receipts, /\.atris\/state\/member-loops\/logs$/);
    assert.deepEqual(payload.command.slice(-7), [
      '--hourly',
      '--forever',
      '--ticks',
      '1',
      '--json',
      '--execute',
      '--confirm-autonomy-policy',
    ]);
    assert.equal(payload.stop_command, 'atris member alive mission-lead --uninstall');
    assert.ok(fs.existsSync(payload.script_path));
    const script = fs.readFileSync(payload.script_path, 'utf8');
    assert.match(script, /member' 'alive' 'mission-lead'/);
    assert.match(script, /--ticks' '1'/);

    const humanInstall = runCli([
      'member', 'alive', 'mission-lead',
      '--install',
      '--dry-run',
      '--hourly',
      '--forever',
      '--execute',
      '--confirm-autonomy-policy',
    ], { cwd: dir });
    assert.equal(humanInstall.status, 0, humanInstall.stderr || humanInstall.stdout);
    assert.match(humanInstall.stdout, /Every hour this will:/);
    assert.match(humanInstall.stdout, /verify: atris member alive mission-lead --status --json/);
    assert.match(humanInstall.stdout, /receipts: .*\.atris\/state\/member-loops\/logs/);

    const status = runCli(['member', 'alive', 'mission-lead', '--status', '--json'], { cwd: dir });
    assert.equal(status.status, 0, status.stderr || status.stdout);
    const statusPayload = JSON.parse(status.stdout);
    assert.equal(statusPayload.hourly_alive.script_exists, true);
    assert.equal(statusPayload.hourly_alive.installed, false);
    assert.equal(statusPayload.hourly_alive.install_command, 'atris member alive mission-lead --install --hourly --forever --execute --confirm-autonomy-policy --json');
    assert.equal(statusPayload.hourly_alive.uninstall_command, 'atris member alive mission-lead --uninstall');
  } finally {
    cleanupTempDir(dir);
  }
});

test('member alive install blocks execute on dirty git', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runGit(['init', '-q'], dir).status, 0);
    assert.equal(runGit(['config', 'user.email', 'test@example.com'], dir).status, 0);
    assert.equal(runGit(['config', 'user.name', 'Test User'], dir).status, 0);
    assert.equal(runCli(['member', 'create', 'mission-lead', '--description="Make Missions loop safely"'], { cwd: dir }).status, 0);
    assert.equal(runGit(['add', '.'], dir).status, 0);
    assert.equal(runGit(['commit', '-qm', 'baseline'], dir).status, 0);
    fs.writeFileSync(path.join(dir, 'dirty.txt'), 'uncommitted install risk\n');

    const install = runCli([
      'member', 'alive', 'mission-lead',
      '--install',
      '--hourly',
      '--forever',
      '--execute',
      '--confirm-autonomy-policy',
      '--json',
    ], { cwd: dir });
    assert.equal(install.status, 1, install.stderr || install.stdout);
    const payload = JSON.parse(install.stdout);
    assert.equal(payload.action, 'alive_install');
    assert.equal(payload.status, 'blocked');
    assert.equal(payload.reason, 'install_requires_clean_git');
    assert.equal(payload.git.dirty, true);
    assert.ok(payload.git.dirty_files.some((line) => /dirty\.txt/.test(line)));
    assert.equal(payload.preview.verify, 'atris member alive mission-lead --status --json');
    assert.equal(fs.existsSync(payload.preview.receipts), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('member alive install without confirmation exits 1', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'mission-lead'], { cwd: dir }).status, 0);

    const install = runCli([
      'member', 'alive', 'mission-lead', '--install', '--execute', '--json',
    ], { cwd: dir });
    assert.equal(install.status, 1, install.stderr || install.stdout);
    const payload = JSON.parse(install.stdout);
    assert.equal(payload.status, 'blocked');
    assert.equal(payload.reason, 'execute_requires_confirm_autonomy_policy');
  } finally {
    cleanupTempDir(dir);
  }
});

test('member status exposes blocked asks before more loop work', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'ops'], { cwd: dir }).status, 0);
    assert.equal(runCli(['member', 'goal', 'ops', 'Keep the business loop moving', '--acceptance', 'one operator-useful action'], { cwd: dir }).status, 0);
    const tick = runCli(['member', 'tick', 'ops', '--json'], { cwd: dir });
    assert.equal(tick.status, 0, tick.stderr || tick.stdout);
    const experimentId = JSON.parse(tick.stdout).experiment.id;

    const blocked = runCli([
      'member', 'block', 'ops', experimentId,
      '--reason', 'needs customer authority',
      '--ask', 'Approve contacting the customer?',
      '--orchestrator', 'team-hub',
      '--json',
    ], { cwd: dir });
    assert.equal(blocked.status, 0, blocked.stderr || blocked.stdout);
    const blockedPayload = JSON.parse(blocked.stdout);
    assert.equal(blockedPayload.needs_user, true);
    assert.equal(blockedPayload.experiment.status, 'blocked');
    assert.equal(blockedPayload.experiment.block.orchestrator, 'team-hub');

    const status = runCli(['member', 'status', 'ops', '--json'], { cwd: dir });
    assert.equal(status.status, 0, status.stderr || status.stdout);
    const statusPayload = JSON.parse(status.stdout);
    assert.equal(statusPayload.state, 'needs_user');
    assert.equal(statusPayload.needs_user, true);
    assert.equal(statusPayload.ask, 'Approve contacting the customer?');
    assert.match(statusPayload.next_command, /member review ops/);
    assert.ok(statusPayload.recent_log.some((line) => /Approve contacting the customer/.test(line)));

    const paused = runCli(['member', 'tick', 'ops', '--json'], { cwd: dir });
    assert.equal(paused.status, 0, paused.stderr || paused.stdout);
    const pausedPayload = JSON.parse(paused.stdout);
    assert.equal(pausedPayload.action, 'blocked');
    assert.equal(pausedPayload.experiment.id, experimentId);
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'atris', 'team', 'ops', 'goals.json'), 'utf8'));
    assert.equal(state.goals[0].experiments.length, 1);
  } finally {
    cleanupTempDir(dir);
  }
});

test('member block refuses discarded experiments', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'ops'], { cwd: dir }).status, 0);
    assert.equal(runCli(['member', 'goal', 'ops', 'Keep discarded work closed'], { cwd: dir }).status, 0);
    const tick = runCli(['member', 'tick', 'ops', '--json'], { cwd: dir });
    assert.equal(tick.status, 0, tick.stderr || tick.stdout);
    const experimentId = JSON.parse(tick.stdout).experiment.id;

    const discarded = runCli([
      'member', 'review', 'ops', experimentId,
      '--discard',
      '--proof', 'discarded because the experiment was not useful',
      '--json',
    ], { cwd: dir });
    assert.equal(discarded.status, 0, discarded.stderr || discarded.stdout);

    const blocked = runCli([
      'member', 'block', 'ops', experimentId,
      '--reason', 'late blocker',
      '--ask', 'Should not reopen discarded work',
      '--json',
    ], { cwd: dir });
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /already discarded/);

    const state = JSON.parse(fs.readFileSync(path.join(dir, 'atris', 'team', 'ops', 'goals.json'), 'utf8'));
    assert.equal(state.goals[0].experiments.length, 1);
    assert.equal(state.goals[0].experiments[0].status, 'discarded');
    assert.equal(state.goals[0].experiments[0].proof, 'discarded because the experiment was not useful');
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission start tick complete writes durable member-owned state', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'mission-lead'], { cwd: dir }).status, 0);

    const start = runCli([
      'mission', 'start', '--no-verify', 'Make Mission real',
      '--owner', 'mission-lead',
      '--runner', 'codex_goal',
      '--lane', 'code',
      '--cadence', 'manual',
      '--verify', 'node -e "process.exit(0)"',
      '--stop', 'verifier passes',
      '--json',
      '--full',
    ], { cwd: dir });
    assert.equal(start.status, 0, start.stderr || start.stdout);
    const startPayload = JSON.parse(start.stdout);
    assert.equal(startPayload.action, 'mission_started');
    assert.equal(startPayload.mission.owner, 'mission-lead');
    assert.equal(startPayload.mission.runner, 'codex_goal');
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'state', 'missions.jsonl')));
    assert.ok(fs.existsSync(path.join(dir, '.atris', 'state', 'mission_events.jsonl')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'team', 'mission-lead', 'MISSION.md')));
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'team', 'mission-lead', 'now.md')));
	    assert.equal(fs.existsSync(path.join(dir, 'atris', 'team', 'mission-lead', 'missions.md')), false);
	    assert.equal(fs.existsSync(path.join(dir, 'atris', 'team', 'mission-lead', 'missions.json')), false);
	    assert.match(fs.readFileSync(path.join(dir, 'atris', 'team', 'mission-lead', 'now.md'), 'utf8'), /Make Mission real/);
	    const ack = runCli([
	      'mission', 'goal', 'ack', startPayload.mission.id,
	      '--runtime', 'codex',
	      '--status', 'active',
	      '--objective', 'Make Mission real',
	      '--json',
	    ], { cwd: dir });
	    assert.equal(ack.status, 0, ack.stderr || ack.stdout);

	    const tick = runCli(['mission', 'tick', startPayload.mission.id, '--verify', '--json', '--full'], { cwd: dir });
    assert.equal(tick.status, 0, tick.stderr || tick.stdout);
    const tickPayload = JSON.parse(tick.stdout);
    assert.equal(tickPayload.action, 'mission_tick');
    assert.equal(tickPayload.mission.status, 'ready');
    assert.equal(tickPayload.verifier_result.passed, true);
    assert.ok(fs.existsSync(path.join(dir, tickPayload.receipt_path)));

    const complete = runCli(['mission', 'complete', startPayload.mission.id, '--proof', tickPayload.receipt_path, '--json', '--full'], { cwd: dir });
    assert.equal(complete.status, 0, complete.stderr || complete.stdout);
    const completePayload = JSON.parse(complete.stdout);
    assert.equal(completePayload.mission.status, 'complete');

    const status = runCli(['mission', 'status', startPayload.mission.id, '--json'], { cwd: dir });
    assert.equal(status.status, 0, status.stderr || status.stdout);
    const statusPayload = JSON.parse(status.stdout);
    assert.equal(statusPayload.missions[0].status, 'complete');
    assert.match(fs.readFileSync(path.join(dir, 'atris', 'status', 'now.md'), 'utf8'), /Make Mission real/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('always-on mission run keeps ticking after verifier passes', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'mission-lead'], { cwd: dir }).status, 0);

    const start = runCli([
      'mission', 'start', '--no-verify', 'Keep the loop alive',
      '--owner', 'mission-lead',
      '--runner', 'codex_goal',
      '--cadence', 'manual',
      '--verify', 'node -e "process.exit(0)"',
      '--always-on',
      '--json',
    ], { cwd: dir });
	    assert.equal(start.status, 0, start.stderr || start.stdout);
	    const mission = JSON.parse(start.stdout).mission;
	    assert.equal(mission.always_on, true);
	    const ack = runCli([
	      'mission', 'goal', 'ack', mission.id,
	      '--runtime', 'codex',
	      '--status', 'active',
	      '--objective', 'Keep the loop alive',
	      '--json',
	    ], { cwd: dir });
	    assert.equal(ack.status, 0, ack.stderr || ack.stdout);

	    const firstRun = runCli([
      'mission', 'run', mission.id,
      '--max-ticks', '2',
      '--complete-on-pass',
      '--json',
    ], { cwd: dir });
    assert.equal(firstRun.status, 0, firstRun.stderr || firstRun.stdout);
    const firstPayload = JSON.parse(firstRun.stdout);
    assert.equal(firstPayload.ran_ticks, 1);
    assert.equal(firstPayload.tick_count, 1);
    assert.equal(firstPayload.mission.status, 'ready');
    assert.match(firstPayload.mission.next_action, /mission run/);

	    const secondRun = runCli([
      'mission', 'run', mission.id,
      '--max-ticks', '2',
      '--complete-on-pass',
      '--json',
    ], { cwd: dir });
    assert.equal(secondRun.status, 0, secondRun.stderr || secondRun.stdout);
    const payload = JSON.parse(secondRun.stdout);
    assert.equal(payload.ran_ticks, 1);
    assert.equal(payload.tick_count, 1);
    assert.equal(payload.ticks[0].tick_index, 2);
    assert.equal(payload.mission.status, 'ready');
    assert.match(payload.mission.next_action, /mission run/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('mission run bounds errored claude ticks with max-ticks', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'mission-lead'], { cwd: dir }).status, 0);

    const fakeBin = path.join(dir, 'fake-bin');
    fs.mkdirSync(fakeBin, { recursive: true });
    const fakeClaude = path.join(fakeBin, 'claude');
    fs.writeFileSync(fakeClaude, [
      '#!/bin/sh',
      'if [ "$1" = "--help" ]; then',
      '  echo "--output-format --permission-mode --resume --session-id --include-partial-messages"',
      '  exit 0',
      'fi',
      'echo "{\"type\":\"result\",\"is_error\":true,\"result\":\"boom\"}"',
      'exit 1',
      '',
    ].join('\n'), 'utf8');
    fs.chmodSync(fakeClaude, 0o755);
    const env = { PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}` };

    const start = runCli([
      'mission', 'start', '--no-verify', 'Bound failed worker attempts',
      '--owner', 'mission-lead',
      '--runner', 'claude',
      '--cadence', 'manual',
      '--verify', 'node -e "process.exit(0)"',
      '--always-on',
      '--json',
    ], { cwd: dir, env });
    assert.equal(start.status, 0, start.stderr || start.stdout);
    const mission = JSON.parse(start.stdout).mission;

    const run = runCli([
      'mission', 'run', mission.id,
      '--max-ticks', '1',
      '--json',
    ], { cwd: dir, env });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.ran_ticks, 0);
    assert.equal(payload.tick_count, 1);
    assert.equal(payload.ticks[0].status, 'errored');
    assert.equal(payload.ticks[0].reason, 'claude-error');
    assert.equal(payload.pause_reason, 'max-ticks-reached');
    assert.equal(payload.mission.status, 'paused');
    assert.equal(payload.mission.stop_reason, 'max-ticks-reached');
  } finally {
    cleanupTempDir(dir);
  }
});

test('member run --minutes scales max-ticks past a single tick, untimed stays at one', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'mission-lead'], { cwd: dir }).status, 0);

    const fakeBin = path.join(dir, 'fake-bin');
    fs.mkdirSync(fakeBin, { recursive: true });
    const fakeClaude = path.join(fakeBin, 'claude');
    // Runner succeeds every tick; the verifier always fails. That drives the
    // 'consecutive-verifier-fails' breaker (trips at 2) with no error-backoff
    // sleep, so the loop is fast and its tick count is fully observable.
    fs.writeFileSync(fakeClaude, [
      '#!/bin/sh',
      'if [ "$1" = "--help" ]; then',
      '  echo "--output-format --permission-mode --resume --session-id --include-partial-messages"',
      '  exit 0',
      'fi',
      'echo "{\"type\":\"result\",\"is_error\":false,\"result\":\"did work\"}"',
      'exit 0',
      '',
    ].join('\n'), 'utf8');
    fs.chmodSync(fakeClaude, 0o755);
    const env = { PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}` };

    const startMission = (title) => {
      const start = runCli([
        'mission', 'start', '--no-verify', title,
        '--owner', 'mission-lead',
        '--runner', 'claude',
        '--cadence', 'manual',
        '--verify', 'node -e "process.exit(1)"',
        '--json',
      ], { cwd: dir, env });
      assert.equal(start.status, 0, start.stderr || start.stdout);
      return JSON.parse(start.stdout).mission;
    };

    // The verifier fails each tick, so the loop stops at min(max-ticks, 2):
    //   max-ticks 1 -> exactly 1 tick (a lone tick can never break the streak)
    //   max-ticks >1 -> 2 ticks, then 'consecutive-verifier-fails'
    // An untimed run keeps the single-tick default; a timed run must loop.
    const untimed = startMission('untimed member run defaults to one tick');
    const untimedRun = runCli(['member', 'run', 'mission-lead', '--mission-id', untimed.id, '--json'], { cwd: dir, env });
    // The check fails on purpose, so the run exits 1 and says so.
    assert.equal(untimedRun.status, 1, untimedRun.stderr || untimedRun.stdout);
    assert.equal(JSON.parse(untimedRun.stdout).check_failed, true);
    const untimedPayload = JSON.parse(untimedRun.stdout);
    // With max-ticks 1 it is impossible to tick more than once.
    assert.equal(untimedPayload.tick_count, 1);
    assert.equal(untimedPayload.ran_ticks, 1);

    const timed = startMission('timed member run loops for the budget');
    const timedRun = runCli(['member', 'run', 'mission-lead', '--mission-id', timed.id, '--minutes', '10', '--json'], { cwd: dir, env, timeout: 60000 });
    // The check fails on purpose, so the run exits 1 and says so.
    assert.equal(timedRun.status, 1, timedRun.stderr || timedRun.stdout);
    assert.equal(JSON.parse(timedRun.stdout).check_failed, true);
    const timedPayload = JSON.parse(timedRun.stdout);
    // max(4, ceil(600/300)) = 4 > 1, so it ticks past one before the breaker trips.
    // The old default of max-ticks 1 could never reach a second tick.
    assert.equal(timedPayload.tick_count, 2);
    assert.equal(timedPayload.ran_ticks, 2);
    assert.equal(timedPayload.pause_reason, 'consecutive-verifier-fails');
  } finally {
    cleanupTempDir(dir);
  }
});

test('allowed rate-limit info with a future resetsAt does not pause a timed run', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'mission-lead'], { cwd: dir }).status, 0);

    const fakeBin = path.join(dir, 'fake-bin');
    fs.mkdirSync(fakeBin, { recursive: true });
    const fakeClaude = path.join(fakeBin, 'claude');
    // Claude reports the five-hour window's resetsAt on every turn even when
    // status is "allowed" (resetsAt here is year 2100, far past any wall).
    // Only a non-allowed status is a real cooldown; an allowed one must not
    // pause the run with rate-limit-exceeded-wall after tick 1.
    fs.writeFileSync(fakeClaude, [
      '#!/bin/sh',
      'if [ "$1" = "--help" ]; then',
      '  echo "--output-format --permission-mode --resume --session-id --include-partial-messages"',
      '  exit 0',
      'fi',
      "echo '{\"type\":\"rate_limit_event\",\"rate_limit_info\":{\"status\":\"allowed\",\"resetsAt\":4102444800,\"rateLimitType\":\"five_hour\"}}'",
      "echo '{\"type\":\"result\",\"is_error\":false,\"result\":\"did work\"}'",
      'exit 0',
      '',
    ].join('\n'), 'utf8');
    fs.chmodSync(fakeClaude, 0o755);
    const env = { PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}` };

    const start = runCli([
      'mission', 'start', '--no-verify', 'timed run survives allowed rate-limit info',
      '--owner', 'mission-lead',
      '--runner', 'claude',
      '--cadence', 'manual',
      '--json',
    ], { cwd: dir, env });
    assert.equal(start.status, 0, start.stderr || start.stdout);
    const mission = JSON.parse(start.stdout).mission;

    const run = runCli(['member', 'run', 'mission-lead', '--mission-id', mission.id, '--minutes', '10', '--no-verify', '--json'], { cwd: dir, env });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const payload = JSON.parse(run.stdout);
    // The allowed-status window must never become a rate-limit pause. This
    // fixture repeats the same result, so the independent repeated-summary
    // breaker stops it after three attempts.
    assert.notEqual(payload.pause_reason, 'rate-limit-exceeded-wall');
    assert.equal(payload.tick_count, 3);
    assert.equal(payload.ran_ticks, 3);
    assert.equal(payload.pause_reason, 'stuck-repeating');
  } finally {
    cleanupTempDir(dir);
  }
});

test('member ping reaches the next tick prompt exactly once', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'mission-lead'], { cwd: dir }).status, 0);

    const fakeBin = path.join(dir, 'fake-bin');
    fs.mkdirSync(fakeBin, { recursive: true });
    const fakeClaude = path.join(fakeBin, 'claude');
    const promptDump = path.join(dir, 'tick-prompt.txt');
    // Dump the -p prompt so the test can assert what the tick actually saw.
    fs.writeFileSync(fakeClaude, [
      '#!/bin/sh',
      'if [ "$1" = "--help" ]; then',
      '  echo "--output-format --permission-mode --resume --session-id --include-partial-messages"',
      '  exit 0',
      'fi',
      `printf '%s' "$2" > "${promptDump}"`,
      "echo '{\"type\":\"result\",\"is_error\":false,\"result\":\"did work\"}'",
      'exit 0',
      '',
    ].join('\n'), 'utf8');
    fs.chmodSync(fakeClaude, 0o755);
    const env = { PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}` };

    const start = runCli([
      'mission', 'start', '--no-verify', 'always-on member you can text',
      '--owner', 'mission-lead',
      '--runner', 'claude',
      '--cadence', 'manual',
      '--json',
    ], { cwd: dir, env });
    assert.equal(start.status, 0, start.stderr || start.stdout);
    const mission = JSON.parse(start.stdout).mission;

    // ping by member name — it must resolve to the live mission
    const ping = runCli(['member', 'ping', 'mission-lead', 'ship the login fix first'], { cwd: dir, env });
    assert.equal(ping.status, 0, ping.stderr || ping.stdout);
    assert.match(ping.stdout, /1 unread/);

    const run = runCli(['member', 'run', 'mission-lead', '--mission-id', mission.id, '--max-ticks', '1', '--json'], { cwd: dir, env });
    assert.equal(run.status, 0, run.stderr || run.stdout);

    const prompt = fs.readFileSync(promptDump, 'utf8');
    assert.match(prompt, /Operator pings \(read these first\)/);
    assert.match(prompt, /ship the login fix first/);

    // consumed: a second run's prompt must not repeat it
    const run2 = runCli(['member', 'run', 'mission-lead', '--mission-id', mission.id, '--max-ticks', '1', '--json'], { cwd: dir, env });
    assert.equal(run2.status, 0, run2.stderr || run2.stdout);
    const prompt2 = fs.readFileSync(promptDump, 'utf8');
    assert.doesNotMatch(prompt2, /ship the login fix first/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('stale session lock rotates to a fresh session instead of grinding the error breaker', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'mission-lead'], { cwd: dir }).status, 0);

    const fakeBin = path.join(dir, 'fake-bin');
    fs.mkdirSync(fakeBin, { recursive: true });
    const fakeClaude = path.join(fakeBin, 'claude');
    const busyMarker = path.join(dir, 'resume-failed-once');
    // The first --resume fails the way a killed tick's stale lock does; every
    // other call succeeds and confirms the requested session id. A run that
    // rotates recovers on the next tick; one that keeps resuming the locked id
    // would have died here before the rotation existed.
    fs.writeFileSync(fakeClaude, [
      '#!/bin/sh',
      'if [ "$1" = "--help" ]; then',
      '  echo "--output-format --permission-mode --resume --session-id --include-partial-messages"',
      '  exit 0',
      'fi',
      'mode=""; sid=""; prev=""',
      'for a in "$@"; do',
      '  if [ "$prev" = "--session-id" ]; then mode=set; sid="$a"; fi',
      '  if [ "$prev" = "--resume" ]; then mode=resume; sid="$a"; fi',
      '  prev="$a"',
      'done',
      `if [ "$mode" = "resume" ] && [ ! -f "${busyMarker}" ]; then`,
      `  touch "${busyMarker}"`,
      '  echo "Error: Session ID $sid is already in use." >&2',
      '  exit 1',
      'fi',
      'echo "{\\"type\\":\\"result\\",\\"is_error\\":false,\\"result\\":\\"did work\\",\\"session_id\\":\\"$sid\\"}"',
      'exit 0',
      '',
    ].join('\n'), 'utf8');
    fs.chmodSync(fakeClaude, 0o755);
    const env = { PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}` };

    const start = runCli([
      'mission', 'start', '--no-verify', 'stale session lock rotates instead of pausing',
      '--owner', 'mission-lead',
      '--runner', 'claude',
      '--cadence', 'manual',
      '--verify', 'node -e "process.exit(1)"',
      '--json',
    ], { cwd: dir, env });
    assert.equal(start.status, 0, start.stderr || start.stdout);
    const mission = JSON.parse(start.stdout).mission;

    const run = runCli(['member', 'run', 'mission-lead', '--mission-id', mission.id, '--minutes', '10', '--json'], { cwd: dir, env });
    // The check fails on purpose, so the run exits 1 and says so.
    assert.equal(run.status, 1, run.stderr || run.stdout);
    assert.equal(JSON.parse(run.stdout).check_failed, true);
    const payload = JSON.parse(run.stdout);
    // Tick 1 ran with a verifier failure. Tick 2 hit the stale lock, retried
    // immediately on a fresh session, then ran with the second verifier
    // failure. The failed resume is not recorded as its own errored tick.
    assert.equal(payload.pause_reason, 'consecutive-verifier-fails');
    assert.equal(payload.tick_count, 2);
    assert.equal(payload.ran_ticks, 2);

    // The rotation is visible as a retry event, while mission tick history has
    // no standalone claude-session-busy error row.
    const stateLog = fs.readFileSync(path.join(dir, '.atris', 'state', 'missions.jsonl'), 'utf8');
    assert.doesNotMatch(stateLog, /"last_tick_reason":"claude-session-busy"/);
    const eventLog = fs.readFileSync(path.join(dir, '.atris', 'state', 'mission_events.jsonl'), 'utf8');
    assert.match(eventLog, /session-lock-busy-retry/);
    const sessionIds = new Set([...stateLog.matchAll(/"claude_session_id":"([0-9a-f-]+)"/g)].map((m) => m[1]));
    assert.equal(sessionIds.size, 2, `expected a rotated second session id, saw: ${[...sessionIds].join(', ')}`);
  } finally {
    cleanupTempDir(dir);
  }
});

test('a resume against a vanished session rotates instead of grinding the error breaker', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'mission-lead'], { cwd: dir }).status, 0);

    const fakeBin = path.join(dir, 'fake-bin');
    fs.mkdirSync(fakeBin, { recursive: true });
    const fakeClaude = path.join(fakeBin, 'claude');
    const goneMarker = path.join(dir, 'resume-failed-once');
    // The first --resume fails the way a cleaned-up session does: the stored id
    // resolves to no conversation. Every other call succeeds. Without the
    // rotation the run would grind claude-error until the breaker paused it.
    fs.writeFileSync(fakeClaude, [
      '#!/bin/sh',
      'if [ "$1" = "--help" ]; then',
      '  echo "--output-format --permission-mode --resume --session-id --include-partial-messages"',
      '  exit 0',
      'fi',
      'mode=""; sid=""; prev=""',
      'for a in "$@"; do',
      '  if [ "$prev" = "--session-id" ]; then mode=set; sid="$a"; fi',
      '  if [ "$prev" = "--resume" ]; then mode=resume; sid="$a"; fi',
      '  prev="$a"',
      'done',
      `if [ "$mode" = "resume" ] && [ ! -f "${goneMarker}" ]; then`,
      `  touch "${goneMarker}"`,
      '  echo "No conversation found with session ID: $sid" >&2',
      '  exit 1',
      'fi',
      'echo "{\\"type\\":\\"result\\",\\"is_error\\":false,\\"result\\":\\"did work\\",\\"session_id\\":\\"$sid\\"}"',
      'exit 0',
      '',
    ].join('\n'), 'utf8');
    fs.chmodSync(fakeClaude, 0o755);
    const env = { PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}` };

    const start = runCli([
      'mission', 'start', '--no-verify', 'vanished session rotates instead of pausing',
      '--owner', 'mission-lead',
      '--runner', 'claude',
      '--cadence', 'manual',
      '--verify', 'node -e "process.exit(1)"',
      '--json',
    ], { cwd: dir, env });
    assert.equal(start.status, 0, start.stderr || start.stdout);
    const mission = JSON.parse(start.stdout).mission;

    const run = runCli(['member', 'run', 'mission-lead', '--mission-id', mission.id, '--minutes', '10', '--json'], { cwd: dir, env });
    // The check fails on purpose, so the run exits 1 and says so.
    assert.equal(run.status, 1, run.stderr || run.stdout);
    assert.equal(JSON.parse(run.stdout).check_failed, true);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.pause_reason, 'consecutive-verifier-fails');

    const stateLog = fs.readFileSync(path.join(dir, '.atris', 'state', 'missions.jsonl'), 'utf8');
    assert.match(stateLog, /claude-session-busy/);
    const sessionIds = new Set([...stateLog.matchAll(/"claude_session_id":"([0-9a-f-]+)"/g)].map((m) => m[1]));
    assert.equal(sessionIds.size, 2, `expected a rotated second session id, saw: ${[...sessionIds].join(', ')}`);
  } finally {
    cleanupTempDir(dir);
  }
});

test('healthy claude sessions rotate for context refresh after N ran ticks', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(runCli(['member', 'create', 'mission-lead'], { cwd: dir }).status, 0);

    const fakeBin = path.join(dir, 'fake-bin');
    fs.mkdirSync(fakeBin, { recursive: true });
    const fakeClaude = path.join(fakeBin, 'claude');
    // Every call succeeds and confirms the requested session id — no failures.
    // Rotation must come from the context-refresh counter alone.
    fs.writeFileSync(fakeClaude, [
      '#!/bin/sh',
      'if [ "$1" = "--help" ]; then',
      '  echo "--output-format --permission-mode --resume --session-id --include-partial-messages"',
      '  exit 0',
      'fi',
      'sid=""; prev=""',
      'for a in "$@"; do',
      '  if [ "$prev" = "--session-id" ]; then sid="$a"; fi',
      '  if [ "$prev" = "--resume" ]; then sid="$a"; fi',
      '  prev="$a"',
      'done',
      'echo "{\\"type\\":\\"result\\",\\"is_error\\":false,\\"result\\":\\"did work\\",\\"session_id\\":\\"$sid\\"}"',
      'exit 0',
      '',
    ].join('\n'), 'utf8');
    fs.chmodSync(fakeClaude, 0o755);
    const env = {
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
      ATRIS_CLAUDE_SESSION_ROTATE_TICKS: '2',
    };

    // Explicitly skip the fallback verifier so ticks keep running to max-ticks
    // and the third tick can mint the fresh session the rotation cleared for.
    const start = runCli([
      'mission', 'start', '--no-verify', 'healthy sessions rotate for context refresh',
      '--owner', 'mission-lead',
      '--runner', 'claude',
      '--cadence', 'manual',
      '--json',
    ], { cwd: dir, env });
    assert.equal(start.status, 0, start.stderr || start.stdout);
    const mission = JSON.parse(start.stdout).mission;

    const run = runCli(['mission', 'run', mission.id, '--max-ticks', '3', '--max-wall', '120', '--no-verify', '--json'], { cwd: dir, env });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.ran_ticks, 3, run.stdout);

    // Rotation event: fires after tick 2 (threshold 2) with the context reason.
    const eventsLog = fs.readFileSync(path.join(dir, '.atris', 'state', 'mission_events.jsonl'), 'utf8');
    assert.match(eventsLog, /mission_session_rotated/);
    assert.match(eventsLog, /context-refresh/);

    // Tick 2's record zeroes the counter and drops the session; tick 3 runs on
    // a fresh id, so two distinct session ids appear despite zero failures.
    const stateLog = fs.readFileSync(path.join(dir, '.atris', 'state', 'missions.jsonl'), 'utf8');
    const sessionIds = new Set([...stateLog.matchAll(/"claude_session_id":"([0-9a-f-]+)"/g)].map((m) => m[1]));
    assert.equal(sessionIds.size, 2, `expected a fresh session after rotation, saw: ${[...sessionIds].join(', ')}`);
  } finally {
    cleanupTempDir(dir);
  }
});

// ============================================
// version
// ============================================

test('version prints atris v<semver>', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['version'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout.trim(), /^atris v\d+\.\d+\.\d+$/);
  } finally {
    cleanupTempDir(dir);
  }
});

// ============================================
// live
// ============================================

test('live help exposes fresh brain command', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['live', '--help'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Usage: atris live \[business\]/);
    assert.match(res.stdout, /Keeps a business brain fresh/);
    assert.match(res.stdout, /--debounce/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('live dry-run prints doctor pull push plan without credentials', () => {
  const dir = makeTempDir();
  try {
    const res = runCli(['live', 'acme', '--dry-run', '--once', '--only', 'atris/MAP.md'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Atris Live: acme/);
    assert.match(res.stdout, /dry-run: atris business doctor --fix/);
    assert.match(res.stdout, /dry-run: atris push acme --from/);
    assert.match(res.stdout, /dry-run: atris pull acme --timeout 600 --only atris\/MAP\.md/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('live options infer slug from business workspace and parse timing', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'business.json'), JSON.stringify({ slug: 'parked' }), 'utf8');
    const options = parseLiveOptions(['--once', '--interval=7', '--debounce', '3', '--timeout=44'], dir);
    assert.equal(options.slug, 'parked');
    assert.equal(options.once, true);
    assert.equal(options.intervalSec, 7);
    assert.equal(options.debounceSec, 3);
    assert.equal(options.timeoutSec, 44);
  } finally {
    cleanupTempDir(dir);
  }
});

test('live options resolve explicit slug to child workspace from portfolio root', () => {
  const dir = makeTempDir();
  try {
    const child = path.join(dir, 'acme');
    fs.mkdirSync(path.join(child, '.atris'), { recursive: true });
    fs.mkdirSync(path.join(child, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(child, '.atris', 'business.json'), JSON.stringify({ slug: 'acme' }), 'utf8');

    const options = parseLiveOptions(['acme', '--once'], dir);
    assert.equal(options.slug, 'acme');
    assert.equal(options.cwd, child);
    assert.equal(options.root, dir);
  } finally {
    cleanupTempDir(dir);
  }
});

test('live snapshot detects meaningful file changes and ignores runtime state', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), '# Map\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'state', '_sync.json'), '{}', 'utf8');

    const before = collectSnapshot(dir);
    fs.writeFileSync(path.join(dir, '.atris', 'state', '_sync.json'), '{"x":1}', 'utf8');
    assert.equal(snapshotsDiffer(before, collectSnapshot(dir)), false);

    fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), '# Map\n\nupdated\n', 'utf8');
    assert.equal(snapshotsDiffer(before, collectSnapshot(dir)), true);
    assert.equal(shouldIgnore(path.join('.atris', 'state', '_sync.json')), true);
    assert.equal(shouldIgnore(path.join('atris', 'MAP.md')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

// ============================================
// push
// ============================================

test('push source resolver keeps pulled business folder as root', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, '.atris'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'business.json'), JSON.stringify({ slug: 'example-co' }), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), '# Map\n', 'utf8');

    assert.equal(
      resolvePushSourceDir({ slug: 'example-co', cwd: dir, argv: ['node', 'atris', 'push', 'example-co'] }),
      dir
    );
  } finally {
    cleanupTempDir(dir);
  }
});

test('push source resolver honors explicit --from path', () => {
  const dir = makeTempDir();
  try {
    const source = path.join(dir, 'custom-root');
    fs.mkdirSync(source, { recursive: true });

    assert.equal(
      resolvePushSourceDir({ slug: 'example-co', cwd: dir, argv: ['node', 'atris', 'push', 'example-co', '--from', './custom-root'] }),
      source
    );
  } finally {
    cleanupTempDir(dir);
  }
});

test('push ignores dotfile basenames when considering cloud deletes', () => {
  assert.equal(basenameOfManifestPath('/journal/.gitkeep'), '.gitkeep');
  assert.equal(basenameOfManifestPath('/atris/MAP.md'), 'MAP.md');
});

test('sync hash walker keeps dot-directory workspace files without scanning state dirs', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.next', 'cache'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.git', 'objects'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'build'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'tmp'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.github', 'workflows', 'ci.yml'), 'name: ci\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), '{"private":true}\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.next', 'cache', 'artifact.txt'), 'ignored\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.git', 'config'), 'ignored\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.atris', 'state', 'tasks.json'), 'ignored\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'dist', 'app.js'), 'ignored\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'build', 'app.js'), 'ignored\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'tmp', 'scratch.md'), 'ignored\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.env'), 'ignored\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'assets', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));

    const hashes = computeLocalHashes(dir);
    assert.ok(hashes['/.github/workflows/ci.yml']);
    assert.ok(hashes['/README.md']);
    assert.equal(hashes['/.claude/settings.local.json'], undefined);
    assert.equal(hashes['/.next/cache/artifact.txt'], undefined);
    assert.equal(hashes['/.git/config'], undefined);
    assert.equal(hashes['/.atris/state/tasks.json'], undefined);
    assert.equal(hashes['/dist/app.js'], undefined);
    assert.equal(hashes['/build/app.js'], undefined);
    assert.equal(hashes['/tmp/scratch.md'], undefined);
    assert.equal(hashes['/.env'], undefined);
    assert.equal(hashes['/assets/logo.png'], undefined);
  } finally {
    cleanupTempDir(dir);
  }
});

test('sync comparison filters ignored generated paths from remote and manifest', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'wiki'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'wiki', 'doc.md'), 'hello\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'dist', 'app.js'), 'generated\n', 'utf8');

    const localFiles = computeLocalHashes(dir);
    const doc = localFiles['/atris/wiki/doc.md'];
    const legacyManifest = {
      files: {
        '/atris/wiki/doc.md': doc,
        '/dist/app.js': { hash: 'old-generated', size: 9 },
      },
    };
    const remoteFiles = {
      '/atris/wiki/doc.md': doc,
      '/dist/app.js': { hash: 'remote-generated', size: 10 },
    };

    const diff = threeWayCompare(localFiles, remoteFiles, legacyManifest);
    assert.deepEqual(diff.deletedLocal, []);
    assert.deepEqual(diff.conflicts, []);
    assert.deepEqual(diff.unchanged, ['/atris/wiki/doc.md']);

    const manifest = buildManifest(remoteFiles, 'commit123', { workspaceRoot: dir });
    assert.equal(manifest.files['/dist/app.js'], undefined);
    assert.deepEqual(Object.keys(manifest.files), ['/atris/wiki/doc.md']);
  } finally {
    cleanupTempDir(dir);
  }
});

test('push normalizes cloud snapshot paths before drift checks', () => {
  assert.deepEqual(buildCloudHashMap([
    { path: 'atris/wiki/a.md', hash: 'one' },
    { path: '/README.md', hash: 'two' },
  ]), {
    '/atris/wiki/a.md': 'one',
    '/README.md': 'two',
  });
});

test('push planner publishes only scoped local brain creates and updates', () => {
  const plan = buildPushChangePlan({
    onlyPrefixes: ['/atris/'],
    baseFiles: {
      '/atris/wiki/existing.md': { hash: 'base', size: 4 },
      '/README.md': { hash: 'outside-base', size: 12 },
    },
    localFiles: {
      '/atris/wiki/existing.md': { hash: 'changed', size: 7 },
      '/atris/wiki/new.md': { hash: 'new', size: 3 },
      '/README.md': { hash: 'outside-changed', size: 15 },
    },
    readFileContent: (filePath) => `content:${filePath}`,
  });

  assert.deepEqual(plan.filesToPush.map(file => file.path).sort(), [
    '/atris/wiki/existing.md',
    '/atris/wiki/new.md',
  ]);
  assert.equal(plan.filesToPush[0].content.startsWith('content:/atris/'), true);
  assert.deepEqual(plan.deletedPaths, []);
  assert.equal(plan.unchangedCount, 0);
});

test('push planner reports unchanged scoped files when already up to date', () => {
  const plan = buildPushChangePlan({
    onlyPrefixes: ['/atris/wiki/'],
    baseFiles: {
      '/atris/wiki/index.md': { hash: 'same', size: 10 },
      '/atris/TODO.md': { hash: 'outside', size: 8 },
    },
    localFiles: {
      '/atris/wiki/index.md': { hash: 'same', size: 10 },
      '/atris/TODO.md': { hash: 'changed-outside', size: 14 },
    },
    readFileContent: () => '',
  });

  assert.deepEqual(plan.filesToPush, []);
  assert.deepEqual(plan.deletedPaths, []);
  assert.equal(plan.unchangedCount, 1);
});

test('push planner treats scoped local deletes as gated deletes and ignores parent junk', () => {
  const plan = buildPushChangePlan({
    onlyPrefixes: ['/atris/'],
    baseFiles: {
      '/atris/wiki/delete-me.md': { hash: 'base', size: 4 },
      '/atris/.shadow': { hash: 'dot', size: 3 },
      '/TODO.md': { hash: 'parent', size: 6 },
    },
    localFiles: {
      '/TODO.md': { hash: 'parent-changed', size: 9 },
    },
    readFileContent: () => '',
  });

  assert.deepEqual(plan.filesToPush, []);
  assert.deepEqual(plan.deletedPaths, ['/atris/wiki/delete-me.md']);
  assert.equal(plan.unchangedCount, 0);
});

test('push planner ignores stale manifest entries from skipped local dirs', () => {
  const plan = buildPushChangePlan({
    baseFiles: {
      '/dist/app.js': { hash: 'old-dist', size: 9 },
      '/build/app.js': { hash: 'old-build', size: 10 },
      '/tmp/scratch.md': { hash: 'old-tmp', size: 11 },
      '/.atris/state/tasks.projection.json': { hash: 'old-state', size: 12 },
      '/assets/logo.png': { hash: 'old-binary', size: 12 },
      '/atris/wiki/delete-me.md': { hash: 'base', size: 4 },
    },
    localFiles: {},
    readFileContent: () => '',
    isLocalFilePresent: (filePath) => filePath === '/assets/logo.png',
  });

  assert.deepEqual(plan.filesToPush, []);
  assert.deepEqual(plan.deletedPaths, ['/atris/wiki/delete-me.md']);
});

test('push retries multi-file server failures individually but not access or sleeping states', () => {
  assert.equal(shouldRetrySyncIndividually({ ok: false, status: 500 }, [{ path: '/a.md' }, { path: '/b.md' }]), true);
  assert.equal(shouldRetrySyncIndividually({ ok: false, status: 502 }, [{ path: '/a.md' }, { path: '/b.md' }]), true);
  assert.equal(shouldRetrySyncIndividually({ ok: false, status: 500 }, [{ path: '/a.md' }]), false);
  assert.equal(shouldRetrySyncIndividually({ ok: false, status: 403 }, [{ path: '/a.md' }, { path: '/b.md' }]), false);
  assert.equal(shouldRetrySyncIndividually({ ok: false, status: 409 }, [{ path: '/a.md' }, { path: '/b.md' }]), false);
  assert.equal(shouldRetrySyncIndividually({ ok: true, status: 200 }, [{ path: '/a.md' }, { path: '/b.md' }]), false);
});

test('push safety blocks nested workspace pollution and sync artifacts', () => {
  const report = analyzePushSafety({
    slug: 'acme',
    filesToPush: [
      { path: '/acme/atris/now.md' },
      { path: '/CLAUDE.md.remote' },
    ],
    unchangedCount: 30,
  });

  assert.equal(report.ok, false);
  assert.match(report.reasons.join('\n'), /nested workspace folder/);
  assert.match(report.reasons.join('\n'), /sync review artifacts/);
});

test('push safety blocks large unscoped dirty workspace plans', () => {
  const report = analyzePushSafety({
    slug: 'acme',
    filesToPush: Array.from({ length: 30 }, (_, i) => ({ path: `/atris/wiki/file-${i}.md` })),
    unchangedCount: 296,
  });

  assert.equal(report.ok, false);
  assert.match(report.reasons.join('\n'), /large unscoped workspace change/);
});

test('push safety allows exact scoped repair pushes', () => {
  const report = analyzePushSafety({
    slug: 'acme',
    onlyPrefixes: ['/atris/now.md'],
    filesToPush: [{ path: '/atris/now.md' }],
    unchangedCount: 1,
  });

  assert.equal(report.ok, true);
});

test('business workspace root detection requires .atris binding and atris folder', () => {
  const dir = makeTempDir();
  try {
    assert.equal(isBusinessWorkspaceRoot(dir), false);
    fs.mkdirSync(path.join(dir, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'business.json'), '{}', 'utf8');
    assert.equal(isBusinessWorkspaceRoot(dir), false);
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    assert.equal(isBusinessWorkspaceRoot(dir), true);
  } finally {
    cleanupTempDir(dir);
  }
});

test('manifest records workspace root metadata', () => {
  const manifest = buildManifest({ '/atris/MAP.md': { hash: 'abc', size: 3 } }, 'commit123', {
    workspaceRoot: '/tmp/example-co',
  });

  assert.equal(manifest.workspace_root, '/tmp/example-co');
  assert.equal(manifest.last_commit, 'commit123');
  assert.equal(manifest.files['/atris/MAP.md'].hash, 'abc');
});

test('business sync plan pulls safely then pushes wiki scope through normal push', () => {
  const options = parseBusinessSyncArgs(['example-co']);
  assert.deepEqual(options, {
    slug: 'example-co',
    dryRun: false,
    timeout: '120',
    allowDelete: false,
    watch: false,
    intervalSec: 60,
    debounceSec: 5,
    status: false,
    review: false,
    resolve: null,
    resolvePath: null,
    take: null,
    showOrphans: false,
    help: false,
  });
  assert.deepEqual(buildBusinessSyncPlan(options), {
    pullArgs: ['pull', 'example-co', '--keep-local', '--fail-on-conflict', '--timeout', '120'],
    pushArgs: ['push', 'example-co'],
  });
});

test('business sync auto-detects slug from business workspace', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'business.json'), JSON.stringify({ slug: 'example-co' }), 'utf8');
    const options = resolveBusinessSyncOptions(['--dry-run'], dir);
    assert.equal(options.slug, 'example-co');
    assert.equal(options.dryRun, true);
  } finally {
    cleanupTempDir(dir);
  }
});

test('business sync plan supports dry-run and explicit delete opt-in', () => {
  const options = parseBusinessSyncArgs(['example-co', '--timeout', '240', '--dry-run', '--delete', '--watch', '--interval=30', '--debounce', '2']);
  assert.equal(options.watch, true);
  assert.equal(options.intervalSec, 30);
  assert.equal(options.debounceSec, 2);
  assert.equal(options.status, false);
  assert.equal(options.review, false);
  assert.equal(options.resolve, null);
  assert.equal(options.help, false);
  assert.deepEqual(buildBusinessSyncPlan(options), {
    pullArgs: ['pull', 'example-co', '--keep-local', '--fail-on-conflict', '--timeout', '240', '--dry-run'],
    pushArgs: ['push', 'example-co', '--dry-run', '--delete'],
  });
});

test('business sync resolve applies local or cloud conflict artifacts to workspace files', () => {
  const dir = makeTempDir();
  try {
    const conflictRoot = path.join(dir, '.atris', 'sync', 'conflicts', '2026-05-01T12-00-00Z');
    const packetDir = path.join(conflictRoot, 'atris', 'wiki');

    function writePacket(overrides = {}) {
      const packet = {
        aBase: 'base copy\n',
        aLocal: 'local copy\n',
        aRemote: 'cloud copy\n',
        readmeBase: 'base readme\n',
        readmeLocal: 'local readme\n',
        readmeRemote: 'cloud readme\n',
        ...overrides,
      };
      fs.rmSync(conflictRoot, { recursive: true, force: true });
      fs.mkdirSync(packetDir, { recursive: true });
      fs.writeFileSync(path.join(packetDir, 'a.md.base'), packet.aBase, 'utf8');
      fs.writeFileSync(path.join(packetDir, 'a.md.local'), packet.aLocal, 'utf8');
      fs.writeFileSync(path.join(packetDir, 'a.md.remote'), packet.aRemote, 'utf8');
      fs.writeFileSync(path.join(conflictRoot, 'README.md.base'), packet.readmeBase, 'utf8');
      fs.writeFileSync(path.join(conflictRoot, 'README.md.local'), packet.readmeLocal, 'utf8');
      fs.writeFileSync(path.join(conflictRoot, 'README.md.remote'), packet.readmeRemote, 'utf8');
      fs.writeFileSync(path.join(conflictRoot, 'summary.md'), '# Review\n', 'utf8');
      fs.mkdirSync(path.join(dir, 'atris', 'wiki'), { recursive: true });
      for (const rel of ['atris/wiki/a.md.remote', 'atris/wiki/a.md.local', 'README.md.remote']) {
        fs.writeFileSync(path.join(dir, rel), 'workspace sidecar\n', 'utf8');
      }
    }

    writePacket();
    const entries = collectConflictResolutionEntries(dir);
    assert.deepEqual(entries.map((entry) => entry.targetRel).sort(), ['README.md', 'atris/wiki/a.md']);

    const local = resolveLatestConflict(dir, 'local');
    assert.deepEqual(local.resolved.sort(), ['README.md', 'atris/wiki/a.md']);
    assert.equal(fs.readFileSync(path.join(dir, 'atris', 'wiki', 'a.md'), 'utf8'), 'local copy\n');
    assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), 'local readme\n');
    assert.equal(fs.existsSync(path.join(dir, 'atris', 'wiki', 'a.md.remote')), false);
    assert.equal(fs.existsSync(path.join(dir, 'atris', 'wiki', 'a.md.local')), false);
    assert.equal(fs.existsSync(path.join(dir, 'README.md.remote')), false);
    assert.equal(fs.existsSync(path.join(conflictRoot, 'summary.md')), false);

    writePacket();
    const cloud = resolveLatestConflict(dir, 'cloud');
    assert.deepEqual(cloud.resolved.sort(), ['README.md', 'atris/wiki/a.md']);
    assert.equal(fs.readFileSync(path.join(dir, 'atris', 'wiki', 'a.md'), 'utf8'), 'cloud copy\n');
    assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), 'cloud readme\n');
    assert.match(cloud.message, /atris sync --dry-run/);

    writePacket();
    const both = resolveLatestConflict(dir, 'both');
    assert.deepEqual(both.resolved.sort(), ['README.md', 'atris/wiki/a.md']);
    assert.equal(fs.readFileSync(path.join(dir, 'atris', 'wiki', 'a.md'), 'utf8'), 'local copy\n');
    assert.equal(fs.readFileSync(path.join(dir, 'atris', 'wiki', 'a.md.cloud'), 'utf8'), 'cloud copy\n');
    assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), 'local readme\n');
    assert.equal(fs.readFileSync(path.join(dir, 'README.md.cloud'), 'utf8'), 'cloud readme\n');
    assert.match(both.message, /both versions/);

    writePacket({
      aBase: 'A\nB\nC\n',
      aLocal: 'A\nB local\nC\n',
      aRemote: 'A\nB\nC cloud\n',
      readmeBase: 'A\nB\nC\n',
      readmeLocal: 'A\nB local\nC\n',
      readmeRemote: 'A\nB\nC cloud\n',
    });
    const merge = resolveLatestConflict(dir, 'merge');
    assert.deepEqual(merge.resolved.sort(), ['README.md', 'atris/wiki/a.md']);
    assert.equal(fs.readFileSync(path.join(dir, 'atris', 'wiki', 'a.md'), 'utf8'), 'A\nB local\nC cloud\n');
    assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), 'A\nB local\nC cloud\n');
    assert.match(merge.message, /safe merge/);
  } finally {
    cleanupTempDir(dir);
  }
});
