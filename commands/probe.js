// atris probe — chat-lane probe (TRR-22): one REAL /atris2/turn over the full
// tool relay, exactly as the surfaces run it. Port of terrace's
// atris/bin/relay-probe and atris/bin/calendar-probe — keep the op tables in
// lockstep across iOS (votd/GMModeAPI.swift Atris2ToolRelay), web
// (atrisos-web orbToolRelay.ts), Obelisk (atris2LocalFileOp.cjs), and the
// terrace probes.
//
// Contract: the turn body sends `local_executor: true` plus a `workspace_path`
// LABEL (/workspace/personal or /workspace/business-{id}). The backend relays
// `local_file_op` / `local_atris_cli_op` calls down the SSE stream; we execute
// each against the computer via POST /ai-computer/terminal and POST the result
// to /atris2/turn/tool-result. Label-absolute paths are rewritten
// root-relative (the runner's /bash cwd is the workspace ROOT).
//
// PASS = >=1 relayed op (with --calendar: >=1 calendar cli op) AND a non-empty
// final answer with no dead-end marker; otherwise prints the marker in the
// receipt line and exits 1 — a FAIL naming the dead-end is the instrument
// working. The receipt line is journal-ready.
//
// Usage:
//   atris probe                                # personal lane, file question
//   atris probe --calendar                     # calendar question (cli-op lane)
//   atris probe --business <id> [--model atris:pro]
//   atris probe --member-slug relay            # turn runs AS the member
//   atris probe --message "..."                # custom question

const https = require('https');
const http = require('http');
const { getApiBaseUrl } = require('../utils/api');
const { loadCredentials } = require('../utils/auth');

// G2's honest blocked message (tool_policy_bench.MAX_TURNS_EXHAUSTED_MESSAGE)
// starts with this — an answer that is only this marker is a dead-end.
const MAX_TURNS_MARKER = 'i ran out of tool budget for this turn';

function workspaceLabel(businessId) {
  return businessId ? `/workspace/business-${businessId}` : '/workspace/personal';
}

