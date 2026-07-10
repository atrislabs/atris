'use strict';

const fs = require('fs');
const path = require('path');
const { apiRequestJson } = require('../utils/api');
const { loadCredentials } = require('../utils/auth');

const VALID_CLOUD_LANES = new Set(['fast', 'pro', 'max']);
const TERMINAL_CLOUD_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DEFAULT_MAX_WATCH_MS = 30 * 60 * 1_000;

class CloudMissionError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'CloudMissionError';
    this.exitCode = exitCode;
  }
}

function valueFlag(args, name) {
  const prefix = `${name}=`;
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i]);
    if (arg.startsWith(prefix)) return { present: true, value: arg.slice(prefix.length), index: i };
    if (arg === name) {
      const next = args[i + 1];
      return {
        present: true,
        value: next && !String(next).startsWith('--') ? String(next) : '',
        index: i,
      };
    }
  }
  return { present: false, value: '', index: -1 };
}

function parseCloudRunArgs(args) {
  const laneFlag = valueFlag(args, '--lane');
  const agentFlag = valueFlag(args, '--agent');
  if (laneFlag.present && !laneFlag.value) {
    throw new CloudMissionError('--lane requires one of: fast, pro, max', 2);
  }
  if (agentFlag.present && !agentFlag.value) {
    throw new CloudMissionError('--agent requires an agent id', 2);
  }
  const lane = laneFlag.value || 'fast';
  if (!VALID_CLOUD_LANES.has(lane)) {
    throw new CloudMissionError(`invalid --lane "${lane}". expected fast, pro, or max`, 2);
  }

  const textParts = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i]);
    if (arg === '--cloud' || arg === '--json') continue;
    if (arg === '--lane') {
      i += 1;
      continue;
    }
    if (arg.startsWith('--lane=')) continue;
    if (arg === '--agent') {
      i += 1;
      continue;
    }
    if (arg.startsWith('--agent=')) continue;
    if (arg.startsWith('--')) {
      throw new CloudMissionError(`unsupported cloud mission flag: ${arg}`, 2);
    }
    textParts.push(arg);
  }
  const text = textParts.join(' ').trim();
  if (!text) {
    throw new CloudMissionError('usage: atris mission run "<intent>" --cloud [--lane fast|pro|max]', 2);
  }
  const parsed = { text, lane, asJson: args.includes('--json') };
  if (agentFlag.present) parsed.agentId = agentFlag.value;
  return parsed;
}

function parseCloudStatusArgs(args) {
  const cloudFlag = valueFlag(args, '--cloud');
  if (!cloudFlag.present || !cloudFlag.value) {
    throw new CloudMissionError('usage: atris mission status --cloud <task_id> [--watch]', 2);
  }
  return {
    taskId: cloudFlag.value,
    watch: args.includes('--watch'),
    asJson: args.includes('--json'),
  };
}

function credentialsToken(load = loadCredentials) {
  const credentials = load();
  const token = credentials && String(credentials.token || '').trim();
  if (!token) throw new CloudMissionError('not logged in. run: atris login', 1);
  return token;
}

function requestError(result) {
  const status = result && result.status ? ` (${result.status})` : '';
  const backendDetail = result && result.data && result.data.detail;
  const errorDetail = result && (result.error || backendDetail);
  const detail = errorDetail ? `: ${errorDetail}` : '';
  const hint = /business/i.test(String(backendDetail || errorDetail || ''))
    ? '\ntry: --agent <id of a business-attached agent>'
    : '';
  return new CloudMissionError(`cloud mission request failed${status}${detail}${hint}`, 1);
}

async function enqueueCloudMission({ text, lane = 'fast', agentId }, deps = {}) {
  if (!VALID_CLOUD_LANES.has(lane)) {
    throw new CloudMissionError(`invalid --lane "${lane}". expected fast, pro, or max`, 2);
  }
  const token = credentialsToken(deps.loadCredentials || loadCredentials);
  const request = deps.apiRequestJson || apiRequestJson;
  const body = { text, lane };
  if (agentId) body.agent_id = agentId;
  const response = await request('/atris2/missions', {
    method: 'POST',
    token,
    body,
  });
  if (!response || !response.ok) throw requestError(response);
  if (!response.data || !response.data.task_id) {
    throw new CloudMissionError('cloud mission response did not include task_id', 1);
  }
  return response.data;
}

