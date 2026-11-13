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
      // Every call has a time limit, so a call the browser never answers (for example one
      // sent while a page is being replaced) fails fast with a sentence instead of hanging.
      send(method, params = {}, ms = 15000) {
        const id = ++nextId;
        ws.send(JSON.stringify({ id, method, params }));
        return new Promise((res, rej) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            rej(new Error(`devtools call ${method} got no answer in ${ms} ms`));
          }, ms);
          pending.set(id, {
            resolve: (value) => { clearTimeout(timer); res(value); },
            reject: (error) => { clearTimeout(timer); rej(error); },
          });
        });
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

// The leak guard. Every page this file opens wraps AgentPage before the page loads it, so
// every snapshot, act and query result (and every error a query throws) is checked against
// strings planted inside hidden or secret marks. Any test whose agent output carries one
// fails, so a new return path that skips the gate is caught by whichever test reaches it.
// No test ever sends these strings itself.
const PLANTED = [
  'PLANTED', 'whsec-fixture-0001', 'pw-fixture-0002', '4242 4242 4242 4242', 'ledger-fixture-0003',
  'sk-fixture-0101', 'KEY-TEXT-0102', 'KEY-TEXT-0104', 'region-secret-0105', 'REGION-SECRET-0106',
  'region-hidden-0107', 'TOKEN-CHILD-0109', 'SUBMIT-SECRET-0110', 'LABELLEDBY-SECRET-0111',
  'LABELLEDBY-HIDDEN-0112', 'LABEL-HIDDEN-0113', 'VAULT-SECRET-0114',
  // The dropdown page: choices that exist only while a list is open.
  'vault-alpha-0201', 'Hidden color',
];

const GUARD_SOURCE = `(() => {
  const planted = ${JSON.stringify(PLANTED)};
  const check = (value, where) => {
    const text = JSON.stringify(value) || '';
    for (const item of planted) {
      if (text.includes(item)) throw new Error('agent page leaked ' + item + ' through ' + where);
    }
    return value;
  };
  const guardRejection = (where) => (error) => {
    check(String(error && error.message), where);
    throw error;
  };
  let api;
  Object.defineProperty(window, 'AgentPage', {
    configurable: true,
    get() { return api; },
    set(real) {
      api = Object.assign({}, real, {
        __guarded: true,
        createAgent(options) {
          const agent = real.createAgent(options);
          return {
            snapshot: () => check(agent.snapshot(), 'snapshot'),
            act: (input, more) => agent.act(input, more).then((r) => check(r, 'act'), guardRejection('act')),
            query: (input) => agent.query(input).then((r) => check(r, 'query'), guardRejection('query')),
          };
        },
      });
    },
  });
  window.__agentGuard = { check };
})();`;

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
    await session.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: GUARD_SOURCE });
    // Headless Chrome has no focused window, so focus() would never fire focus events.
    // Emulate a focused page, the way a person's browser is, so focus handlers run.
    await session.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
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

const BROWSER = { skip: SKIP, timeout: 60000 };

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

// The edge-case page holds the cases review found: secrets in choices and labels, marked
// choices, form-attribute buttons, refusing selects, multiple selects, and parts the file
// cannot read. Each test loads it fresh, so no test depends on another.
const EDGE = path.join(__dirname, 'fixtures', 'agent-page', 'edge-cases.html');
let edgeLoads = 0;

// Loads a fixture fresh. Each poll has a short limit, and a load that stalls is asked for once
// more, so one slow navigation cannot hang the rest of the file.
async function loadFixture(file, what) {
  const cdp = await browserPage();
  for (let attempt = 1; ; attempt++) {
    const url = `${pathToFileURL(file).href}?load=${++edgeLoads}`;
    let seen = null;
    try {
      await cdp.send('Page.navigate', { url });
      await waitFor(async () => {
        const result = await cdp.send('Runtime.evaluate', {
          expression: '({ href: location.href, ready: document.readyState, agent: typeof window.AgentPage })',
          returnByValue: true,
        }, 2000);
        seen = result.result && result.result.value;
        return seen && seen.href === url && seen.ready === 'complete' && seen.agent === 'object';
      }, 15000, what);
      return cdp;
    } catch (error) {
      if (attempt >= 2) throw new Error(`${error.message}; last seen ${JSON.stringify(seen)}`);
    }
  }
}

async function edgePage() {
  return loadFixture(EDGE, 'the edge-case page to load');
}

const edgeCounts = () => window.__counts;

const MARKERS = [
  'sk-fixture-0101', 'KEY-TEXT-0102', 'sk-fixture-0103', 'KEY-TEXT-0104', 'region-secret-0105',
  'REGION-SECRET-0106', 'region-hidden-0107', 'REGION-HIDDEN-0108', 'TOKEN-CHILD-0109',
  'SUBMIT-SECRET-0110', 'LABELLEDBY-SECRET-0111', 'LABELLEDBY-HIDDEN-0112', 'LABEL-HIDDEN-0113',
  'VAULT-SECRET-0114',
];

test('secret and hidden text never leaks through options, labels, query, or errors', BROWSER, async () => {
  const cdp = await edgePage();
  const seen = await inPage(cdp, async () => {
    const agent = window.AgentPage.createAgent({});
    return {
      snapshot: agent.snapshot(),
      all: await agent.query({}),
      probe: await agent.query({ text: 'KEY-TEXT-0102' }),
      probeRegion: await agent.query({ text: 'REGION-SECRET-0106' }),
      badKey: await agent.act({ steps: [{ label: 'Signing key', action: 'set', args: { value: 'nope' } }] }),
      badRegion: await agent.act({ steps: [{ label: 'Region', action: 'set', args: { value: 'nope' } }] }),
      badVault: await agent.act({ steps: [{ label: 'Vaults', action: 'set', args: { value: 'nope' } }] }),
      goodKey: await agent.act({ steps: [{ label: 'Signing key', action: 'set', args: { value: 'sk-fixture-0103' } }] }),
      hiddenRegion: await agent.act({ steps: [{ label: 'Region', action: 'set', args: { value: 'REGION-HIDDEN-0108' } }] }),
      regionValue: document.querySelector('[aria-label="Secrets"] label select').value,
    };
  });
  // goodKey and hiddenRegion send a marker themselves, so only that one marker may come back.
  const { goodKey, hiddenRegion, ...readBack } = seen;
  const text = JSON.stringify(readBack);
  for (const marker of MARKERS) {
    assert.equal(text.includes(marker), false, `${marker} must not reach the agent`);
  }
  for (const [result, sent] of [[goodKey, 'sk-fixture-0103'], [hiddenRegion, 'REGION-HIDDEN-0108']]) {
    for (const marker of MARKERS.filter((item) => item !== sent)) {
      assert.equal(JSON.stringify(result).includes(marker), false, `${marker} must not come back after a set`);
    }
  }
  assert.equal(goodKey.ok, true, JSON.stringify(goodKey));
  const controls = (list) => list.filter((entry) => entry.kind !== 'unread');
  assert.deepEqual(controls(seen.probe), [], 'a secret choice is not a search oracle');
  assert.deepEqual(controls(seen.probeRegion), []);
  assert.equal(hiddenRegion.ok, false, 'a hidden choice cannot be picked');
  assert.match(hiddenRegion.steps[0].error, /no choice matches/);
  assert.equal(seen.regionValue, 'west');
  const byLabel = (label) => seen.snapshot.find((entry) => entry.label === label);
  assert.ok(byLabel('Run'), 'the button keeps its readable words');
  assert.ok(byLabel('Open vault'), 'a secret aria-labelledby falls back to the readable text');
  assert.ok(byLabel('Fallback name'), 'a hidden aria-labelledby falls back to the readable text');
  assert.ok(byLabel('Plain field'), 'a hidden label element is skipped');
});

