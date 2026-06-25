const fs = require('fs');
const os = require('os');
const path = require('path');

const SCHEMA = 'atris.chat_scan.v1';
const PROMPT_LINE = /^(?:max|pro|fast|code-fast)\s*›\s*(.+)$/i;
const ERROR_LINE = /\b(error|failed|failure|timeout|HTTP \d{3}|ECONNREFUSED|ENOTFOUND|aborted|blocked)\b/i;
const USER_BAIL = /\b(interrupted|Not completed yet|tool budget ended|max turns forcing final)\b/i;

function compact(text, max = 160) {
  const one = String(text || '').replace(/\s+/g, ' ').trim();
  if (!one) return '';
  return one.length <= max ? one : `${one.slice(0, max - 3)}...`;
}

function safeRead(filePath, maxBytes = 2_000_000) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function listRecentFiles(dir, { pattern, limit = 40, maxAgeMs = 14 * 86400000 } = {}) {
  if (!dir || !fs.existsSync(dir)) return [];
  const cutoff = Date.now() - maxAgeMs;
  const out = [];
  const walk = (current) => {
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (pattern && !pattern.test(entry.name)) continue;
      let mtime = 0;
      try {
        mtime = fs.statSync(full).mtimeMs;
      } catch {
        continue;
      }
      if (mtime < cutoff) continue;
      out.push({ path: full, mtimeMs: mtime });
    }
  };
  walk(dir);
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, limit);
}

function cursorTranscriptRoots(cwd = process.cwd()) {
  const base = path.join(os.homedir(), '.cursor', 'projects');
  if (!fs.existsSync(base)) return [];
  const slug = cwd.replace(/^\/+/, '').split(path.sep).join('-');
  const exact = path.join(base, slug, 'agent-transcripts');
  const roots = [];
  if (fs.existsSync(exact)) roots.push(exact);
  const extra = process.env.ATRIS_CHAT_SCAN_CURSOR_ROOT;
  if (extra && fs.existsSync(extra)) roots.push(extra);
  return roots;
}

function axLogDirs(cwd = process.cwd()) {
  const dirs = [];
  const local = path.join(cwd, 'atris', 'runs');
  const home = path.join(os.homedir(), '.atris', 'runs');
  if (fs.existsSync(local)) dirs.push(local);
  if (fs.existsSync(home) && home !== local) dirs.push(home);
  return dirs;
}

function parseWorkedDuration(label) {
  const text = String(label || '').trim().toLowerCase();
  if (!text) return 0;
  let seconds = 0;
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*(ms|m|s)\b/g)) {
    const value = Number(match[1]);
    if (!Number.isFinite(value)) continue;
    if (match[2] === 'ms') seconds += value / 1000;
    if (match[2] === 's') seconds += value;
    if (match[2] === 'm') seconds += value * 60;
  }
  return seconds;
}

function extractUserQuery(text) {
  const raw = String(text || '');
  const tagged = raw.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  if (tagged) return compact(tagged[1], 240);
  return compact(raw, 240);
}

function parseCursorTranscript(filePath, text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const userTurns = [];
  const assistantSummaries = [];
  let toolCalls = 0;
  let errors = 0;

  for (const line of lines) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const role = row.role;
    const parts = row.message?.content || [];
    if (role === 'user') {
      for (const part of parts) {
        if (part.type === 'text' && part.text) {
          const q = extractUserQuery(part.text);
          if (q) userTurns.push(q);
        }
      }
    }
    if (role === 'assistant') {
      let turnTools = 0;
      let turnText = '';
      for (const part of parts) {
        if (part.type === 'tool_use') turnTools += 1;
        if (part.type === 'text' && part.text && !part.text.includes('[REDACTED]')) {
          turnText += part.text;
        }
      }
      toolCalls += turnTools;
      if (turnText.trim()) assistantSummaries.push(compact(turnText, 280));
      if (ERROR_LINE.test(turnText) || USER_BAIL.test(turnText)) errors += 1;
    }
  }

  const lastUser = userTurns[userTurns.length - 1] || null;
  const lastAssistant = assistantSummaries[assistantSummaries.length - 1] || null;
  return {
    source: 'cursor',
    path: filePath,
    user_turns: userTurns.length,
    assistant_turns: assistantSummaries.length,
    tool_calls: toolCalls,
    last_user: lastUser,
    last_assistant: lastAssistant,
    sample_users: userTurns.slice(-3),
  };
}

