'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const deterministicVoice = require('../scripts/det/voice');
const {
  buildVoiceCardHookJson,
  voiceCardForRoot,
} = require('../lib/voice-card');

const JUDGE_TIMEOUT_MS = 30_000;

function extractVoiceSection(repoRoot = process.cwd()) {
  const candidates = [
    path.join(repoRoot, 'atris.md'),
    path.join(repoRoot, 'atris', 'atris.md'),
  ];

  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    const start = lines.findIndex((line) => /^## voice\s*$/i.test(line));
    if (start === -1) continue;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^##\s+/.test(lines[i])) {
        end = i;
        break;
      }
    }
    return lines.slice(start, end).join('\n').trim();
  }

  throw new Error('the voice section was not found');
}

function findExecutable(name, env = process.env) {
  const pathValue = env.PATH || '';
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Try the next directory.
    }
  }
  return null;
}

function judgePrompt(rubric) {
  return [
    'Judge only the SHAPE and PLAINNESS of the reply provided on stdin against the rubric below.',
    'Do not judge factual correctness or technical quality.',
    'When unsure, PASS. False alarms are worse than misses.',
    'Return only strict JSON with exactly this shape: {"pass": boolean, "reasons": [strings]}.',
    '',
    rubric,
  ].join('\n');
}

function parseVerdict(output) {
  const verdict = JSON.parse(String(output || '').trim());
  if (!verdict || Array.isArray(verdict) || typeof verdict !== 'object') {
    throw new Error('the verdict is not an object');
  }
  const keys = Object.keys(verdict).sort();
  if (keys.length !== 2 || keys[0] !== 'pass' || keys[1] !== 'reasons') {
    throw new Error('the verdict has the wrong fields');
  }
  if (typeof verdict.pass !== 'boolean'
      || !Array.isArray(verdict.reasons)
      || !verdict.reasons.every((reason) => typeof reason === 'string')) {
    throw new Error('the verdict has the wrong shape');
  }
  return verdict;
}

function unavailable(stderr, reason) {
  const cleanReason = String(reason || 'unknown error').replace(/\s+/g, ' ').trim();
  stderr.write(`voice judge unavailable: ${cleanReason}\n`);
  return 0;
}

function runScan(reply, args, stdout) {
  const mode = args.includes('--json') ? 'json' : 'scan';
  const result = deterministicVoice.run(mode, reply);
  if (result.error) return { code: 2, error: result.error };
  stdout.write(`${result.text}\n`);
  const passed = result.text.startsWith('PASS') || result.text.startsWith('{"pass":true');
  return { code: passed ? 0 : 1 };
}

function runJudge(reply, options = {}) {
  const repoRoot = options.repoRoot || process.cwd();
  const env = options.env || process.env;
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;

  let rubric;
  try {
    rubric = extractVoiceSection(repoRoot);
  } catch (error) {
    return unavailable(stderr, error.message);
  }

  const customCommand = String(env.ATRIS_VOICE_JUDGE_CMD || '').trim();
  const claudePath = customCommand ? null : findExecutable('claude', env);
  if (!customCommand && !claudePath) {
    return unavailable(stderr, 'no judge command was found');
  }

  let tempDir;
  try {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-voice-'));
    const rubricPath = path.join(tempDir, 'rubric.md');
    fs.writeFileSync(rubricPath, rubric, 'utf8');
    const childEnv = { ...env, ATRIS_VOICE_RUBRIC: rubricPath };
    const result = customCommand
      ? spawnSync('/bin/sh', ['-c', customCommand], {
        input: reply,
        encoding: 'utf8',
        env: childEnv,
        timeout: JUDGE_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      })
      : spawnSync(claudePath, ['-p', '--model', 'haiku', judgePrompt(rubric)], {
        input: reply,
        encoding: 'utf8',
        env: childEnv,
        timeout: JUDGE_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      });

    if (result.error) return unavailable(stderr, result.error.code === 'ETIMEDOUT' ? 'the judge timed out' : 'the judge command failed');
    if (result.status !== 0) return unavailable(stderr, 'the judge command failed');

    let verdict;
    try {
      verdict = parseVerdict(result.stdout);
    } catch {
      return unavailable(stderr, 'the judge returned an unreadable verdict');
    }

    stdout.write(`${JSON.stringify(verdict)}\n`);
    return verdict.pass ? 0 : 1;
  } catch {
    return unavailable(stderr, 'the judge command failed');
  } finally {
    if (tempDir) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Cleanup cannot block the reply.
      }
    }
  }
}

function showVoiceHelp(stdout = process.stdout) {
  stdout.write([
    'usage: atris voice scan [--json]',
    '       atris voice judge',
    '       atris voice card [--hook]',
    '',
    'scan checks binary voice tells. judge checks reply shape and plainness. card prints the house voice.',
    '',
  ].join('\n'));
}

function voiceCommand(args, options = {}) {
  const subcommand = args[0];
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    showVoiceHelp(stdout);
    return 0;
  }
  if (subcommand === 'card') {
    const card = voiceCardForRoot(options.repoRoot || process.cwd());
    stdout.write(`${args.includes('--hook') ? JSON.stringify(buildVoiceCardHookJson(card)) : card}\n`);
    return 0;
  }
  if (!['scan', 'judge'].includes(subcommand)) {
    stderr.write('usage: atris voice scan [--json] | atris voice judge | atris voice card [--hook]\n');
    return 2;
  }

  const reply = options.input === undefined ? fs.readFileSync(0, 'utf8') : options.input;
  if (subcommand === 'scan') {
    const result = runScan(reply, args.slice(1), stdout);
    if (result.error) stderr.write(`${result.error}\n`);
    return result.code;
  }
  return runJudge(reply, { ...options, stdout, stderr });
}

module.exports = {
  extractVoiceSection,
  voiceCommand,
};