test('a hidden or confirm-marked choice is never picked without the person', BROWSER, async () => {
  const cdp = await edgePage();
  const seen = await inPage(cdp, async () => {
    const calls = [];
    const plain = window.AgentPage.createAgent({});
    const asking = window.AgentPage.createAgent({ allow: (request) => { calls.push(request); return !request.confirm; } });
    return {
      listed: (await plain.query({ text: 'Cleanup mode' }))[0].options.map((option) => option.label),
      shred: await plain.act({ steps: [{ label: 'Cleanup mode', action: 'set', args: { value: 'Shred' } }] }),
      purgeAlone: await plain.act({ steps: [{ label: 'Cleanup mode', action: 'set', args: { value: 'Purge' } }] }),
      purgeAsked: await asking.act({ steps: [{ label: 'Cleanup mode', action: 'set', args: { value: 'Purge' } }] }),
      compress: await plain.act({ steps: [{ label: 'Cleanup mode', action: 'set', args: { value: 'Compress' } }] }),
      retention: await plain.act({ steps: [{ label: 'Retention', action: 'set', args: { value: '1 day' } }] }),
      retentionValue: document.querySelector('[aria-label="Retention"]').value,
      calls,
      picked: window.__counts.picked,
    };
  });
  assert.equal(seen.listed.includes('Shred'), false, 'a hidden choice is not listed');
  assert.equal(seen.shred.ok, false);
  assert.match(seen.shred.steps[0].error, /no choice matches/);
  assert.equal(seen.purgeAlone.ok, false);
  assert.match(seen.purgeAlone.steps[0].error, /needs a person/);
  assert.equal(seen.purgeAsked.ok, false);
  assert.equal(seen.calls.length, 1);
  assert.equal(seen.calls[0].confirm, true, 'the person is told the choice is marked');
  assert.match(seen.calls[0].reason, /Purging deletes every file/);
  assert.equal(seen.compress.ok, false);
  assert.match(seen.compress.steps[0].error, /disabled/);
  assert.equal(seen.retention.ok, false);
  assert.match(seen.retention.steps[0].error, /needs a person/);
  assert.equal(seen.retentionValue, '30');
  assert.deepEqual(seen.picked, {}, 'no marked, hidden, or disabled choice was clicked');
});

test('a button tied to a confirm form by the form attribute needs the person', BROWSER, async () => {
  const cdp = await edgePage();
  const seen = await inPage(cdp, async () => {
    const agent = window.AgentPage.createAgent({});
    return {
      entry: agent.snapshot().find((item) => item.label === 'Close account'),
      act: await agent.act({ steps: [{ label: 'Close account', action: 'click' }] }),
    };
  });
  assert.equal(seen.entry.confirm, true);
  assert.equal(seen.act.ok, false);
  assert.match(seen.act.steps[0].error, /needs a person/);
  assert.equal((await inPage(cdp, edgeCounts)).submitted, 0, 'the form was not sent');
});

test('a confirm mark added while the person is deciding still counts', BROWSER, async () => {
  const cdp = await edgePage();
  const act = await inPage(cdp, async () => {
    const agent = window.AgentPage.createAgent({
      allow: async (request) => {
        document.getElementById('publish').setAttribute('data-agent-confirm', 'Publishing is now public.');
        return !request.confirm;
      },
    });
    return agent.act({ steps: [{ label: 'Publish draft', action: 'click' }] });
  });
  assert.equal(act.ok, false);
  assert.match(act.steps[0].error, /marked for a person/);
  assert.equal((await inPage(cdp, edgeCounts)).published, 0, 'the press did not happen');
});

test('a select the page refuses is reported as not kept', BROWSER, async () => {
  const cdp = await edgePage();
  const act = await inPage(cdp, () => window.AgentPage.createAgent({})
    .act({ steps: [{ label: 'Plan', action: 'set', args: { value: 'Team' } }] }));
  assert.equal(act.ok, false, JSON.stringify(act));
  assert.match(act.steps[0].error, /did not keep/);
  assert.equal(act.steps[0].current.value, 'Free');
});

test('disabled choices and disabled or read-only controls are refused with a sentence', BROWSER, async () => {
  const cdp = await edgePage();
  const seen = await inPage(cdp, async () => {
    const agent = window.AgentPage.createAgent({});
    const set = (label, value) => agent.act({ steps: [{ label, action: 'set', args: { value } }] });
    return {
      fifty: await set('Seat count', 'Fifty'),
      hundred: await set('Seat count', 'Hundred'),
      seats: document.getElementById('seats').value,
      workspace: await set('Workspace id', 'ws-2'),
      legacy: await set('Legacy field', 'x'),
      workspaceEntry: agent.snapshot().find((item) => item.label === 'Workspace id'),
    };
  });
  assert.equal(seen.fifty.ok, false);
  assert.match(seen.fifty.steps[0].error, /"Fifty" is disabled/);
  assert.equal(seen.hundred.ok, false);
  assert.match(seen.hundred.steps[0].error, /is disabled/);
  assert.equal(seen.seats, 'one');
  assert.match(seen.workspace.steps[0].error, /"Workspace id" is read-only/);
  assert.match(seen.legacy.steps[0].error, /"Legacy field" is disabled/);
  assert.equal(seen.workspaceEntry.readonly, true);
});

test('a multiple select shows every choice and set never clears others silently', BROWSER, async () => {
  const cdp = await edgePage();
  const seen = await inPage(cdp, async () => {
    const agent = window.AgentPage.createAgent({});
    const selected = () => Array.from(document.getElementById('channels').selectedOptions, (option) => option.value);
    const set = (value) => agent.act({ steps: [{ label: 'Channels', action: 'set', args: { value } }] });
    const entry = agent.snapshot().find((item) => item.label === 'Channels');
    const single = await set('Phone');
    const afterSingle = selected();
    const fax = await set(['Email', 'Fax']);
    const all = await set(['Email', 'Chat', 'Phone']);
    const afterAll = selected();
    const narrow = await set(['Email']);
    return { entry, single, afterSingle, fax, all, afterAll, narrow, afterNarrow: selected() };
  });
  assert.equal(seen.entry.multiple, true);
  assert.deepEqual(seen.entry.value, ['Email', 'Chat']);
  assert.equal(seen.single.ok, false, 'one value would clear the others, so it is refused');
  assert.match(seen.single.steps[0].error, /full list/);
  assert.deepEqual(seen.afterSingle, ['email', 'chat']);
  assert.equal(seen.fax.ok, false);
  assert.match(seen.fax.steps[0].error, /disabled/);
  assert.equal(seen.all.ok, true, JSON.stringify(seen.all));
  assert.deepEqual(seen.afterAll, ['email', 'chat', 'phone']);
  assert.deepEqual(seen.all.steps[0].current.value, ['Email', 'Chat', 'Phone']);
  assert.equal(seen.narrow.ok, true, 'a full list may clear choices on purpose');
  assert.deepEqual(seen.narrow.steps[0].changes[0].to, ['Email']);
  assert.deepEqual(seen.afterNarrow, ['email']);
});

test('snapshot and query report frames, shadow parts, and editable regions they did not read', BROWSER, async () => {
  const cdp = await edgePage();
  const seen = await inPage(cdp, async () => {
    const agent = window.AgentPage.createAgent({});
    return { snapshot: agent.snapshot(), query: await agent.query({ within: 'Unreadable' }) };
  });
  for (const list of [seen.snapshot, seen.query]) {
    const unread = Object.fromEntries(list.filter((item) => item.kind === 'unread').map((item) => [item.what, item]));
    for (const what of ['frame', 'shadow', 'closed', 'editable']) {
      assert.ok(unread[what], `${what} is reported: ${JSON.stringify(list)}`);
      assert.equal(unread[what].count, 1);
      assert.match(unread[what].label, /not read|cannot read/);
    }
  }
});

// Round two. Each test writes a small page into the sandbox fixture and drives it.
const SANDBOX = path.join(__dirname, 'fixtures', 'agent-page', 'sandbox.html');

async function sandbox(html) {
  const cdp = await loadFixture(SANDBOX, 'the sandbox page to load');
  await inPage(cdp, (markup) => {
    document.getElementById('sandbox').innerHTML = markup;
    return true;
  }, html);
  return cdp;
}

test('the leak guard is on for every page and catches a planted string', BROWSER, async () => {
  const cdp = await sandbox('<button type="button">Plain</button>');
  const seen = await inPage(cdp, () => {
    let caught = '';
    try {
      window.__agentGuard.check({ label: 'PLANTED-SELF-TEST' }, 'self test');
    } catch (error) {
      caught = error.message;
    }
    return { guarded: window.AgentPage.__guarded === true, caught };
  });
  assert.equal(seen.guarded, true, 'AgentPage is wrapped by the guard');
  assert.match(seen.caught, /agent page leaked PLANTED through self test/);
});

