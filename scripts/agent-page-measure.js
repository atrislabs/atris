#!/usr/bin/env node
// Agent page measure: how much does an AI agent have to read, and how many steps does it
// need, to do one task on a web page?
//
// It loads a page in headless Chrome (node built-ins only, over the DevTools protocol) and
// runs one fixed task three ways, with every step written out in TASKS below:
//
//   agent page          snapshot, then one act with all the steps (lib/agent-page.js)
//   accessibility tree  the full accessibility tree before the task and again after every
//                       action, acting by node. This is what a typical browser tool hands a model.
//   raw page            document.body.outerHTML before the task and again after every action,
//                       acting by selector.
//
// For each way it counts the calls a model would make and the characters that come back to
// it. It does not run a model. The plan is fixed, so the numbers are about reading and steps,
// not a real model's time or cost. No screenshots are involved anywhere.
//
// Usage:
//   node scripts/agent-page-measure.js [url] [--task settings|forms] [--json] [--verbose]
//
//   url        the page to load. Default: the project settings fixture. A file path works too.
//   --task     which written-out task to run. settings (default) is the project settings task.
//              forms is the same shape of task for the React forms gallery in atris-design
//              (type into an input, pick a select option, flip a switch, press a button).
//   --json     print the numbers as JSON
//   --verbose  also list every call and how many characters it returned
//
// ATRIS_CHROME_PATH picks the Chrome to use; otherwise it is found the way the browser tests do.
// Exit code 0 means all three ways finished the task and ended in the expected state.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { isDeepStrictEqual } = require('node:util');
const { findChrome } = require('./gm-phone-trace');
const { makeProfileDir, removeProfileDir, headlessArgs } = require('../lib/headless-chrome');
const agentPageFile = require('../lib/agent-page');

const FIXTURE = path.join(__dirname, '..', 'test', 'fixtures', 'agent-page', 'project-settings.html');
const AGENT_PAGE_FILE = path.join(__dirname, '..', 'lib', 'agent-page.js');

const DISCLAIMER = 'this measures how much an agent reads and how many steps it takes, with a fixed plan. ' +
  'it does not measure a real model\'s time or cost.';
const NO_SCREENSHOTS = 'no screenshots are involved in any of the three ways. ' +
  'tools that work from screenshots cost more and are not measured here.';
const ACK = 'done'; // what an action call says back, besides the page it returns

// ---- the tasks, written out ---------------------------------------------------------------
//
// Each task is the same four moves: type into an input, choose from a select, turn on one
// control, press save. The plan is written once per way so nothing is hidden. Functions that
// run inside the page (ready, readState) are sent as source text, so they use no outside names.

