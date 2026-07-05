'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  HTML_TAG_RE,
  RENDERED_SOURCE_FENCE_RE,
  scanOutboundArtifact,
} = require('../scripts/outbound-artifact-gate');

const DEFAULT_GATE = Object.freeze({
  format: 'plain',
  proofFile: null,
  bodyFile: null,
  visual: false,
  allowSlop: false,
});

class OutboundArtifactGateError extends Error {
  constructor(check, file, errors = []) {
    super(`outbound artifact gate failed: ${check} in ${file}`);
    this.name = 'OutboundArtifactGateError';
    this.check = check;
    this.file = file;
    this.errors = errors;
  }
}

function defaultGateOptions() {
  return { ...DEFAULT_GATE };
}

function readOutboundBodyFile(bodyFile) {
  const file = path.resolve(String(bodyFile || ''));
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    throw new OutboundArtifactGateError('body-file-read-error', file);
  }
}

function writeInlineBodyFile(body) {
  const file = path.join(os.tmpdir(), `atris-outbound-gate-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(file, String(body || ''), { encoding: 'utf8', flag: 'wx' });
  return file;
}

function normalizeProofFile(proofFile) {
  return proofFile ? path.resolve(String(proofFile)) : null;
}

function extractOutboundGateOptions(args = []) {
  const rest = [];
  const gate = defaultGateOptions();

  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i] || '');
    const eq = arg.indexOf('=');
    const key = eq >= 0 ? arg.slice(0, eq) : arg;
    const inlineValue = eq >= 0 ? arg.slice(eq + 1) : null;

    if (key === '--visual') {
      gate.visual = true;
      continue;
    }
    if (key === '--allow-slop') {
      gate.allowSlop = true;
      continue;
    }
    if (key === '--format') {
      gate.format = String(inlineValue !== null ? inlineValue : args[i + 1] || 'plain').toLowerCase();
      if (inlineValue === null) i += 1;
      continue;
    }
    if (key === '--proof-file' || key === '--render-proof') {
      gate.proofFile = normalizeProofFile(inlineValue !== null ? inlineValue : args[i + 1]);
      if (inlineValue === null) i += 1;
      continue;
    }
    if (key === '--body-file') {
      gate.bodyFile = path.resolve(String(inlineValue !== null ? inlineValue : args[i + 1] || ''));
      if (inlineValue === null) i += 1;
      continue;
    }

    rest.push(arg);
  }

  return { args: rest, gate };
}

function parseOutboundSendArgs(args = []) {
  const parsed = extractOutboundGateOptions(args);
  return {
    text: parsed.gate.bodyFile ? '' : parsed.args.join(' ').trim(),
    gate: parsed.gate,
  };
}

function shouldRunOutboundGate(channel, body, gate = {}) {
  const format = String(gate.format || 'plain').toLowerCase();
  if (format !== 'plain') return true;
  if (gate.visual || gate.proofFile || gate.bodyFile) return true;
  return HTML_TAG_RE.test(body) || RENDERED_SOURCE_FENCE_RE.test(body);
}

function assertOutboundSendAllowed(channel, body, gate = {}) {
  const options = { ...defaultGateOptions(), ...(gate || {}) };
  options.format = String(options.format || 'plain').toLowerCase();
  options.channel = String(channel || 'other').toLowerCase();
  options.proofFile = normalizeProofFile(options.proofFile);
  if (options.bodyFile) options.bodyFile = path.resolve(String(options.bodyFile));

  const inspectedBody = options.bodyFile ? readOutboundBodyFile(options.bodyFile) : String(body || '');
  if (!shouldRunOutboundGate(options.channel, inspectedBody, options)) {
    return { ok: true, inspected: false, body: inspectedBody, file: null };
  }

  const inspectedFile = options.bodyFile || writeInlineBodyFile(inspectedBody);
  const errors = scanOutboundArtifact({
    channel: options.channel,
    format: options.format,
    bodyFile: inspectedFile,
    proofFile: options.proofFile,
    visual: options.visual,
    allowSlop: options.allowSlop,
  }, inspectedBody);

  if (errors.length) {
    throw new OutboundArtifactGateError(errors[0].id, inspectedFile, errors);
  }

  return { ok: true, inspected: true, body: inspectedBody, file: inspectedFile };
}

function exitOutboundGateFailure(error) {
  console.error(error.message);
  process.exit(1);
}

function assertOutboundSendAllowedOrExit(channel, body, gate = {}, options = {}) {
  try {
    return assertOutboundSendAllowed(channel, body, gate);
  } catch (error) {
    exitOutboundGateFailure(error, options);
  }
}

function prepareOutboundSendTextOrExit(channel, args = [], options = {}) {
  const parsed = parseOutboundSendArgs(args);
  return assertOutboundSendAllowedOrExit(channel, parsed.text, parsed.gate, options);
}

module.exports = {
  OutboundArtifactGateError,
  assertOutboundSendAllowed,
  assertOutboundSendAllowedOrExit,
  defaultGateOptions,
  extractOutboundGateOptions,
  parseOutboundSendArgs,
  prepareOutboundSendTextOrExit,
  readOutboundBodyFile,
  shouldRunOutboundGate,
};