test('a control hidden by the step itself leaves only its ref in the result', BROWSER, async () => {
  const cdp = await sandbox(
    '<input aria-label="Field" onchange="this.setAttribute(\'data-agent-hidden\', \'\'); this.value = \'PLANTED-HIDDEN-NEW\'">' +
    '<input aria-label="Token" value="PLANTED-BEFORE-HIDE">' +
    '<button type="button" onclick="document.querySelector(\'[aria-label=Token]\').setAttribute(\'data-agent-hidden\', \'\')">Hide token</button>'
  );
  const seen = await inPage(cdp, async () => {
    const agent = window.AgentPage.createAgent({});
    return {
      set: await agent.act({ steps: [{ label: 'Field', action: 'set', args: { value: 'public' } }] }),
      hide: await agent.act({ steps: [{ label: 'Hide token', action: 'click' }] }),
    };
  });
  assert.equal('current' in seen.set.steps[0], false, 'no current value for a control that is hidden now');
  assert.deepEqual(seen.set.steps[0].changes, [{ ref: seen.set.steps[0].ref, removed: true }]);
  assert.equal(seen.hide.ok, true);
  const hidden = seen.hide.steps[0].changes;
  assert.equal(hidden.length, 1);
  assert.deepEqual(Object.keys(hidden[0]).sort(), ['ref', 'removed'], 'a control hidden by the press is reported by ref only');
});

test('a secret control shows its name only, never its placeholder, title, state, or earlier value', BROWSER, async () => {
  const cdp = await sandbox(
    '<input data-agent-secret placeholder="PLANTED-PLACEHOLDER">' +
    '<input data-agent-secret title="PLANTED-TITLE">' +
    '<label>Card pin <input data-agent-secret type="text" title="PLANTED-TITLE-TWO"></label>' +
    '<button type="button" data-agent-secret aria-label="Reveal key">PLANTED-BUTTON-TEXT</button>' +
    '<label data-agent-secret>Remember device <input type="checkbox" checked></label>' +
    '<fieldset data-agent-secret><legend>Plan</legend>' +
    '<label>Basic <input type="radio" name="plan" checked></label><label>Pro <input type="radio" name="plan"></label></fieldset>' +
    '<details data-agent-secret open><summary aria-label="Recovery codes">PLANTED-SUMMARY</summary><p>x</p></details>' +
    '<input aria-label="Token" value="PLANTED-BEFORE-LOCK">' +
    '<button type="button" onclick="document.querySelector(\'[aria-label=Token]\').setAttribute(\'data-agent-secret\', \'\')">Lock</button>'
  );
  const seen = await inPage(cdp, async () => {
    // Lock first: until then the token field is public, and showing its value is right.
    const agent = window.AgentPage.createAgent({});
    const lock = await agent.act({ steps: [{ label: 'Lock', action: 'click' }] });
    return { lock, snapshot: agent.snapshot(), query: await agent.query({}) };
  });
  const byLabel = (label) => seen.snapshot.find((entry) => entry.label === label);
  assert.equal(byLabel('Card pin').value, '[redacted]', 'a label element names a secret control');
  assert.ok(byLabel('Reveal key'), 'aria-label names a secret control');
  const device = byLabel('Remember device');
  assert.equal(device.checked, '[redacted]');
  assert.deepEqual(device.actions, ['check', 'uncheck'], 'actions do not give away the state');
  for (const label of ['Basic', 'Pro']) {
    assert.equal(byLabel(label).checked, '[redacted]');
    assert.deepEqual(byLabel(label).actions, ['check']);
  }
  assert.equal(byLabel('Recovery codes').open, '[redacted]');
  assert.deepEqual(seen.lock.steps[0].changes, [], 'a value that became secret is not shown as from');
});

test('clearing a confirm-marked choice or radio needs the person, and the sentence is theirs', BROWSER, async () => {
  const cdp = await sandbox(
    '<select aria-label="Plan tier"><option value="a" selected data-agent-confirm="Leaving the legacy plan is permanent.">Legacy</option>' +
    '<option value="b">Modern</option></select>' +
    '<div role="listbox" aria-label="Region pick">' +
    '<div role="option" aria-selected="true" data-agent-confirm="Moving regions resets data.">East</div>' +
    '<div role="option" onclick="this.previousElementSibling.setAttribute(\'aria-selected\', \'false\'); this.setAttribute(\'aria-selected\', \'true\')">West</div></div>' +
    '<label>Protected <input type="radio" name="tier" checked data-agent-confirm="Dropping protection exposes files."></label>' +
    '<label>Open <input type="radio" name="tier"></label>'
  );
  const seen = await inPage(cdp, async () => {
    const calls = [];
    const plain = window.AgentPage.createAgent({});
    const asking = window.AgentPage.createAgent({ allow: (request) => { calls.push(request.reason); return false; } });
    const steps = [
      { label: 'Plan tier', action: 'set', args: { value: 'Modern' } },
      { label: 'Region pick', action: 'set', args: { value: 'West' } },
      { label: 'Open', action: 'check' },
    ];
    const alone = [];
    for (const step of steps) alone.push(await plain.act({ steps: [step] }));
    for (const step of steps) await asking.act({ steps: [step] });
    return {
      alone,
      calls,
      tier: document.querySelector('select').value,
      region: document.querySelector('[role=option]').getAttribute('aria-selected'),
      radio: document.querySelector('input[name=tier]').checked,
    };
  });
  for (const result of seen.alone) {
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.match(result.steps[0].error, /needs a person/);
  }
  assert.match(seen.calls[0], /Leaving the legacy plan is permanent/);
  assert.match(seen.calls[1], /Moving regions resets data/);
  assert.match(seen.calls[2], /Dropping protection exposes files/);
  assert.equal(seen.tier, 'a');
  assert.equal(seen.region, 'true');
  assert.equal(seen.radio, true);
});

test('a confirm mark on the label of a control counts', BROWSER, async () => {
  const cdp = await sandbox(
    '<label for="sub" data-agent-confirm="Subscribing sends weekly mail.">Subscribe</label><input id="sub" type="checkbox">'
  );
  const seen = await inPage(cdp, async () => {
    const agent = window.AgentPage.createAgent({});
    return {
      entry: agent.snapshot().find((item) => item.label === 'Subscribe'),
      act: await agent.act({ steps: [{ label: 'Subscribe', action: 'check' }] }),
      checked: document.getElementById('sub').checked,
    };
  });
  assert.equal(seen.entry.confirm, true);
  assert.equal(seen.act.ok, false);
  assert.match(seen.act.steps[0].error, /needs a person/);
  assert.equal(seen.checked, false);
});

test('an approval is refused when the marks change while the person decides', BROWSER, async () => {
  const cdp = await sandbox(
    '<div data-agent-confirm="Approve save" id="save-zone"><button type="button" id="go" onclick="window.__ran = \'moved\'">Continue</button></div>' +
    '<div data-agent-confirm="Approve delete" id="delete-zone"></div>' +
    '<button type="button" id="swap" data-agent-confirm="Approve save" onclick="window.__ran = \'replaced\'">Proceed</button>' +
    '<button type="button" id="drop" data-agent-confirm="Approve save" onclick="window.__ran = \'removed\'">Finish</button>'
  );
  const seen = await inPage(cdp, async () => {
    window.__ran = '';
    const run = (label, change) => window.AgentPage.createAgent({
      allow: () => { change(); return true; },
    }).act({ steps: [{ label, action: 'click' }] });
    return {
      moved: await run('Continue', () => document.getElementById('delete-zone').append(document.getElementById('go'))),
      replaced: await run('Proceed', () => document.getElementById('swap').setAttribute('data-agent-confirm', 'Approve delete')),
      removed: await run('Finish', () => document.getElementById('drop').removeAttribute('data-agent-confirm')),
      ran: window.__ran,
    };
  });
  for (const name of ['moved', 'replaced', 'removed']) {
    assert.equal(seen[name].ok, false, `${name}: ${JSON.stringify(seen[name])}`);
    assert.match(seen[name].steps[0].error, /changed while the person was deciding/);
  }
  assert.equal(seen.ran, '', 'nothing ran under a warning the person did not see');
});

