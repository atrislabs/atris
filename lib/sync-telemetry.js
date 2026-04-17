// Atris sync telemetry — emit one event per `atris push` / `atris pull`.
//
// Why awaited (not fire-and-forget): push.js / pull.js call process.exit(1)
// on most failure paths. A fire-and-forget POST gets killed mid-flight and
// the RL loop loses signals on the exact failures it most needs to learn.
//
// Best-effort: any error swallowed silently — telemetry never blocks UX.
// Hard 2s timeout so a flaky control plane can't slow real operations.

const { apiRequestJson } = require('../utils/api');

let _cachedVersion = null;
function cliVersion() {
  if (_cachedVersion) return _cachedVersion;
  try {
    _cachedVersion = require('../package.json').version || 'unknown';
  } catch {
    _cachedVersion = 'unknown';
  }
  return _cachedVersion;
}

async function emitSyncEvent(token, businessId, workspaceId, op, outcome, latencyMs, extras = {}) {
  if (!token || !businessId || !workspaceId || !op || !outcome) return false;
  const event = {
    business_id: businessId,
    workspace_id: workspaceId,
    op,
    outcome,
    latency_ms: Math.max(0, Math.round(latencyMs || 0)),
    bytes_transferred: extras.bytes_transferred || 0,
    bytes_changed: extras.bytes_changed || 0,
    files_pushed: extras.files_pushed || 0,
    files_deleted: extras.files_deleted || 0,
    files_unchanged: extras.files_unchanged || 0,
    cli_version: cliVersion(),
  };
  if (extras.error_detail) event.error_detail = String(extras.error_detail).slice(0, 500);

  try {
    await apiRequestJson('/atris-sync/telemetry', {
      method: 'POST',
      token,
      body: event,
      timeoutMs: 2000,
      retries: 0,
    });
    return true;
  } catch {
    return false;
  }
}

function startTimer() {
  const t0 = Date.now();
  return () => Date.now() - t0;
}

module.exports = { emitSyncEvent, startTimer };
