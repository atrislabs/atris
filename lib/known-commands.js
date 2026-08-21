'use strict';

const knownCommands = ['init', 'install', 'workspace', 'log', 'logs', 'wish', 'ask', 'approve', 'stop', 'ready', 'check', 'drill', 'dream', 'now', 'goal', 'wtf', 'founder', 'orb', 'radar', 'who', 'stream', 'ctop', 'launchpad', 'status', 'analytics', 'visualize', 'brain', 'brainstorm', 'autopilot', 'run', '_start', 'plan', 'do', 'review', 'release',
                       'activate', '_activate', 'agent', 'team', 'chat', 'fast', 'ax', 'console', 'serve', 'login', 'logout', 'whoami', 'switch', 'use', 'accounts', '_resolve', '_profile-email', '_switch-session', 'shell-init', 'update', 'upgrade', 'version', 'help', 'next', 'atris',
                       'clean', 'close', 'harvest', 'verify', 'recover', 'search', 'scout', 'skill', 'member', 'codex-goal', 'app', 'apps', 'learn', 'lesson', 'taste', 'teach', 'plugin', 'experiments', 'bench', 'router', 'receipt', 'proof', 'openclaw', 'pull', 'push', 'watch', 'cloud', 'live', 'align', 'terminal', 'computer', 'diff', 'business', 'sync', 'youtube',
                       'ingest', 'query', 'lint', 'loop', 'pulse', 'task', 'mission', 'decide', 'agents', 'probe', 'worktree', 'land', 'caretaker', 'autoland', 'drive', 'aeo', 'slop', 'voice', 'strings', 'write', 'security-review', 'secure', 'deck', 'site', 'theme', 'card', 'reel', 'improve', 'study', 'rainmaker', 'xp', 'play', 'gm', 'game', 'x', 'recap', 'report', 'signup', 'clarity', 'interview', 'meet', 'moves', 'unknowns', 'avail', 'sync-checkout',
                       'ci', 'github', 'vercel', 'supabase', 'linear', 'stripe', 'gmail', 'calendar', 'twitter', 'slack', 'imessage', 'integrations', 'setup', 'clean-workspace', 'cw',
                       'fork', 'browse', 'publish', 'pack', 'sleep', 'wake', 'feedback', 'errors', 'wiki', 'code-review', 'cr', 'soul', 'fleet', 'fleet-report', 'loops', 'self-improve', 'compile', 'spaceship', 'truth', 'sign', 'engine', 'engines', 'feed', 'brief', 'social', 'people', 'follow', 'unfollow', 'friends', 'msg', 'inbox', 'invite', 'join'];

// Damerau-Levenshtein edit distance between two short strings. Counts an
// adjacent transposition (e.g. "taks" -> "task") as a single edit, since
// transpositions are the most common command typo.
function editDistance(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  // Full matrix so we can look back two rows for the transposition case.
  const d = [];
  for (let i = 0; i <= m; i++) d.push([i, ...new Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[m][n];
}

// Given a mistyped command, return the closest known command if it's a near
// miss (small edit distance or clear prefix), else null. Helps a new person who
// typos `atris taks` get pointed at `task` instead of a confusing fallthrough.
function suggestCommand(input, commands = knownCommands) {
  if (!input || typeof input !== 'string') return null;
  const word = input.toLowerCase().trim();
  if (!word) return null;
  // Ignore internal/private commands (leading underscore) as suggestions.
  const candidates = commands.filter((c) => !c.startsWith('_'));
  let best = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    const d = editDistance(word, c);
    // Threshold scales gently with length: allow 1 edit for short words, 2 for longer.
    const maxEdits = word.length <= 4 ? 1 : 2;
    if (d <= maxEdits && d < bestScore) {
      best = c;
      bestScore = d;
    }
  }
  return best;
}

module.exports = { knownCommands, suggestCommand, editDistance };
