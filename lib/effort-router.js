'use strict';

// West Coast thinking-effort router and 1-turn Deep Thinker diagnostic protocol.
//
// Core principle: model weights and thinking effort are separate axes.
//   - Deep Thinker (astra, fable, sol): high/xhigh for 1-turn diagnosis or design
//   - Everyday Worker (opus, neon, sonnet): low for 70-80% bounded execution
//   - Sprinter (terra, hydrogen, haiku, atris-fast, flash): low for scouts & JSON
//
// Explicit CLI flags and ROSTER.md pins always win; this module supplies the
// default effort when a dispatch leaves effort unset, plus the 1-turn read-only
// mystery-bug diagnostic prompt and worker lookup after two misses.

const { EFFORT_WORDS, engineEffortLevels } = require('./runner-command');

const EFFORT_LEVELS = EFFORT_WORDS;
const WEIGHT_CLASSES = Object.freeze(['sprinter', 'worker', 'thinker']);

const HIGH_SIGNAL_RE = /\b(race\s+condition|deadlock|concurrency|distributed\s+lock|ledger|rollback|mystery\s+bug|intermittent|flaky\s+race|repo[- ]wide|system[- ]wide|architecture|threat\s+model|auth(?:entication)?\s+boundary|security\s+audit|cross[- ]service)\b/i;
const MEDIUM_SIGNAL_RE = /\b(webhook|idempotenc|third[- ]party|3rd[- ]party|e2e|end[- ]to[- ]end|integration\s+test|multi[- ]agent|handoff|eval\s+regression|query\s+tun|multi[- ]tenant|streaming|optimistic\s+update|cache\s+invalidat)\b/i;
const TRIVIAL_SIGNAL_RE = /\b(typo|copy|readme|docs?|comment|css|tailwind|styling|layout|rename|lint|json\s+schema|boilerplate|unit\s+test)\b/i;

function taskText(task) {
  if (!task) return '';
  if (typeof task === 'string') return task;
  const parts = [
    task.title,
    task.content,
    task.objective,
    task.description,
    task.tag,
    ...(Array.isArray(task.tags) ? task.tags : []),
    ...(task.metadata && Array.isArray(task.metadata.tags) ? task.metadata.tags : []),
  ];
  return parts.filter(Boolean).map(String).join(' ').trim();
}

function declaredFileCount(task) {
  if (!task || typeof task !== 'object') return 0;
  const list = [
    ...(Array.isArray(task.files) ? task.files : []),
    ...(task.metadata && Array.isArray(task.metadata.files) ? task.metadata.files : []),
  ].filter(Boolean);
  return new Set(list.map(String)).size;
}

// Classify one task by Span x Unknowns into { effort, weight_class, audible, reason }.
function classifyTaskEffort(task, { retryCount = 0, prep = null, job = '' } = {}) {
  const normalizedJob = String(job || '').trim().toLowerCase().replace(/[-_]+/g, ' ');
  const kind = String((task && typeof task === 'object' && (task.kind || (task.metadata && task.metadata.kind))) || '').trim().toLowerCase();
  const text = taskText(task);
  const files = declaredFileCount(task);

  if (Number(retryCount) >= 2) {
    return {
      effort: 'high',
      weight_class: 'thinker',
      audible: true,
      reason: 'two low attempts missed; run one read-only diagnostic turn',
    };
  }

  if (normalizedJob === 'diagnose' || normalizedJob === 'hard problem' || normalizedJob === 'purposeful search') {
    return {
      effort: 'high',
      weight_class: 'thinker',
      audible: normalizedJob === 'diagnose',
      reason: `${normalizedJob} job calls for deep reasoning`,
    };
  }

  if (normalizedJob === 'search' || normalizedJob === 'prep' || normalizedJob === 'triage' || normalizedJob === 'notes') {
    return {
      effort: 'low',
      weight_class: 'sprinter',
      audible: false,
      reason: 'bounded read or structured output runs fast on low',
    };
  }

  if (normalizedJob === 'small build' || normalizedJob === 'ui edits') {
    return {
      effort: 'low',
      weight_class: 'worker',
      audible: false,
      reason: 'small bounded edit runs on low',
    };
  }

  if (kind === 'explore' || (HIGH_SIGNAL_RE.test(text) && !TRIVIAL_SIGNAL_RE.test(text))) {
    return {
      effort: 'high',
      weight_class: 'thinker',
      audible: false,
      reason: kind === 'explore' ? 'explore task has open unknowns' : 'high-unknown or wide-blast-radius task',
    };
  }

  if (normalizedJob === 'review' || files >= 4 || (MEDIUM_SIGNAL_RE.test(text) && !TRIVIAL_SIGNAL_RE.test(text))) {
    return {
      effort: 'medium',
      weight_class: 'worker',
      audible: false,
      reason: normalizedJob === 'review' ? 'independent review uses medium effort' : 'multi-file coordination or integration scope',
    };
  }

  if (prep && prep.ok) {
    return {
      effort: 'low',
      weight_class: 'worker',
      audible: false,
      reason: 'prep brief resolved context; execute on low',
    };
  }

  return {
    effort: 'low',
    weight_class: 'worker',
    audible: false,
    reason: 'bounded execution pass drives on low',
  };
}

