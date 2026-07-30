'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_WIDTH = 80;
const MIN_WIDTH = 20;
const MAX_WIDTH = 120;

function clean(value, fallback = '') {
  const text = String(value == null ? '' : value)
    .replace(/[—–]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return text || fallback;
}

function clip(value, width) {
  const chars = Array.from(clean(value));
  if (chars.length <= width) return chars.join('');
  if (width <= 3) return chars.slice(0, width).join('');
  return `${chars.slice(0, width - 3).join('').trimEnd()}...`;
}

function pad(value, width) {
  const text = clip(value, width);
  return `${text}${' '.repeat(Math.max(0, width - Array.from(text).length))}`;
}

function dashboardWidth(opts) {
  const requested = Number(opts && opts.width);
  if (!Number.isFinite(requested)) return DEFAULT_WIDTH;
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.trunc(requested)));
}

function styles(enabled) {
  const wrap = code => value => (
    enabled ? `\x1b[${code}m${value}\x1b[0m` : String(value)
  );
  return {
    bold: wrap('1'),
    dim: wrap('2'),
    green: wrap('32'),
    yellow: wrap('33'),
    cyan: wrap('36'),
  };
}

function chapterLine(chapter, width, style) {
  const state = clean(chapter && chapter.state, 'locked').toLowerCase();
  const current = state === 'current';
  const done = state === 'complete' || state === 'done';
  const marker = current ? '[NOW ]' : done ? '[DONE]' : '[LOCK]';
  const number = chapter && chapter.n != null ? `${chapter.n}.` : '';
  const location = current ? '  YOU ARE HERE' : '';
  const line = clip(`${marker} ${number} ${clean(chapter && chapter.title, 'Untitled chapter')}${location}`, width);
  if (current) return style.yellow(style.bold(line));
  if (done) return style.green(line);
  return style.dim(line);
}

function missionBox(mission, width, style) {
  const innerWidth = width - 2;
  const contentWidth = width - 4;
  const heading = ' CURRENT MISSION ';
  const top = heading.length <= innerWidth
    ? `╔${heading}${'═'.repeat(innerWidth - heading.length)}╗`
    : `╔${'═'.repeat(innerWidth)}╗`;
  const row = value => `║ ${pad(value, contentWidth)} ║`;
  const bottom = `╚${'═'.repeat(innerWidth)}╝`;
  const title = clean(mission && mission.title, 'No current mission');
  const status = clean(mission && mission.status, 'unavailable').toUpperCase();
  return [
    style.cyan(style.bold(top)),
    style.bold(row(title)),
    row(`STATUS: ${status}`),
    style.cyan(style.bold(bottom)),
  ];
}

/**
 * Render an atris.game_state.v1 payload without reading process or filesystem state.
 * Callers opt into ANSI with opts.color and provide their terminal width via opts.width.
 */
function renderGameDashboard(payload, opts = {}) {
  const state = payload && typeof payload === 'object' ? payload : {};
  const storyline = state.storyline && typeof state.storyline === 'object'
    ? state.storyline
    : null;
  const missions = state.missions && typeof state.missions === 'object'
    ? state.missions
    : {};
  const active = Array.isArray(missions.active) ? missions.active.slice(0, 3) : [];
  const recentComplete = Array.isArray(missions.recent_complete)
    ? missions.recent_complete.length
    : Number(missions.recent_complete) || 0;
  const width = dashboardWidth(opts);
  const style = styles(opts.color === true);
  const title = clean(storyline && storyline.name, 'No storyline loaded');
  const destination = clean(storyline && storyline.destination, 'No destination loaded');
  const chapters = Array.isArray(storyline && storyline.chapters)
    ? storyline.chapters.slice(0, 7)
    : [];
  const streak = storyline && storyline.streak && typeof storyline.streak === 'object'
    ? storyline.streak
    : {};
  const streakCurrent = Number.isFinite(Number(streak.current)) ? Number(streak.current) : 0;
  const streakTarget = Number.isFinite(Number(streak.target)) ? Number(streak.target) : 0;
  const streakLabel = clean(streak.label, 'mission streak');
  const lines = [];

  lines.push(style.cyan(style.bold(clip(title, width))));
  lines.push(style.dim(clip(`DESTINATION: ${destination}`, width)));
  lines.push('');
  lines.push(style.bold('CHAPTER RAIL'));
  if (chapters.length) {
    for (const chapter of chapters) lines.push(chapterLine(chapter, width, style));
  } else {
    lines.push(style.dim(clip('[LOCK] No chapters loaded', width)));
  }

  lines.push('');
  lines.push(...missionBox(storyline && storyline.mission, width, style));
  lines.push('');
  lines.push(style.yellow(style.bold(clip(`STREAK: ${streakCurrent} / ${streakTarget} | ${streakLabel}`, width))));
  lines.push('');
  lines.push(style.bold('LIVE MISSIONS'));
  if (active.length) {
    for (const mission of active) {
      const id = mission && mission.id != null ? `#${mission.id}` : '#?';
      lines.push(style.bold(clip(`${id} ${clean(mission && mission.title, 'Untitled mission')}`, width)));
      lines.push(style.dim(clip(`  owner: ${clean(mission && mission.owner, 'unassigned')}`, width)));
      lines.push(clip(`  next: ${clean(mission && mission.next, 'No next action recorded')}`, width));
    }
  } else {
    lines.push(style.dim(clip('No active missions.', width)));
  }
  lines.push(clip(`RECENT COMPLETES: ${recentComplete}`, width));
  lines.push('');
  lines.push(style.cyan(style.bold(clip(`NEXT MOVE: ${clean(active[0] && active[0].next, 'No active mission')}`, width))));

  return lines.join('\n');
}

function loadGameState(workspaceRoot = process.cwd()) {
  const script = path.join(workspaceRoot, 'scripts', 'game_state_sync.py');
  const python = path.join(workspaceRoot, 'venv', 'bin', 'python');
  if (!fs.existsSync(script) || !fs.existsSync(python)) return null;

  try {
    const stdout = execFileSync(python, [script, '--json'], {
      cwd: workspaceRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 4 * 1024 * 1024,
    });
    const payload = JSON.parse(stdout.trim());
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

async function gameCommand(args = [], opts = {}) {
  void args;
  const payload = loadGameState(process.cwd());
  if (!payload) {
    if (!opts.silentMissing) {
      console.log('no game state in this workspace (needs atris/storylines/)');
    }
    return false;
  }

  console.log(renderGameDashboard(payload, {
    color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
    width: process.stdout.columns || DEFAULT_WIDTH,
  }));
  return true;
}

module.exports = {
  renderGameDashboard,
  gameCommand,
};
