'use strict';

// Where a team member does its work: "runs on" on a team line.
//
//   - cosmo: claude, model: opus 5.5, on: atris computer
//   - amara: on: grok bot
//
// Three kinds of place:
//   local           this machine, shown by its own name ("Keshav's MacBook Pro")
//   atris computer  the computer Atris hosts for the person or business
//   anything else   a named bot on another machine ("grok bot", "claude duet")
//
// Naming an engine installed here ("on: muse") means that engine, locally.
// Only local members run here; the rest wait for their own machine.

const os = require('os');
const { execFileSync } = require('child_process');

const LOCAL_WORDS = new Set(['', 'local', 'here', 'this mac', 'this computer', 'this machine', 'my mac', 'my laptop', 'mac', 'laptop']);
const ATRIS_COMPUTER_WORDS = new Set(['atris computer', 'atris cloud', 'cloud', 'computer', 'atris', 'your atris computer', 'business computer', 'personal computer', 'cloud computer']);
const ATRIS_COMPUTER = 'atris computer';
const KNOWN_LABELS = Object.freeze({
  'atris computer': 'Atris computer',
  'grok bot': 'Grok bot',
  'claude duet': 'Claude Duet',
  dots: 'Dots',
  hermes: 'Hermes',
  muse: 'Muse',
});

let cachedMachineName = null;

// The name a person gave this machine, the one AirDrop shows. Falls back to
// the host name without its .local tail.
function machineName() {
  if (cachedMachineName !== null) return cachedMachineName;
  let name = '';
  if (process.env.ATRIS_MACHINE_NAME) name = process.env.ATRIS_MACHINE_NAME;
  if (!name && process.platform === 'darwin') {
    try {
      name = execFileSync('scutil', ['--get', 'ComputerName'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim();
    } catch { name = ''; }
  }
  if (!name) name = String(os.hostname() || '').replace(/\.local$/i, '');
  cachedMachineName = name || 'this computer';
  return cachedMachineName;
}

function cleanWords(text) {
  return String(text || '')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function placeLabel(id) {
  if (KNOWN_LABELS[id]) return KNOWN_LABELS[id];
  return id.charAt(0).toUpperCase() + id.slice(1);
}

// What "on: <words>" means. isEngine(name) answers whether the words name an
// engine atris knows; it is passed in so this file stays free of the
// registry. Throws a plain sentence on words that cannot be a place.
function readRunsOn(words, options = {}) {
  const raw = String(words || '').trim();
  const clean = cleanWords(raw);
  if (/[,:]/.test(clean)) throw new Error(`"${raw}" is not a place; use on: atris computer, on: local, or a bot name like on: grok bot`);
  if (clean.length > 40) throw new Error(`"${raw}" is too long for a place name`);
  if (LOCAL_WORDS.has(clean) || clean === cleanWords(machineName())) {
    return { id: 'local', label: machineName(), here: true };
  }
  if (ATRIS_COMPUTER_WORDS.has(clean)) return { id: ATRIS_COMPUTER, label: placeLabel(ATRIS_COMPUTER), here: false };
  const engine = typeof options.isEngine === 'function' ? options.isEngine(clean) : '';
  if (engine) return { id: 'local', label: machineName(), here: true, engine };
  return { id: clean, label: placeLabel(clean), here: false };
}

// The "on:" part of a team line value, split off so the rest reads exactly
// as it always did. Returns { rest, on } where on is the words after "on:"
// or '' when the line names no place.
function splitRunsOn(value) {
  const parts = String(value || '').split(',').map((part) => part.trim()).filter(Boolean);
  let on = '';
  const rest = [];
  for (const part of parts) {
    const match = /^on\s*:\s*(.*)$/i.exec(part);
    if (match && !on) on = match[1].trim() || 'local';
    else if (match) throw new Error('names two places; keep one on: part');
    else rest.push(part);
  }
  return { rest: rest.join(', '), on };
}

// The "runs on" text a table shows for one member.
function runsOnText(place, engineId) {
  if (!place || place.here) {
    const where = place && place.label ? place.label : machineName();
    return engineId ? `${engineId} on ${where}` : where;
  }
  return place.label;
}

module.exports = {
  ATRIS_COMPUTER,
  machineName,
  readRunsOn,
  splitRunsOn,
  runsOnText,
};