async function fetchCloudMissionStatus(taskId, deps = {}) {
  const token = credentialsToken(deps.loadCredentials || loadCredentials);
  const request = deps.apiRequestJson || apiRequestJson;
  const response = await request(`/atris2/missions/${encodeURIComponent(taskId)}`, {
    method: 'GET',
    token,
  });
  if (!response || !response.ok) throw requestError(response);
  if (!response.data || !response.data.task_id || !response.data.status) {
    throw new CloudMissionError('cloud mission response did not include task_id and status', 1);
  }
  return response.data;
}

function appendCloudMissionReceipt(root, receipt) {
  const stateDir = path.join(root, '.atris', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, 'missions.jsonl');
  fs.appendFileSync(file, `${JSON.stringify(receipt)}\n`, 'utf8');
  return file;
}

function cloudMissionSummary(mission) {
  if (mission && mission.result && typeof mission.result === 'object' && mission.result.summary) {
    return String(mission.result.summary);
  }
  if (mission && typeof mission.result === 'string' && mission.result.trim()) return mission.result.trim();
  if (mission && mission.summary) return String(mission.summary);
  return 'not available yet';
}

function cloudStatusLines(mission) {
  return [
    `cloud mission: ${mission.task_id}`,
    `  status: ${mission.status}`,
    `  lane: ${mission.lane || 'unknown'}`,
    `  summary: ${cloudMissionSummary(mission)}`,
  ];
}

function printCloudStatus(mission, asJson, log) {
  if (asJson) {
    log(JSON.stringify(mission, null, 2));
    return;
  }
  for (const line of cloudStatusLines(mission)) log(line);
}

async function runCloudMissionCommand(args, options = {}) {
  const log = options.log || console.log;
  const error = options.error || console.error;
  try {
    const parsed = parseCloudRunArgs(args);
    const mission = await enqueueCloudMission(parsed, options);
    const receipt = {
      cloud: true,
      task_id: mission.task_id,
      lane: mission.lane || parsed.lane,
      text: parsed.text,
    };
    appendCloudMissionReceipt(options.root || process.cwd(), receipt);
    if (parsed.asJson) {
      log(JSON.stringify({ ok: true, action: 'cloud_mission_enqueued', mission, receipt }, null, 2));
    } else {
      log(`cloud mission queued: ${mission.task_id}`);
      log(`lane: ${receipt.lane}`);
      log(`next: atris mission status --cloud ${mission.task_id}`);
    }
    return { exitCode: 0, mission, receipt };
  } catch (caught) {
    error(caught.message || String(caught));
    return { exitCode: caught.exitCode || 1, error: caught };
  }
}

async function statusCloudMissionCommand(args, options = {}) {
  const log = options.log || console.log;
  const error = options.error || console.error;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now || Date.now;
  const pollIntervalMs = options.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS;
  const maxWatchMs = options.maxWatchMs || DEFAULT_MAX_WATCH_MS;
  try {
    const parsed = parseCloudStatusArgs(args);
    const startedAt = now();
    while (true) {
      const mission = await fetchCloudMissionStatus(parsed.taskId, options);
      printCloudStatus(mission, parsed.asJson, log);
      const terminal = TERMINAL_CLOUD_STATUSES.has(mission.status);
      if (!parsed.watch) return { exitCode: 0, mission };
      if (terminal) return { exitCode: mission.status === 'completed' ? 0 : 1, mission };
      const elapsed = now() - startedAt;
      if (elapsed >= maxWatchMs) {
        error(`cloud mission watch timed out after ${Math.round(maxWatchMs / 60_000)} minutes`);
        return { exitCode: 1, mission, timedOut: true };
      }
      await sleep(Math.min(pollIntervalMs, maxWatchMs - elapsed));
    }
  } catch (caught) {
    error(caught.message || String(caught));
    return { exitCode: caught.exitCode || 1, error: caught };
  }
}

module.exports = {
  VALID_CLOUD_LANES,
  TERMINAL_CLOUD_STATUSES,
  parseCloudRunArgs,
  parseCloudStatusArgs,
  enqueueCloudMission,
  fetchCloudMissionStatus,
  appendCloudMissionReceipt,
  cloudMissionSummary,
  cloudStatusLines,
  runCloudMissionCommand,
  statusCloudMissionCommand,
};
