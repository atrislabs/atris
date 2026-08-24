'use strict';

/**
 * Compact --json helpers for headless agents.
 * Default payloads stay tiny; --full dumps the full object.
 */

function wantsJson(args = []) {
  return Array.isArray(args) && args.includes('--json');
}

function wantsFull(args = []) {
  return Array.isArray(args) && (args.includes('--full') || args.includes('--verbose'));
}

function compactErrorPayload({
  reason = 'error',
  detail = null,
  selected_ref = null,
  next_command = null,
} = {}) {
  return {
    ok: false,
    reason: String(reason || 'error'),
    detail: detail == null ? null : String(detail),
    selected_ref: selected_ref == null ? null : String(selected_ref),
    next_command: next_command == null ? null : String(next_command),
  };
}

function compactSuccessPayload({
  action,
  ids = {},
  next_command = null,
} = {}) {
  const payload = { ok: true, action: String(action || 'ok') };
  for (const [key, value] of Object.entries(ids || {})) {
    if (value == null || value === '') continue;
    payload[key] = value;
  }
  if (next_command != null && next_command !== '') {
    payload.next_command = String(next_command);
  }
  return payload;
}

function printCliJson(fullPayload, compactPayload, args = [], print = console.log) {
  const body = wantsFull(args) ? fullPayload : compactPayload;
  print(JSON.stringify(body, null, 2));
  return body;
}

module.exports = {
  wantsJson,
  compactErrorPayload,
  compactSuccessPayload,
  printCliJson,
};