const TASKS = {
  settings: {
    title: 'rename the project, change one member\'s role, turn on one notification, save',
    ready: () => !!document.querySelector('#project-name') && !!window.__settings,
    // The page's own state, read by the script to prove the task finished. The model never sees it.
    readState: () => {
      const s = window.__settings;
      return {
        project_name: s.projectName,
        ben_role: s.members.Ben,
        weekly_digest: s.digest,
        saves: s.saves,
        status: document.getElementById('status').textContent,
      };
    },
    expected: { project_name: 'Atlas Garden', ben_role: 'Admin', weekly_digest: true, saves: 1, status: 'Saved Atlas Garden.' },

    // Agent page: one act with every step. Controls are named by their label.
    agentPage: [
      { label: 'Project name', action: 'set', args: { value: 'Atlas Garden' } },
      { label: 'Role for Ben', action: 'set', args: { value: 'Admin' } },
      { label: 'Weekly digest', action: 'check' },
      { label: 'Save', action: 'click' },
    ],

    // Accessibility tree: one action per call, each naming a node by its role and name.
    tree: [
      { do: 'type', role: 'textbox', name: 'Project name', text: 'Atlas Garden' },
      { do: 'select', role: 'combobox', name: 'Role for Ben', option: 'Admin' },
      { do: 'click', role: 'checkbox', name: 'Weekly digest' },
      { do: 'click', role: 'button', name: 'Save' },
    ],

    // Raw page: one action per call, each naming an element by a CSS selector read from the html.
    raw: [
      { do: 'type', selector: '#project-name', text: 'Atlas Garden' },
      { do: 'select', selector: '[data-member-role="Ben"]', option: 'Admin' },
      { do: 'click', selector: '#digest' },
      { do: 'click', selector: '#save' },
    ],
  },

  forms: {
    title: 'type into an input, pick a select option, flip a switch, press a button',
    // React has hydrated once its props sit on the DOM nodes, so a click reaches its handler.
    ready: () => {
      const input = document.querySelector('input[type="email"]');
      return !!input && Object.keys(input).some((key) => key.startsWith('__reactProps'));
    },
    readState: () => {
      const text = (id) => document.getElementById(id).textContent.trim();
      return {
        email: text('input-echo'),
        model: text('select-echo'),
        dark_sidebar: text('switch-echo'),
        save_draft: text('button-clicks'),
      };
    },
    expected: { email: 'ana@example.com', model: 'codex', dark_sidebar: 'dark sidebar on', save_draft: 'clicked 1 time' },

    agentPage: [
      { label: 'email', action: 'set', args: { value: 'ana@example.com' } },
      { label: 'model', action: 'set', args: { value: 'codex' } },
      { label: 'dark sidebar', action: 'check' },
      { label: 'save draft', action: 'click' },
    ],

    // The select is a button that opens a list, so choosing takes two actions here: open, then pick.
    tree: [
      { do: 'type', role: 'textbox', name: 'email', text: 'ana@example.com' },
      { do: 'click', role: 'combobox', name: 'model' },
      { do: 'click', role: 'option', name: 'codex' },
      { do: 'click', role: 'switch', name: 'dark sidebar' },
      { do: 'click', role: 'button', name: 'save draft' },
    ],

    raw: [
      { do: 'type', selector: 'input[type="email"]', text: 'ana@example.com' },
      { do: 'click', selector: 'button[data-agent-pick="model"]' },
      { do: 'click', selector: '[role="option"][data-index="1"]' },
      { do: 'click', selector: 'section[aria-labelledby="gallery-switch"] input[role="switch"]' },
      { do: 'click', selector: 'section[aria-labelledby="gallery-button"] button[data-tone="primary"]' },
    ],
  },
};

// ---- chrome and the DevTools protocol (the same approach as test/agent-page-browser.test.js) -----

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

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  return response.json();
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
      // Every browser call has a time limit, so a call the browser never answers fails with a sentence.
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

async function launchChrome(chromePath, profileDir) {
  const args = headlessArgs(profileDir, ['--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0']);
  // The Linux check machines run Chrome without its sandbox, as the browser tests do.
  if (process.platform === 'linux') args.push('--no-sandbox');
  args.push('about:blank');
  const child = spawn(chromePath, args, { stdio: 'ignore' });
  let launchError = null;
  child.on('error', (error) => { launchError = error; });
  const port = await waitFor(() => {
    if (launchError) throw launchError;
    if (child.exitCode !== null) throw new Error(`chrome exited with code ${child.exitCode}`);
    const file = path.join(profileDir, 'DevToolsActivePort');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n')[0].trim() : null;
  }, 20000, 'chrome to open its debugging port');
  return { child, port };
}

async function closeChrome(port, child) {
  try {
    const version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
    const browser = await connect(version.webSocketDebuggerUrl);
    // Browser.close may never answer, because the browser shuts its socket first.
    browser.send('Browser.close', {}, 2000).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 500));
    browser.close();
  } catch {
    // Chrome may already be gone; the kill below covers it.
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

// Runs a function inside the page. The function is sent as source text.
async function inPage(cdp, fn, arg = null, ms = 15000) {
  const expression = `(${fn.toString()})(${JSON.stringify(arg)})`;
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, ms);
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception && result.exceptionDetails.exception.description;
    throw new Error(detail || result.exceptionDetails.text);
  }
  return result.result.value;
}

async function loadPage(cdp, url, ready) {
  // A blank page first, so the next load is a fresh page, not a reload of the old one.
  await cdp.send('Page.navigate', { url: 'about:blank' });
  const navigated = await cdp.send('Page.navigate', { url });
  if (navigated.errorText) throw new Error(`could not load ${url}: ${navigated.errorText}`);
  await waitFor(async () => {
    const state = await inPage(cdp, () => ({ href: location.href, ready: document.readyState }));
    return state.href !== 'about:blank' && state.ready === 'complete' && inPage(cdp, ready);
  }, 60000, 'the page to load and be ready for the task');
}

