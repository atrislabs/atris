// atris probe: chat-lane probe (TRR-22): one REAL /atris2/turn over the full
// tool relay, exactly as the surfaces run it. Port of terrace's
// atris/bin/relay-probe and atris/bin/calendar-probe, so keep the op tables in
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
// receipt line and exits 1. a FAIL naming the dead-end is the instrument
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
const path = require('path');
const { getApiBaseUrl } = require('../utils/api');
const { loadCredentials } = require('../utils/auth');
const { buildToolResultBody } = require('../lib/tool-result-encode');

// G2's honest blocked message (tool_policy_bench.MAX_TURNS_EXHAUSTED_MESSAGE)
// starts with this. an answer that is only this marker is a dead-end.
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

// Every file op the server's local_file_op offers: the enum of LOCAL_FILE_TOOL
// in the backend (backend/rl/tool_policy_bench.py). The backend test
// test_local_file_op_probe_lockstep.py pins that enum to this list, so the
// server cannot add an op without that test failing until this table and
// SERVER_FILE_OPS are updated together. test/probe-file-ops.test.js fails if
// any op listed here has no command below.
const SERVER_FILE_OPS = ['list', 'search', 'glob', 'inspect', 'read', 'write', 'append', 'edit', 'bash'];

// Directory names the server hides from glob unless include_generated is set
// (IGNORED_WORKSPACE_PARTS in the same backend file).
const IGNORED_PARTS = ['.git', '.next', '.pytest_cache', '.venv', '__pycache__', 'build', 'dist', 'node_modules', 'release', 'venv'];

// The `..` guard. It covers args.path and, for the ops that take more than one
// path, every `paths` entry and the glob pattern. The `bash` op still executes
// whatever command the model sends, verbatim, on the remote ai-computer, that
// is the production relay contract and the table must stay in lockstep with
// it, so this probe is NOT read-only.
function hasParentRef(value) {
  return String(value).split('/').includes('..');
}

function boundedInt(value, fallback, low, high) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, low), high);
}

function b64(value) {
  return Buffer.from(String(value), 'utf8').toString('base64');
}

// Same edit the server runs (_python_edit_command): replace the first match.
const PY_EDIT = 'import base64,pathlib,sys;'
  + 'p=pathlib.Path(sys.argv[1]);text=p.read_text(encoding=\'utf-8\');'
  + 'old=base64.b64decode(sys.argv[2]).decode(\'utf-8\');'
  + 'new=base64.b64decode(sys.argv[3]).decode(\'utf-8\');'
  + 'old in text or sys.exit(\'find text not found\');'
  + 'p.write_text(text.replace(old,new,1),encoding=\'utf-8\')';

// glob like the server's pathlib glob: `**` recurses, hidden files match,
// directories end in `/`, generated directories are hidden unless asked for.
const PY_GLOB = 'import glob,os,pathlib,sys\n'
  + 'pat,limit,gen,ign=sys.argv[1],int(sys.argv[2]),sys.argv[3]==\'1\',sys.argv[4].split(\',\')\n'
  + 'raw=map(str,pathlib.Path(\'.\').glob(pat)) if not os.path.isabs(pat) else glob.glob(pat,recursive=True)\n'
  + 'hits=sorted({h+(\'/\' if os.path.isdir(h) else \'\') for h in raw if gen or not any(x in ign for x in h.split(\'/\'))})\n'
  + 'print(\'\\n\'.join(hits[:limit]))\n'
  + 'len(hits)>limit and print(\'[%d more match(es) not shown]\'%(len(hits)-limit))';

