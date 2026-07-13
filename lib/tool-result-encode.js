'use strict';

function encodeToolResult(result) {
  return Buffer.from(JSON.stringify(result), 'utf8').toString('base64');
}

module.exports = { encodeToolResult };