test('a press that should open or close something says not ok when it did not', BROWSER, async () => {
  const cdp = await sandbox(
    '<details><summary onclick="event.preventDefault()">More options</summary><p>Inside</p></details>' +
    '<details><summary>Advanced</summary><p>Inside</p></details>' +
    '<button type="button" aria-expanded="false">Menu</button>' +
    '<button type="button" aria-expanded="false" onclick="this.setAttribute(\'aria-expanded\', \'true\')">Filters</button>'
  );
  const seen = await inPage(cdp, async () => {
    const agent = window.AgentPage.createAgent({});
    const press = (label) => agent.act({ steps: [{ label, action: 'click' }] });
    return { stopped: await press('More options'), opens: await press('Advanced'), stuck: await press('Menu'), toggles: await press('Filters') };
  });
  assert.equal(seen.stopped.ok, false);
  assert.match(seen.stopped.steps[0].error, /did not open/);
  assert.equal(seen.opens.ok, true, JSON.stringify(seen.opens));
  assert.equal(seen.opens.steps[0].current.open, true);
  assert.equal(seen.stuck.ok, false);
  assert.match(seen.stuck.steps[0].error, /did not open/);
  assert.equal(seen.toggles.ok, true, JSON.stringify(seen.toggles));
});

test('an error from the allow callback is reported with a fixed sentence', BROWSER, async () => {
  const cdp = await sandbox(
    '<input data-agent-secret aria-label="Token" value="PLANTED-ERROR"><button type="button">Run</button>'
  );
  const seen = await inPage(cdp, async () => {
    const out = {};
    for (const mode of ['throw', 'reject', 'null']) {
      const agent = window.AgentPage.createAgent({
        allow: () => {
          if (mode === 'null') throw null;
          const error = new Error(document.querySelector('input').value);
          if (mode === 'throw') throw error;
          return Promise.reject(error);
        },
      });
      try {
        out[mode] = await agent.act({ steps: [{ label: 'Run', action: 'click' }] });
      } catch (error) {
        out[mode] = { rejected: String(error && error.message) };
      }
    }
    return out;
  });
  for (const mode of ['throw', 'reject', 'null']) {
    assert.equal(seen[mode].ok, false, `${mode}: ${JSON.stringify(seen[mode])}`);
    assert.equal(seen[mode].steps[0].error, 'the confirmation failed, so nothing was changed. Ask the person again.');
  }
});

test('while one step waits on the person, other agents on the page cannot act', BROWSER, async () => {
  const cdp = await sandbox(
    '<button type="button" data-agent-confirm="Deletes the account." onclick="window.__deleted = (window.__deleted || 0) + 1">Delete account</button>' +
    '<button type="button" onclick="window.__refreshed = (window.__refreshed || 0) + 1">Refresh</button>'
  );
  const seen = await inPage(cdp, async () => {
    const first = window.AgentPage.createAgent({
      timeout: 300,
      allow: () => new Promise((resolve) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'Confirm deletion';
        button.onclick = () => resolve(true);
        document.getElementById('sandbox').append(button);
      }),
    });
    const pending = first.act({ steps: [{ label: 'Delete account', action: 'click' }] });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = window.AgentPage.createAgent({});
    const sneak = await second.act({ steps: [{ label: 'Confirm deletion', action: 'click' }] });
    const dangerous = await pending;
    const after = await second.act({ steps: [{ label: 'Refresh', action: 'click' }] });
    return { sneak, dangerous, after, deleted: window.__deleted || 0, refreshed: window.__refreshed || 0 };
  });
  assert.equal(seen.sneak.ok, false, JSON.stringify(seen.sneak));
  assert.match(seen.sneak.error, /waiting for the person/);
  assert.equal(seen.dangerous.ok, false);
  assert.match(seen.dangerous.steps[0].error, /no answer/);
  assert.equal(seen.deleted, 0);
  assert.equal(seen.after.ok, true, 'once the wait ends, other agents can act again');
  assert.equal(seen.refreshed, 1);
});

test('query finds a choice past the cap when text is given', BROWSER, async () => {
  const cdp = await sandbox('<select aria-label="Lots"></select>');
  const seen = await inPage(cdp, async () => {
    document.querySelector('select').innerHTML =
      Array.from({ length: 60 }, (_, i) => `<option>Option ${i}</option>`).join('');
    const agent = window.AgentPage.createAgent({});
    return { found: await agent.query({ text: 'Option 59' }), all: await agent.query({ text: 'Lots' }) };
  });
  assert.equal(seen.found.length, 1);
  assert.deepEqual(seen.found[0].options.map((option) => option.label), ['Option 59']);
  assert.equal(seen.all[0].options.length, 51, 'without matching text the choices stay capped');
});

// Round three.
test('a removed or now-hidden control is reported by ref only', BROWSER, async () => {
  const cdp = await sandbox(
    '<input type="submit" value="PLANTED-REMOVED">' +
    '<button type="button" onclick="const i = document.querySelector(\'input\'); i.setAttribute(\'data-agent-secret\', \'\'); i.remove()">Lock</button>' +
    '<div id="region"><input type="submit" value="PLANTED-HIDDEN-REMOVED"></div>' +
    '<button type="button" onclick="const p = document.getElementById(\'region\'); p.setAttribute(\'data-agent-hidden\', \'\'); p.firstChild.remove()">Hide</button>' +
    '<input type="submit" id="fade" value="PLANTED-FADED">' +
    '<button type="button" onclick="document.getElementById(\'fade\').setAttribute(\'data-agent-hidden\', \'\')">Fade</button>'
  );
  const seen = await inPage(cdp, async () => {
    const agent = window.AgentPage.createAgent({});
    const press = (label) => agent.act({ steps: [{ label, action: 'click' }] });
    return { lock: await press('Lock'), hide: await press('Hide'), fade: await press('Fade') };
  });
  for (const name of ['lock', 'hide', 'fade']) {
    const changes = seen[name].steps[0].changes;
    assert.equal(changes.length, 1, `${name}: ${JSON.stringify(changes)}`);
    assert.deepEqual(Object.keys(changes[0]).sort(), ['ref', 'removed'], `${name} is reported by ref only`);
  }
});

test('choices hidden by css or the hidden attribute are never listed or counted', BROWSER, async () => {
  const cdp = await sandbox(
    '<div role="listbox" aria-label="Plan">' +
    '<div role="option" style="display:none" aria-selected="true">PLANTED-CSS-HIDDEN</div>' +
    '<div role="option" hidden>PLANTED-HTML-HIDDEN</div><div role="option">Public</div></div>' +
    '<select aria-label="Native"><option hidden>PLANTED-NATIVE-HIDDEN</option>' +
    '<option style="display:none">PLANTED-NATIVE-CSS</option><option>Open</option></select>'
  );
  const seen = await inPage(cdp, async () => {
    const agent = window.AgentPage.createAgent({});
    return {
      all: await agent.query({}),
      missing: await agent.act({ steps: [{ label: 'Plan', action: 'set', args: { value: 'nope' } }] }),
    };
  });
  const plan = seen.all.find((entry) => entry.label === 'Plan');
  const native = seen.all.find((entry) => entry.label === 'Native');
  assert.deepEqual(plan.options.map((option) => option.label), ['Public']);
  assert.equal(plan.value, '', 'a hidden selected choice is not the value');
  assert.deepEqual(native.options.map((option) => option.label), ['Open']);
  assert.match(seen.missing.steps[0].error, /Choices: "Public"\.$/, 'no count of hidden choices');
});

test('clearing a hidden confirm-marked selection needs the person', BROWSER, async () => {
  const cdp = await sandbox(
    '<select aria-label="Plan"><option selected data-agent-hidden data-agent-confirm="Do not leave">Private</option>' +
    '<option>Public</option></select>'
  );
  const seen = await inPage(cdp, async () => ({
    result: await window.AgentPage.createAgent({}).act({ steps: [{ label: 'Plan', action: 'set', args: { value: 'Public' } }] }),
    selected: Array.from(document.querySelectorAll('option'), (option) => option.selected),
  }));
  assert.equal(seen.result.ok, false, JSON.stringify(seen.result));
  assert.match(seen.result.steps[0].error, /needs a person/);
  assert.deepEqual(seen.selected, [true, false]);
});

test('a confirm mark on the label of a radio being cleared counts', BROWSER, async () => {
  const cdp = await sandbox(
    '<label for="p" data-agent-confirm="Clearing needs approval">Protected</label><input id="p" type="radio" name="r" checked>' +
    '<label>Public <input type="radio" name="r"></label>'
  );
  const seen = await inPage(cdp, async () => ({
    result: await window.AgentPage.createAgent({}).act({ steps: [{ label: 'Public', action: 'check' }] }),
    checked: Array.from(document.querySelectorAll('input'), (input) => input.checked),
  }));
  assert.equal(seen.result.ok, false, JSON.stringify(seen.result));
  assert.match(seen.result.steps[0].error, /needs a person/);
  assert.deepEqual(seen.checked, [true, false]);
});