function shq(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

// --- Port of Atris2ToolRelay path normalization (lockstep) ---

function normalizePath(raw, label) {
  const l = label.replace(/\/$/, '');
  if (!l) return raw;
  if (raw === l || raw === l + '/') return '.';
  if (raw.startsWith(l + '/')) return raw.slice(l.length + 1) || '.';
  return raw;
}

function normalizeBash(cmd, label) {
  const l = label.replace(/\/$/, '');
  if (!l) return cmd;
  return cmd.split(l + '/').join('').split(l).join('.');
}

// No write/edit file ops, and the `..` guard only covers args.path. The
// `bash` op still executes whatever command the model sends, verbatim, on
// the remote ai-computer — that is the production relay contract and the
// table must stay in lockstep with it, so this probe is NOT read-only.
function fileOpCommand(args, label) {
  const op = String(args.type || '').toLowerCase();
  const raw = normalizePath(String(args.path || '') || '.', label);
  if (raw.split('/').includes('..')) return null;
  const p = shq(raw);
  if (op === 'bash') return `( ${normalizeBash(String(args.command || '') || 'true', label)} )`;
  if (op === 'list') return `find ${p} -maxdepth 3 -not -path '*/node_modules/*' -not -path '*/.git/*' | head -200`;
  if (op === 'search') {
    const q = shq(String(args.query || args.pattern || ''));
    return `grep -rn -m 50 ${q} ${p} 2>/dev/null | head -50`;
  }
  if (op === 'read') return `{ [ -d ${p} ] && ls -p ${p} | head -200 || head -c 12000 ${p}; }`;
  return null;
}

// Port of Atris2ToolRelay.atrisCLICommand (GMModeAPI.swift) — op → `atris …`.
const SIMPLE_CLI_OPS = {
  status: ['atris.md'],
  integrations_status: ['integrations'],
  calendar_today: ['calendar', 'today'],
  calendar_yesterday: ['calendar', 'yesterday'],
  calendar_week: ['calendar', 'week'],
  gmail_inbox: ['gmail', 'inbox'],
  slack_channels: ['slack', 'channels'],
  slack_dms: ['slack', 'dms'],
  task_status: ['task', 'status', '--json'],
  task_list: ['task', 'list', '--json'],
  skill_list: ['skill', 'list'],
  member_list: ['member', 'list'],
  mission_status: ['mission', 'status', '--json'],
};

function atrisCliCommand(args) {
  const op = String(args.type || '').toLowerCase();
  let argv = SIMPLE_CLI_OPS[op] || null;
  if (!argv) {
    if (op === 'task_show') {
      const taskId = String(args.task_id || '');
      if (taskId) argv = ['task', 'show', taskId, '--json'];
    } else if (op === 'member_status') {
      const member = String(args.member || '');
      if (member) argv = ['member', 'status', member, '--json'];
    } else if (op === 'calendar_date') {
      const date = String(args.date || '');
      if (/^\d{4}-\d{2}-\d{2}$/.test(date)) argv = ['calendar', 'date', date];
    } else if (op === 'slack_messages') {
      const channel = String(args.channel || '');
      if (channel) argv = ['slack', 'messages', channel, '--limit', '20'];
    } else if (op === 'slack_search') {
      const query = String(args.query || '');
      if (query) argv = ['slack', 'search', query, '--limit', '20'];
    }
  }
  if (!argv) return null;
  return 'atris ' + argv.map(shq).join(' ');
}

function atrisCliResult(command, term) {
  // a terminal response without a numeric exit_code is a broken endpoint,
  // not a success — never let it masquerade as ok with empty stdout
  const code = typeof term.exit_code === 'number' ? term.exit_code : -1;
  const out = {
    schema: 'atris.local_cli_result.v1',
    status: code === 0 ? 'ok' : 'error',
    command,
    stdout: String(term.stdout || '').slice(0, 12000),
    exit_code: code,
  };
  if (code !== 0) {
    out.error = typeof term.exit_code === 'number'
      ? String(term.stderr || term.stdout || 'command failed').slice(0, 2000)
      : 'terminal endpoint returned no exit_code';
  }
  return out;
}

// --- HTTP helpers (Bearer auth against the prod API, like the terrace probes) ---

function postJson(urlString, token, payload, timeoutMs) {
  const url = new URL(urlString);
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = transport.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Authorization: `Bearer ${token}`,
      },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          return;
        }
        if (!data) { resolve({}); return; }
        try { resolve(JSON.parse(data)); } catch (e) {
          reject(new Error(`invalid JSON from ${url.pathname}: ${data.slice(0, 120)}`));
        }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('request timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function runTerminal(base, token, command, businessId) {
  const body = { command, timeout: 60 };
  if (businessId) body.business_id = businessId;
  return postJson(`${base}/ai-computer/terminal`, token, body, 80000);
}

function parseArgs(argv) {
  const a = { business: null, model: 'atris:fast', memberId: null, memberSlug: null, calendar: false, message: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--business') a.business = argv[++i] || null;
    else if (flag === '--model') a.model = argv[++i] || a.model;
    else if (flag === '--member-id') a.memberId = argv[++i] || null;
    else if (flag === '--member-slug') a.memberSlug = argv[++i] || null;
    else if (flag === '--calendar') a.calendar = true;
    else if (flag === '--message') a.message = argv[++i] || null;
    else if (flag === '--help' || flag === '-h') {
      console.log('Usage: atris probe [--calendar] [--business <id>] [--model atris:fast] [--member-slug <slug>] [--member-id <id>] [--message "..."]');
      process.exit(0);
    }
  }
  return a;
}

