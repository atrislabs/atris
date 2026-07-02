const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const RESULTS_HEADER = 'timestamp\ttrack\trepo\ttask\tstatus\tscore\treviewed\ttests\tartifacts\tinterventions\tnotes\n';

function readTextIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf8');
}

function runGit(repoDir, args) {
  if (!repoDir || !fs.existsSync(repoDir)) return null;
  const result = spawnSync('git', ['-C', repoDir, ...args], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  return (result.stdout || '').trim();
}

function getGitHead(repoDir) {
  return runGit(repoDir, ['rev-parse', 'HEAD']);
}

function collectChangedFiles(repoDir, beforeSha, afterSha, prefix = '') {
  const changed = new Set();

  const addLines = (output) => {
    if (!output) return;
    output.split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .forEach((line) => changed.add(prefix + line));
  };

  if (beforeSha && afterSha && beforeSha !== afterSha) {
    addLines(runGit(repoDir, ['diff', '--name-only', `${beforeSha}..${afterSha}`]));
  }

  addLines(runGit(repoDir, ['diff', '--name-only']));
  addLines(runGit(repoDir, ['diff', '--cached', '--name-only']));
  addLines(runGit(repoDir, ['ls-files', '--others', '--exclude-standard']));

  return [...changed].sort();
}

function buildRunId(track) {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${track}`;
}

function buildWikiArtifact(beforeText, afterText) {
  if (!beforeText && !afterText) {
    return { status: 'missing' };
  }

  if (beforeText === afterText) {
    return { status: 'not_applicable', before: beforeText || '', after: afterText || '' };
  }

  return { status: 'updated', before: beforeText || '', after: afterText || '' };
}

function summarizeReview(text) {
  const clean = (text || '').trim().replace(/\s+/g, ' ');
  if (!clean) return 'no review output captured';
  return clean.length > 400 ? `${clean.slice(0, 397)}...` : clean;
}

function inferTestResults(text) {
  const lines = (text || '').split('\n');
  const matches = [];

  for (const line of lines) {
    if (!/(npm|pnpm|yarn|node\s+--test|pytest|python\s+-m|cargo test|go test)/i.test(line)) {
      continue;
    }

    let status = 'not_run';
    if (/\b(pass|passed|green|clean)\b/i.test(line)) status = 'pass';
    if (/\b(fail|failed|error)\b/i.test(line)) status = 'fail';

    matches.push({
      command: line.trim(),
      status,
    });
  }

  if (matches.length > 0) return matches;

  return [{
    command: '(no explicit test command captured)',
    status: 'not_run',
  }];
}

function scoreEndstateArtifact(artifact) {
  const breakdown = {
    reviewed_completion: artifact.review?.status === 'pass' ? 40 : 0,
    test_outcome: 0,
    artifact_completeness: 0,
    wiki_memory: artifact.wiki?.status === 'missing' ? 0 : 10,
    operator_load: Math.max(0, 10 - ((artifact.interventions?.count || 0) * 2)),
  };

  const tests = Array.isArray(artifact.tests) ? artifact.tests : [];
  const executed = tests.filter((test) => test.status !== 'not_run');
  if (executed.length > 0) {
    const passed = executed.filter((test) => test.status === 'pass').length;
    breakdown.test_outcome = Math.round((passed / executed.length) * 25);
  }

  const required = [
    'run_id',
    'track',
    'repo_commits',
    'task_brief',
    'prompt_context',
    'changed_files',
    'tests',
    'review',
    'wiki',
    'elapsed_seconds',
    'interventions',
  ];
  const present = required.filter((key) => Object.prototype.hasOwnProperty.call(artifact, key)).length;
  breakdown.artifact_completeness = Math.round((present / required.length) * 15);

  const total = Object.values(breakdown).reduce((sum, value) => sum + value, 0);
  return { total, breakdown };
}

function getArtifactScore(artifact) {
  if (typeof artifact?.score === 'number') return artifact.score;
  return scoreEndstateArtifact(artifact).total;
}

function getReviewRank(artifact) {
  const status = artifact?.review?.status;
  if (status === 'pass') return 2;
  if (status === 'draft') return 1;
  return 0;
}

function compactReason(text, fallback = 'provider seed row wedged') {
  const clean = String(text || '').trim().replace(/\s+/g, ' ');
  if (!clean) return fallback;
  return clean.length > 180 ? `${clean.slice(0, 177)}...` : clean;
}

function providerSeedDiagnostic(artifact) {
  const seed = artifact?.provider_seed || artifact?.providerSeed || null;
  const explicitStatus = String(seed?.status || artifact?.provider_seed_status || '').trim().toLowerCase();
  const explicitReason = seed?.reason || artifact?.provider_seed_reason || '';
  const text = [
    explicitStatus,
    explicitReason,
    artifact?.review?.summary,
    artifact?.notes,
    ...(Array.isArray(artifact?.tests) ? artifact.tests.map((test) => `${test.command || ''} ${test.status || ''}`) : []),
  ].filter(Boolean).join(' ');

  const hasSeedProvider = /\b(provider[_ -]?seed|seed[_ -]?provider|seeded provider|provider row|seed row)\b/i.test(text)
    || (/\bprovider\b/i.test(text) && /\bseed(?:ed|s|ing)?\b/i.test(text));
  const isWedged = /\b(wedged|inconclusive|blocked|stale|timeout|timed out|hung|missing|unavailable|failed)\b/i.test(text);

  if (!hasSeedProvider || !isWedged) return null;

  const status = /inconclusive/i.test(explicitStatus || text) ? 'inconclusive' : 'wedged';
  const provider = seed?.provider || artifact?.provider || null;
  const rowId = seed?.row_id || seed?.rowId || artifact?.provider_seed_row_id || null;
  const reason = compactReason(explicitReason || artifact?.review?.summary || artifact?.notes);

  return {
    status,
    provider,
    row_id: rowId,
    reason,
  };
}

function readLatestArtifact(packDir) {
  const artifactsDir = path.join(packDir, 'artifacts');
  if (!fs.existsSync(artifactsDir)) {
    throw new Error(`No artifacts found at ${artifactsDir}`);
  }

  const files = fs.readdirSync(artifactsDir)
    .filter((file) => file.endsWith('.json'))
    .sort();

  if (files.length === 0) {
    throw new Error(`No artifact JSON files found at ${artifactsDir}`);
  }

  const filePath = path.join(artifactsDir, files[files.length - 1]);
  return {
    filePath,
    artifact: JSON.parse(fs.readFileSync(filePath, 'utf8')),
  };
}

function compareEndstateArtifacts(baselineEntry, stackEntry) {
  const baselineScore = getArtifactScore(baselineEntry.artifact);
  const stackScore = getArtifactScore(stackEntry.artifact);
  const baselineReview = getReviewRank(baselineEntry.artifact);
  const stackReview = getReviewRank(stackEntry.artifact);
  const providerSeedDiagnostics = {
    baseline: providerSeedDiagnostic(baselineEntry.artifact),
    stack: providerSeedDiagnostic(stackEntry.artifact),
  };
  const providerSeedBlocked = Object.entries(providerSeedDiagnostics)
    .filter(([, diagnostic]) => diagnostic)
    .map(([track, diagnostic]) => ({ track, ...diagnostic }));

  if (providerSeedBlocked.length > 0) {
    const details = providerSeedBlocked
      .map((item) => `${item.track}${item.provider ? `/${item.provider}` : ''}: ${item.reason}`)
      .join('; ');
    return {
      winner: 'none',
      leader: 'inconclusive',
      reason: `Inconclusive provider seed re-cert: ${details}. Fix or reseed the provider row, then rerun the benchmark comparison.`,
      baselineScore,
      stackScore,
      inconclusive: true,
      providerSeedDiagnostics,
    };
  }

  const stackWins = stackScore > baselineScore && stackReview >= baselineReview;
  const leader = stackScore === baselineScore
    ? 'tie'
    : (stackScore > baselineScore ? 'stack' : 'baseline');

  let reason = '';
  if (stackWins) {
    reason = `Stack leads ${stackScore} to ${baselineScore} and does not lose reviewed completion.`;
  } else if (stackScore === baselineScore) {
    reason = `Scores are tied at ${stackScore}/100. The stack must beat the baseline on total score.`;
  } else if (stackScore < baselineScore) {
    reason = `Baseline leads ${baselineScore} to ${stackScore}. The stack must beat the baseline on total score.`;
  } else {
    reason = 'The stack improved total score but lost reviewed completion, so it does not clear the Level 1 rule.';
  }

  return {
    winner: stackWins ? 'stack' : 'none',
    leader,
    reason,
    baselineScore,
    stackScore,
    inconclusive: false,
    providerSeedDiagnostics,
  };
}

function ensureResultsFile(resultsPath) {
  if (!fs.existsSync(resultsPath)) {
    fs.writeFileSync(resultsPath, RESULTS_HEADER, 'utf8');
    return;
  }

  const content = fs.readFileSync(resultsPath, 'utf8');
  if (!content.trim()) {
    fs.writeFileSync(resultsPath, RESULTS_HEADER, 'utf8');
  }
}

function toTsvField(value) {
  return String(value ?? '')
    .replace(/\t/g, ' ')
    .replace(/\r?\n/g, ' ')
    .trim();
}

function appendResultsRow(resultsPath, artifactPath, artifact, score) {
  ensureResultsFile(resultsPath);

  const tests = Array.isArray(artifact.tests) ? artifact.tests : [];
  const passed = tests.filter((test) => test.status === 'pass').length;
  const ran = tests.filter((test) => test.status !== 'not_run').length;

  const row = [
    new Date().toISOString(),
    artifact.track,
    'atris-cli+atrisos-backend',
    artifact.task_brief,
    artifact.review?.status || 'draft',
    score.total,
    artifact.review?.status === 'pass' ? 'yes' : 'no',
    ran > 0 ? `${passed}/${ran} pass` : 'not-run',
    path.relative(path.dirname(resultsPath), artifactPath),
    artifact.interventions?.count || 0,
    artifact.notes || '',
  ].map(toTsvField).join('\t');

  fs.appendFileSync(resultsPath, `${row}\n`, 'utf8');
}

function writeArtifact(packDir, artifact) {
  const artifactsDir = path.join(packDir, 'artifacts');
  fs.mkdirSync(artifactsDir, { recursive: true });
  const filePath = path.join(artifactsDir, `${artifact.run_id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(artifact, null, 2), 'utf8');
  return filePath;
}

module.exports = {
  appendResultsRow,
  buildRunId,
  buildWikiArtifact,
  compareEndstateArtifacts,
  collectChangedFiles,
  getArtifactScore,
  getGitHead,
  inferTestResults,
  providerSeedDiagnostic,
  readLatestArtifact,
  readTextIfExists,
  scoreEndstateArtifact,
  summarizeReview,
  writeArtifact,
};