test('a reset or submit button involves every field in its form', BROWSER, async () => {
  const cdp = await sandbox(
    '<form id="one"><input aria-label="Protected" value="initial" data-agent-confirm="Change needs approval">' +
    '<button type="reset">Reset</button></form>' +
    '<form id="two" onsubmit="event.preventDefault(); window.__sent = (window.__sent || 0) + 1">' +
    '<label for="amount" data-agent-confirm="Sending moves money">Amount</label><input id="amount" value="10">' +
    '<button>Send</button></form>'
  );
  const seen = await inPage(cdp, async () => {
    document.querySelector('[aria-label=Protected]').value = 'edited';
    const agent = window.AgentPage.createAgent({});
    return {
      reset: await agent.act({ steps: [{ label: 'Reset', action: 'click' }] }),
      send: await agent.act({ steps: [{ label: 'Send', action: 'click' }] }),
      value: document.querySelector('[aria-label=Protected]').value,
      sent: window.__sent || 0,
    };
  });
  assert.equal(seen.reset.ok, false, JSON.stringify(seen.reset));
  assert.match(seen.reset.steps[0].error, /needs a person/);
  assert.equal(seen.value, 'edited');
  assert.equal(seen.send.ok, false, JSON.stringify(seen.send));
  assert.match(seen.send.steps[0].error, /needs a person/);
  assert.equal(seen.sent, 0);
});

test('a mark that appears in the middle of a step stops the rest', BROWSER, async () => {
  const cdp = await sandbox(
    '<input aria-label="Name" value="old" onfocus="this.setAttribute(\'data-agent-confirm\', \'Typing requires approval now\')">' +
    '<div role="listbox" aria-label="Plan" aria-multiselectable="true">' +
    '<div role="option" onclick="this.setAttribute(\'aria-selected\', \'true\'); this.nextElementSibling.setAttribute(\'data-agent-confirm\', \'Second choice needs a person\')">A</div>' +
    '<div role="option" onclick="this.setAttribute(\'aria-selected\', \'true\')">B</div></div>'
  );
  const seen = await inPage(cdp, async () => {
    const agent = window.AgentPage.createAgent({});
    return {
      typed: await agent.act({ steps: [{ label: 'Name', action: 'set', args: { value: 'new' } }] }),
      picked: await agent.act({ steps: [{ label: 'Plan', action: 'set', args: { value: ['A', 'B'] } }] }),
      value: document.querySelector('input').value,
      selected: Array.from(document.querySelectorAll('[role=option]'), (item) => item.getAttribute('aria-selected')),
    };
  });
  for (const name of ['typed', 'picked']) {
    assert.equal(seen[name].ok, false, `${name}: ${JSON.stringify(seen[name])}`);
    assert.match(seen[name].steps[0].error, /needs a person/);
  }
  assert.equal(seen.value, 'old', 'the value was not written');
  assert.deepEqual(seen.selected, ['true', null], 'the second choice was not picked');
});

test('a control replaced during the change is checked again in the live page', BROWSER, async () => {
  const cdp = await sandbox(
    '<input aria-label="Name" value="old" onchange="const n = this.cloneNode(); n.value = \'old\'; n.removeAttribute(\'onchange\'); this.replaceWith(n)">' +
    '<select aria-label="Plan" onchange="const n = this.cloneNode(true); n.value = \'a\'; n.removeAttribute(\'onchange\'); this.replaceWith(n)">' +
    '<option value="a">A</option><option value="b">B</option></select>' +
    '<input aria-label="City" onchange="const n = this.cloneNode(); n.value = this.value; n.removeAttribute(\'onchange\'); this.replaceWith(n)">'
  );
  const seen = await inPage(cdp, async () => {
    const agent = window.AgentPage.createAgent({});
    const set = (label, value) => agent.act({ steps: [{ label, action: 'set', args: { value } }] });
    return { name: await set('Name', 'new'), plan: await set('Plan', 'B'), city: await set('City', 'Lima') };
  });
  assert.equal(seen.name.ok, false, JSON.stringify(seen.name));
  assert.match(seen.name.steps[0].error, /did not keep/);
  assert.equal(seen.plan.ok, false, JSON.stringify(seen.plan));
  assert.match(seen.plan.steps[0].error, /did not keep/);
  assert.equal(seen.city.ok, true, JSON.stringify(seen.city));
  assert.equal(seen.city.steps[0].current.value, 'Lima', 'the result reads the replacement');
});

// Round four: dropdowns. A list that shows only while open: select-only and editable
// comboboxes and menu buttons, with the list inline, in a separate container, or in the top layer.
const DROPDOWNS = path.join(__dirname, 'fixtures', 'agent-page', 'dropdowns.html');

async function dropdownPage() {
  return loadFixture(DROPDOWNS, 'the dropdown page to load');
}

test('a select-only combobox shows its value, takes set by label or value, lists its choices, and is left closed', BROWSER, async () => {
  const cdp = await dropdownPage();
  const seen = await inPage(cdp, async () => {
    const agent = window.AgentPage.createAgent({});
    const shut = (id) => {
      const list = document.getElementById(id + '-list');
      return { expanded: document.getElementById(id).getAttribute('aria-expanded'), shown: !!list && list.getClientRects().length > 0 };
    };
    const ids = ['fruit', 'color', 'size'];
    const states = () => Object.fromEntries(ids.map((id) => [id, shut(id)]));
    document.getElementById('notes').focus();
    const entry = (label) => agent.snapshot().find((item) => item.label === label);
    const before = { fruit: entry('Fruit'), color: entry('Color'), size: entry('Size') };
    const query = {};
    for (const label of ['Fruit', 'Color', 'Size']) query[label] = (await agent.query({ text: label })).find((item) => item.label === label);
    const afterQuery = { states: states(), focus: document.activeElement.id };
    const set = (label, value) => agent.act({ steps: [{ label, action: 'set', args: { value } }] });
    const results = { fruit: await set('Fruit', 'Cherry'), color: await set('Color', 'color-blue'), size: await set('Size', 'large') };
    return { before, query, afterQuery, results, after: states(), focus: document.activeElement.id, values: window.__state.values };
  });
  assert.deepEqual(
    { kind: seen.before.fruit.kind, value: seen.before.fruit.value, actions: seen.before.fruit.actions, popup: seen.before.fruit.popup },
    { kind: 'combobox', value: 'Apple', actions: ['set'], popup: 'listbox' },
  );
  assert.equal(seen.before.color.value, 'Red');
  assert.equal(seen.before.size.value, 'Small');
  const labels = (entry) => entry.options.map((option) => option.label);
  assert.deepEqual(labels(seen.query.Fruit), ['Apple', 'Banana', 'Cherry', 'Durian', 'Elderberry'], 'an inline list is read');
  assert.deepEqual(labels(seen.query.Color), ['Red', 'Green', 'Blue'], 'a list made only while open is read');
  assert.deepEqual(labels(seen.query.Size), ['Small', 'Medium', 'Large'], 'a top-layer list is read');
  const fruit = Object.fromEntries(seen.query.Fruit.options.map((option) => [option.label, option]));
  assert.equal(fruit.Apple.selected, true);
  assert.equal(fruit.Cherry.value, 'cherry');
  assert.equal(fruit.Durian.confirm, true);
  assert.equal(fruit.Elderberry.disabled, true);
  for (const id of ['fruit', 'color', 'size']) {
    assert.deepEqual(seen.afterQuery.states[id], { expanded: 'false', shown: false }, `${id} closed again after the read`);
    assert.deepEqual(seen.after[id], { expanded: 'false', shown: false }, `${id} closed again after the pick`);
  }
  assert.equal(seen.afterQuery.focus, 'notes', 'focus went back after the read');
  assert.equal(seen.focus, 'notes', 'focus went back after the pick');
  for (const [name, value] of [['fruit', 'Cherry'], ['color', 'Blue'], ['size', 'Large']]) {
    const result = seen.results[name];
    assert.equal(result.ok, true, `${name}: ${JSON.stringify(result)}`);
    assert.equal(result.steps[0].current.value, value);
    assert.ok(result.steps[0].changes.some((change) => change.field === 'value' && change.to === value), JSON.stringify(result.steps[0].changes));
  }
  assert.deepEqual([seen.values.fruit, seen.values.color, seen.values.size], ['cherry', 'color-blue', 'large']);
});