// Gives the page a moment to draw what an action changed, the same for every way.
const settle = (cdp) => inPage(cdp, () => new Promise((resolve) => {
  const done = () => setTimeout(resolve, 50);
  requestAnimationFrame(() => requestAnimationFrame(done));
  setTimeout(resolve, 500);
}));

// ---- acting on a page the way a browser tool does: by real input events -------------------------

async function objectForNode(cdp, backendNodeId) {
  const { object } = await cdp.send('DOM.resolveNode', { backendNodeId });
  return object.objectId;
}

async function objectForSelector(cdp, selector) {
  const result = await cdp.send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(selector)})` });
  if (!result.result.objectId) throw new Error(`no element matches ${selector}`);
  return result.result.objectId;
}

async function click(cdp, objectId) {
  await cdp.send('DOM.scrollIntoViewIfNeeded', { objectId });
  const { model } = await cdp.send('DOM.getBoxModel', { objectId });
  const q = model.content;
  const x = (q[0] + q[2] + q[4] + q[6]) / 4;
  const y = (q[1] + q[3] + q[5] + q[7]) / 4;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

// Focus the field, select what is in it, and insert the new text as typing would.
async function type(cdp, objectId, text) {
  await cdp.send('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: 'function () { this.focus(); if (typeof this.select === "function") this.select(); }',
  });
  await cdp.send('Input.insertText', { text });
}

// A native select: choose the option by its text or value, then fire input and change.
async function selectOption(cdp, objectId, option) {
  const result = await cdp.send('Runtime.callFunctionOn', {
    objectId,
    returnByValue: true,
    arguments: [{ value: option }],
    functionDeclaration: `function (wanted) {
      var match = Array.prototype.find.call(this.options || [], function (o) { return o.text.trim() === wanted || o.value === wanted; });
      if (!match) return false;
      this.value = match.value;
      this.dispatchEvent(new Event('input', { bubbles: true }));
      this.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }`,
  });
  if (!result.result.value) throw new Error(`the select has no option ${option}`);
}

async function perform(cdp, objectId, step) {
  if (step.do === 'click') await click(cdp, objectId);
  else if (step.do === 'type') await type(cdp, objectId, step.text);
  else if (step.do === 'select') await selectOption(cdp, objectId, step.option);
  else throw new Error(`unknown action ${step.do}`);
  await settle(cdp);
}

// ---- reading the page the two other ways -------------------------------------------------------

// Left out of the tree: wrappers with no name, list bullets, and pieces of text that only repeat
// what their parent already says.
const BARE_ROLES = new Set(['none', 'generic', 'presentation', 'LabelText', 'Legend']);
const REPEATED_ROLES = new Set(['InlineTextBox', 'LineBreak', 'ListMarker']);
const STATES = ['checked', 'disabled', 'expanded', 'hasPopup', 'invalid', 'level', 'pressed', 'readonly', 'required', 'selected'];

// The full accessibility tree, written as one compact line per node, the way browser tools hand
// it to a model: [id] role "name" value, plus the states that are on. Ignored nodes are left out
// and their children move up. `lookup` is what the model would act on, by role and name.
async function readTree(cdp) {
  const { nodes } = await cdp.send('Accessibility.getFullAXTree');
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const lines = [];
  const lookup = [];
  const walk = (node, depth, parentTexts) => {
    const role = node.role && node.role.value;
    const name = node.name && node.name.value ? String(node.name.value) : '';
    const value = node.value && node.value.value !== undefined && node.value.value !== '' ? String(node.value.value) : '';
    const shown = !node.ignored && !REPEATED_ROLES.has(role) && !(BARE_ROLES.has(role) && !name) &&
      !(role === 'StaticText' && parentTexts.includes(name));
    if (shown) {
      let line = `${'  '.repeat(depth)}[${node.nodeId}] ${role}`;
      if (name) line += ` ${JSON.stringify(name)}`;
      if (value) line += ` value=${JSON.stringify(value)}`;
      for (const property of node.properties || []) {
        const on = property.value.value;
        if (!STATES.includes(property.name) || on === false || on === 'false') continue;
        line += on === true ? ` [${property.name}]` : ` [${property.name}=${on}]`;
      }
      lines.push(line);
      lookup.push({ id: node.nodeId, role, name, backendNodeId: node.backendDOMNodeId });
    }
    const texts = shown ? [name, value].filter(Boolean) : parentTexts;
    for (const childId of node.childIds || []) {
      const child = byId.get(childId);
      if (child) walk(child, shown ? depth + 1 : depth, texts);
    }
  };
  walk(nodes[0], 0, []);
  return { text: lines.join('\n'), lookup, protocolCharacters: JSON.stringify(nodes).length };
}

const readHtml = (cdp) => inPage(cdp, () => document.body.outerHTML);
const withoutScripts = (html) => html.replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<style\b[\s\S]*?<\/style>/gi, '');

// ---- the three ways ---------------------------------------------------------------------------

// One entry per call the model makes. `characters` is everything that call returned to it.
function newMeter() {
  const calls = [];
  return {
    calls,
    record(call, text, pageRead) { calls.push({ call, characters: text.length, page_read: pageRead }); },
  };
}

async function runAgentPage(cdp, task) {
  const meter = newMeter();
  // The page is meant to ship the file itself (a script tag). If it did not, load it here.
  const loaded = await inPage(cdp, () => !!window.AgentPage);
  if (!loaded) await cdp.send('Runtime.evaluate', { expression: fs.readFileSync(AGENT_PAGE_FILE, 'utf8') });
  await inPage(cdp, () => {
    window.__measureAgent = window.AgentPage.createAgent({});
    return true;
  });

  const snapshot = await inPage(cdp, () => JSON.stringify(window.__measureAgent.snapshot()));
  meter.record('page_snapshot', snapshot, true);

  const act = await inPage(cdp, (steps) => window.__measureAgent.act({ steps }).then((result) => JSON.stringify(result)), task.agentPage, 60000);
  meter.record('page_act (all steps)', act, false);
  const outcome = JSON.parse(act);
  if (!outcome.ok) throw new Error(`the agent page act did not finish: ${act}`);
  // Not counted: the act result already lists each step's new value. A cautious model might still
  // take one more snapshot to check, so its size is reported beside the table.
  const check = await inPage(cdp, () => JSON.stringify(window.__measureAgent.snapshot()));
  return { meter, final_snapshot_characters: check.length };
}

async function runTree(cdp, task) {
  const meter = newMeter();
  let last = await readTree(cdp);
  let protocolCharacters = last.protocolCharacters;
  meter.record('read accessibility tree', last.text, true);
  for (const step of task.tree) {
    const node = last.lookup.find((entry) => entry.role === step.role && entry.name === step.name);
    if (!node) throw new Error(`the accessibility tree has no ${step.role} named ${JSON.stringify(step.name)}`);
    await perform(cdp, await objectForNode(cdp, node.backendNodeId), step);
    last = await readTree(cdp);
    protocolCharacters += last.protocolCharacters;
    meter.record(`${step.do} ${step.role} ${JSON.stringify(step.name)}`, `${ACK}\n${last.text}`, true);
  }
  return { meter, protocol_json_characters: protocolCharacters };
}

async function runRaw(cdp, task) {
  const meter = newMeter();
  let html = await readHtml(cdp);
  let withoutScriptCharacters = withoutScripts(html).length;
  meter.record('read document.body.outerHTML', html, true);
  for (const step of task.raw) {
    await perform(cdp, await objectForSelector(cdp, step.selector), step);
    html = await readHtml(cdp);
    withoutScriptCharacters += withoutScripts(html).length;
    meter.record(`${step.do} ${step.selector}`, `${ACK}\n${html}`, true);
  }
  return { meter, characters_without_scripts_and_styles: withoutScriptCharacters };
}

const WAYS = [
  { name: 'agent page', run: runAgentPage },
  { name: 'accessibility tree', run: runTree },
  { name: 'raw page', run: runRaw },
];

async function measure(cdp, url, task) {
  const ways = [];
  for (const way of WAYS) {
    await loadPage(cdp, url, task.ready);
    let outcome = null;
    let error = null;
    try {
      outcome = await way.run(cdp, task);
    } catch (caught) {
      error = caught.message;
    }
    const calls = outcome ? outcome.meter.calls : [];
    const characters = calls.reduce((sum, call) => sum + call.characters, 0);
    let finalState = null;
    try {
      finalState = await inPage(cdp, task.readState);
    } catch (caught) {
      error = error || `could not read the final state: ${caught.message}`;
    }
    ways.push({
      way: way.name,
      calls: calls.length,
      page_reads: calls.filter((call) => call.page_read).length,
      characters_read: characters,
      rough_tokens: Math.round(characters / 4),
      completed: !error && isDeepStrictEqual(finalState, task.expected),
      error,
      final_state: finalState,
      per_call: calls.map(({ call, characters: size }) => ({ call, characters: size })),
      extra: outcome ? Object.fromEntries(Object.entries(outcome).filter(([key]) => key !== 'meter')) : {},
    });
  }
  return ways;
}

// ---- the report ------------------------------------------------------------------------------

const number = (value) => value.toLocaleString('en-US');

function buildReport(url, taskName, task, ways, toolDefinitionCharacters) {
  const tree = ways.find((way) => way.way === 'accessibility tree');
  const raw = ways.find((way) => way.way === 'raw page');
  const agent = ways.find((way) => way.way === 'agent page');
  const finalSnapshot = agent.extra.final_snapshot_characters;
  return {
    disclaimer: DISCLAIMER,
    screenshots: NO_SCREENSHOTS,
    page: url,
    task: taskName,
    task_description: task.title,
    rough_tokens_note: 'rough tokens are characters divided by 4, not a real tokenizer count',
    ways,
    expected_final_state: task.expected,
    all_ways_ended_in_the_expected_state: ways.every((way) => way.completed),
    side_numbers: {
      one_read_characters: Object.fromEntries(ways.map((way) => [way.way, way.per_call[0] ? way.per_call[0].characters : null])),
      agent_page_with_a_final_snapshot: finalSnapshot === undefined ? null : {
        calls: agent.calls + 1,
        characters_read: agent.characters_read + finalSnapshot,
      },
      accessibility_tree_as_raw_protocol_json_characters: tree.extra.protocol_json_characters || null,
      raw_page_characters_without_scripts_and_styles: raw.extra.characters_without_scripts_and_styles || null,
      agent_page_tool_definitions_characters: toolDefinitionCharacters,
    },
  };
}

function printReport(report, verbose) {
  const out = [];
  out.push('agent page measure', '');
  out.push(report.disclaimer, report.screenshots, '');
  out.push(`page  ${report.page}`);
  out.push(`task  ${report.task}: ${report.task_description}`, '');

  const rows = [['way', 'calls', 'page reads', 'characters read', 'rough tokens (characters / 4)']];
  for (const way of report.ways) {
    rows.push([way.way, String(way.calls), String(way.page_reads), number(way.characters_read), number(way.rough_tokens)]);
  }
  const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => row[i].length)));
  rows.forEach((row, index) => {
    out.push(row.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]))).join('   '));
    if (index === 0) out.push(widths.map((w) => '-'.repeat(w)).join('   '));
  });
  out.push('');

  if (verbose) {
    for (const way of report.ways) {
      out.push(`calls, ${way.way}`);
      way.per_call.forEach((call, i) => out.push(`  ${i + 1}. ${call.call}: ${number(call.characters)} characters`));
      out.push('');
    }
  }

  out.push('final state after each way (read by the script, not by the model)');
  for (const way of report.ways) {
    const state = way.final_state ? Object.entries(way.final_state).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('  ') : 'not read';
    out.push(`  ${way.way.padEnd(18)}  ${state}${way.error ? `\n  ${' '.repeat(18)}  error: ${way.error}` : ''}`);
  }
  out.push(`  expected            ${Object.entries(report.expected_final_state).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('  ')}`);
  out.push(`all three ways ended in the expected state: ${report.all_ways_ended_in_the_expected_state ? 'yes' : 'no'}`, '');

  const side = report.side_numbers;
  const withCheck = side.agent_page_with_a_final_snapshot;
  out.push('how to read this');
  out.push('  a call is one tool call by the model. an action call returns the page again, as common browser tools do,');
  out.push('  so that re-read is not counted as its own call. page reads counts how often a whole page or tree came back.');
  out.push('  characters read is everything returned to the model. the tree is written as one compact line per node.');
  const one = side.one_read_characters;
  out.push(`  one read of the page: agent page ${number(one['agent page'])}, accessibility tree ${number(one['accessibility tree'])}, raw page ${number(one['raw page'])} characters.`);
  out.push('  the gap has two parts: each read is smaller, and the agent page reads once instead of after every action.');
  if (withCheck) {
    out.push(`  the agent page act result already lists each step's new value. with one more snapshot to check, it is ${withCheck.calls} calls and ${number(withCheck.characters_read)} characters.`);
  }
  out.push(`  handed over as raw protocol json, the accessibility tree reads would be ${number(side.accessibility_tree_as_raw_protocol_json_characters || 0)} characters.`);
  out.push(`  the raw page reads include script and style text. without it they would be ${number(side.raw_page_characters_without_scripts_and_styles || 0)} characters.`);
  out.push('  the agent page leaves out what the page marks hidden or secret, and lists controls, not page text.');
  out.push('  the other two ways see that content, and the page text too, so some of the gap is by design.');
  out.push(`  the three agent page tool definitions are ${number(side.agent_page_tool_definitions_characters)} characters. no way counts tool definitions.`);
  out.push('  the agent page way needs the page to ship lib/agent-page.js. the others need nothing on the page.');
  out.push('  the plan is fixed and knows every target up front, so no way pays for a wrong guess or a retry. a real model would.');
  console.log(out.join('\n'));
}

