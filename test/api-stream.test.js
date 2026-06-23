const assert = require('assert');
const http = require('http');
const test = require('node:test');
const { streamProChat } = require('../utils/api');

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

test('streamProChat emits text_delta and suppresses duplicate result output', async () => {
  let requestBody = '';
  const server = http.createServer((req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.headers.authorization, 'Bearer token-123');
    assert.equal(req.headers.accept, 'text/event-stream');

    req.on('data', (chunk) => {
      requestBody += chunk.toString();
    });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"type":"text_delta","content":"hello"}\n\n');
      res.end('data: {"type":"result","result":"hello"}\n\n');
    });
  });
  const port = await listen(server);
  const originalWrite = process.stdout.write;
  let output = '';
  process.stdout.write = (chunk, encoding, callback) => {
    output += String(chunk);
    if (typeof encoding === 'function') encoding();
    if (typeof callback === 'function') callback();
    return true;
  };

  try {
    await streamProChat(`http://127.0.0.1:${port}/turn`, 'token-123', JSON.stringify({ message: 'what now?' }));
  } finally {
    process.stdout.write = originalWrite;
    await close(server);
  }

  assert.equal(requestBody, '{"message":"what now?"}');
  assert.equal((output.match(/hello/g) || []).length, 1);
});