test('an editable combobox shows its value, takes set by label or value, lists its choices, and is left closed', BROWSER, async () => {
  const cdp = await dropdownPage();
  const seen = await inPage(cdp, async () => {
    const agent = window.AgentPage.createAgent({});
    document.getElementById('notes').focus();
    const entry = agent.snapshot().find((item) => item.label === 'City');
    const city = (await agent.query({ text: 'City' })).find((item) => item.label === 'City');
    const country = (await agent.query({ text: 'Country' })).find((item) => item.label === 'Country');
    const set = (label, value) => agent.act({ steps: [{ label, action: 'set', args: { value } }] });
    const picked = { city: await set('City', 'Quito'), country: await set('Country', 'chile') };
    return {
      entry, city, country, picked,
      inputs: { city: document.getElementById('city').value, country: document.getElementById('country').value },
      expanded: ['city', 'country'].map((id) => document.getElementById(id).getAttribute('aria-expanded')),
      lists: [!!document.getElementById('city-list').getClientRects().length, !!document.getElementById('country-list')],
      focus: document.activeElement.id,
      values: window.__state.values,
    };
  });
  assert.deepEqual(
    { kind: seen.entry.kind, value: seen.entry.value, actions: seen.entry.actions, popup: seen.entry.popup },
    { kind: 'combobox', value: 'Lima', actions: ['set'], popup: 'listbox' },
  );
  assert.deepEqual(seen.city.options.map((option) => option.label), ['Lima', 'Oslo', 'Quito']);
  assert.deepEqual(seen.country.options.map((option) => option.label), ['Peru', 'Chile']);
  assert.equal(seen.picked.city.ok, true, JSON.stringify(seen.picked.city));
  assert.equal(seen.picked.country.ok, true, JSON.stringify(seen.picked.country));
  assert.equal(seen.picked.country.steps[0].current.value, 'Chile');
  assert.deepEqual(seen.inputs, { city: 'Quito', country: 'Chile' });
  assert.deepEqual([seen.values.city, seen.values.country], ['quito', 'chile']);
  assert.deepEqual(seen.expanded, ['false', 'false']);
  assert.deepEqual(seen.lists, [false, false], 'both lists are closed again');
  assert.equal(seen.focus, 'notes');
});

test('opening a list goes through the in gate: a mark on the control, its label, its form, or a choice needs the person first', BROWSER, async () => {
  const cdp = await dropdownPage();
  const seen = await inPage(cdp, async () => {
    const calls = [];
    const plain = window.AgentPage.createAgent({});
    const asking = (answer) => window.AgentPage.createAgent({
      allow: (request) => {
        calls.push({
          label: request.label, action: request.action, confirm: request.confirm, reasons: request.reasons,
          opens: Object.assign({}, window.__state.opens),
          planOpen: document.getElementById('plan').getAttribute('aria-expanded'),
        });
        return answer(request);
      },
    });
    const set = (agent, label, value) => agent.act({ steps: [{ label, action: 'set', args: { value } }] });
    const out = {};
    out.danger = await set(plain, 'Danger level', 'High');
    out.shipping = await set(plain, 'Shipping', 'Air');
    out.billing = await set(plain, 'Billing cycle', 'Yearly');
    out.durian = await set(plain, 'Fruit', 'Durian');
    out.dangerQuery = (await plain.query({ text: 'Danger level' })).find((item) => item.label === 'Danger level');
    out.opensAfterMarked = Object.assign({}, window.__state.opens);
    out.enterprise = await set(plain, 'Plan', 'Enterprise');
    out.planAfterRefusal = { opens: window.__state.opens.plan, expanded: document.getElementById('plan').getAttribute('aria-expanded'), list: !!document.getElementById('plan-list') };
    const firstCall = calls.length;
    out.enterpriseNo = await set(asking((request) => !request.confirm), 'Plan', 'Enterprise');
    out.noCalls = calls.slice(firstCall);
    const secondCall = calls.length;
    out.enterpriseYes = await set(asking(() => true), 'Plan', 'Enterprise');
    out.yesCalls = calls.slice(secondCall);
    const thirdCall = calls.length;
    out.dangerYes = await set(asking(() => true), 'Danger level', 'High');
    out.dangerCalls = calls.slice(thirdCall);
    const fourthCall = calls.length;
    out.sizeRead = (await asking(() => true).query({ text: 'Size' })).find((item) => item.label === 'Size');
    out.sizeCalls = calls.slice(fourthCall);
    out.values = window.__state.values;
    return out;
  });
  for (const name of ['danger', 'shipping', 'billing', 'durian']) {
    assert.equal(seen[name].ok, false, `${name}: ${JSON.stringify(seen[name])}`);
    assert.match(seen[name].steps[0].error, /needs a person/);
  }
  assert.equal(seen.dangerQuery.confirm, true);
  assert.equal(seen.dangerQuery.options, undefined, 'a marked list is not opened to read without the person');
  assert.match(seen.dangerQuery.note, /needs a person/);
  assert.deepEqual(seen.opensAfterMarked, {}, 'nothing opened under a mark the person did not see');

  assert.equal(seen.enterprise.ok, false, JSON.stringify(seen.enterprise));
  assert.match(seen.enterprise.steps[0].error, /needs a person/);
  assert.deepEqual(seen.planAfterRefusal, { opens: 1, expanded: 'false', list: false }, 'a mark seen only once open closes the list again');

  assert.equal(seen.enterpriseNo.ok, false);
  assert.match(seen.enterpriseNo.steps[0].error, /did not confirm/);
  assert.deepEqual(seen.noCalls.map((call) => call.confirm), [false, true], 'the person is asked again once the marked choice is seen');
  assert.deepEqual(seen.noCalls[1].reasons, ['Enterprise is billed yearly.']);
  assert.equal(seen.noCalls[1].planOpen, 'false', 'the list is closed while the person decides');

  assert.equal(seen.enterpriseYes.ok, true, JSON.stringify(seen.enterpriseYes));
  assert.equal(seen.yesCalls.length, 2);
  assert.equal(seen.values.plan, 'enterprise');

  assert.equal(seen.dangerYes.ok, true, JSON.stringify(seen.dangerYes));
  assert.equal(seen.dangerCalls[0].confirm, true);
  assert.equal(seen.dangerCalls[0].opens.danger, undefined, 'the person was asked before the list opened');
  assert.equal(seen.values.danger, 'high');

  assert.deepEqual(seen.sizeRead.options.map((option) => option.label), ['Small', 'Medium', 'Large']);
  assert.equal(seen.sizeCalls.length, 1, 'opening to read is a change, so the person is asked');
  assert.equal(seen.sizeCalls[0].action, 'open');
  assert.equal(seen.sizeCalls[0].opens.size, undefined, 'asked before the list opened');
  assert.equal(seen.values.shipping, 'ground');
  assert.equal(seen.values.billing, 'monthly');
  assert.equal(seen.values.fruit, 'apple');
});

test('a menu button presses an item by name inside a closed menu and leaves it closed', BROWSER, async () => {
  const cdp = await dropdownPage();
  const seen = await inPage(cdp, async () => {
    const plain = window.AgentPage.createAgent({});
    const yes = window.AgentPage.createAgent({ allow: () => true });
    const press = (agent, label, item) => agent.act({ steps: [{ label, action: 'click', args: { item } }] });
    document.getElementById('notes').focus();
    const out = {};
    out.entry = plain.snapshot().find((item) => item.label === 'Project actions');
    out.items = (await plain.query({ text: 'Project actions' })).find((item) => item.label === 'Project actions');
    out.more = (await plain.query({ text: 'More' })).find((item) => item.label === 'More');
    out.duplicate = await press(plain, 'Project actions', 'Duplicate');
    out.exported = await press(plain, 'More', 'export');
    const opensBeforeDelete = window.__state.opens.actions;
    out.remove = await press(plain, 'Project actions', 'Delete');
    out.deleteOpened = window.__state.opens.actions - opensBeforeDelete;
    out.erase = await press(plain, 'More', 'Erase');
    out.eraseYes = await press(yes, 'More', 'Erase');
    out.missing = await press(plain, 'More', 'Nope');
    out.notMenu = await press(plain, 'Fruit', 'Apple');
    out.actions = window.__state.actions;
    out.closed = ['actions', 'more'].map((id) => document.getElementById(id).getAttribute('aria-expanded'));
    out.moreControls = document.getElementById('more').hasAttribute('aria-controls');
    out.focus = document.activeElement.id;
    return out;
  });
  assert.deepEqual({ kind: seen.entry.kind, actions: seen.entry.actions, popup: seen.entry.popup }, { kind: 'button', actions: ['click'], popup: 'menu' });
  assert.deepEqual(seen.items.options.map((option) => option.label), ['Rename', 'Duplicate', 'Delete']);
  assert.equal(seen.items.options[2].confirm, true);
  assert.deepEqual(seen.more.options.map((option) => option.label), ['Export', 'Erase']);
  assert.equal(seen.duplicate.ok, true, JSON.stringify(seen.duplicate));
  assert.equal(seen.exported.ok, true, JSON.stringify(seen.exported));
  assert.equal(seen.remove.ok, false);
  assert.match(seen.remove.steps[0].error, /needs a person/);
  assert.equal(seen.deleteOpened, 0, 'a marked item seen while closed stops the step before the menu opens');
  assert.equal(seen.erase.ok, false);
  assert.match(seen.erase.steps[0].error, /needs a person/);
  assert.equal(seen.eraseYes.ok, true, JSON.stringify(seen.eraseYes));
  assert.equal(seen.missing.ok, false);
  assert.match(seen.missing.steps[0].error, /no item matches "Nope"\. Items: "Export", "Erase"\./);
  assert.equal(seen.notMenu.ok, false);
  assert.match(seen.notMenu.steps[0].error, /only a menu button/);
  assert.deepEqual(seen.actions, ['actions:duplicate', 'more:export', 'more:erase']);
  assert.deepEqual(seen.closed, ['false', 'false']);
  assert.equal(seen.moreControls, false, 'the menu that names its list only while open is closed again');
  assert.equal(seen.focus, 'notes');
});