function parseAxLog(filePath, text) {
  const lines = text.split(/\r?\n/);
  const userTurns = [];
  const findings = [];
  let mode = null;
  let cwd = null;
  let startedAt = null;
  let finishedAt = null;
  let exitCode = null;
  let lastWorkedSec = null;
  let toolCalls = 0;
  let interrupted = false;

  for (const line of lines) {
    if (line.startsWith('mode: ')) mode = line.slice(6).trim();
    if (line.startsWith('cwd: ')) cwd = line.slice(5).trim();
    if (line.startsWith('started_at: ')) startedAt = line.slice(12).trim();
    if (line.startsWith('finished_at: ')) finishedAt = line.slice(13).trim();
    if (line.startsWith('exit_code: ')) exitCode = Number(line.slice(11).trim());
    const prompt = line.match(PROMPT_LINE);
    if (prompt) userTurns.push(compact(prompt[1], 240));
    if (/^●\s/.test(line)) toolCalls += 1;
    if (/·\s*Interrupted/i.test(line)) interrupted = true;
    const worked = line.match(/^— Worked for ([^-]+?) —/);
    if (worked) lastWorkedSec = worked[1];
    if (ERROR_LINE.test(line) || /^x\s/.test(line.trim())) {
      findings.push(compact(line, 180));
    }
    if (USER_BAIL.test(line)) findings.push(compact(line, 180));
  }

  return {
    source: 'ax',
    path: filePath,
    mode,
    cwd,
    started_at: startedAt,
    finished_at: finishedAt,
    exit_code: Number.isFinite(exitCode) ? exitCode : null,
    user_turns: userTurns.length,
    tool_calls: toolCalls,
    interrupted,
    last_worked: lastWorkedSec,
    last_user: userTurns[userTurns.length - 1] || null,
    sample_users: userTurns.slice(-3),
    log_findings: [...new Set(findings)].slice(0, 8),
  };
}

function buildFindings(sessions) {
  const findings = [];
  for (const session of sessions) {
    if (session.interrupted) {
      findings.push({
        severity: 'medium',
        code: 'interrupted_turn',
        title: 'User interrupted an in-flight turn',
        source: session.source,
        path: session.path,
        evidence: session.last_user || session.last_assistant || '',
      });
    }
    if (session.exit_code && session.exit_code !== 0) {
      findings.push({
        severity: 'high',
        code: 'nonzero_exit',
        title: `Chat session exited with code ${session.exit_code}`,
        source: session.source,
        path: session.path,
        evidence: session.last_user || '',
      });
    }
    for (const line of session.log_findings || []) {
      findings.push({
        severity: 'medium',
        code: 'log_error_pattern',
        title: 'Error-like line in chat log',
        source: session.source,
        path: session.path,
        evidence: line,
      });
    }
    if (session.source === 'ax' && session.last_worked) {
      const seconds = parseWorkedDuration(session.last_worked);
      const incomplete = (session.log_findings || []).some((l) => /Not completed yet|tool budget|Blocked:|max turns forcing/i.test(l));
      if (seconds >= 45 && incomplete) {
        findings.push({
          severity: 'high',
          code: 'slow_incomplete_turn',
          title: `Long turn (${session.last_worked}) ended incomplete`,
          source: session.source,
          path: session.path,
          evidence: session.last_user || '',
        });
      }
    }
    if (session.user_turns >= 2 && session.sample_users?.length >= 2) {
      const a = session.sample_users[session.sample_users.length - 2].toLowerCase();
      const b = session.sample_users[session.sample_users.length - 1].toLowerCase();
      if (a && b && (a.includes(b.slice(0, 24)) || b.includes(a.slice(0, 24)))) {
        findings.push({
          severity: 'low',
          code: 'repeat_user_ask',
          title: 'User may have repeated a similar ask',
          source: session.source,
          path: session.path,
          evidence: `${a} -> ${b}`,
        });
      }
    }
  }
  findings.sort((x, y) => {
    const rank = { high: 3, medium: 2, low: 1 };
    return (rank[y.severity] || 0) - (rank[x.severity] || 0);
  });
  return findings.slice(0, 20);
}

