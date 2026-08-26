'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const TRIAL_PROMPTS = [
  'Write a brief status update telling your manager the deploy finished and one alert needs review.',
  'Explain to a teammate in a few sentences why the cache change made startup faster.',
  'Write a short note announcing that exports now run on a schedule.',
  'Summarize for a non-engineer what changed in this week\'s release.',
  'Write a two-paragraph answer on whether we should switch to the new logging library.',
  'Draft a short reply declining a meeting and proposing async notes instead.',
];
const TRIAL_DRAFTS_PER_ARM = 2;
const TRIAL_BET = 0.5;
const JARGON_WORDS = /\b(?:leverage|seamless|robust|delve|synergy)\b/i;

function playbookFile(root = process.cwd()) {
  return path.join(root, '.atris', 'state', 'playbook.json');
}

function readPlaybook(root = process.cwd()) {
  try {
    const value = JSON.parse(fs.readFileSync(playbookFile(root), 'utf8'));
    return { version: 1, rules: Array.isArray(value.rules) ? value.rules : [] };
  } catch (err) {
    if (err.code === 'ENOENT') return { version: 1, rules: [] };
    throw err;
  }
}

function writePlaybook(playbook, root = process.cwd()) {
  const file = playbookFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(playbook, null, 2)}\n`);
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  if (!args[index + 1] || args[index + 1].startsWith('--')) {
    throw new Error(`${name} needs a value`);
  }
  return args[index + 1];
}

function printHelp(output) {
  output('usage: atris playbook [show] [--family <family>] [--json]');
  output('       atris playbook add <family> <rule> [--source <source>]');
  output('       atris playbook inject [--family <family>]');
  output('       atris playbook remove <id>');
  output('       atris playbook verify <id> --with <score> --without <score> [--method <method>]');
  output('       atris playbook trial [--engine <cmd>] [--max-pairs <n>] [--alpha <a>]');
}

function filteredRules(playbook, family) {
  return family ? playbook.rules.filter((entry) => entry.family === family) : playbook.rules;
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sentenceCount(paragraph) {
  const value = paragraph.trim();
  if (!value) return 0;
  const endings = value.match(/[.!?]+(?=\s|$)/g) || [];
  return endings.length + (/[.!?]["')\]]*\s*$/.test(value) ? 0 : 1);
}

function gradeText(text) {
  const value = String(text || '').trim();
  const paragraphs = value ? value.split(/\n\s*\n/) : [''];
  const checks = [
    !value.includes('\u2014'),
    paragraphs.every((paragraph) => sentenceCount(paragraph) <= 2),
    !JARGON_WORDS.test(value),
    !/\b[A-Z]{4,}\b/.test(value),
    !value.includes('!'),
  ];
  return checks.filter(Boolean).length / checks.length;
}

function bettingEvidence(differences, direction) {
  const logEvidence = differences.reduce((sum, difference) => (
    sum + Math.log(1 + (direction * TRIAL_BET * difference))
  ), 0);
  return Math.exp(Math.min(logEvidence, Math.log(Number.MAX_VALUE)));
}

function trialPrompt(rules, prompt) {
  const system = [
    'You are a sharp, plain-spoken assistant. Answer directly and briefly.',
    rules.length ? `Follow every writing rule that applies:\n${rules.map((rule) => `- ${rule}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
  return { system, argv: `${system}\n\nPrompt:\n${prompt}` };
}

function runShellEngine(command, prompt) {
  return new Promise((resolve, reject) => {
    execFile('/bin/sh', ['-c', `${command} "$1"`, 'atris-playbook-engine', prompt], {
      timeout: 120000,
      maxBuffer: 1024 * 1024,
    }, (err, stdout) => {
      if (err) {
        reject(new Error(`trial engine failed: ${err.message || err}`));
        return;
      }
      const reply = String(stdout || '').trim();
      if (!reply) {
        reject(new Error('trial engine returned an empty reply'));
        return;
      }
      resolve(reply);
    });
  });
}

async function runLocalEngine(system, prompt, fetchImpl) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetchImpl('http://localhost:11434/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'qwen2.5:7b',
          temperature: 0.8,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt },
          ],
        }),
        signal: AbortSignal.timeout(120000),
      });
      if (!response.ok) {
        lastError = new Error(`local trial engine returned status ${response.status}`);
        continue;
      }
      const body = await response.json();
      const reply = String(body.choices?.[0]?.message?.content || '').trim();
      if (reply) return reply;
      lastError = new Error('local trial engine returned an empty reply');
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`local trial engine failed: ${lastError?.message || 'no reply'}`);
}

async function armScore(rules, prompt, options) {
  const prepared = trialPrompt(rules, prompt);
  const drafts = [];
  for (let index = 0; index < TRIAL_DRAFTS_PER_ARM; index += 1) {
    drafts.push(options.engine
      ? await runShellEngine(options.engine, prepared.argv)
      : await runLocalEngine(prepared.system, prompt, options.fetchImpl));
  }
  return Math.max(...drafts.map(gradeText));
}

function numberedPrompt(index) {
  const base = TRIAL_PROMPTS[index % TRIAL_PROMPTS.length];
  const cycle = Math.floor(index / TRIAL_PROMPTS.length);
  return cycle === 0 ? base : `${base} Variation ${cycle}.`;
}

function trialStats(rule, alphaBudget) {
  const differences = Array.isArray(rule.trial_diffs) ? rule.trial_diffs : [];
  if (differences.length === 0) return null;
  return {
    pairs: differences.length,
    difference: mean(differences),
    killEvidence: bettingEvidence(differences, 1),
    certifyEvidence: bettingEvidence(differences, -1),
    threshold: 1 / alphaBudget,
  };
}

function applyTrialVerdict(rule, stats, options) {
  const quarantined = stats.killEvidence >= stats.threshold;
  const certified = stats.certifyEvidence >= stats.threshold;
  if (!quarantined && !certified) return null;
  const withScores = Array.isArray(rule.trial_scores_with) ? rule.trial_scores_with : [];
  const withoutScores = Array.isArray(rule.trial_scores_without) ? rule.trial_scores_without : [];
  rule.quarantined = quarantined;
  rule.verified = {
    method: 'paired-trial',
    score_with: withScores.length ? mean(withScores) : null,
    score_without: withoutScores.length ? mean(withoutScores) : null,
    pairs: stats.pairs,
    mean_difference: stats.difference,
    kill_evidence: stats.killEvidence,
    certify_evidence: stats.certifyEvidence,
    evidence_threshold: stats.threshold,
    alpha: options.alphaBudget,
    at: options.now(),
  };
  return quarantined ? 'quarantined' : 'certified';
}

async function runRuleTrial(rule, playbook, options) {
  const activeRules = playbook.rules.filter((entry) => entry !== rule && !entry.quarantined);
  const rulesWithout = activeRules.map((entry) => entry.rule);
  const rulesWith = [...rulesWithout, rule.rule];
  rule.trial_diffs = Array.isArray(rule.trial_diffs) ? rule.trial_diffs : [];
  rule.trial_scores_with = Array.isArray(rule.trial_scores_with) ? rule.trial_scores_with : [];
  rule.trial_scores_without = Array.isArray(rule.trial_scores_without) ? rule.trial_scores_without : [];
  options.output(`on trial: ${rule.id} (${rule.trial_diffs.length} prior pairs)`);

  let stats = trialStats(rule, options.alphaBudget);
  let verdict = stats ? applyTrialVerdict(rule, stats, options) : null;
  while (!verdict && rule.trial_diffs.length < options.maxPairs) {
    const start = rule.trial_diffs.length;
    const prompt = numberedPrompt(start);
    const [scoreWith, scoreWithout] = await Promise.all([
      armScore(rulesWith, prompt, options),
      armScore(rulesWithout, prompt, options),
    ]);
    rule.trial_scores_with.push(scoreWith);
    rule.trial_scores_without.push(scoreWithout);
    rule.trial_diffs.push(Number((scoreWithout - scoreWith).toFixed(6)));
    stats = trialStats(rule, options.alphaBudget);
    verdict = applyTrialVerdict(rule, stats, options);
    writePlaybook(playbook, options.root);
  }

  if (verdict) {
    writePlaybook(playbook, options.root);
    options.output(`rule ${verdict}: ${rule.id} after ${stats.pairs} pairs`);
    return;
  }
  options.output(`rule undecided after ${rule.trial_diffs.length} pairs: ${rule.id}`);
}

async function runTrials(playbook, rest, options) {
  const rawMaxPairs = optionValue(rest, '--max-pairs');
  const rawAlpha = optionValue(rest, '--alpha');
  const maxPairs = rawMaxPairs === null ? 30 : Number(rawMaxPairs);
  const alpha = rawAlpha === null ? 0.05 : Number(rawAlpha);
  if (!Number.isInteger(maxPairs) || maxPairs < 1) throw new Error('--max-pairs needs a positive integer');
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) throw new Error('--alpha needs a number between 0 and 1');
  const engine = optionValue(rest, '--engine');
  const unresolved = playbook.rules.filter((rule) => !rule.verified && rule.quarantined !== true);
  if (unresolved.length === 0) {
    options.output('no unresolved rules');
    return 0;
  }
  const alphaBudget = alpha / Math.max(1, playbook.rules.length);
  for (const rule of unresolved) {
    await runRuleTrial(rule, playbook, {
      ...options,
      engine,
      maxPairs,
      alphaBudget,
    });
  }
  return 0;
}

function playbookCommand(args = [], options = {}) {
  const root = options.root || process.cwd();
  const output = options.output || console.log;
  const now = options.now || (() => new Date().toISOString());
  const makeId = options.makeId || (() => crypto.randomUUID().slice(0, 8));
  const subcommand = args[0] && !args[0].startsWith('--') ? args[0] : 'show';
  const rest = subcommand === 'show' && args[0] !== 'show' ? args : args.slice(1);

  if (args.includes('--help') || args.includes('-h') || subcommand === 'help') {
    printHelp(output);
    return 0;
  }

  const playbook = readPlaybook(root);
  if (subcommand === 'trial') {
    return runTrials(playbook, rest, {
      root,
      output,
      now,
      fetchImpl: options.fetch || globalThis.fetch,
    });
  }
  if (subcommand === 'show') {
    const family = optionValue(rest, '--family');
    const rules = filteredRules(playbook, family);
    if (rest.includes('--json')) {
      output(JSON.stringify({ version: 1, rules }, null, 2));
      return 0;
    }
    if (rules.length === 0) {
      output('no style rules saved');
      return 0;
    }
    const families = [...new Set(rules.map((entry) => entry.family))];
    for (const name of families) {
      output(`${name}:`);
      for (const entry of rules.filter((rule) => rule.family === name)) {
        const state = entry.quarantined ? ' (quarantined)' : '';
        output(`- ${entry.id}: ${entry.rule}${state}`);
      }
    }
    return 0;
  }

  if (subcommand === 'add') {
    const family = rest[0];
    const rule = rest[1];
    if (!family || !rule || family.startsWith('--') || rule.startsWith('--')) {
      throw new Error('add needs a family and rule');
    }
    const duplicate = playbook.rules.find((entry) => entry.family === family && entry.rule === rule);
    if (duplicate) {
      output(`rule already exists: ${duplicate.id}`);
      return 0;
    }
    const entry = {
      id: makeId(),
      family,
      rule,
      source: optionValue(rest, '--source') || '',
      verified: null,
      created_at: now(),
    };
    playbook.rules.push(entry);
    writePlaybook(playbook, root);
    output(`rule added: ${entry.id}`);
    return 0;
  }

  if (subcommand === 'inject') {
    const family = optionValue(rest, '--family');
    const rules = filteredRules(playbook, family).filter((entry) => !entry.quarantined);
    if (rules.length === 0) return 0;
    output('Workspace style rules (follow every rule that applies):');
    for (const entry of rules) output(`- ${entry.rule}`);
    return 0;
  }

  if (subcommand === 'remove') {
    const id = rest[0];
    if (!id) throw new Error('remove needs a rule id');
    const index = playbook.rules.findIndex((entry) => entry.id === id);
    if (index === -1) throw new Error(`rule not found: ${id}`);
    playbook.rules.splice(index, 1);
    writePlaybook(playbook, root);
    output(`rule removed: ${id}`);
    return 0;
  }

  if (subcommand === 'verify') {
    const id = rest[0];
    const rawScoreWith = optionValue(rest, '--with');
    const rawScoreWithout = optionValue(rest, '--without');
    const scoreWith = Number(rawScoreWith);
    const scoreWithout = Number(rawScoreWithout);
    if (!id) throw new Error('verify needs a rule id');
    if (rawScoreWith === null || rawScoreWithout === null ||
        !Number.isFinite(scoreWith) || !Number.isFinite(scoreWithout)) {
      throw new Error('verify needs numeric --with and --without scores');
    }
    const entry = playbook.rules.find((rule) => rule.id === id);
    if (!entry) throw new Error(`rule not found: ${id}`);
    entry.verified = {
      method: optionValue(rest, '--method') || 'replay',
      score_with: scoreWith,
      score_without: scoreWithout,
      at: now(),
    };
    if (scoreWith < scoreWithout) entry.quarantined = true;
    else delete entry.quarantined;
    writePlaybook(playbook, root);
    output(entry.quarantined ? `rule quarantined: ${id}` : `rule verified: ${id}`);
    return 0;
  }

  throw new Error(`unknown playbook command: ${subcommand}`);
}

module.exports = { playbookCommand, playbookFile, readPlaybook, gradeText };