test('hidden choices that exist only while open are never listed or picked, and a secret list never shows its choices', BROWSER, async () => {
  const cdp = await dropdownPage();
  const seen = await inPage(cdp, async () => {
    const agent = window.AgentPage.createAgent({});
    const set = (label, value) => agent.act({ steps: [{ label, action: 'set', args: { value } }] });
    const out = {};
    out.color = (await agent.query({ text: 'Color' })).find((item) => item.label === 'Color');
    out.hiddenPick = await set('Color', 'hidden-color-0401');
    out.city = (await agent.query({ text: 'City' })).find((item) => item.label === 'City');
    out.more = (await agent.query({ text: 'More' })).find((item) => item.label === 'More');
    out.vaultEntry = agent.snapshot().find((item) => item.label === 'Vault');
    out.vaultQuery = (await agent.query({ text: 'Vault' })).find((item) => item.label === 'Vault');
    out.vaultMiss = await set('Vault', 'nope');
    out.vaultPick = await set('Vault', 'vault-beta-0202');
    // A person opens the secret lists themselves: their choices still never reach the agent.
    window.__widgets.vault.open();
    window.__widgets.keys.open();
    out.openSnapshot = agent.snapshot();
    out.openQuery = await agent.query({});
    out.openVault = (await agent.query({ text: 'Vault' })).find((item) => item.label === 'Vault');
    window.__widgets.vault.close();
    window.__widgets.keys.close();
    out.rotate = await agent.act({ steps: [{ label: 'Key tools', action: 'click', args: { item: 'rotate-0301' } }] });
    out.values = window.__state.values;
    out.actions = window.__state.actions;
    return out;
  });
  assert.deepEqual(seen.color.options.map((option) => option.label), ['Red', 'Green', 'Blue']);
  assert.equal(seen.hiddenPick.ok, false);
  assert.match(seen.hiddenPick.steps[0].error, /no choice matches "hidden-color-0401"\. Choices: "Red", "Green", "Blue"\.$/);
  assert.equal(seen.values.color, 'color-red');
  assert.deepEqual(seen.city.options.map((option) => option.label), ['Lima', 'Oslo', 'Quito']);
  assert.deepEqual(seen.more.options.map((option) => option.label), ['Export', 'Erase']);

  assert.equal(seen.vaultEntry.value, '[redacted]');
  assert.equal(seen.vaultEntry.secret, true);
  assert.equal(seen.vaultQuery.options, undefined, 'a secret list shows no choices');
  assert.equal(seen.vaultMiss.ok, false);
  assert.match(seen.vaultMiss.steps[0].error, /The choices are secret\./);
  assert.equal(seen.vaultPick.ok, true, JSON.stringify(seen.vaultPick));
  assert.equal(seen.vaultPick.steps[0].current.value, '[redacted]');
  assert.equal(seen.values.vault, 'vault-beta-0202');
  assert.equal(seen.openVault.options, undefined);
  const leaked = JSON.stringify([seen.vaultEntry, seen.vaultQuery, seen.vaultMiss, seen.vaultPick, seen.openSnapshot, seen.openQuery, seen.openVault, seen.rotate]);
  for (const text of ['vault-alpha-0201', 'vault-beta-0202', 'rotate-0301', 'PLANTED']) {
    assert.equal(leaked.includes(text), false, `${text} must not reach the agent`);
  }
  assert.equal(seen.rotate.ok, true, JSON.stringify(seen.rotate));
  assert.deepEqual(seen.actions, ['keys:rotate'], 'a secret menu item the agent already knows can still be pressed');
});

test('set on a list says ok only when the value changed in the live page after the list closed', BROWSER, async () => {
  const cdp = await dropdownPage();
  const seen = await inPage(cdp, async () => {
    const agent = window.AgentPage.createAgent({});
    const set = (label, value) => agent.act({ steps: [{ label, action: 'set', args: { value } }] });
    return {
      refused: await set('Locked tier', 'Pro'),
      disabled: await set('Fruit', 'Elderberry'),
      same: await set('Fruit', 'Apple'),
      expanded: document.getElementById('locked').getAttribute('aria-expanded'),
      opens: window.__state.opens,
      values: window.__state.values,
    };
  });
  assert.equal(seen.refused.ok, false, JSON.stringify(seen.refused));
  assert.equal(seen.refused.steps[0].error, 'the page did not keep the new choice.');
  assert.equal(seen.refused.steps[0].current.value, 'Basic');
  assert.equal(seen.expanded, 'false');
  assert.equal(seen.values.locked, 'basic');
  assert.equal(seen.disabled.ok, false);
  assert.match(seen.disabled.steps[0].error, /"Elderberry" is disabled/);
  assert.equal(seen.same.ok, true, 'a choice already in place needs no change');
  assert.deepEqual(seen.same.steps[0].changes, []);
  assert.equal(seen.values.fruit, 'apple');
});

test('choices rendered elsewhere are found through aria-controls or aria-owns, not by ancestry', BROWSER, async () => {
  const cdp = await dropdownPage();
  const seen = await inPage(cdp, async () => {
    const agent = window.AgentPage.createAgent({});
    const set = (label, value) => agent.act({ steps: [{ label, action: 'set', args: { value } }] });
    return {
      theme: (await agent.query({ text: 'Theme' })).find((item) => item.label === 'Theme'),
      decoy: await set('Theme', 'Decoy preset'),
      dark: await set('Theme', 'Dark'),
      input: document.getElementById('theme').value,
      decoySelected: document.querySelector('#theme-decoy [role=option]').getAttribute('aria-selected'),
      inField: document.getElementById('theme-field').contains(document.getElementById('theme-decoy')),
    };
  });
  assert.equal(seen.inField, true, 'the decoy list sits inside the field');
  assert.deepEqual(seen.theme.options.map((option) => option.label), ['Light', 'Dark']);
  assert.equal(seen.decoy.ok, false);
  assert.match(seen.decoy.steps[0].error, /no choice matches/);
  assert.equal(seen.dark.ok, true, JSON.stringify(seen.dark));
  assert.equal(seen.input, 'Dark');
  assert.equal(seen.decoySelected, null, 'the decoy was not touched');
});

