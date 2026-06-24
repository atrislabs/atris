const GOAL_CLEAR_ALIASES = new Set(['clear', 'stop', 'off', 'reset', 'none', 'cancel']);
const GOAL_ACHIEVED_RE = /^\s*GOAL_ACHIEVED:\s*(.+)$/im;
const GOAL_JSON_RE = /\{[\s\S]*"achieved"\s*:\s*(true|false)[\s\S]*\}/i;

function parseTokenBudget(raw) {
  const text = String(raw || '').trim().toUpperCase();
  const match = text.match(/^(\d+(?:\.\d+)?)([KMB])?$/);
  if (!match) return null;
  let value = Number(match[1]);
  if (match[2] === 'K') value *= 1000;
  if (match[2] === 'M') value *= 1000000;
  if (match[2] === 'B') value *= 1000000000;
  return Math.round(value);
}

function parseGoalCommand(line) {
  const raw = String(line || '').trim();
  const lower = raw.toLowerCase();
  if (!lower.startsWith('/goal')) return null;

  const rest = raw.slice(5).trim();
  if (!rest) return { action: 'status' };

  const firstWord = rest.split(/\s+/)[0].toLowerCase();
  if (GOAL_CLEAR_ALIASES.has(firstWord)) return { action: 'clear' };

  let condition = rest;
  let tokenBudget = null;
  const tokensMatch = condition.match(/^--tokens\s+(\S+)\s+([\s\S]+)$/i);
  if (tokensMatch) {
    tokenBudget = parseTokenBudget(tokensMatch[1]);
    condition = tokensMatch[2].trim();
  }

  const maxTurnsMatch = condition.match(/\b(?:max|stop after|within)\s+(\d+)\s+turns?\b/i);
  const maxTurns = maxTurnsMatch ? Number(maxTurnsMatch[1]) : null;

  if (!condition) return { action: 'status' };
  return { action: 'set', condition, maxTurns, tokenBudget };
}

function createGoalState(condition, options = {}) {
  return {
    active: true,
    condition: String(condition || '').trim(),
    maxTurns: Number.isFinite(options.maxTurns) ? options.maxTurns : null,
    tokenBudget: Number.isFinite(options.tokenBudget) ? options.tokenBudget : null,
    turns: 0,
    evalTurns: 0,
    tokensUsed: 0,
    creditsUsed: 0,
    startedAt: Date.now(),
    lastReason: 'Goal started — working toward the condition.',
    achieved: false,
    achievedAt: null,
  };
}

function goalElapsedMs(goal) {
  const end = goal.achievedAt || Date.now();
  return Math.max(0, end - (goal.startedAt || end));
}