function scanChatLogs(options = {}) {
  const cwd = options.cwd || process.cwd();
  const limit = Number(options.limit) || 12;
  const maxAgeHours = Number(options.hours) || 720;
  const maxAgeMs = maxAgeHours * 3600000;
  const sessions = [];

  for (const dir of axLogDirs(cwd)) {
    for (const file of listRecentFiles(dir, { pattern: /^ax-.*\.log$/, limit, maxAgeMs })) {
      const text = safeRead(file.path);
      if (!text) continue;
      sessions.push(parseAxLog(file.path, text));
    }
  }

  for (const root of cursorTranscriptRoots(cwd)) {
    for (const file of listRecentFiles(root, { pattern: /\.jsonl$/, limit, maxAgeMs })) {
      const text = safeRead(file.path);
      if (!text) continue;
      const parsed = parseCursorTranscript(file.path, text);
      if (parsed.user_turns > 0 || parsed.assistant_turns > 0) sessions.push(parsed);
    }
  }

  sessions.sort((a, b) => {
    const ta = fs.statSync(a.path).mtimeMs;
    const tb = fs.statSync(b.path).mtimeMs;
    return tb - ta;
  });

  const findings = buildFindings(sessions);
  const report = {
    schema: SCHEMA,
    scanned_at: new Date().toISOString(),
    cwd,
    window_hours: maxAgeHours,
    sources: {
      ax_dirs: axLogDirs(cwd),
      cursor_roots: cursorTranscriptRoots(cwd),
    },
    summary: {
      sessions: sessions.length,
      ax_sessions: sessions.filter((s) => s.source === 'ax').length,
      cursor_sessions: sessions.filter((s) => s.source === 'cursor').length,
      findings: findings.length,
      high_findings: findings.filter((f) => f.severity === 'high').length,
    },
    sessions: sessions.slice(0, limit).map((s) => ({
      ...s,
      path: s.path,
      rel_path: s.path.startsWith(cwd) ? path.relative(cwd, s.path) : s.path,
    })),
    findings,
    next_command: findings.length
      ? 'atris member wake auto-improver --execute --confirm-autonomy-policy'
      : 'atris chat scan --hours 168',
  };
  return report;
}

function writeLatestScan(root, report) {
  const stateDir = path.join(root, '.atris', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const latestPath = path.join(stateDir, 'chat_scan.latest.json');
  fs.writeFileSync(latestPath, `${JSON.stringify(report, null, 2)}\n`);
  return latestPath;
}

function readLatestScan(root) {
  const latestPath = path.join(root, '.atris', 'state', 'chat_scan.latest.json');
  try {
    if (!fs.existsSync(latestPath)) return null;
    return JSON.parse(fs.readFileSync(latestPath, 'utf8'));
  } catch {
    return null;
  }
}

function ensureChatScan(root, options = {}) {
  const maxAgeMs = Number(options.maxAgeMs ?? 3600000);
  const existing = readLatestScan(root);
  if (existing && existing.scanned_at && !options.force) {
    const age = Date.now() - new Date(existing.scanned_at).getTime();
    if (Number.isFinite(age) && age >= 0 && age <= maxAgeMs) {
      return existing;
    }
  }
  const report = scanChatLogs({ cwd: root, hours: options.hours, limit: options.limit });
  if (options.write !== false) writeLatestScan(root, report);
  return report;
}

function topChatFindings(report, limit = 3) {
  return (report && Array.isArray(report.findings) ? report.findings : []).slice(0, limit);
}

module.exports = {
  SCHEMA,
  scanChatLogs,
  writeLatestScan,
  readLatestScan,
  ensureChatScan,
  topChatFindings,
  cursorTranscriptRoots,
  axLogDirs,
};