// ---- main ------------------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { url: null, task: 'settings', json: false, verbose: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--verbose') options.verbose = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--task') { options.task = argv[i + 1]; i += 1; }
    else if (arg.startsWith('--task=')) options.task = arg.slice('--task='.length);
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else if (options.url) throw new Error('give one page only');
    else options.url = arg;
  }
  if (!TASKS[options.task]) throw new Error(`unknown task ${options.task}; choose one of ${Object.keys(TASKS).join(', ')}`);
  return options;
}

const USAGE = 'usage: node scripts/agent-page-measure.js [url] [--task settings|forms] [--json] [--verbose]';

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${error.message}\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  if (typeof WebSocket !== 'function') {
    console.error('needs node 22 or newer (built-in websocket)');
    return 2;
  }
  const chromePath = process.env.ATRIS_CHROME_PATH || findChrome();
  if (!chromePath || !fs.existsSync(chromePath)) {
    console.error(`no google chrome found${chromePath ? ` at ${chromePath}` : ' on this machine'}; set ATRIS_CHROME_PATH to run this`);
    return 2;
  }

  const task = TASKS[options.task];
  const url = !options.url ? pathToFileURL(FIXTURE).href : /^[a-z][a-z0-9+.-]*:\/\//i.test(options.url) ? options.url : pathToFileURL(path.resolve(options.url)).href;

  const profileDir = makeProfileDir('atris-agent-page-measure-');
  let chrome = null;
  let cdp = null;
  try {
    chrome = await launchChrome(chromePath, profileDir);
    const pageSocket = await waitFor(async () => {
      const tabs = await fetchJson(`http://127.0.0.1:${chrome.port}/json/list`);
      const tab = tabs.find((entry) => entry.type === 'page');
      return tab ? tab.webSocketDebuggerUrl : null;
    }, 20000, 'a chrome page');
    cdp = await connect(pageSocket);
    await cdp.send('Page.enable');
    await cdp.send('Accessibility.enable');
    // Headless Chrome has no focused window, so emulate a focused page, the way a person's browser is.
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

    const ways = await measure(cdp, url, task);
    const definitions = JSON.stringify(agentPageFile.agentTools).length;
    const report = buildReport(url, options.task, task, ways, definitions);
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else printReport(report, options.verbose);
    return report.all_ways_ended_in_the_expected_state ? 0 : 1;
  } catch (error) {
    console.error(`agent page measure stopped: ${error.message}`);
    return 1;
  } finally {
    if (cdp) cdp.close();
    if (chrome) await closeChrome(chrome.port, chrome.child);
    removeProfileDir(profileDir);
  }
}

main().then((code) => { process.exitCode = code; });
