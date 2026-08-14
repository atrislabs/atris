'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PACKAGE_ROOT = path.join(__dirname, '..');
const VOICE_CARD_START = '<!-- ATRIS_VOICE_CARD:START -->';
const VOICE_CARD_END = '<!-- ATRIS_VOICE_CARD:END -->';
const BRAIN_START = '<!-- ATRIS_BRAIN_COMPILE:START -->';
const BRAIN_END = '<!-- ATRIS_BRAIN_COMPILE:END -->';
const CLAUDE_VOICE_HOOK_COMMAND = 'command -v atris >/dev/null 2>&1 && atris voice card --hook || true';

function extractVoiceDoctrine(content) {
  const lines = String(content || '').split(/\r?\n/);
  const start = lines.findIndex((line) => /^## voice\s*$/i.test(line));
  if (start === -1) return '';
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n').trim();
}

function readVoiceDoctrine(root = process.cwd()) {
  const candidates = [
    path.join(root, 'atris.md'),
    path.join(root, 'atris', 'atris.md'),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const doctrine = extractVoiceDoctrine(fs.readFileSync(file, 'utf8'));
    if (doctrine) return doctrine;
  }
  return '';
}

function principleSentence(doctrine, label, fallback) {
  const line = String(doctrine || '')
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith('- **') && label.test(candidate));
  if (!line) return fallback;
  const body = line.replace(/^- \*\*[^*]+\*\*\s*/, '').trim();
  const sentence = body.match(/^.*?[.!?](?:\s|$)/);
  return (sentence ? sentence[0] : body)
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim() || fallback;
}

function naturalLead(source) {
  if (source === 'Answer first, support after.') {
    return 'Start with the answer, then give the reader only what helps them act.';
  }
  return source;
}

function naturalSpecific(source) {
  if (source === 'Name the exact thing.') {
    return 'Name the exact thing in plain words, like you are talking to a person.';
  }
  return source;
}

function composeVoiceCard(doctrine = readVoiceDoctrine(PACKAGE_ROOT)) {
  const lead = naturalLead(principleSentence(
    doctrine,
    /Lead with the move/i,
    'Start with the answer, then give the reader only what helps them act.',
  ));
  const specific = naturalSpecific(principleSentence(
    doctrine,
    /Specific over buzzy/i,
    'Name the exact thing in plain words, like you are talking to a person.',
  ));

  return `${lead} ${specific}

Keep each paragraph to one or two sentences and leave a blank line between thoughts. Use a comma or period instead of an em dash.

Status example:
The reply check is built. I am running the final checks now, so the result is not ready yet.

Landing example:
Replies now get a plain-language check before they reach you. The checks passed, and the change is ready.`;
}

const VOICE_CARD = composeVoiceCard();

function voiceCardForRoot(root = process.cwd()) {
  const doctrine = readVoiceDoctrine(root) || readVoiceDoctrine(PACKAGE_ROOT);
  return composeVoiceCard(doctrine);
}

function buildVoiceCardHookJson(card = VOICE_CARD) {
  return {
    suppressOutput: true,
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: card,
    },
  };
}

function renderVoiceCardBlock(card = VOICE_CARD) {
  return `${VOICE_CARD_START}
## Voice card

${card}
${VOICE_CARD_END}`;
}

function replaceOrAppendVoiceBlock(source, card) {
  const block = renderVoiceCardBlock(card);
  const start = source.indexOf(VOICE_CARD_START);
  const end = source.indexOf(VOICE_CARD_END, start + VOICE_CARD_START.length);
  if (start !== -1 && end !== -1) {
    return `${source.slice(0, start)}${block}${source.slice(end + VOICE_CARD_END.length)}`;
  }
  const separator = source.trim() ? '\n\n' : '';
  return `${source.trimEnd()}${separator}${block}\n`;
}

function ensureAlwaysApplyFrontmatter(source) {
  if (!source.startsWith('---\n') && !source.startsWith('---\r\n')) {
    return `---\nalwaysApply: true\n---\n\n${source.replace(/^\s+/, '')}`;
  }

  const normalized = source.replace(/\r\n/g, '\n');
  const closing = normalized.indexOf('\n---', 4);
  if (closing === -1) {
    return `---\nalwaysApply: true\n---\n\n${source}`;
  }

  const frontmatter = normalized.slice(4, closing).split('\n');
  const alwaysApply = frontmatter.findIndex((line) => /^alwaysApply\s*:/.test(line));
  if (alwaysApply === -1) frontmatter.push('alwaysApply: true');
  else frontmatter[alwaysApply] = 'alwaysApply: true';
  return `---\n${frontmatter.join('\n')}\n---${normalized.slice(closing + 4)}`;
}

