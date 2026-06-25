const MULTILINE_CSI = [
  '\x1b[13;2~',
  '\x1b[27;2;13~',
  '\x1b[23~',
  '\x1b[13;2u',
];

const MULTILINE_CSI_RE = /\x1b\[(?:13;2~|27;2;13~|23~|13;2u)/;
const MULTILINE_CSI_VISIBLE_RE = /\[(?:13;2~|27;2;13~|23~|13;2u)/g;

// Node's readline cannot emit a 'line' whose buffer contains a literal "\n"
// (it reorders the text around the newline on submit). So newlines live in the
// buffer as this sentinel while typing is rendered, then are restored to "\n"
// when the answer is read back via stripMultilineCsiText.
const MULTILINE_PLACEHOLDER = '\x1f';
const MULTILINE_PLACEHOLDER_RE = /\x1f/g;

function isMultilineCsiPrefix(buffer) {
  const value = String(buffer || '');
  if (!value) return false;
  return MULTILINE_CSI.some((seq) => seq.startsWith(value));
}

function isMultilineCsiComplete(buffer) {
  return MULTILINE_CSI.includes(String(buffer || ''));
}

function isMultilineCsiKey(key) {
  const sequence = String(key?.sequence || '');
  return MULTILINE_CSI_RE.test(sequence);
}

function isMultilineInsertKey(str, key) {
  if (!key) return str === '\n';
  if (key.shift && (key.name === 'return' || key.name === 'enter')) return true;
  if (key.meta && (key.name === 'return' || key.name === 'enter')) return true;
  if (str === '\n' && key.name !== 'return') return true;
  return false;
}

function isSubmitKey(str, key) {
  if (key && (key.name === 'return' || key.name === 'enter') && !key.shift && !key.meta) return true;
  if (!key && str === '\r') return true;
  return false;
}

function stripMultilineCsiText(text) {
  return String(text || '')
    .replace(MULTILINE_PLACEHOLDER_RE, '\n')
    .replace(/\x1b\[20[01]~/g, '')
    .replace(/\x1b\[(?:13;2~|27;2;13~|23~|13;2u)/g, '\n')
    .replace(MULTILINE_CSI_VISIBLE_RE, '\n')
    .replace(/\^?\[\[27;2;13~/g, '\n');
}

// The raw bytes a keypress represents. readline's keypress decoder mangles
// some CSI sequences (e.g. it splits \x1b[27;2;13~ into a malformed escape
// whose `sequence` is \x1b[27;2; followed by literal "1", "3", "~"), so when
// `str` is empty we fall back to the decoded `sequence`.
function keyBytes(str, key) {
  if (typeof str === 'string' && str.length > 0) return str;
  if (key && typeof key.sequence === 'string' && key.sequence.length > 0) return key.sequence;
  return typeof str === 'string' ? str : '';
}

function defaultInsertBreak(rl) {
  if (!rl) return;
  // _insertString splices a literal newline at the cursor; rl.write('\n')
  // would instead SUBMIT the line, so it must not be used here.
  if (typeof rl._insertString === 'function') {
    rl._insertString('\n');
    return;
  }
  if (typeof rl.line === 'string') {
    const cursor = Number.isFinite(rl.cursor) ? rl.cursor : rl.line.length;
    rl.line = rl.line.slice(0, cursor) + '\n' + rl.line.slice(cursor);
    rl.cursor = cursor + 1;
    if (typeof rl._refreshLine === 'function') rl._refreshLine();
    return;
  }
  if (typeof rl.write === 'function') rl.write('\n');
}

function attachMultilineChatInput(rl, { insertBreak = defaultInsertBreak, onSubmit } = {}) {
  if (!rl || typeof rl._ttyWrite !== 'function') return () => {};
  const ttyWrite = rl._ttyWrite.bind(rl);
  let escBuffer = null;

  rl._ttyWrite = (str, key) => {
    const bytes = keyBytes(str, key);

    // Mid-sequence: keypress decoder shredded a multiline CSI across calls and
    // we're reassembling it (e.g. \x1b[27;2; then "1", "3", "~").
    if (escBuffer !== null) {
      escBuffer += bytes;
      if (isMultilineCsiComplete(escBuffer)) {
        escBuffer = null;
        insertBreak(rl);
        return;
      }
      if (isMultilineCsiPrefix(escBuffer) && escBuffer.length <= 24) {
        return;
      }
      // Diverged from every target sequence: replay the swallowed bytes
      // literally (current keypress is already included in the buffer).
      const replay = escBuffer;
      escBuffer = null;
      for (const ch of replay) ttyWrite(ch);
      return;
    }

    // Whole multiline CSI delivered in a single keypress (terminals or Node
    // versions that don't shred it).
    if (isMultilineCsiKey(key) || MULTILINE_CSI_RE.test(bytes)) {
      insertBreak(rl);
      return;
    }

    // Start of a shredded multiline CSI: begin buffering from the raw escape.
    if (bytes && bytes.charCodeAt(0) === 0x1b && isMultilineCsiPrefix(bytes)) {
      escBuffer = bytes;
      if (isMultilineCsiComplete(escBuffer)) {
        escBuffer = null;
        insertBreak(rl);
      }
      return;
    }

    // Plain Shift+Enter / Meta+Enter / synthetic \n.
    if (isMultilineInsertKey(str, key)) {
      insertBreak(rl);
      return;
    }

    // Submit (Enter): the line buffer keeps its literal "\n" so readline's own
    // multiline cursor math advances past every wrapped row (otherwise the box
    // bottom border overwrites a row). readline mangles the emitted 'line'
    // string when it holds a newline, so we hand the true buffer to onSubmit
    // and the caller reads that instead of the line event.
    if (isSubmitKey(str, key) && typeof rl.line === 'string' && rl.line.includes('\n')) {
      if (typeof onSubmit === 'function') onSubmit(rl.line);
    }

    ttyWrite(str, key);
  };

  return () => {
    rl._ttyWrite = ttyWrite;
    escBuffer = null;
  };
}

module.exports = {
  MULTILINE_CSI,
  MULTILINE_PLACEHOLDER,
  attachMultilineChatInput,
  isMultilineCsiComplete,
  isMultilineCsiKey,
  isMultilineInsertKey,
  isMultilineCsiPrefix,
  isSubmitKey,
  stripMultilineCsiText,
  keyBytes,
};
