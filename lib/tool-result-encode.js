'use strict';

function encodeToolResult(result) {
  return Buffer.from(JSON.stringify(result), 'utf8').toString('base64');
}

function toolResultEncodingEnabled(env = process.env) {
  return env.ATRIS_TOOL_RESULT_B64 !== '0';
}

function buildToolResultBody(callId, result, env = process.env) {
  if (!toolResultEncodingEnabled(env)) {
    return { call_id: callId, result };
  }

  return {
    call_id: callId,
    result: encodeToolResult(result),
    output_encoding: 'base64',
  };
}

module.exports = { buildToolResultBody, encodeToolResult, toolResultEncodingEnabled };