// Core /atris2/turn client: one streamed turn over the full local tool relay.
// Shared by `atris probe` (the instrument) and `atris mission run --runner atris2`
// (the worker). Transport-level outcome only — callers apply their own
// pass/fail policy on top of the returned fields.
async function runAtris2Turn(opts = {}) {
  const {
    prompt,
    model = 'atris:fast',
    business = null,
    memberId = null,
    memberSlug = null,
    maxTurns = 8,
    idleMs = 180000,
    connectTimeoutMs = 60000,
    signal = null,
  } = opts;
  const t0 = Date.now();
  const out = { ok: false, text: '', engine: null, tools_run: 0, cli_ops: [], unsupported: [], error: null, duration_ms: 0 };
  const creds = loadCredentials();
  if (!creds || !creds.token) {
    out.error = 'not-logged-in';
    out.duration_ms = Date.now() - t0;
    return out;
  }
  const token = creds.token;
  const base = getApiBaseUrl();
  const label = workspaceLabel(business);

  const body = {
    message: prompt, model, max_turns: maxTurns,
    verify_command: 'true', local_executor: true, workspace_path: label,
  };
  if (memberId) body.member_id = memberId;
  if (memberSlug) body.member_slug = memberSlug;

  let toolsRun = 0;
  let resultText = '';
  let err = null;
  let engine = null;
  const cliOps = [];
  const unsupported = [];

  try {
    await new Promise((resolve, reject) => {
      const url = new URL(`${base}/atris2/turn`);
      const transport = url.protocol === 'https:' ? https : http;
      const postData = JSON.stringify(body);
      const req = transport.request({
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          Accept: 'text/event-stream',
          Authorization: `Bearer ${token}`,
        },
        // connect/first-byte guard; cleared once headers arrive so the
        // idle timer below is the only judge of a flowing stream
        timeout: connectTimeoutMs,
      }, (res) => {
        req.setTimeout(0);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          let data = '';
          res.on('data', (c) => data += c);
          res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`)));
          return;
        }
        let buffer = '';
        let idleTimer = null;
        const resetIdle = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => { req.destroy(); reject(new Error(`stream stalled: no events for ${idleMs / 1000}s`)); }, idleMs);
        };
        resetIdle();

        // Relayed tool calls run sequentially: the backend awaits each result
        // before continuing the loop, so a promise chain preserves order.
        let toolChain = Promise.resolve();

        const handleEvent = (ev) => {
          if (!ev || typeof ev !== 'object') return;
          const et = ev.type;
          if (et === 'system_init') {
            engine = String(ev.model || '') || null;
          } else if (et === 'tool_call_request') {
            const name = String(ev.name || '');
            const args = ev.args || ev.arguments || {};
            const op = String(args.type || '').toLowerCase();
            toolsRun += 1;
            toolChain = toolChain.then(async () => {
              let out;
              if (name === 'local_file_op') {
                const cmd = fileOpCommand(args, label);
                if (cmd === null) {
                  out = { status: 'error', error: 'unsupported op or unsafe path' };
                  unsupported.push(`file_op:${op}`);
                } else {
                  const term = await runTerminal(base, token, cmd, business);
                  const ok = term.exit_code === 0;
                  out = ok
                    ? { status: 'ok', stdout: String(term.stdout || '').slice(0, 12000) }
                    : {
                        status: 'error',
                        error: typeof term.exit_code === 'number'
                          ? String(term.stderr || 'command failed').slice(0, 2000)
                          : 'terminal endpoint returned no exit_code',
                      };
                }
              } else if (name === 'local_atris_cli_op') {
                const cmd = atrisCliCommand(args);
                if (cmd === null) {
                  out = { status: 'error', error: `unsupported atris cli op: ${op || '?'}` };
                  unsupported.push(`cli_op:${op || '?'}`);
                } else {
                  const term = await runTerminal(base, token, cmd, business);
                  out = atrisCliResult(cmd, term);
                  cliOps.push(op || '?');
                }
              } else {
                out = { status: 'error', error: `unsupported relayed tool: ${name || '?'}` };
                unsupported.push(`tool:${name || '?'}`);
              }
              await postJson(`${base}/atris2/turn/tool-result`, token,
                { call_id: ev.call_id || ev.id, result: out }, 30000);
              resetIdle();
            }).catch((e) => reject(e));
          } else if (et === 'result') {
            resultText = String(ev.result || '');
          } else if (et === 'error') {
            err = String(ev.error || 'turn error');
          }
        };

        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          resetIdle();
          buffer += chunk;
          let nl;
          while ((nl = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, nl).replace(/\r$/, '');
            buffer = buffer.slice(nl + 1);
            if (!line.startsWith('data: ')) continue;
            try { handleEvent(JSON.parse(line.slice(6))); } catch (e) { /* malformed frame */ }
          }
        });
        res.on('end', () => {
          toolChain.then(() => { if (idleTimer) clearTimeout(idleTimer); resolve(); });
        });
        res.on('error', (e) => { if (idleTimer) clearTimeout(idleTimer); reject(e); });
      });
      req.on('timeout', () => { req.destroy(new Error(`no response headers within ${Math.round(connectTimeoutMs / 1000)}s`)); });
      req.on('error', reject);
      if (signal) signal.addEventListener('abort', () => { req.destroy(new Error('aborted')); }, { once: true });
      req.write(postData);
      req.end();
    });
  } catch (e) {
    if (!err) err = `${e.name || 'Error'}: ${e.message || e}`;
  }

  out.text = resultText;
  out.engine = engine;
  out.tools_run = toolsRun;
  out.cli_ops = cliOps;
  out.unsupported = unsupported;
  out.error = err;
  out.ok = err === null;
  out.duration_ms = Date.now() - t0;
  return out;
}

async function probeCommand(argv) {
  const a = parseArgs(argv || []);
  const creds = loadCredentials();
  if (!creds || !creds.token) {
    console.error('✗ Not logged in. Run: atris login');
    return 1;
  }
  const where = a.business ? `business ${String(a.business).slice(0, 8)}` : 'personal';
  const member = a.memberSlug || a.memberId;
  const prompt = a.message || (a.calendar
    ? "What's on my calendar today? Use your tools."
    : 'Read the first 5 lines of any markdown file in this workspace and quote one real line from it. Use your file tools.');

  const t0 = Date.now();
  const turn = await runAtris2Turn({
    prompt, model: a.model, business: a.business,
    memberId: a.memberId, memberSlug: a.memberSlug, maxTurns: 8,
  });
  const toolsRun = turn.tools_run;
  const cliCalendarOps = turn.cli_ops.filter((op) => String(op).startsWith('calendar')).length;
  const resultText = turn.text;
  const err = turn.error;
  const engine = turn.engine;
  const unsupported = turn.unsupported;

  // Name the dead-end (first match wins); null = converged.
  let deadEnd = null;
  if (err) {
    deadEnd = `error: ${String(err).slice(0, 120)}`;
  } else if (a.calendar && cliCalendarOps === 0) {
    deadEnd = 'no local_atris_cli_op calendar op relayed'
      + (unsupported.length ? ` (unsupported: ${unsupported.slice(0, 3).join(',')})` : '')
      + (toolsRun ? ` (tools=${toolsRun})` : ' (zero tool calls)');
  } else if (!a.calendar && toolsRun === 0) {
    deadEnd = 'zero relayed tool calls';
  } else if (unsupported.length) {
    deadEnd = `unsupported relayed call(s): ${unsupported.slice(0, 3).join(',')}`;
  } else if (resultText.trim().length <= 20) {
    deadEnd = 'empty/short final answer';
  } else if (resultText.toLowerCase().includes(MAX_TURNS_MARKER)) {
    deadEnd = 'max turns exhausted (honest G2 blocked message)';
  }

  const secs = Math.round((Date.now() - t0) / 100) / 10;
  const ok = deadEnd === null;
  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const detail = ok
    ? `answer: ${resultText.slice(0, 80).replace(/\n/g, ' ')}`
    : `dead-end: ${deadEnd}`;
  const line = `- **atris-probe** \`${stamp}\` — ${where} · ${a.model}`
    + (member ? ` · member=${member}` : '')
    + (engine ? ` · engine=${engine}` : '')
    + ` · ${ok ? 'PASS' : 'FAIL'} · ${secs}s · tools=${toolsRun}`
    + (a.calendar ? ` cal_cli=${cliCalendarOps}` : '')
    + ` · ${detail}`;
  console.log(line);
  return ok ? 0 : 1;
}

module.exports = {
  probeCommand,
  runAtris2Turn,
  // exported for tests
  normalizePath,
  normalizeBash,
  fileOpCommand,
  atrisCliCommand,
  atrisCliResult,
};
