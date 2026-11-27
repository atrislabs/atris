'use strict';

// Whether Sentinel may save results to the person's Atris account.
//
// Nothing is saved until the person says yes. In order:
//   --no-upload                 no, this run
//   --upload                    yes, this run
//   ATRIS_SENTINEL_UPLOAD=1|0   yes or no, for CI and scripts
//   the saved answer            ~/.atris/sentinel/settings.json, set by the
//                               first question or atris sentinel upload --always|--never
//   an interactive terminal     ask once, one line, and save the answer
//   anything else (CI, a pipe)  no
//
// A saved answer is the person's own choice and lives in their home folder,
// never in the project.

const fs = require('fs');
const os = require('os');
const path = require('path');

function homeOf({ homeDir, env = process.env } = {}) {
  return homeDir || (env && env.HOME) || os.homedir();
}

function settingsPath(o = {}) {
  return path.join(homeOf(o), '.atris', 'sentinel', 'settings.json');
}

function readSettings(o = {}) {
  try {
    const s = JSON.parse(fs.readFileSync(settingsPath(o), 'utf8'));
    return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  } catch { return {}; }
}

// true, false, or null when the person has not said.
function savedChoice(o = {}) {
  const s = readSettings(o);
  return typeof s.upload === 'boolean' ? s.upload : null;
}

function saveChoice(upload, o = {}) {
  const file = settingsPath(o);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const next = { ...readSettings(o), upload: Boolean(upload), upload_decided_at: new Date().toISOString() };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

function envChoice(env = process.env) {
  const v = String((env && env.ATRIS_SENTINEL_UPLOAD) || '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return null;
}

const QUESTION = '  save a short summary of each review to your atris account? titles, file and line, counts. never code (y/N) ';
const NOT_ASKED = '  not saved to your atris account. add --upload, or say yes for good with: atris sentinel upload --always';

// flag: true (--upload), false (--no-upload) or null.
// ask(question) answers true or false; it is used only when the input is
// an interactive terminal. Returns { upload, why }.
async function decideUpload({ flag = null, token = '', env = process.env, homeDir, input = process.stdin, ask = null, tell = () => {} } = {}) {
  if (flag === false) return { upload: false, why: 'flag' };
  if (!token) return { upload: false, why: 'not-logged-in' };
  if (flag === true) return { upload: true, why: 'flag' };
  const fromEnv = envChoice(env);
  if (fromEnv !== null) return { upload: fromEnv, why: 'env' };
  const saved = savedChoice({ homeDir, env });
  if (saved !== null) return { upload: saved, why: 'saved' };
  if (!input || !input.isTTY || !ask) {
    tell(NOT_ASKED);
    return { upload: false, why: 'no-terminal' };
  }
  let yes = false;
  try { yes = Boolean(await ask(QUESTION)); } catch { yes = false; }
  try {
    saveChoice(yes, { homeDir, env });
    tell(yes
      ? '  saved your answer. change it any time: atris sentinel upload --never'
      : '  nothing will be saved to your account. change it any time: atris sentinel upload --always');
  } catch {}
  return { upload: yes, why: 'asked' };
}

// The one place a command asks: deps.askUpload in tests, else a one-line
// readline prompt, only when stdin is a real terminal. A test that hands in
// its own input without askUpload gets no question (like CI).
function uploadConsent(flag, { token = '', deps = {}, tell = () => {}, json = false } = {}) {
  const input = deps.input || process.stdin;
  let ask = deps.askUpload || null;
  if (!ask && !deps.input) {
    ask = (q) => new Promise((resolve) => {
      const rl = require('readline').createInterface({ input, output: json ? process.stderr : process.stdout });
      rl.question(q, (answer) => { rl.close(); resolve(/^\s*y(es)?\s*$/i.test(String(answer || ''))); });
    });
  }
  return decideUpload({ flag, token, env: deps.env || process.env, homeDir: deps.homeDir, input, ask, tell });
}

module.exports = { uploadConsent, decideUpload, savedChoice, saveChoice, settingsPath, envChoice, QUESTION, NOT_ASKED };
