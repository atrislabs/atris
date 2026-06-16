// Policy lesson mining for the RSI loop (CLI-215).
//
// The workspace already records its own history: career XP receipts (human
// accepts), task episodes (every review turn with an RL label), and
// scorecards (improve/brain ticks). This module mines that history into a
// small set of deterministic policy lessons — each one carries the evidence
// counts it was computed from — and surfaces them at the moment an agent
// submits proof (`atris task ready`), so the next submission behaves
// differently than the last. No LLM calls; re-mining refreshes the numbers.
const fs = require('fs');
const path = require('path');
const { RECEIPT_PATH_PATTERN, extractReceiptEvidence } = require('./receipt-evidence');
const escapeRegExp = require('./escape-regexp');

const POLICY_LESSONS_FILE = path.join('.atris', 'state', 'policy_lessons.json');
const CAREER_XP_RECEIPTS_FILE = path.join('.atris', 'state', 'career_xp_receipts.jsonl');
const TASK_EPISODES_FILE = path.join('.atris', 'state', 'task_episodes.jsonl');
const SCORECARDS_FILE = path.join('.atris', 'state', 'scorecards.jsonl');

// Review actors that are agents, not the human gate. Mining must split the
// two: agent self-review churn and human accept/bounce are different signals.
const AGENT_ACTOR_PATTERN = /review|validator|certifier|auto|codex|claude|devin|droid|improver|second-pass|agent|bot/i;
// "Names a runnable verify command" — the check a reviewer could replay.
const VERIFY_COMMAND_PATTERN = /\b(npm (run )?test|node --test|node --check|node bin\/|pytest|cargo test|go test|make test|atris verify|grep\s+-[A-Za-z]*q[A-Za-z]*|rg\s+(?:-\S+\s+)*(?:"[^"]+"|'[^']+'|\S+)\s+(?:\.{0,2}\/|~\/|\/|[\w.-]+\/|[\w.-]+\.[A-Za-z0-9]|\b(?:atris|bin|commands|lib|scripts|src|test)\b)|git diff --(?:check|exit-code|quiet)|diff (?:-u|--brief)|cmp -s|test -[fs])\b|--verify\b|\bverify:\s/;
const COMMIT_REF_PATTERN = /\bcommit\s+[0-9a-f]{7,40}\b/i;

function readJsonlFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  return raw.split('\n').map((line) => {
    const text = line.trim();
    if (!text) return null;
    try { return JSON.parse(text); } catch { return null; }
  }).filter(Boolean);
}

function loadHistory(root) {
  return {
    receipts: readJsonlFile(path.join(root, CAREER_XP_RECEIPTS_FILE)),
    episodes: readJsonlFile(path.join(root, TASK_EPISODES_FILE)),
    scorecards: readJsonlFile(path.join(root, SCORECARDS_FILE)),
  };
}

function isAgentActor(actor) {
  return AGENT_ACTOR_PATTERN.test(String(actor || ''));
}

function hasReceiptPath(text) {
  return new RegExp(RECEIPT_PATH_PATTERN.source).test(String(text || ''));
}

function hasVerifyCommand(text) {
  return VERIFY_COMMAND_PATTERN.test(String(text || ''));
}

function bounceCause(episode) {
  const proof = String(episode.proof || '').trim();
  if (!proof) return 'empty_proof';
  if (/supersed/i.test(proof)) return 'superseded';
  if (/wrong owner|route .*to|owner:/i.test(proof)) return 'wrong_owner';
  return 'other';
}

function featureGateCounts(episodes, predicate) {
  const counts = { accepted_with: 0, accepted_without: 0, revised_with: 0, revised_without: 0 };
  for (const episode of episodes) {
    const withFeature = predicate(String(episode.proof || ''));
    const key = `${episode.rl.label}_${withFeature ? 'with' : 'without'}`;
    if (key in counts) counts[key] += 1;
  }
  return counts;
}

function acceptRate(withCount, againstCount) {
  const total = withCount + againstCount;
  return total > 0 ? withCount / total : null;
}

// True when proofs carrying the feature get accepted at a higher rate than
// proofs without it — the bar for emitting a feature lesson at all.
function featureHelps(counts) {
  const withRate = acceptRate(counts.accepted_with, counts.revised_with);
  const withoutRate = acceptRate(counts.accepted_without, counts.revised_without);
  return withRate !== null && withoutRate !== null && withRate > withoutRate;
}