// Round five: review findings on the dropdown paths.
test('opening a list never sends a form: a submit-type trigger involves its form, and a read does not open it', BROWSER, async () => {
  const cdp = await dropdownPage();
  const seen = await inPage(cdp, async () => {
    const sent = { marked: 0, plain: 0 };
    for (const [id, marked] of [['marked', true], ['plain', false]]) {
      const form = document.createElement('form');
      form.id = id + '-form';
      form.innerHTML = '<input name="field" value="private"' + (marked ? ' data-agent-confirm="Sending this field needs a person."' : '') + '>';
      form.addEventListener('submit', (event) => { event.preventDefault(); sent[id]++; });
      document.body.append(form);
      window.widget({ id: id + '-pick', label: id === 'marked' ? 'Marked send' : 'Plain send', type: 'select', place: 'portal', lazy: true,
        value: 'old', parent: form.id, options: [{ label: 'Old', value: 'old' }, { label: 'Next', value: 'next' }] });
      document.getElementById(id + '-pick').removeAttribute('type');
    }
    const agent = window.AgentPage.createAgent({});
    const out = {};
    out.snapshot = agent.snapshot().filter((item) => /send/.test(item.label));
    out.queryMarked = (await agent.query({ text: 'Marked send' })).find((item) => item.label === 'Marked send');
    out.queryPlain = (await agent.query({ text: 'Plain send' })).find((item) => item.label === 'Plain send');
    out.afterReads = Object.assign({}, sent);
    out.opensAfterReads = Object.assign({}, window.__state.opens);
    out.setMarked = await agent.act({ steps: [{ label: 'Marked send', action: 'set', args: { value: 'Next' } }] });
    out.sent = sent;
    return out;
  });
  assert.deepEqual(seen.afterReads, { marked: 0, plain: 0 }, 'a read never sends a form');
  assert.deepEqual(seen.opensAfterReads, {}, 'a read does not open a list whose opening could send a form');
  for (const entry of [seen.queryMarked, seen.queryPlain]) {
    assert.equal(entry.options, undefined);
    assert.match(entry.note, /could send a form or leave the page/);
  }
  assert.equal(seen.snapshot.find((item) => item.label === 'Marked send').confirm, true, 'the form fields count for the trigger');
  assert.equal(seen.setMarked.ok, false, JSON.stringify(seen.setMarked));
  assert.match(seen.setMarked.steps[0].error, /needs a person/);
  assert.equal(seen.sent.marked, 0, 'the marked form was not sent');
});

test('a query builds every entry at return, after the last answer from the person', BROWSER, async () => {
  const cdp = await dropdownPage();
  const seen = await inPage(cdp, async () => {
    window.widget({ id: 'audit-first', label: 'Audit first', type: 'select', place: 'inline', value: 'old', options: [
      { label: 'PLANTED-FIRST-VALUE', value: 'old' }, { label: 'Spare', value: 'spare' }] });
    window.widget({ id: 'audit-second', label: 'Audit second', type: 'select', place: 'inline', value: 'one', options: [
      { label: 'One', value: 'one' }, { label: 'PLANTED-LATER-HIDDEN', value: 'two' }] });
    window.widget({ id: 'audit-third', label: 'Audit third', type: 'select', place: 'portal', lazy: true, value: 'x', options: [
      { label: 'Ex', value: 'x' }] });
    const agent = window.AgentPage.createAgent({
      allow: (request) => {
        if (request.label === 'Audit third') {
          document.getElementById('audit-first').setAttribute('data-agent-secret', '');
          document.querySelector('#audit-second-list [data-value="two"]').setAttribute('data-agent-hidden', '');
        }
        return true;
      },
    });
    return agent.query({ text: 'Audit' });
  });
  const byLabel = (label) => seen.find((item) => item.label === label);
  assert.equal(byLabel('Audit first').value, '[redacted]', 'a control made secret during the call reads [redacted] at return');
  assert.equal(byLabel('Audit first').options, undefined, 'and its choices are not returned');
  assert.deepEqual(byLabel('Audit second').options.map((option) => option.label), ['One'], 'a choice hidden during the call is dropped at return');
  assert.deepEqual(byLabel('Audit third').options.map((option) => option.label), ['Ex']);
});

test('a secret or hidden chosen choice keeps the value secret, however it was named', BROWSER, async () => {
  const cdp = await dropdownPage();
  const seen = await inPage(cdp, async () => {
    window.widget({ id: 'secret-pick', label: 'Secret pick', type: 'select', place: 'portal', lazy: true, value: 'old', options: [
      { label: 'Old', value: 'old' }, { label: 'PLANTED-SECRET-CHOICE', value: 'next', attrs: { 'data-agent-secret': '' } }] });
    window.widget({ id: 'secret-edit', label: 'Secret edit', type: 'edit', place: 'portal', lazy: true, value: 'old', options: [
      { label: 'Old', value: 'old' }, { label: 'PLANTED-SECRET-TYPED', value: 'typed', attrs: { 'data-agent-secret': '' } }] });
    window.widget({ id: 'hidden-pick', label: 'Hidden pick', type: 'select', place: 'inline', value: 'gone', options: [
      { label: 'Shown', value: 'shown' }, { label: 'PLANTED-HIDDEN-CHOSEN', value: 'gone', attrs: { 'data-agent-hidden': '' } }] });
    const agent = window.AgentPage.createAgent({});
    const set = (label, value) => agent.act({ steps: [{ label, action: 'set', args: { value } }] });
    const pick = await set('Secret pick', 'next');
    const edit = await set('Secret edit', 'typed');
    const shot = agent.snapshot();
    const query = await agent.query({ text: 'Hidden pick' });
    return { pick, edit, shot, query, values: window.__state.values };
  });
  assert.equal(seen.pick.ok, true, JSON.stringify(seen.pick));
  assert.equal(seen.pick.steps[0].current.value, '[redacted]');
  assert.deepEqual(seen.pick.steps[0].changes.map((change) => [change.from, change.to]), [['Old', '[redacted]']]);
  assert.equal(seen.edit.ok, true, JSON.stringify(seen.edit));
  assert.equal(seen.edit.steps[0].current.value, '[redacted]');
  const byLabel = (label) => seen.shot.find((item) => item.label === label);
  assert.equal(byLabel('Secret pick').value, '[redacted]', 'a later snapshot still hides it');
  assert.equal(byLabel('Secret edit').value, '[redacted]');
  assert.equal(byLabel('Hidden pick').value, '', 'a hidden chosen choice is not the value');
  assert.equal(seen.query.find((item) => item.label === 'Hidden pick').value, '');
  assert.deepEqual([seen.values['secret-pick'], seen.values['secret-edit']], ['next', 'typed']);
});

test('set is judged by the chosen option, never by a value that equals another label', BROWSER, async () => {
  const cdp = await dropdownPage();
  const seen = await inPage(cdp, async () => {
    window.widget({ id: 'tricky-refuse', label: 'Tricky refuse', type: 'select', place: 'portal', lazy: true, value: 'old', refuse: true,
      options: [{ label: 'Basic', value: 'old' }, { label: 'Pro', value: 'Basic' }] });
    window.widget({ id: 'tricky-pick', label: 'Tricky pick', type: 'select', place: 'portal', lazy: true, value: 'basic-label',
      options: [{ label: 'Starter', value: 'starter' }, { label: 'Basic', value: 'basic-label' }, { label: 'Plus', value: 'Starter' }] });
    const agent = window.AgentPage.createAgent({});
    const set = (label, value) => agent.act({ steps: [{ label, action: 'set', args: { value } }] });
    return { refused: await set('Tricky refuse', 'Pro'), picked: await set('Tricky pick', 'Starter'), values: window.__state.values };
  });
  assert.equal(seen.refused.ok, false, JSON.stringify(seen.refused));
  assert.equal(seen.refused.steps[0].error, 'the page did not keep the new choice.');
  assert.equal(seen.values['tricky-refuse'], 'old');
  assert.equal(seen.picked.ok, true, JSON.stringify(seen.picked));
  assert.equal(seen.values['tricky-pick'], 'starter', 'the label wins over another choice\'s value');
  assert.match(seen.picked.steps[0].note, /matches the label of one choice and the value of another\. The label was used\./);
});

test('two agents on one page cannot open the same list at once', BROWSER, async () => {
  const cdp = await dropdownPage();
  const seen = await inPage(cdp, async () => {
    document.getElementById('notes').focus();
    const agents = [window.AgentPage.createAgent({}), window.AgentPage.createAgent({})];
    const results = await Promise.all(agents.map((agent, i) => agent.act({ steps: [{ label: 'Fruit', action: 'set', args: { value: i ? 'Cherry' : 'Banana' } }] })));
    return { results, focus: document.activeElement.id, open: document.getElementById('fruit').getAttribute('aria-expanded'), value: window.__state.values.fruit };
  });
  const oks = seen.results.filter((result) => result.ok);
  assert.equal(oks.length, 1, JSON.stringify(seen.results));
  const refused = seen.results.find((result) => !result.ok);
  assert.match(refused.steps[0].error, /another step on this page is using a list/);
  assert.equal(seen.open, 'false');
  assert.equal(seen.focus, 'notes');
});
