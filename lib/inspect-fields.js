'use strict';

const MISSION_INSPECT_FIELDS = new Set(['status', 'runner', 'ack', 'pings']);

const TASK_INSPECT_FIELDS = new Set([
  'status',
  'title',
  'claimed_by',
  'tag',
  'review',
]);

function parseFieldList(raw) {
  return String(raw || '')
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

function readFieldsFlag(args, flagName = '--fields') {
  const index = args.indexOf(flagName);
  if (index === -1) return null;
  const raw = args[index + 1];
  if (!raw || String(raw).startsWith('--')) {
    return { error: `${flagName} requires a comma-separated field list` };
  }
  const fields = parseFieldList(raw);
  if (!fields.length) {
    return { error: `${flagName} requires at least one field` };
  }
  return { fields };
}

function stripInspectArgs(args, { flagName = '--fields' } = {}) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i]);
    if (arg === '--json') continue;
    if (arg === flagName) {
      i += 1;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

function validateFields(fields, allowed, label) {
  const unknown = fields.filter((field) => !allowed.has(field));
  if (!unknown.length) return null;
  return `Unknown ${label} inspect field${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}. Allowed: ${[...allowed].join(', ')}`;
}

function missionAckInspectValue(mission) {
  const ack = mission && mission.native_goal_ack;
  if (!ack || typeof ack !== 'object') {
    return {
      acknowledged: false,
      status: null,
      runtime: null,
      objective: null,
      acknowledged_at: null,
    };
  }
  return {
    acknowledged: true,
    status: ack.status || null,
    runtime: ack.runtime || null,
    objective: ack.objective || null,
    acknowledged_at: ack.acknowledged_at || null,
  };
}

function missionPingsInspectValue(mission) {
  const pings = Array.isArray(mission && mission.pings) ? mission.pings.filter(Boolean) : [];
  const pending = pings.filter((ping) => ping && !ping.consumed_at).length;
  return {
    total: pings.length,
    pending,
  };
}

function missionInspectFieldValues(mission, fields) {
  const values = {};
  for (const field of fields) {
    switch (field) {
      case 'status':
        values.status = mission.status || null;
        break;
      case 'runner': {
        const runner = mission.runner || 'manual';
        values.runner = mission.model ? `${runner} (${mission.model})` : runner;
        break;
      }
      case 'ack':
        values.ack = missionAckInspectValue(mission);
        break;
      case 'pings':
        values.pings = missionPingsInspectValue(mission);
        break;
      default:
        break;
    }
  }
  return values;
}

function formatInspectScalar(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function formatInspectFieldText(field, value) {
  if (field === 'ack') {
    if (!value || value.acknowledged !== true) return 'unacknowledged';
    const bits = [value.status || 'acknowledged'];
    if (value.acknowledged_at) bits.push(`@ ${value.acknowledged_at}`);
    return bits.join(' ');
  }
  if (field === 'pings') {
    if (!value || typeof value !== 'object') return '0';
    if (value.pending === value.total) return String(value.pending);
    return `${value.pending} pending / ${value.total} total`;
  }
  if (field === 'runner' && value && typeof value === 'object') {
    return value.model ? `${value.runner} (${value.model})` : String(value.runner || 'manual');
  }
  if (field === 'review' && value && typeof value === 'object') {
    return JSON.stringify(value);
  }
  return formatInspectScalar(value);
}

function inspectTextLines(fields, values) {
  if (fields.length === 1) {
    const field = fields[0];
    return [formatInspectFieldText(field, values[field])];
  }
  return fields.map((field) => `${field}: ${formatInspectFieldText(field, values[field])}`);
}

function buildInspectPayload({
  action,
  idKey,
  idValue,
  fields,
  values,
}) {
  return {
    ok: true,
    action,
    [idKey]: idValue,
    fields: values,
    requested_fields: fields,
  };
}

module.exports = {
  MISSION_INSPECT_FIELDS,
  TASK_INSPECT_FIELDS,
  parseFieldList,
  readFieldsFlag,
  stripInspectArgs,
  validateFields,
  missionAckInspectValue,
  missionPingsInspectValue,
  missionInspectFieldValues,
  formatInspectFieldText,
  inspectTextLines,
  buildInspectPayload,
};
