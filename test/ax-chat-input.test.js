const assert = require('node:assert/strict');
const { test } = require('node:test');
const readline = require('node:readline');
const { PassThrough } = require('node:stream');
const {
  attachMultilineChatInput,
  isMultilineCsiComplete,
  isMultilineCsiKey,
  isMultilineInsertKey,
  isMultilineCsiPrefix,
  isSubmitKey,
  stripMultilineCsiText,
} = require('../lib/ax-chat-input');

// Drive a real readline interface (the unit mock below cannot catch the
// keypress decoder shredding \x1b[27;2;13~ or readline mangling an embedded
// newline on submit — both real regressions this guards). readline cannot emit
// a 'line' string holding a literal newline, so the multiline value is read
// from onSubmit exactly as ax does, with the single-line case falling back to
// the line event.
function runRealChat(chunks) {
  return new Promise((resolve, reject) => {
    const input = new PassThrough();
    input.isTTY = true;
    input.setRawMode = () => {};
    const output = new PassThrough();
    output.isTTY = true;
    const rl = readline.createInterface({ input, output, terminal: true });
    readline.emitKeypressEvents(input, rl);
    let writes = 0;
    const realWrite = rl.write.bind(rl);
    rl.write = (...args) => {
      if (++writes > 500) {
        reject(new Error('runaway rl.write recursion'));
        return undefined;
      }
      return realWrite(...args);
    };
    let captured = null;
    attachMultilineChatInput(rl, { onSubmit: (line) => { captured = line; } });
    const timer = setTimeout(() => reject(new Error('no line event')), 2000);
    rl.on('line', (line) => {
      clearTimeout(timer);
      rl.close();
      resolve(stripMultilineCsiText(captured != null ? captured : line));
    });
    for (const chunk of chunks) input.write(chunk);
  });
}

function createMockRl() {
  const breaks = [];
  const rl = {
    line: '',
    cursor: 0,
    write(value) {
      const text = String(value);
      if (text === '\n') {
        breaks.push('\n');
        this.line += '\n';
      } else {
        this.line += text;
      }
      this.cursor = this.line.length;
    },
    _ttyWrite(str) {
      this.line += String(str);
      this.cursor = this.line.length;
    },
  };
  attachMultilineChatInput(rl, {
    insertBreak: (target) => target.write('\n'),
  });
  return { rl, breaks };
}

test('ttyWrite wrapper swallows split cursor shift+enter CSI', () => {
  const { rl, breaks } = createMockRl();
  rl._ttyWrite('\x1b', { name: 'escape', sequence: '\x1b' });
  for (const ch of '[27;2;13~') rl._ttyWrite(ch, { sequence: ch });
  assert.equal(breaks.length, 1);
  assert.equal(rl.line, '\n');
});

test('ttyWrite wrapper swallows full shift+enter CSI key', () => {
  const { rl, breaks } = createMockRl();
  rl._ttyWrite('', { sequence: '\x1b[27;2;13~' });
  assert.equal(breaks.length, 1);
  assert.equal(rl.line, '\n');
});

test('ttyWrite wrapper keeps normal typing', () => {
  const { rl, breaks } = createMockRl();
  rl._ttyWrite('h', { sequence: 'h' });
  rl._ttyWrite('i', { sequence: 'i' });
  assert.equal(breaks.length, 0);
  assert.equal(rl.line, 'hi');
});

test('chat input helpers recognize multiline CSI', () => {
  assert.equal(isMultilineCsiPrefix('\x1b['), true);
  assert.equal(isMultilineCsiComplete('\x1b[27;2;13~'), true);
  assert.equal(isMultilineCsiKey({ sequence: '\x1b[27;2;13~' }), true);
  assert.equal(isMultilineInsertKey('', { shift: true, name: 'return' }), true);
});

test('stripMultilineCsiText converts leaked visible CSI to newlines', () => {
  assert.equal(stripMultilineCsiText('hi[27;2;13~ there'), 'hi\n there');
  assert.equal(stripMultilineCsiText('hi\x1b[27;2;13~ there'), 'hi\n there');
});

test('stripMultilineCsiText restores the submit-time newline sentinel', () => {
  assert.equal(stripMultilineCsiText('foo\x1fbar'), 'foo\nbar');
});

test('isSubmitKey only matches a plain Enter', () => {
  assert.equal(isSubmitKey('\r', { name: 'return' }), true);
  assert.equal(isSubmitKey('\r', null), true);
  assert.equal(isSubmitKey('', { name: 'return', shift: true }), false);
  assert.equal(isSubmitKey('', { name: 'return', meta: true }), false);
  assert.equal(isSubmitKey('a', { name: 'a' }), false);
});

test('real readline turns xterm shift+enter (\\x1b[27;2;13~) into a newline', async () => {
  // This is the exact sequence the keypress decoder shreds into \x1b[27;2;
  // plus literal "1", "3", "~"; the mock cannot reproduce it.
  assert.equal(await runRealChat(['foo', '\x1b[27;2;13~', 'bar', '\r']), 'foo\nbar');
});

test('real readline handles byte-split shift+enter and multiple breaks', async () => {
  assert.equal(await runRealChat(['foo', ...'\x1b[27;2;13~', 'bar', '\r']), 'foo\nbar');
  assert.equal(
    await runRealChat(['a', '\x1b[27;2;13~', 'b', '\x1b[27;2;13~', 'c', '\r']),
    'a\nb\nc',
  );
});

test('real readline covers csi/kitty shift+enter variants and plain submit', async () => {
  assert.equal(await runRealChat(['foo', '\x1b[13;2~', 'bar', '\r']), 'foo\nbar');
  assert.equal(await runRealChat(['foo', '\x1b[23~', 'bar', '\r']), 'foo\nbar');
  assert.equal(await runRealChat(['foo', '\x1b[13;2u', 'bar', '\r']), 'foo\nbar');
  assert.equal(await runRealChat(['hello', '\r']), 'hello');
});

test('real readline keeps a bracketed paste as one multi-line message', async () => {
  // Terminals wrap pastes in \x1b[200~ … \x1b[201~; the whole block must become
  // a single message instead of submitting on each embedded newline.
  assert.equal(
    await runRealChat(['\x1b[200~line one\nline two\nline three\x1b[201~', '\r']),
    'line one\nline two\nline three',
  );
  // text typed before + paste appended, then sent
  assert.equal(
    await runRealChat(['note: ', '\x1b[200~pasted\nlines\x1b[201~', '\r']),
    'note: pasted\nlines',
  );
});
