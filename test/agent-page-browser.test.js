// Agent page: the real-browser proof. Drives the fixture settings page in headless
// Google Chrome over the DevTools protocol, using only Node built-ins (WebSocket is
// built in on Node 22 and newer). Skips with a clear message when Chrome is missing.
//
// Every check is its own top-level test, and all of them share one browser session.
// Nested t.test() subtests dropped the DevTools socket in our runs, so they are not used.

'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const CHROME = process.env.ATRIS_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FIXTURE = path.join(__dirname, 'fixtures', 'agent-page', 'project-settings.html');

function skipReason() {
  if (!fs.existsSync(CHROME)) {
    return `Google Chrome not found at ${CHROME}; set ATRIS_CHROME_PATH to run this browser test`;
  }
  if (typeof WebSocket !== 'function') return 'needs Node 22 or newer (built-in WebSocket)';
  return false;
}

const SKIP = skipReason();

async function waitFor(check, ms, what) {
  const until = Date.now() + ms;
  let lastError = null;
  while (Date.now() < until) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}${lastError ? `: ${lastError.message}` : ''}`);
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let nextId = 0;
    const failAll = (reason) => {
      for (const waiter of pending.values()) waiter.reject(new Error(reason));
      pending.clear();
    };
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    };
    ws.onerror = () => {
      failAll('devtools socket failed');
      reject(new Error('devtools socket failed'));
    };
    ws.onclose = () => failAll('devtools socket closed');
    ws.onopen = () => resolve({
      send(method, params = {}) {
        const id = ++nextId;
        ws.send(JSON.stringify({ id, method, params }));
        return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }));
      },
      close() { ws.close(); },
    });
  });
}

// Runs a function inside the page. The function is sent as source text, so it must be
// self-contained: it can only use the page's own globals.
async function inPage(cdp, fn, arg = null) {
  const expression = `(${fn.toString()})(${JSON.stringify(arg)})`;
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception && result.exceptionDetails.exception.description;
    throw new Error(detail || result.exceptionDetails.text);
  }
  return result.result.value;
}

// Page-side helpers. Each one runs inside the fixture page.
const pageState = () => ({ protocol: location.protocol, ready: document.readyState });
const pageSnapshot = () => window.AgentPage.createAgent({}).snapshot();
const pageQuery = (q) => window.AgentPage.createAgent({}).query(q);
const pageSettings = () => window.__settings;
const pageAct = async ({ steps, answer, timeout }) => {
  const calls = [];
  const options = { timeout };
  if (answer !== 'none') {
    options.allow = (request) => {
      calls.push({
        label: request.label,
        action: request.action,
        confirm: request.confirm,
        before: JSON.stringify(window.__settings),
      });
      if (answer === 'hang') return new Promise(() => {});
      return answer === 'yes';
    };
  }
  const result = await window.AgentPage.createAgent(options).act({ steps });
  return { result, calls };
};
const pageLastClick = () => window.__lastClick;
const pageAddControls = (count) => {
  const html = Array.from({ length: count }, (_, i) => `<label>Extra ${i} <input type="text"></label>`).join('');
  const wrap = document.createElement('div');
  wrap.setAttribute('data-test-extra', '');
  wrap.innerHTML = html;
  document.body.appendChild(wrap);
  return document.querySelectorAll('[data-test-extra] input').length;
};
const pageRemoveControls = () => {
  document.querySelectorAll('[data-test-extra]').forEach((node) => node.remove());
  return true;
};

async function launchChrome(profileDir) {
  const child = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ], { stdio: 'ignore' });
  const port = await waitFor(() => {
    const file = path.join(profileDir, 'DevToolsActivePort');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n')[0].trim() : null;
  }, 20000, 'Chrome to open its debugging port');
  return { child, port };
}

async function closeChrome(port, child) {
  try {
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const browser = await connect(version.webSocketDebuggerUrl);
    // Browser.close may never answer, because the browser shuts its socket first.
    // Do not wait for a reply; give it a moment, then the kill below covers the rest.
    browser.send('Browser.close').catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 500));
    browser.close();
  } catch {
    // Chrome may already be gone; the kill below covers it.
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

async function openSession() {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-agent-page-chrome-'));
  const chrome = await launchChrome(profileDir);
  const session = { profileDir, chrome, cdp: null };
  try {
    const pageUrl = await waitFor(async () => {
      const tabs = await (await fetch(`http://127.0.0.1:${chrome.port}/json/list`)).json();
      const tab = tabs.find((entry) => entry.type === 'page');
      return tab ? tab.webSocketDebuggerUrl : null;
    }, 20000, 'a Chrome page');
    session.cdp = await connect(pageUrl);
    await session.cdp.send('Page.enable');
    await session.cdp.send('Page.navigate', { url: pathToFileURL(FIXTURE).href });
    await waitFor(async () => {
      const state = await inPage(session.cdp, pageState);
      return state.protocol === 'file:' && state.ready === 'complete';
    }, 20000, 'the fixture page to load');
    return session;
  } catch (error) {
    await closeSession(session);
    throw error;
  }
}

