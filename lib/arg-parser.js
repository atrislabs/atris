'use strict';

function hasFlag(args, name) {
  return args.includes(name);
}

function unquote(value) {
  const text = String(value);
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function readFlag(args, name, fallback = '') {
  const prefix = `${name}=`;
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i]);
    if (arg === name && args[i + 1] && !String(args[i + 1]).startsWith('--')) {
      return unquote(args[i + 1]);
    }
    if (arg.startsWith(prefix)) return unquote(arg.slice(prefix.length));
  }
  return fallback;
}

function readIntFlag(args, name, fallback = null) {
  const raw = readFlag(args, name, '');
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : null;
}

function readNumberFlag(args, name, fallback = null) {
  const raw = readFlag(args, name, '');
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

module.exports = { hasFlag, readFlag, readIntFlag, readNumberFlag };
