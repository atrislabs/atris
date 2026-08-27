'use strict';

const os = require('os');
const path = require('path');

const SETTINGS_NAME = 'settings.json';
const CLAUDE_DIR_NAME = '.claude';
const DENY_REASON = 'pack runs cannot change .claude/settings.json to add SessionStart or disable hooks';

function expandUserPath(value, home) {
  const text = String(value);
  if (text === '~') return home;
  if (text.startsWith('~/') || text.startsWith('~\\')) return path.join(home, text.slice(2));
  return text;
}

function asText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function settingsPlantPersistence(value) {
  if (!value || typeof value !== 'object') return false;
  if (value.disableAllHooks === true) return true;
  if (value.hooks && Object.prototype.hasOwnProperty.call(value.hooks, 'SessionStart')) return true;
  return Object.values(value).some((entry) => settingsPlantPersistence(entry));
}

function plantsPersistence(text) {
  const source = asText(text);
  if (!source) return false;
  if (/\bSessionStart\b/.test(source)) return true;
  if (/["']?disableAllHooks["']?\s*:\s*true\b/.test(source)) return true;
  try {
    return settingsPlantPersistence(JSON.parse(source));
  } catch {
    return false;
  }
}

function isClaudeSettingsPath(value, options = {}) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const home = options.home || os.homedir();
  const cwd = options.cwd || process.cwd();
  const expanded = expandUserPath(value.trim(), home);
  const resolved = path.resolve(cwd, expanded);
  if (path.basename(resolved) === SETTINGS_NAME && path.basename(path.dirname(resolved)) === CLAUDE_DIR_NAME) {
    return true;
  }
  const configDir = path.resolve(
    options.configDir
      || process.env.CLAUDE_CONFIG_DIR
      || path.join(home, CLAUDE_DIR_NAME),
  );
  return resolved === path.join(configDir, SETTINGS_NAME);
}

function commandMentionsClaudeSettings(command) {
  const text = String(command || '');
  if (!text.trim()) return false;
  return /(?:^|[^\w])(?:~\/|\.\/|(?:\.\.\/)+)?(?:\$\{?HOME\}?\/)?\.claude\/settings\.json\b/.test(text)
    || /\$\{?CLAUDE_CONFIG_DIR\}?\/settings\.json/.test(text)
    || /(?:^|[^\w])(?:\$HOME|\$\{HOME\})\/\.claude\/settings\.json\b/.test(text);
}

function fileToolPath(input) {
  const toolInput = (input && input.tool_input) || {};
  return toolInput.file_path || toolInput.path || null;
}

function bashCommand(input) {
  const toolInput = (input && input.tool_input) || {};
  return toolInput.command || toolInput.cmd || '';
}

function writeContents(input) {
  const toolInput = (input && input.tool_input) || {};
  return toolInput.contents ?? toolInput.content ?? toolInput.new_string ?? '';
}

function enforceConfigGuard(input, options = {}) {
  const tool = input && input.tool_name;
  if (tool === 'Write' || tool === 'Edit') {
    if (!isClaudeSettingsPath(fileToolPath(input), options)) return { allowed: true };
    if (!plantsPersistence(writeContents(input))) return { allowed: true };
    return { allowed: false, reason: DENY_REASON };
  }
  if (tool === 'Bash') {
    if (!commandMentionsClaudeSettings(bashCommand(input))) return { allowed: true };
    return { allowed: false, reason: DENY_REASON };
  }
  return { allowed: true };
}

module.exports = {
  DENY_REASON,
  commandMentionsClaudeSettings,
  enforceConfigGuard,
  isClaudeSettingsPath,
  plantsPersistence,
};
