'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { getEngineAdapter } = require('../lib/bench/engines');
const {
  SKILL_EVAL_SCHEMA,
  appendSkillEvalReceipt,
  changedSkillFiles,
} = require('../lib/skill-eval-gate');

const REVIEW_DIRECTORY_PREFIX = 'atris-review-';
const RUBRIC_KEYS = Object.freeze([
  'instruction_clarity',
  'trigger_precision',
  'procedural_completeness',
  'safety',
  'verifiability',
]);
const JUDGE_ORDER = Object.freeze(['claude', 'codex', 'cursor']);

function readFlag(args, name) {
  const prefix = `${name}=`;
  const inline = args.find((arg) => String(arg).startsWith(prefix));
  if (inline) return String(inline).slice(prefix.length);
  const index = args.indexOf(name);
  if (index !== -1 && args[index + 1] && !String(args[index + 1]).startsWith('--')) {
    return String(args[index + 1]);
  }
  return null;
}

function parseArgs(args = []) {
  const valueFlags = new Set(['--judge', '--worker-model', '--timeout']);
  let skillPath = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    if (valueFlags.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith('--')) continue;
    if (!skillPath) skillPath = arg;
  }
  return {
    skillPath,
    judge: readFlag(args, '--judge') || process.env.ATRIS_SKILL_JUDGE || null,
    workerModel: readFlag(args, '--worker-model') || null,
    timeoutMs: Math.max(1000, Number(readFlag(args, '--timeout') || 300) * 1000),
    json: args.includes('--json'),
    help: args.includes('--help') || args.includes('-h') || args.includes('help'),
  };
}

function workerModelFromEnvironment(env = process.env) {
  if (env.ATRIS_WORKER_MODEL) return String(env.ATRIS_WORKER_MODEL).trim();
  if (env.CODEX_SANDBOX || env.CODEX_THREAD_ID) return String(env.CODEX_MODEL || 'codex').trim();
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) {
    return String(env.ATRIS_CLAUDE_MODEL || env.ANTHROPIC_MODEL || 'claude').trim();
  }
  if (env.CURSOR_AGENT) return 'cursor';
  if (env.DEVIN_SESSION_ID) return 'devin';
  if (env.ATRIS_RUNNER_MODEL) return String(env.ATRIS_RUNNER_MODEL).trim();
  return 'human';
}

function identityFamily(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (/claude|anthropic/.test(normalized)) return 'claude';
  if (/codex|openai|gpt/.test(normalized)) return 'codex';
  if (/cursor/.test(normalized)) return 'cursor';
  return normalized;
}

function resolveSkillPath(root, requested) {
  if (!requested) throw new Error('a skill path is required');
  let absolute = path.resolve(root, requested);
  try {
    if (fs.statSync(absolute).isDirectory()) absolute = path.join(absolute, 'SKILL.md');
  } catch {
    // A deleted SKILL.md can still be evaluated from the branch diff.
  }
  const relative = path.relative(root, absolute).replace(/\\/g, '/');
  if (!relative || relative === '..' || relative.startsWith('../') || path.basename(relative) !== 'SKILL.md') {
    throw new Error('the skill path must name a SKILL.md inside this workspace');
  }
  return { absolute, relative };
}

function gitOutput(root, args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.status === 0 ? String(result.stdout || '') : null;
}

function previousSkillContent(root, skillPath) {
  for (const ref of ['origin/master', 'origin/main', 'master', 'main', 'HEAD']) {
    const content = gitOutput(root, ['show', `${ref}:${skillPath}`]);
    if (content !== null) return { ref, content };
  }
  return { ref: null, content: '' };
}

function buildJudgePrompt(skillPath, previousRef) {
  const comparison = previousRef
    ? `previous-skill.md is the version from ${previousRef}. Reject regressions even when the current file is acceptable in isolation.`
    : 'There is no previous version. Judge whether the new skill is ready to guide an agent safely and repeatably.';
  return `You are reviewing agent instructions in current-skill.md.
${comparison}

Score each rubric from 1 to 5:
- instruction_clarity: an agent can follow the instructions without guessing.
- trigger_precision: the skill says exactly when it should and should not run.
- procedural_completeness: the required workflow and closure behavior are present.
- safety: risky actions, permissions, and failure behavior are explicit.
- verifiability: success can be checked with concrete evidence.

Set passed to true only when every score is at least 4 and the current version has no regression from the previous version. Do not edit any files. Return exactly one JSON object and no markdown:
{"passed":true,"rubric_scores":{"instruction_clarity":4,"trigger_precision":4,"procedural_completeness":4,"safety":4,"verifiability":4},"summary":"one short factual sentence"}`;
}

function parseJudgePayload(output) {
  const text = String(output || '').trim();
  const candidates = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) candidates.push(text.slice(firstBrace, lastBrace + 1));

  let payload = null;
  for (const candidate of candidates) {
    try {
      payload = JSON.parse(candidate);
      break;
    } catch {
      // Try the next extraction form.
    }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('the judge did not return one readable JSON object');
  }
  if (!payload.rubric_scores || typeof payload.rubric_scores !== 'object' || Array.isArray(payload.rubric_scores)) {
    throw new Error('the judge did not return rubric scores');
  }
  const rubricScores = {};
  for (const key of RUBRIC_KEYS) {
    const score = Number(payload.rubric_scores[key]);
    if (!Number.isFinite(score) || score < 1 || score > 5) {
      throw new Error(`the judge returned an invalid ${key} score`);
    }
    rubricScores[key] = score;
  }
  const passed = payload.passed === true && Object.values(rubricScores).every((score) => score >= 4);
  return {
    passed,
    rubric_scores: rubricScores,
    summary: String(payload.summary || '').trim().slice(0, 500),
  };
}