function truncateGoalText(text, limit = 72) {
  const value = String(text || '').trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1)}…`;
}

function compactGoalHistory(history = [], limit = 8) {
  return history
    .slice(-limit)
    .map(turn => `${turn.role}: ${String(turn.content || '').slice(0, 900)}`)
    .join('\n');
}

function buildGoalDirective(goal, options = {}) {
  const condition = goal.condition;
  const reason = goal.lastReason && goal.turns > 0
    ? `\nEvaluator guidance from last turn: ${goal.lastReason}`
    : '';
  return [
    'Work autonomously toward this completion condition:',
    condition,
    '',
    'Use local tools as needed. Do not ask the user for permission between steps.',
    'Do not declare the goal achieved yourself — a separate evaluator decides that.',
    reason,
    options.continue ? '\nContinue from the recent conversation below.' : '',
  ].filter(Boolean).join('\n');
}

function buildGoalEvalPrompt(goal, history, lastOutput) {
  return [
    'You are a strict goal evaluator for a coding agent session.',
    'Reply with JSON only: {"achieved": true|false, "reason": "short reason"}',
    'Judge only from observable evidence in the transcript and latest output.',
    'If the condition requires command output or file contents, require proof in the transcript.',
    '',
    `Goal condition: ${goal.condition}`,
    '',
    'Recent conversation:',
    compactGoalHistory(history),
    '',
    'Latest assistant output:',
    String(lastOutput || '').slice(0, 4000),
  ].join('\n');
}

function parseGoalEvalResponse(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const marker = raw.match(GOAL_ACHIEVED_RE);
  if (marker) {
    return { achieved: true, reason: marker[1].trim() };
  }

  const jsonMatch = raw.match(GOAL_JSON_RE);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      achieved: parsed.achieved === true,
      reason: String(parsed.reason || '').trim() || (parsed.achieved ? 'Condition met.' : 'Condition not met yet.'),
    };
  } catch {
    return null;
  }
}

function parseGoalAchievedMarker(text) {
  const marker = String(text || '').match(GOAL_ACHIEVED_RE);
  if (!marker) return null;
  return { achieved: true, reason: marker[1].trim() };
}

function accumulateGoalUsage(goal, result, creditsFromState) {
  if (!goal || !result) return;
  const credits = typeof creditsFromState === 'function' ? creditsFromState(result) : null;
  if (Number.isFinite(credits) && credits > 0) {
    goal.creditsUsed += credits;
  }
  const approxTokens = Math.max(0, Math.round(String(result.output || '').length / 4));
  goal.tokensUsed += approxTokens;
}

function goalBudgetExceeded(goal) {
  if (!goal || !Number.isFinite(goal.tokenBudget)) return false;
  return goal.tokensUsed >= goal.tokenBudget;
}

function goalTurnLimitReached(goal) {
  if (!goal || !Number.isFinite(goal.maxTurns)) return false;
  return goal.turns >= goal.maxTurns;
}

function clearGoalState(goal) {
  if (!goal) return null;
  goal.active = false;
  return goal;
}

function finishGoalAchieved(goal, reason) {
  goal.active = false;
  goal.achieved = true;
  goal.achievedAt = Date.now();
  goal.lastReason = reason || 'Condition met.';
  return goal;
}

function formatGoalCounter(goal) {
  const turns = `${goal.turns}${Number.isFinite(goal.maxTurns) ? `/${goal.maxTurns}` : ''}`;
  const duration = `${Math.max(1, Math.round(goalElapsedMs(goal) / 1000))}s`;
  const usage = [];
  if (goal.creditsUsed > 0) usage.push(`${goal.creditsUsed} credits`);
  if (goal.tokensUsed > 0) usage.push(`~${goal.tokensUsed} tokens`);
  return { turns, duration, usage: usage.join(' · ') };
}

function formatGoalStatus(goal, options = {}) {
  const paint = options.paint || ((text) => String(text));
  if (!goal) {
    return 'No active goal. Set one with /goal <condition>.';
  }

  const counter = formatGoalCounter(goal);
  const lines = [];

  if (goal.active) {
    lines.push(paint('◎ /goal active', [options.bold, options.magenta]));
    lines.push(paint(goal.condition, [options.bold]));
    lines.push(paint(`turn ${counter.turns} · ${counter.duration}${counter.usage ? ` · ${counter.usage}` : ''}`, [options.muted]));
    if (goal.lastReason) lines.push(paint(`reason: ${goal.lastReason}`, [options.muted]));
    if (Number.isFinite(goal.tokenBudget)) {
      lines.push(paint(`budget: ~${goal.tokensUsed}/${goal.tokenBudget} tokens`, [options.muted]));
    }
    return lines.join('\n');
  }

  if (goal.achieved) {
    lines.push(paint('✦ /goal achieved', [options.bold, options.ok || options.magenta]));
    lines.push(paint(goal.condition, [options.bold]));
    lines.push(paint(`${counter.turns} turns · ${counter.duration}${counter.usage ? ` · ${counter.usage}` : ''}`, [options.muted]));
    if (goal.lastReason) lines.push(paint(`reason: ${goal.lastReason}`, [options.muted]));
    return lines.join('\n');
  }

  lines.push(paint('Goal stopped.', [options.muted]));
  lines.push(paint(goal.condition, [options.bold]));
  lines.push(paint(`turn ${counter.turns} · ${counter.duration}`, [options.muted]));
  if (goal.lastReason) lines.push(paint(`reason: ${goal.lastReason}`, [options.muted]));
  return lines.join('\n');
}

function formatGoalActiveBanner(goal, options = {}) {
  if (!goal || !goal.active) return '';
  const paint = options.paint || ((text) => String(text));
  const counter = formatGoalCounter(goal);
  return paint(
    `◎ /goal active · ${truncateGoalText(goal.condition, 56)} · turn ${counter.turns}${Number.isFinite(goal.maxTurns) ? `/${goal.maxTurns}` : ''} · ${counter.duration}`,
    [options.bold, options.magenta]
  );
}

function formatGoalAchieved(goal, options = {}) {
  const paint = options.paint || ((text) => String(text));
  const counter = formatGoalCounter(goal);
  return [
    paint('✦ Goal achieved', [options.bold, options.magenta]),
    paint(goal.condition, [options.bold, options.accent]),
    paint(`${counter.turns} turns · ${counter.duration}${counter.usage ? ` · ${counter.usage}` : ''}`, [options.muted]),
    goal.lastReason ? paint(`reason: ${goal.lastReason}`, [options.muted]) : '',
  ].filter(Boolean).join('\n');
}

function formatGoalContinue(goal, options = {}) {
  const paint = options.paint || ((text) => String(text));
  return paint(`◎ continuing goal · turn ${goal.turns + 1}${Number.isFinite(goal.maxTurns) ? `/${goal.maxTurns}` : ''} · ${goal.lastReason}`, [options.magenta]);
}

function formatGoalStopped(goal, reason, options = {}) {
  const paint = options.paint || ((text) => String(text));
  const counter = formatGoalCounter(goal);
  return [
    paint('◎ Goal stopped', [options.bold, options.muted]),
    paint(reason, [options.muted]),
    paint(`${counter.turns} turns · ${counter.duration}`, [options.muted]),
  ].join('\n');
}

async function evaluateGoalTurn(goal, ctx = {}, deps = {}) {
  const marker = parseGoalAchievedMarker(ctx.lastOutput);
  if (marker) return marker;

  if (typeof deps.evaluateGoal === 'function') {
    return deps.evaluateGoal(goal, ctx);
  }

  if (typeof deps.postTurn !== 'function') {
    return { achieved: false, reason: goal.lastReason || 'Condition not met yet.' };
  }

  const evalOutput = { isTTY: false, write() {} };
  try {
    const result = await deps.postTurn(buildGoalEvalPrompt(goal, ctx.history || [], ctx.lastOutput), {
      ...(ctx.turnOptions || {}),
      mode: 'fast',
      history: [],
      output: evalOutput,
      showProgress: false,
      goalEval: true,
    });
    const parsed = parseGoalEvalResponse(result.output);
    if (parsed) return parsed;
  } catch (error) {
    return { achieved: false, reason: `Evaluator unavailable: ${error.message}` };
  }

  return { achieved: false, reason: goal.lastReason || 'Condition not met yet.' };
}

module.exports = {
  GOAL_CLEAR_ALIASES,
  accumulateGoalUsage,
  buildGoalDirective,
  buildGoalEvalPrompt,
  clearGoalState,
  compactGoalHistory,
  createGoalState,
  evaluateGoalTurn,
  finishGoalAchieved,
  formatGoalAchieved,
  formatGoalActiveBanner,
  formatGoalContinue,
  formatGoalCounter,
  formatGoalStatus,
  formatGoalStopped,
  goalBudgetExceeded,
  goalElapsedMs,
  goalTurnLimitReached,
  parseGoalAchievedMarker,
  parseGoalCommand,
  parseGoalEvalResponse,
  parseTokenBudget,
  truncateGoalText,
};