function mineProofPolicy(history, opts = {}) {
  const { receipts = [], episodes = [], scorecards = [] } = history || {};
  const minHumanReviewed = Number.isFinite(opts.minHumanReviewed) ? opts.minHumanReviewed : 10;
  const now = opts.now instanceof Date ? opts.now : new Date();

  const reviewed = episodes.filter((e) => e && e.rl && e.action && e.action.actor);
  const humanReviewed = reviewed.filter((e) => !isAgentActor(e.action.actor));
  const agentReviewed = reviewed.filter((e) => isAgentActor(e.action.actor));
  const humanGateEpisodes = humanReviewed.filter((e) => e.rl.label === 'accepted' || e.rl.label === 'revised');

  const accepted = humanGateEpisodes.filter((e) => e.rl.label === 'accepted').length;
  const revised = humanGateEpisodes.filter((e) => e.rl.label === 'revised').length;
  const verifyCounts = featureGateCounts(humanGateEpisodes, hasVerifyCommand);
  const receiptCounts = featureGateCounts(humanGateEpisodes, hasReceiptPath);
  const commitCounts = featureGateCounts(humanGateEpisodes, (p) => COMMIT_REF_PATTERN.test(p));

  const bounceCauses = {};
  for (const episode of humanGateEpisodes) {
    if (episode.rl.label !== 'revised') continue;
    const cause = bounceCause(episode);
    bounceCauses[cause] = (bounceCauses[cause] || 0) + 1;
  }

  const agentReviseTurns = agentReviewed.filter((e) => e.rl.label === 'revised').length;
  const autoCertifiedReceipts = receipts.filter((r) => isAgentActor(r.actor)).length;

  const improveTicks = scorecards.filter((s) => s && s.schema === 'atris.improve_tick.v1');
  const brainScorecards = scorecards.filter((s) => s && s.schema === 'atris.brain.scorecard.v1');
  const avgReward = (rows) => (rows.length
    ? Math.round((rows.reduce((sum, r) => sum + (Number(r.reward) || 0), 0) / rows.length) * 100) / 100
    : null);

  const stats = {
    human_gate: {
      accepted,
      revised,
      verify_command: verifyCounts,
      receipt_path: receiptCounts,
      commit_ref: commitCounts,
      bounce_causes: bounceCauses,
    },
    agent_lane: {
      review_turns: agentReviewed.length,
      revise_turns: agentReviseTurns,
      auto_certified_receipts: autoCertifiedReceipts,
    },
    scorecards: {
      total: scorecards.length,
      improve_ticks: { count: improveTicks.length, avg_reward: avgReward(improveTicks) },
      brain: { count: brainScorecards.length, avg_reward: avgReward(brainScorecards) },
    },
  };

  const lessons = [];
  const enoughHumanData = humanGateEpisodes.length >= minHumanReviewed;

  if (enoughHumanData && verifyCounts.accepted_with >= 5 && featureHelps(verifyCounts)) {
    lessons.push({
      id: 'proof-verify-command',
      hint_when: 'proof_missing_verify_command',
      lesson: `Name a runnable verify command in every proof: ${verifyCounts.accepted_with}/${verifyCounts.accepted_with + verifyCounts.revised_with} proofs with one were accepted at the human gate, while ${verifyCounts.revised_without}/${revised} human bounces named none.`,
      evidence: { source: 'task_episodes.human_gate', ...verifyCounts },
    });
  }

  if (enoughHumanData && receiptCounts.accepted_with >= 1 && featureHelps(receiptCounts)) {
    lessons.push({
      id: 'proof-live-receipt',
      hint_when: 'proof_missing_receipt_path',
      lesson: `Cite a live receipt path (atris/runs/...) whose verifier passed: receipt-backed proofs are ${receiptCounts.accepted_with}/${receiptCounts.accepted_with + receiptCounts.revised_with} at the human gate and auto-review certifies them agent-side with zero human turns, while evidence-less proofs stall in the review lane (${agentReviseTurns} agent revise turns recorded).`,
      evidence: { source: 'task_episodes + review lane', ...receiptCounts, agent_revise_turns: agentReviseTurns, auto_certified_receipts: autoCertifiedReceipts },
    });
  }

  if (enoughHumanData && revised > 0) {
    const causeSummary = Object.entries(bounceCauses).map(([cause, count]) => `${count} ${cause}`).join(', ');
    lessons.push({
      id: 'bounce-causes-routing',
      hint_when: null,
      lesson: `Human bounces are routing/staleness problems, not prose problems (${revised} bounces: ${causeSummary}). Before ready: confirm the task owner is right and the work was not superseded.`,
      evidence: { source: 'task_episodes.human_gate', revised, bounce_causes: bounceCauses },
    });
  }

  return {
    schema: 'atris.policy_lessons.v1',
    mined_at: now.toISOString(),
    sources: {
      career_xp_receipts: receipts.length,
      task_episodes: episodes.length,
      scorecards: scorecards.length,
      human_reviewed_episodes: humanGateEpisodes.length,
    },
    stats,
    lessons,
  };
}