async function closeSession(session) {
  if (session.cdp) session.cdp.close();
  await closeChrome(session.chrome.port, session.chrome.child);
  fs.rmSync(session.profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

let opening = null;

function browserPage() {
  if (!opening) opening = openSession();
  return opening.then((session) => session.cdp);
}

after(async () => {
  if (!opening) return;
  const session = await opening.catch(() => null);
  if (session) await closeSession(session);
});

const BROWSER = { skip: SKIP, timeout: 120000 };

test('snapshot lists the controls by name, with state and allowed actions', BROWSER, async () => {
  const cdp = await browserPage();
  const shot = await inPage(cdp, pageSnapshot);
  const byLabel = (label) => shot.find((entry) => entry.label === label);
  assert.ok(shot.length <= 101, `snapshot is capped at 100 plus a more entry, got ${shot.length}`);

  assert.equal(byLabel('Project name').kind, 'input');
  assert.equal(byLabel('Project name').value, 'Atlas');
  assert.deepEqual(byLabel('Project name').actions, ['set']);

  assert.equal(byLabel('Role for Ana').kind, 'select');
  assert.equal(byLabel('Role for Ana').value, 'Owner');
  assert.equal(byLabel('Role for Ben').kind, 'select', 'aria-label names a select');

  assert.equal(byLabel('Weekly digest').kind, 'checkbox');
  assert.equal(byLabel('Weekly digest').checked, false);
  assert.deepEqual(byLabel('Weekly digest').actions, ['check']);

  assert.equal(byLabel('Remove Ana').kind, 'button', 'aria-label beats visible text');
  assert.deepEqual(byLabel('Save').actions, ['click']);
  assert.equal(byLabel('Archive project').confirm, true, 'archive needs a person');
});

test('hidden sections are left out entirely', BROWSER, async () => {
  const cdp = await browserPage();
  const shot = await inPage(cdp, pageSnapshot);
  const leaked = shot.filter((entry) => /billing|ledger|debug reset/i.test(entry.label || ''));
  assert.deepEqual(leaked, []);
});

test('secret fields read [redacted] and their values never reach the agent', BROWSER, async () => {
  const cdp = await browserPage();
  const shot = await inPage(cdp, pageSnapshot);
  for (const label of ['Webhook secret', 'Owner password', 'Card number', 'Verification code']) {
    const entry = shot.find((item) => item.label === label);
    assert.ok(entry, `${label} is listed`);
    assert.equal(entry.value, '[redacted]', `${label} is redacted`);
    assert.equal(entry.secret, true, `${label} is marked secret`);
  }
  const text = JSON.stringify(shot);
  for (const secret of ['whsec-fixture-0001', 'pw-fixture-0002', '4242 4242 4242 4242']) {
    assert.equal(text.includes(secret), false, `${secret} must not appear in the snapshot`);
  }
});

test('rename the project by its label through a React-style controlled input', BROWSER, async () => {
  const cdp = await browserPage();
  const { result, calls } = await inPage(cdp, pageAct, {
    steps: [{ label: 'Project name', action: 'set', args: { value: 'Atlas Garden' } }],
    answer: 'yes',
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.steps[0].current.value, 'Atlas Garden');
  const settings = await inPage(cdp, pageSettings);
  assert.equal(settings.projectName, 'Atlas Garden', 'the page state changed, not just the box');
  assert.equal(calls.length, 1, 'the person was asked before the plain change');
  assert.equal(calls[0].confirm, false, 'a plain change is not marked for confirmation');
  assert.match(calls[0].before, /"projectName":"Atlas"/, 'the page had not changed yet when the person was asked');
});

test('change a role by its label', BROWSER, async () => {
  const cdp = await browserPage();
  const { result } = await inPage(cdp, pageAct, {
    steps: [{ label: 'Role for Ben', action: 'set', args: { value: 'Admin' } }],
    answer: 'none',
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const settings = await inPage(cdp, pageSettings);
  assert.equal(settings.members.Ben, 'Admin');
});

test('tick a checkbox, report the change, and refuse a second tick', BROWSER, async () => {
  const cdp = await browserPage();
  const first = await inPage(cdp, pageAct, {
    steps: [{ label: 'Weekly digest', action: 'check' }],
    answer: 'none',
  });
  assert.equal(first.result.ok, true, JSON.stringify(first.result));
  assert.deepEqual(first.result.steps[0].changes, [
    { ref: first.result.steps[0].changes[0].ref, label: 'Weekly digest', field: 'checked', from: false, to: true },
  ]);
  const settings = await inPage(cdp, pageSettings);
  assert.equal(settings.digest, true);

  const second = await inPage(cdp, pageAct, {
    steps: [{ label: 'Weekly digest', action: 'check' }],
    answer: 'none',
  });
  assert.equal(second.result.ok, false);
  assert.match(second.result.steps[0].error, /accepts: uncheck/);
});

test('press save, and the page can tell the press came from the agent', BROWSER, async () => {
  const cdp = await browserPage();
  const { result } = await inPage(cdp, pageAct, {
    steps: [{ label: 'Save', action: 'click' }],
    answer: 'none',
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const settings = await inPage(cdp, pageSettings);
  assert.equal(settings.saves, 1);
  const click = await inPage(cdp, pageLastClick);
  assert.equal(click.acting, 'true', 'the page sees the agent is acting');
  assert.equal(click.agentAct.action, 'click');
  assert.equal(click.agentAct.ref, result.steps[0].ref);
});

test('a plain change the person refuses does not happen', BROWSER, async () => {
  const cdp = await browserPage();
  const before = await inPage(cdp, pageSettings);
  const { result, calls } = await inPage(cdp, pageAct, {
    steps: [{ label: 'Save', action: 'click' }],
    answer: 'no',
  });
  assert.equal(result.ok, false);
  assert.match(result.steps[0].error, /did not confirm/);
  assert.equal(calls.length, 1, 'the person was asked before the press');
  assert.equal(calls[0].confirm, false);
  const settings = await inPage(cdp, pageSettings);
  assert.equal(settings.saves, before.saves, 'the press did not happen');
});

test('the archive button refuses without a person', BROWSER, async () => {
  const cdp = await browserPage();
  const { result, calls } = await inPage(cdp, pageAct, {
    steps: [{ label: 'Archive project', action: 'click' }],
    answer: 'none',
  });
  assert.equal(result.ok, false);
  assert.match(result.steps[0].error, /ask the person/i);
  assert.deepEqual(calls, []);
  const settings = await inPage(cdp, pageSettings);
  assert.equal(settings.archived, false, 'nothing changed');
});

test('the archive button refuses when the person says no', BROWSER, async () => {
  const cdp = await browserPage();
  const { result, calls } = await inPage(cdp, pageAct, {
    steps: [{ label: 'Archive project', action: 'click' }],
    answer: 'no',
  });
  assert.equal(result.ok, false);
  assert.match(result.steps[0].error, /did not confirm/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].label, 'Archive project');
  const settings = await inPage(cdp, pageSettings);
  assert.equal(settings.archived, false);
});

test('the archive button stops waiting when the person never answers', BROWSER, async () => {
  const cdp = await browserPage();
  const { result } = await inPage(cdp, pageAct, {
    steps: [{ label: 'Archive project', action: 'click' }],
    answer: 'hang',
    timeout: 50,
  });
  assert.equal(result.ok, false);
  assert.match(result.steps[0].error, /no answer/);
});

test('the archive button runs once the person says yes', BROWSER, async () => {
  const cdp = await browserPage();
  const { result, calls } = await inPage(cdp, pageAct, {
    steps: [{ label: 'Archive project', action: 'click' }],
    answer: 'yes',
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(calls.length, 1);
  const settings = await inPage(cdp, pageSettings);
  assert.equal(settings.archived, true);
});

test('a secret field can be typed into but its value is never echoed back', BROWSER, async () => {
  const cdp = await browserPage();
  const { result } = await inPage(cdp, pageAct, {
    steps: [{ label: 'Webhook secret', action: 'set', args: { value: 'whsec-new-0009' } }],
    answer: 'none',
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.steps[0].current.value, '[redacted]');
  assert.equal(JSON.stringify(result).includes('whsec-new-0009'), false);
});

test('an ambiguous label errors and lists the matches, and nothing is removed', BROWSER, async () => {
  const cdp = await browserPage();
  const { result } = await inPage(cdp, pageAct, {
    steps: [{ label: 'Remove', action: 'click' }],
    answer: 'none',
  });
  assert.equal(result.ok, false);
  const error = result.steps[0].error;
  assert.match(error, /matches 2 controls/);
  assert.match(error, /Remove Ana/);
  assert.match(error, /Remove Ben/);
  const settings = await inPage(cdp, pageSettings);
  assert.deepEqual(Object.keys(settings.members).sort(), ['Ana', 'Ben']);
});

test('a label that is not on the page errors without touching anything', BROWSER, async () => {
  const cdp = await browserPage();
  const { result } = await inPage(cdp, pageAct, {
    steps: [{ label: 'Export billing', action: 'click' }],
    answer: 'none',
  });
  assert.equal(result.ok, false);
  assert.match(result.steps[0].error, /no control labeled/);
});

test('query lists choices and sections, with options', BROWSER, async () => {
  const cdp = await browserPage();
  const roles = await inPage(cdp, pageQuery, { text: 'Role' });
  assert.equal(roles.length, 2);
  const ana = roles.find((entry) => entry.label === 'Role for Ana');
  assert.deepEqual(ana.options.map((option) => option.label), ['Owner', 'Admin', 'Member', 'Viewer']);

  const inNotifications = await inPage(cdp, pageQuery, { within: 'Notifications' });
  assert.deepEqual(inNotifications.map((entry) => entry.kind), ['checkbox', 'checkbox']);
});

test('the lists are capped with a more count', BROWSER, async () => {
  const cdp = await browserPage();
  const added = await inPage(cdp, pageAddControls, 120);
  assert.ok(added >= 120);
  try {
    const shot = await inPage(cdp, pageSnapshot);
    assert.equal(shot.length, 101);
    const last = shot.at(-1);
    assert.equal(last.kind, 'more');
    assert.ok(last.more > 0);

    const inputs = await inPage(cdp, pageQuery, { kind: 'input' });
    assert.equal(inputs.length, 51);
    assert.equal(inputs.at(-1).kind, 'more');
  } finally {
    await inPage(cdp, pageRemoveControls);
  }
});