function upsertCursorVoiceCard(filePath, card = VOICE_CARD, options = {}) {
  const source = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  const withFrontmatter = ensureAlwaysApplyFrontmatter(source);
  const content = replaceOrAppendVoiceBlock(withFrontmatter, card);
  const changed = content !== source;
  if (changed && !options.dryRun) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
  }
  return { action: source ? (changed ? 'updated' : 'unchanged') : 'created', content };
}

function upsertAgentVoiceCard(filePath, card = VOICE_CARD, options = {}) {
  const source = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  const brainStart = source.indexOf(BRAIN_START);
  const brainEnd = source.indexOf(BRAIN_END, brainStart + BRAIN_START.length);
  let content;

  if (brainStart !== -1 && brainEnd !== -1) {
    const block = source.slice(brainStart, brainEnd + BRAIN_END.length);
    const updatedBlock = replaceOrAppendVoiceBlock(
      block.slice(0, -BRAIN_END.length).trimEnd(),
      card,
    ).trimEnd() + `\n${BRAIN_END}`;
    content = `${source.slice(0, brainStart)}${updatedBlock}${source.slice(brainEnd + BRAIN_END.length)}`;
  } else {
    const prefix = source.trimEnd() || '# AGENTS';
    content = `${prefix}\n\n${BRAIN_START}\n## Atris Brain Compile\n\n${renderVoiceCardBlock(card)}\n${BRAIN_END}\n`;
  }

  const changed = content !== source;
  if (changed && !options.dryRun) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
  }
  return { action: source ? (changed ? 'updated' : 'unchanged') : 'created', content };
}

function voiceHookEntry() {
  return {
    hooks: [
      {
        type: 'command',
        command: CLAUDE_VOICE_HOOK_COMMAND,
      },
    ],
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidSettings(filePath, warn, reason) {
  const warning = `could not add the atris voice hook to ${path.relative(process.cwd(), filePath) || filePath} because ${reason}; the file was left unchanged.`;
  warn(warning);
  return { action: 'skipped', warning };
}

function upsertClaudeVoiceHook(filePath, options = {}) {
  const exists = fs.existsSync(filePath);
  const source = exists ? fs.readFileSync(filePath, 'utf8') : null;
  const warn = options.warn || console.warn;
  let settings;

  if (exists) {
    try {
      settings = JSON.parse(source);
    } catch {
      return invalidSettings(filePath, warn, 'it is not valid json');
    }
  } else {
    settings = JSON.parse(JSON.stringify(options.initialSettings || {}));
  }

  if (!isPlainObject(settings)) {
    return invalidSettings(filePath, warn, 'its top level is not an object');
  }
  if (settings.hooks === undefined) settings.hooks = {};
  if (!isPlainObject(settings.hooks)) {
    return invalidSettings(filePath, warn, 'its hooks value is not an object');
  }
  if (settings.hooks.UserPromptSubmit === undefined) settings.hooks.UserPromptSubmit = [];
  if (!Array.isArray(settings.hooks.UserPromptSubmit)) {
    return invalidSettings(filePath, warn, 'its UserPromptSubmit hooks are not a list');
  }

  const present = settings.hooks.UserPromptSubmit.some((group) => (
    group && Array.isArray(group.hooks) && group.hooks.some((hook) => (
      hook && typeof hook.command === 'string' && hook.command.includes('atris voice card --hook')
    ))
  ));
  if (present) return { action: 'unchanged', content: source };

  settings.hooks.UserPromptSubmit.push(voiceHookEntry());
  const content = `${JSON.stringify(settings, null, 2)}\n`;
  if (!options.dryRun) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
  }
  return { action: exists ? 'updated' : 'created', content };
}

module.exports = {
  CLAUDE_VOICE_HOOK_COMMAND,
  VOICE_CARD,
  buildVoiceCardHookJson,
  composeVoiceCard,
  readVoiceDoctrine,
  renderVoiceCardBlock,
  upsertAgentVoiceCard,
  upsertClaudeVoiceHook,
  upsertCursorVoiceCard,
  voiceCardForRoot,
};