function fileOpCommand(args, label) {
  const op = String(args.type || '').toLowerCase();
  const raw = normalizePath(String(args.path || '') || '.', label);
  if (hasParentRef(raw)) return null;
  const p = shq(raw);
  if (op === 'bash') return `( ${normalizeBash(String(args.command || '') || 'true', label)} )`;
  if (op === 'list') return `find ${p} -maxdepth 3 -not -path '*/node_modules/*' -not -path '*/.git/*' | head -200`;
  if (op === 'search') {
    const q = shq(String(args.query || args.pattern || ''));
    return `grep -rn -m 50 ${q} ${p} 2>/dev/null | head -50`;
  }
  // The server's read with a wildcard (*, ?, [) is a glob.
  if (op === 'read' && /[*?[]/.test(raw)) return fileOpCommand({ ...args, type: 'glob', pattern: raw }, label);
  if (op === 'read') return `{ [ -d ${p} ] && ls -p ${p} | head -200 || head -c 12000 ${p}; }`;
  if (op === 'glob') {
    const pattern = normalizePath(String(args.pattern || args.query || args.path || '').trim(), label);
    if (!pattern || hasParentRef(pattern)) return null;
    const limit = boundedInt(args.max_results, 200, 1, 1000);
    return `python3 -c ${shq(PY_GLOB)} ${shq(pattern)} ${limit} ${args.include_generated ? 1 : 0} ${shq(IGNORED_PARTS.join(','))}`;
  }
  if (op === 'inspect') {
    const depth = boundedInt(args.max_depth, 2, 1, 4);
    const limit = boundedInt(args.max_results, 80, 1, 300);
    const rawPaths = args.paths;
    const listed = Array.isArray(rawPaths)
      ? rawPaths.map((item) => String(item).trim()).filter(Boolean)
      : String(rawPaths || '').split(',').map((item) => item.trim()).filter(Boolean);
    const reads = listed.slice(0, 8).map((item) => normalizePath(item, label));
    if (reads.some(hasParentRef)) return null;
    const pieces = [`find ${p} -mindepth 1 -maxdepth ${depth} -print | head -${limit}`];
    for (const rel of reads) pieces.push(`printf '\\n== %s ==\\n' ${shq(rel)}; head -c 12000 ${shq(rel)}`);
    const verify = String(args.command || '').trim();
    if (verify) pieces.push(`( ${normalizeBash(verify, label)} )`);
    return pieces.join('; ');
  }
  if (op === 'write' || op === 'append') {
    // A write needs a real file path and its content. The server writes an
    // empty file when content is missing; a probe call like that is malformed.
    if (!String(args.path || '').trim() || raw === '.' || typeof args.content !== 'string') return null;
    const parent = shq(path.posix.dirname(raw));
    return `mkdir -p -- ${parent} && printf %s ${shq(b64(args.content))} | base64 -d ${op === 'append' ? '>>' : '>'} ${p}`;
  }
  if (op === 'edit') {
    const find = String(args.find || '');
    if (!String(args.path || '').trim() || raw === '.' || !find) return null;
    return `python3 -c ${shq(PY_EDIT)} ${p} ${b64(find)} ${b64(args.replace || '')}`;
  }
  return null;
}

// Port of Atris2ToolRelay.atrisCLICommand (GMModeAPI.swift): op → `atris …`.
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

// Things the server relays or offers that this harness does not run. A model
// that uses one gets an error back and the probe reports "probe limit", which
// says the harness could not vouch for that call, not that the product broke.
// Anything the server never offers (an invented op or tool) stays a failure.
const NOT_RUN_CLI_OPS = new Set([
  'apps_list', 'atris_search', 'imessage_doctor', 'imessage_latest',
  'task_create', 'task_update', 'skill_audit', 'codex_goal_status',
]);
const NOT_RUN_TOOLS = new Set(['dispatch_scout']);

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
  // not a success. never let it masquerade as ok with empty stdout
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

// CLI-231: local executor for atris2 mission ticks. Same result shape as the
// /ai-computer/terminal endpoint ({ stdout, stderr, exit_code }), but the
// command runs in the mission's OWN workspace directory instead of the hosted
// ai-computer. Without this, a mission tick in a local workspace read the
// remote computer's files and reported local members (e.g. maze) as missing.
function runLocalTerminal(command, cwd, environment = process.env, pathPrefix = '') {
  const { exec } = require('child_process');
  const { envWithNodeDir } = require('../lib/spawn-env');
  const baseEnv = envWithNodeDir(environment);
  const env = pathPrefix
    ? { ...baseEnv, PATH: `${pathPrefix}${path.delimiter}${baseEnv.PATH || ''}` }
    : baseEnv;
  return new Promise((resolve) => {
    exec(command, { cwd, env, timeout: 60000, maxBuffer: 4 * 1024 * 1024, shell: '/bin/bash' }, (error, stdout, stderr) => {
      resolve({
        stdout: String(stdout || ''),
        stderr: String(stderr || (error && error.message) || ''),
        exit_code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
      });
    });
  });
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
// (the worker). Transport-level outcome only. callers apply their own
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
    localCwd = null,
    localEnv = null,
    localPathPrefix = '',
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
  const limits = [];

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
                  out = { status: 'error', error: SERVER_FILE_OPS.includes(op) ? 'refused: unsafe path or missing argument' : 'unsupported op' };
                  unsupported.push(SERVER_FILE_OPS.includes(op) ? `file_op_refused:${op}` : `file_op:${op}`);
                } else {
                  const term = localCwd
                    ? await runLocalTerminal(cmd, localCwd, localEnv || process.env, localPathPrefix)
                    : await runTerminal(base, token, cmd, business);
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
                  (NOT_RUN_CLI_OPS.has(op) ? limits : unsupported).push(`cli_op:${op || '?'}`);
                } else {
                  const term = localCwd
                    ? await runLocalTerminal(cmd, localCwd, localEnv || process.env, localPathPrefix)
                    : await runTerminal(base, token, cmd, business);
                  out = atrisCliResult(cmd, term);
                  cliOps.push(op || '?');
                }
              } else {
                out = { status: 'error', error: `unsupported relayed tool: ${name || '?'}` };
                (NOT_RUN_TOOLS.has(name) ? limits : unsupported).push(`tool:${name || '?'}`);
              }
              await postJson(`${base}/atris2/turn/tool-result`, token,
                buildToolResultBody(ev.call_id || ev.id, out), 30000);
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
  // Only present when the harness skipped something, so the result keeps its old shape otherwise.
  if (limits.length) out.limits = limits;
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
  const limits = turn.limits || [];

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
  const limitNote = limits.length
    ? ` · probe limit (this harness did not run it, not a product failure): ${limits.slice(0, 3).join(',')}`
    : '';
  const detail = (ok
    ? `answer: ${resultText.slice(0, 80).replace(/\n/g, ' ')}`
    : `dead-end: ${deadEnd}`) + limitNote;
  const line = buildProbeLine({ stamp, where, model: a.model, member, engine, ok, secs, toolsRun, calendar: a.calendar, cliCalendarOps, detail });
  console.log(line);
  return ok ? 0 : 1;
}

function buildProbeLine({ stamp, where, model, member, engine, ok, secs, toolsRun, calendar, cliCalendarOps, detail }) {
  const line = `- **atris-probe** \`${stamp}\` - ${where} · ${model}`
    + (member ? ` · member=${member}` : '')
    + (engine ? ` · engine=${engine}` : '')
    + ` · ${ok ? 'pass' : 'fail'} · ${secs}s · tools=${toolsRun}`
    + (calendar ? ` cal_cli=${cliCalendarOps}` : '')
    + ` · ${detail}`;
  return line.replace(/\s*\u2014\s*/g, ', ');
}

module.exports = {
  probeCommand,
  buildProbeLine,
  runAtris2Turn,
  // exported for tests
  normalizePath,
  normalizeBash,
  fileOpCommand,
  SERVER_FILE_OPS,
  atrisCliCommand,
  atrisCliResult,
  runLocalTerminal,
};
