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

// The edge-case page holds the cases review found: secrets in choices and labels, marked
// choices, form-attribute buttons, refusing selects, multiple selects, and parts the file
// cannot read. Each test loads it fresh, so no test depends on another.
const EDGE = path.join(__dirname, 'fixtures', 'agent-page', 'edge-cases.html');
let edgeLoads = 0;

async function edgePage() {
  const cdp = await browserPage();
  const url = `${pathToFileURL(EDGE).href}?load=${++edgeLoads}`;
  await cdp.send('Page.navigate', { url });
  await waitFor(async () => {
    const state = await inPage(cdp, () => ({ href: location.href, ready: document.readyState }));
    return state.href === url && state.ready === 'complete';
  }, 20000, 'the edge-case page to load');
  return cdp;
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