// Map a desired effort word to one the target engine accepts, or '' when the
// engine takes no effort flag. Never throws on unsupported effort levels.
function effectiveEffortForEngine(engineId, desired) {
  const word = String(desired || '').trim().toLowerCase();
  if (!word) return '';
  const allowed = engineEffortLevels(engineId);
  if (!allowed.length) return '';
  if (allowed.includes(word)) return word;
  const fallbackOrder = word === 'max' ? ['xhigh', 'high', 'medium', 'low']
    : word === 'xhigh' ? ['high', 'medium', 'low']
      : word === 'high' ? ['medium', 'low']
        : word === 'medium' ? ['low', 'high']
          : ['low'];
  return fallbackOrder.find((level) => allowed.includes(level)) || '';
}

// Playbook Section 4: the exact 1-turn read-only mystery-bug diagnostic prompt.
function buildMysteryBugDiagnosticPrompt({ task, error = '', logs = '', files = [] } = {}) {
  const title = taskText(task) || 'unspecified task';
  const errText = String(error || '').trim().slice(-1200);
  const logText = String(logs || '').trim().slice(-3000);
  const fileList = (Array.isArray(files) ? files : []).filter(Boolean).slice(0, 12);
  return [
    'Do NOT write code or patch symptoms yet.',
    '1. Trace the full execution path and state lifecycle across the relevant files and logs.',
    '2. List the top 2-3 root-cause hypotheses ranked by probability.',
    '3. Identify the exact single-line or minimal architectural fix for the #1 hypothesis.',
    '',
    `Task: ${title.slice(0, 800)}`,
    errText ? `\nFailure:\n${errText}` : '',
    logText ? `\nLogs:\n${logText}` : '',
    fileList.length ? `\nRelevant Files:\n${fileList.map((f) => `- ${f}`).join('\n')}` : '',
  ].filter((part) => part !== '').join('\n');
}

// Pick the Deep Thinker for a 1-turn diagnostic audible: `diagnose` job first,
// then `hard problem`, then `review`, else the first ready engine.
function resolveDiagnosticWorker(root = process.cwd(), options = {}) {
  const { resolveJobTeam, readEngineRegistry, engineReadyAt } = require('./engine-registry');
  for (const jobName of ['diagnose', 'hard problem', 'review']) {
    try {
      const team = resolveJobTeam(jobName, root, { lowStakes: false });
      if (team && team.lead && team.lead.id) {
        const engine = team.lead.id;
        const desired = team.lead.roster_effort || 'high';
        return {
          job: jobName,
          engine,
          model: team.lead.roster_model || '',
          effort: effectiveEffortForEngine(engine, desired),
          maxSeconds: Number(team.lead.roster_max_seconds) || 0,
        };
      }
    } catch {}
  }
  const registry = readEngineRegistry(root, { persist: false });
  const ready = (registry.engines || []).filter((e) => engineReadyAt(e, options.now));
  const preferred = ['codex', 'claude', 'fable', 'agy', 'grok']
    .map((id) => ready.find((e) => e.id === id))
    .find(Boolean) || ready[0] || null;
  if (!preferred) return null;
  return {
    job: 'diagnose',
    engine: preferred.id,
    model: '',
    effort: effectiveEffortForEngine(preferred.id, 'high'),
    maxSeconds: 0,
  };
}

// Execute one read-only Deep Thinker diagnostic turn and return { ok, engine, model, effort, diagnosis, error }.
async function runDiagnosticAudible(root, {
  task,
  error = '',
  logs = '',
  files = [],
  timeoutMs = 180000,
  askJobs = null,
} = {}) {
  const worker = resolveDiagnosticWorker(root);
  if (!worker) {
    return { ok: false, engine: '', model: '', effort: '', diagnosis: '', error: 'no ready diagnostic engine' };
  }
  const prompt = buildMysteryBugDiagnosticPrompt({ task, error, logs, files });
  const runAsk = typeof askJobs === 'function'
    ? askJobs
    : require('./engine-ask').runEngineAskJobs;
  const [answer] = await runAsk([{
    engine: worker.engine,
    model: worker.model,
    ...(worker.effort ? { effort: worker.effort } : {}),
    prompt,
    label: 'west-coast diagnostic audible',
  }], { root, timeoutMs: worker.maxSeconds ? Math.min(timeoutMs, worker.maxSeconds * 1000) : timeoutMs });
  const text = String((answer && (answer.stdout || answer.output || answer.text)) || '').trim();
  if (!answer || answer.ok === false || !text) {
    return {
      ok: false,
      engine: worker.engine,
      model: worker.model,
      effort: worker.effort,
      diagnosis: '',
      error: (answer && (answer.error || answer.reason)) || 'diagnostic engine returned no output',
    };
  }
  return {
    ok: true,
    engine: worker.engine,
    model: answer.model_ran || worker.model,
    effort: worker.effort,
    diagnosis: text.slice(0, 2400),
    error: null,
  };
}

module.exports = {
  EFFORT_LEVELS,
  WEIGHT_CLASSES,
  classifyTaskEffort,
  effectiveEffortForEngine,
  buildMysteryBugDiagnosticPrompt,
  resolveDiagnosticWorker,
  runDiagnosticAudible,
};