// Mirrors the review lane's auto-review bar (autoReviewableEvidence): every
// named receipt must exist on disk and show a passing verifier. A proof that
// names a receipt the lane would reject still earns the hint.
function hasLaneCertifiableReceipt(proof, root) {
  const evidence = extractReceiptEvidence(proof, root);
  return Boolean(
    evidence
    && !evidence.missing.length
    && evidence.receipts.length
    && evidence.receipts.every((entry) => entry.verifier_passed === true),
  );
}

function policyHintsForProof(proofText, mined, root = process.cwd()) {
  const lessons = mined && Array.isArray(mined.lessons) ? mined.lessons : [];
  if (!lessons.length) return [];
  const proof = String(proofText || '');
  const hints = [];
  for (const lesson of lessons) {
    if (lesson.hint_when === 'proof_missing_verify_command' && !hasVerifyCommand(proof)) {
      hints.push({ id: lesson.id, hint: lesson.lesson });
    } else if (lesson.hint_when === 'proof_missing_receipt_path' && !hasLaneCertifiableReceipt(proof, root)) {
      hints.push({ id: lesson.id, hint: lesson.lesson });
    }
  }
  return hints;
}

function policyLessonsPath(root) {
  return path.join(root, POLICY_LESSONS_FILE);
}

function readPolicyLessons(root) {
  try {
    const parsed = JSON.parse(fs.readFileSync(policyLessonsPath(root), 'utf8'));
    return parsed && parsed.schema === 'atris.policy_lessons.v1' ? parsed : null;
  } catch {
    return null;
  }
}

function writePolicyLessons(root, mined) {
  const filePath = policyLessonsPath(root);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(mined, null, 2) + '\n', 'utf8');
  return filePath;
}

// Sync mined lessons into atris/lessons.md (the surface agents already read).
// One line per lesson id; re-mining replaces the line so counts stay fresh
// instead of stacking stale duplicates.
function syncLessonsMd(root, mined) {
  const lessonsPath = path.join(root, 'atris', 'lessons.md');
  const today = (mined.mined_at || new Date().toISOString()).split('T')[0];
  const lines = (mined.lessons || []).map((lesson) => ({
    id: lesson.id,
    line: `- **[${today}] policy-${lesson.id}** — pass — ${lesson.lesson} (mined from ${mined.sources.career_xp_receipts} receipts / ${mined.sources.task_episodes} episodes / ${mined.sources.scorecards} scorecards)`,
  }));
  if (!lines.length) return { path: lessonsPath, written: [] };

  let content;
  try {
    content = fs.readFileSync(lessonsPath, 'utf8');
  } catch {
    content = '# lessons.md — What We Learned\n\n> Append-only. One line per lesson.\n\n---\n';
  }
  const written = [];
  for (const { id, line } of lines) {
    const marker = new RegExp(`^- \\*\\*\\[\\d{4}-\\d{2}-\\d{2}\\] policy-${escapeRegExp(id)}\\*\\*.*$`, 'm');
    if (marker.test(content)) {
      content = content.replace(marker, line);
    } else {
      content = content.replace(/\n*$/, '\n') + line + '\n';
    }
    written.push(id);
  }
  fs.mkdirSync(path.dirname(lessonsPath), { recursive: true });
  fs.writeFileSync(lessonsPath, content, 'utf8');
  return { path: lessonsPath, written };
}

module.exports = {
  AGENT_ACTOR_PATTERN,
  VERIFY_COMMAND_PATTERN,
  loadHistory,
  mineProofPolicy,
  policyHintsForProof,
  policyLessonsPath,
  readPolicyLessons,
  writePolicyLessons,
  syncLessonsMd,
};