function createReviewDirectory(fileSystem = fs) {
  const directory = fileSystem.mkdtempSync(path.join(os.tmpdir(), REVIEW_DIRECTORY_PREFIX));
  if (/(eval|test)/i.test(path.basename(directory))) {
    fileSystem.rmSync(directory, { recursive: true, force: true });
    throw new Error('could not create a neutral review workspace');
  }
  return directory;
}

function chooseJudge(requested, workerModel, directory, engineFactory = getEngineAdapter) {
  const workerFamily = identityFamily(workerModel);
  const candidates = requested ? [requested] : JUDGE_ORDER;
  const unavailable = [];
  for (const name of candidates) {
    let adapter;
    try {
      adapter = engineFactory(name);
    } catch (error) {
      unavailable.push(`${name}: ${error.message || error}`);
      continue;
    }
    if (identityFamily(adapter.name) === workerFamily) {
      unavailable.push(`${adapter.name}: matches worker model`);
      continue;
    }
    const status = adapter.available(directory);
    if (!status.available) {
      unavailable.push(`${adapter.name}: ${status.reason}`);
      continue;
    }
    return adapter;
  }
  const detail = unavailable.length ? ` (${unavailable.join('; ')})` : '';
  throw new Error(`no independent judge engine is available${detail}`);
}

function printHelp() {
  console.log('Usage: atris skill eval <skill-path> [--judge <engine>] [--worker-model <id>] [--timeout <seconds>] [--json]');
  console.log('');
  console.log('Runs an independent rubric review and appends its receipt to .atris/state/scorecards.jsonl.');
}

function skillEvalCommand(args = [], dependencies = {}) {
  const options = parseArgs(args);
  if (options.help) {
    printHelp();
    return 0;
  }
  const root = path.resolve(dependencies.root || process.cwd());
  let directory = null;
  try {
    const skill = resolveSkillPath(root, options.skillPath);
    const previous = previousSkillContent(root, skill.relative);
    let current = '';
    try {
      current = fs.readFileSync(skill.absolute, 'utf8');
    } catch {
      if (!previous.ref) throw new Error(`could not read ${skill.relative}`);
    }

    directory = createReviewDirectory(dependencies.fs || fs);
    fs.writeFileSync(path.join(directory, 'current-skill.md'), current || '[skill deleted]\n', 'utf8');
    fs.writeFileSync(path.join(directory, 'previous-skill.md'), previous.content || '[no previous skill]\n', 'utf8');
    const workerModel = options.workerModel || workerModelFromEnvironment(dependencies.env || process.env);
    const judge = chooseJudge(
      options.judge,
      workerModel,
      directory,
      dependencies.getEngineAdapter || getEngineAdapter,
    );
    const result = judge.run(buildJudgePrompt(skill.relative, previous.ref), directory, options.timeoutMs);
    if (!result || result.status !== 0) {
      const detail = String(result && (result.stderr || result.stdout) || '').trim().slice(0, 400);
      throw new Error(`the ${judge.name} judge failed${detail ? `: ${detail}` : ''}`);
    }
    const verdict = parseJudgePayload(result.stdout);
    const changed = changedSkillFiles(root).find((entry) => entry.path === skill.relative);
    const receiptAt = new Date(Math.max(
      Date.now(),
      Number(changed && changed.changed_at_ms || 0) + 1,
    )).toISOString();
    const receipt = {
      schema: SKILL_EVAL_SCHEMA,
      ts: receiptAt,
      source: 'skill_eval',
      skill_path: skill.relative,
      skill_changed_at: changed ? changed.changed_at : null,
      worker_model: workerModel,
      judge_identity: judge.name,
      passed: verdict.passed,
      rubric_scores: verdict.rubric_scores,
      summary: verdict.summary || null,
    };
    const receiptFile = appendSkillEvalReceipt(root, receipt);
    const relativeReceipt = path.relative(root, receiptFile).replace(/\\/g, '/');
    if (options.json) {
      console.log(JSON.stringify({ ok: verdict.passed, receipt, receipt_file: relativeReceipt }));
    } else if (verdict.passed) {
      console.log(`skill eval passed for ${skill.relative}; receipt written to ${relativeReceipt}.`);
    } else {
      console.error(`skill eval failed for ${skill.relative}; the failing receipt was written to ${relativeReceipt}.`);
    }
    return verdict.passed ? 0 : 1;
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    if (options.json) console.log(JSON.stringify({ ok: false, error: message }));
    else console.error(`skill eval could not run: ${message}.`);
    return 2;
  } finally {
    if (directory) {
      try {
        (dependencies.fs || fs).rmSync(directory, { recursive: true, force: true });
      } catch {
        // The result is already recorded; temporary cleanup is best effort.
      }
    }
  }
}

module.exports = {
  skillEvalCommand,
};
