'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { scanFile } = require('../commands/slop');
const {
  CLAUDE_VOICE_HOOK_COMMAND,
  VOICE_CARD,
  buildVoiceCardHookJson,
  composeVoiceCard,
  readVoiceDoctrine,
  upsertClaudeVoiceHook,
  upsertCursorVoiceCard,
  voiceCardForRoot,
} = require('../lib/voice-card');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'atris.js');
const BRAIN_START = '<!-- ATRIS_BRAIN_COMPILE:START -->';
const BRAIN_END = '<!-- ATRIS_BRAIN_COMPILE:END -->';
const VOICE_START = '<!-- ATRIS_VOICE_CARD:START -->';
const VOICE_END = '<!-- ATRIS_VOICE_CARD:END -->';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-voice-card-'));
}

function runCli(cwd, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
    timeout: 60_000,
  });
}

function count(text, part) {
  return text.split(part).length - 1;
}

function voiceHookCount(settings) {
  return (settings.hooks.UserPromptSubmit || []).filter((group) => (
    group.hooks.some((hook) => hook.command && hook.command.includes('atris voice card --hook'))
  )).length;
}

test('voice card composes under the word cap with two examples and zero slop hits', () => {
  const words = VOICE_CARD.trim().split(/\s+/);
  assert.ok(words.length < 160, `card has ${words.length} words`);
  assert.equal(count(VOICE_CARD, ' example:'), 2);
  assert.match(VOICE_CARD, /Status example:\n.+\n\nLanding example:\n.+/s);
  assert.doesNotMatch(VOICE_CARD, /\u2014/);

  const dir = makeTempDir();
  try {
    const file = path.join(dir, 'voice-card.txt');
    fs.writeFileSync(file, VOICE_CARD, 'utf8');
    assert.deepEqual(scanFile(file), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('voice card composition follows relevant doctrine edits', () => {
  const doctrine = readVoiceDoctrine(ROOT).replace(
    'Answer first, support after.',
    'Put the result first.',
  );
  assert.match(composeVoiceCard(doctrine), /^Put the result first\./);
});

test('voice card hook mode prints the exact UserPromptSubmit payload', () => {
  const result = runCli(ROOT, ['voice', 'card', '--hook']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    JSON.parse(result.stdout),
    buildVoiceCardHookJson(voiceCardForRoot(ROOT)),
  );
  assert.deepEqual(Object.keys(JSON.parse(result.stdout)), ['suppressOutput', 'hookSpecificOutput']);
});

test('Claude settings merge preserves foreign keys and hooks and is idempotent', () => {
  const dir = makeTempDir();
  try {
    const file = path.join(dir, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const foreign = {
      permissions: { allow: ['Read'] },
      customFlag: true,
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'custom-start' }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'custom-prompt' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'custom-stop' }] }],
      },
    };
    fs.writeFileSync(file, JSON.stringify(foreign, null, 2), 'utf8');

    const first = upsertClaudeVoiceHook(file);
    assert.equal(first.action, 'updated');
    const merged = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(merged.permissions, foreign.permissions);
    assert.equal(merged.customFlag, true);
    assert.deepEqual(merged.hooks.SessionStart, foreign.hooks.SessionStart);
    assert.deepEqual(merged.hooks.Stop, foreign.hooks.Stop);
    assert.deepEqual(merged.hooks.UserPromptSubmit[0], foreign.hooks.UserPromptSubmit[0]);
    assert.equal(voiceHookCount(merged), 1);
    assert.equal(merged.hooks.UserPromptSubmit[1].hooks[0].command, CLAUDE_VOICE_HOOK_COMMAND);

    const once = fs.readFileSync(file, 'utf8');
    const second = upsertClaudeVoiceHook(file);
    assert.equal(second.action, 'unchanged');
    assert.equal(fs.readFileSync(file, 'utf8'), once);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Claude settings merge warns once and leaves corrupt json untouched', () => {
  const dir = makeTempDir();
  try {
    const file = path.join(dir, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const corrupt = '{ "hooks": nope';
    fs.writeFileSync(file, corrupt, 'utf8');
    const warnings = [];

    const result = upsertClaudeVoiceHook(file, { warn: (line) => warnings.push(line) });
    assert.equal(result.action, 'skipped');
    assert.deepEqual(warnings, [result.warning]);
    assert.match(warnings[0], /^could not add the atris voice hook .+ because it is not valid json; the file was left unchanged\.$/);
    assert.equal(fs.readFileSync(file, 'utf8'), corrupt);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Cursor voice card upsert is idempotent and preserves text outside its markers', () => {
  const dir = makeTempDir();
  try {
    const file = path.join(dir, '.cursor', 'rules', 'atris-voice.mdc');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      '---',
      'description: keep my project note',
      'alwaysApply: false',
      '---',
      '',
      'keep this before the card',
      '',
    ].join('\n'), 'utf8');

    upsertCursorVoiceCard(file, VOICE_CARD);
    fs.appendFileSync(file, '\nkeep this after the card\n', 'utf8');
    const once = fs.readFileSync(file, 'utf8');
    assert.match(once, /^---\ndescription: keep my project note\nalwaysApply: true\n---/);
    assert.match(once, /keep this before the card/);
    assert.match(once, /keep this after the card/);
    assert.equal(count(once, VOICE_START), 1);
    assert.equal(count(once, VOICE_END), 1);

    const result = upsertCursorVoiceCard(file, VOICE_CARD);
    assert.equal(result.action, 'unchanged');
    assert.equal(fs.readFileSync(file, 'utf8'), once);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fresh init wires the voice card into Claude, Cursor, and AGENTS', () => {
  const dir = makeTempDir();
  try {
    const result = runCli(dir, ['init', '--yes']);
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

    const settings = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));
    assert.equal(voiceHookCount(settings), 1);
    assert.equal(settings.hooks.UserPromptSubmit[0].hooks[0].command, CLAUDE_VOICE_HOOK_COMMAND);

    const cursor = fs.readFileSync(path.join(dir, '.cursor', 'rules', 'atris-voice.mdc'), 'utf8');
    assert.match(cursor, /^---\nalwaysApply: true\n---/);
    assert.match(cursor, new RegExp(VOICE_CARD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const agents = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
    assert.ok(agents.indexOf(BRAIN_START) < agents.indexOf(VOICE_START));
    assert.ok(agents.indexOf(VOICE_END) < agents.indexOf(BRAIN_END));
    assert.match(agents, new RegExp(VOICE_CARD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('update adds missing voice doors without replacing user settings or text', () => {
  const dir = makeTempDir();
  try {
    const init = runCli(dir, ['init', '--yes']);
    assert.equal(init.status, 0, init.stderr || init.stdout);

    const settingsFile = path.join(dir, '.claude', 'settings.json');
    const customSettings = {
      theme: 'owner-choice',
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'owner-start' }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'owner-prompt' }] }],
      },
    };
    fs.writeFileSync(settingsFile, JSON.stringify(customSettings, null, 2), 'utf8');

    const cursorFile = path.join(dir, '.cursor', 'rules', 'atris-voice.mdc');
    fs.appendFileSync(cursorFile, '\nowner cursor note\n', 'utf8');
    const agentsFile = path.join(dir, 'AGENTS.md');
    fs.appendFileSync(agentsFile, '\nowner agent note\n', 'utf8');

    const update = runCli(dir, ['update', '--yes']);
    assert.equal(update.status, 0, update.stderr || update.stdout);
    const merged = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    assert.equal(merged.theme, 'owner-choice');
    assert.deepEqual(merged.hooks.SessionStart, customSettings.hooks.SessionStart);
    assert.deepEqual(merged.hooks.UserPromptSubmit[0], customSettings.hooks.UserPromptSubmit[0]);
    assert.equal(voiceHookCount(merged), 1);
    assert.match(fs.readFileSync(cursorFile, 'utf8'), /owner cursor note/);
    assert.match(fs.readFileSync(agentsFile, 'utf8'), /owner agent note/);

    const once = [settingsFile, cursorFile, agentsFile].map((file) => fs.readFileSync(file, 'utf8'));
    const rerun = runCli(dir, ['update', '--yes']);
    assert.equal(rerun.status, 0, rerun.stderr || rerun.stdout);
    assert.deepEqual(
      [settingsFile, cursorFile, agentsFile].map((file) => fs.readFileSync(file, 'utf8')),
      once,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('brain compile refreshes the card from doctrine and preserves outside text', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'atris.md'), fs.readFileSync(path.join(ROOT, 'atris.md'), 'utf8'), 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), '# Map\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), '# TODO\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Owner rules\n', 'utf8');

    const first = runCli(dir, ['brain', 'compile', '--yes', '--root', dir, '--verify']);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstAgents = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
    assert.match(firstAgents, /Start with the answer/);

    const doctrineFile = path.join(dir, 'atris', 'atris.md');
    fs.writeFileSync(
      doctrineFile,
      fs.readFileSync(doctrineFile, 'utf8').replace('Answer first, support after.', 'Put the result first.'),
      'utf8',
    );
    fs.appendFileSync(path.join(dir, 'AGENTS.md'), '\nowner agent tail\n', 'utf8');
    const cursorFile = path.join(dir, '.cursor', 'rules', 'atris-voice.mdc');
    fs.appendFileSync(cursorFile, '\nowner cursor tail\n', 'utf8');

    const second = runCli(dir, ['brain', 'compile', '--yes', '--root', dir, '--verify']);
    assert.equal(second.status, 0, second.stderr || second.stdout);
    const agents = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
    const cursor = fs.readFileSync(cursorFile, 'utf8');
    assert.match(agents, /Put the result first\./);
    assert.match(cursor, /Put the result first\./);
    assert.match(agents, /owner agent tail/);
    assert.match(cursor, /owner cursor tail/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
