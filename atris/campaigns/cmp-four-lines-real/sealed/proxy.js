'use strict';
// makeModule(agentDir, module): stands in for the agent's module inside the
// held-out test. Each call runs the agent's code in a sealed child process, so
// agent code never shares a process with the held-out tests. Changes the call
// made to its array or object arguments are copied back, so a test that checks
// its input was left alone still sees a mutation.
const path = require('path');
const { spawnSync } = require('child_process');
const { enc, dec, same } = require('./codec');

function profile(agentDir, sealedDir) {
  // the sandbox matches real paths (/private/var, not /var), so resolve links first
  const real = (p) => { try { return require('fs').realpathSync(p); } catch { return p; } };
  const q = (p) => JSON.stringify(real(p));
  return [
    '(version 1)', '(allow default)', '(deny network*)',
    // contents and listings under home are denied; node may still stat the folders on its path
    `(deny file-read-data (subpath ${q(process.env.HOME_REAL || require('os').homedir())}))`,
    `(allow file-read-data (subpath ${q(agentDir)}) (subpath ${q(sealedDir)}))`,
    `(deny file-read* (subpath ${q(process.env.HELD_DIR || '/nonexistent')}))`,
    // the original held-out file too, wherever the campaign keeps it
    `(deny file-read* (subpath ${q(require('path').dirname(process.env.HOLDOUT_SRC || '/nonexistent/x'))}))`,
    '(deny file-write*)', '(allow file-write* (literal "/dev/null"))',
  ].join('');
}

function copyBack(into, from) {
  if (same(into, from)) return; // unchanged: leave it, even if it is frozen
  if (Array.isArray(into) && Array.isArray(from)) { into.length = 0; from.forEach((x, i) => { into[i] = x; }); into.length = from.length; return; }
  if (into && typeof into === 'object' && from && typeof from === 'object') {
    for (const k of Object.keys(into)) if (!(k in from)) delete into[k];
    Object.assign(into, from);
  }
}

function makeModule(agentDir, mod) {
  const sealedDir = __dirname;
  const call = (fn, args) => {
    const nonce = require('crypto').randomBytes(16).toString('hex');
    const r = spawnSync('/usr/bin/sandbox-exec', ['-p', profile(agentDir, sealedDir), process.execPath, path.join(sealedDir, 'runner.js'), agentDir, mod, fn], {
      input: `${nonce}\n${enc(args)}`, encoding: 'utf8', timeout: 20000, cwd: agentDir, env: { PATH: '/usr/bin:/bin' },
    });
    // only the line the runner marked with this call's nonce counts as the result
    const at = (r.stdout || '').lastIndexOf(`\n${nonce}`);
    if (r.status !== 0 || at < 0) throw new Error(`sealed call failed: ${(r.stderr || r.error || '').toString().slice(0, 200)}`);
    const out = dec(r.stdout.slice(at + nonce.length + 1));
    args.forEach((a, i) => copyBack(a, out.args[i]));
    if (out.thrown) {
      // rebuild a built-in error only when the child saw a real one; else rethrow the plain value
      if (out.thrown.builtin) {
        const C = globalThis[out.thrown.builtin];
        throw typeof C === 'function' ? new C(out.thrown.message) : new Error(out.thrown.message);
      }
      throw out.thrown.value;
    }
    return out.value;
  };
  return new Proxy({}, { get: (_, fn) => (typeof fn === 'string' ? (...args) => call(fn, args) : undefined) });
}

module.exports = { makeModule };
