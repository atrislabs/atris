'use strict';

// The one page gm phone serves. Plain html, css, and vanilla js, no build
// step. Every piece of text from the task list goes in with textContent,
// never as html. The nonce matches the page's content security policy.

function phonePage(nonce) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<title>front office</title>
<style nonce="${nonce}">
:root {
  --bg: #f6f5f2;
  --card: #ffffff;
  --ink: #1b1b19;
  --muted: #6b6a66;
  --line: #e3e1db;
  --accent: #0f6b4f;
  --accent-ink: #ffffff;
  --stuck: #b4441f;
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--ink); }
body {
  font: 17px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  padding: max(16px, env(safe-area-inset-top)) 18px max(20px, env(safe-area-inset-bottom));
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.strip { display: flex; flex-direction: column; gap: 12px; }
.where { color: var(--muted); font-size: 14px; }
.target { font-size: 22px; font-weight: 600; letter-spacing: -0.01em; }
.bar { height: 6px; background: var(--line); border-radius: 3px; overflow: hidden; }
.bar > div { height: 100%; background: var(--accent); width: 0; }
.team { display: flex; flex-wrap: wrap; gap: 10px; }
.who {
  width: 40px; height: 40px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 14px; font-weight: 600;
  background: var(--line); color: var(--muted);
}
.who.working { background: var(--accent); color: var(--accent-ink); }
.who.stuck { background: var(--stuck); color: #fff; }
.who.waiting { background: var(--card); color: var(--ink); box-shadow: inset 0 0 0 2px var(--accent); }
.who.asleep { background: transparent; box-shadow: inset 0 0 0 1px var(--line); }
.card {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 16px;
  padding: 24px 20px;
  display: flex; flex-direction: column; gap: 16px;
}
.count { color: var(--muted); font-size: 14px; }
.say { font-size: 20px; line-height: 1.4; margin: 0; }
button {
  font: inherit;
  width: 100%;
  min-height: 56px;
  border-radius: 12px;
  border: 1px solid var(--line);
  background: var(--card);
  color: var(--ink);
  padding: 12px 16px;
  text-align: left;
  cursor: pointer;
}
button .effect { display: block; font-size: 14px; color: var(--muted); }
button.main { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); font-weight: 600; min-height: 64px; }
button.main .effect { color: var(--accent-ink); opacity: 0.85; font-weight: 400; }
button.armed { background: var(--ink); color: #fff; border-color: var(--ink); }
button.armed .effect { color: #fff; opacity: 0.85; }
button.later { border: none; background: transparent; color: var(--muted); text-align: center; }
button[disabled] { opacity: 0.5; }
.job { border-top: 1px solid var(--line); padding-top: 14px; display: flex; flex-direction: column; gap: 10px; }
.job .title { font-weight: 600; }
.job .meta { color: var(--muted); font-size: 14px; }
.row { display: flex; gap: 10px; }
.row button { text-align: center; }
.reply { font-size: 16px; padding: 14px 16px; border-radius: 12px; background: var(--card); border: 1px solid var(--line); }
.reply.done { border-color: var(--accent); }
.clear h2 { margin: 0; font-size: 24px; }
.clear ul { margin: 0; padding-left: 20px; color: var(--muted); }
.live { margin-top: auto; color: var(--muted); font-size: 14px; border-top: 1px solid var(--line); padding-top: 12px; }
.toast {
  position: fixed; left: 16px; right: 16px; bottom: max(16px, env(safe-area-inset-bottom));
  background: var(--ink); color: #fff; border-radius: 12px; padding: 12px 16px;
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
}
.toast button { width: auto; min-height: 52px; background: transparent; color: #fff; border-color: #fff; text-align: center; }
[hidden] { display: none !important; }
</style>
</head>
<body>
<section class="strip">
  <div class="where" id="where">front office</div>
  <div class="target" id="target">loading</div>
  <div class="bar"><div id="bar"></div></div>
  <div class="team" id="team"></div>
</section>
<div id="reply" class="reply" hidden></div>
<main id="main"></main>
<div class="live" id="live"></div>
<div class="toast" id="toast" hidden><span id="toast-text"></span><button id="toast-undo" type="button">undo</button></div>
<script nonce="${nonce}">
(function () {
  var token = new URLSearchParams(location.search).get('t') || '';
  var last = null;
  var view = 'card';
  var armed = null;
  var pendingReply = null;
  var undoTimer = null;

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function api(path, body) {
    var opts = { headers: { 'x-gm-token': token } };
    if (body) {
      opts.method = 'POST';
      opts.headers['content-type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(path + (body ? '' : '?t=' + encodeURIComponent(token)), opts)
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }).then(function (j) { j.status = r.status; return j; }); });
  }

  function say(text, done) {
    var reply = document.getElementById('reply');
    reply.hidden = !text;
    reply.textContent = text || '';
    reply.className = 'reply' + (done ? ' done' : '');
  }

  function choiceButton(card, choice, main) {
    var b = el('button', main ? 'main' : (choice.id === 'later' ? 'later' : ''));
    b.type = 'button';
    var label = el('span', null, choice.label);
    b.appendChild(label);
    if (choice.effect) b.appendChild(el('span', 'effect', choice.effect));
    var key = card.id + ':' + choice.id;
    if (armed && armed.key === key) {
      b.className = 'armed';
      label.textContent = 'tap again to confirm';
    }
    b.addEventListener('click', function () { tap(card, choice, key); });
    return b;
  }

  function tap(card, choice, key) {
    if (choice.view === 'oldest') { view = 'oldest'; draw(); return; }
    if (choice.confirm && !(armed && armed.key === key && Date.now() < armed.until)) {
      armed = { key: key, until: Date.now() + 5000 };
      draw();
      setTimeout(function () { if (armed && armed.key === key && Date.now() >= armed.until) { armed = null; draw(); } }, 5100);
      return;
    }
    armed = null;
    if (choice.ack) say(choice.ack, false);
    api('/action', { card: card.id, choice: choice.id, confirm: Boolean(choice.confirm) }).then(function (res) {
      if (!res.ok) { say(res.message || 'that did not go through', false); return refresh(); }
      if (choice.id === 'later') { say('', false); view = 'card'; }
      if (res.undo) showUndo(res.ack, res.undo);
      else if (res.id) pendingReply = res.id;
      if (choice.id !== 'later' && !/^(approve|sendback):/.test(choice.id)) view = 'card';
      refresh();
    });
  }

  function showUndo(text, undo) {
    var toast = document.getElementById('toast');
    document.getElementById('toast-text').textContent = text;
    toast.hidden = false;
    var b = document.getElementById('toast-undo');
    b.onclick = function () {
      toast.hidden = true;
      api('/undo', { id: undo.id }).then(function (res) { say(res.ack || res.message || '', false); refresh(); });
    };
    clearTimeout(undoTimer);
    undoTimer = setTimeout(function () { toast.hidden = true; }, undo.ms);
  }

  function drawCard(main, s) {
    var card = s.card;
    var box = el('section', 'card');
    box.appendChild(el('div', 'count', 'decision ' + (s.decided + 1) + ' of ' + Math.min(s.card_limit, s.decided + s.cards_left)));
    if (view === 'oldest' && card.jobs) {
      box.appendChild(el('p', 'say', 'the oldest jobs waiting on review'));
      card.jobs.forEach(function (job) {
        var j = el('div', 'job');
        j.appendChild(el('div', 'title', job.title));
        j.appendChild(el('div', 'meta', job.member + ', waiting ' + job.age + ', ' + job.ref));
        var row = el('div', 'row');
        row.appendChild(choiceButton(card, { id: 'approve:' + job.ref, label: 'approve', confirm: true, ack: job.member + ': thanks, landing it' }, false));
        row.appendChild(choiceButton(card, { id: 'sendback:' + job.ref, label: 'send back', confirm: true, ack: job.member + ': on it, taking another pass' }, false));
        j.appendChild(row);
        box.appendChild(j);
      });
      var back = el('button', 'later', 'back');
      back.type = 'button';
      back.addEventListener('click', function () { view = 'card'; armed = null; draw(); });
      box.appendChild(back);
    } else {
      box.appendChild(el('p', 'say', card.text));
      card.choices.forEach(function (c, i) { box.appendChild(choiceButton(card, c, i === 0 && c.id !== 'later')); });
    }
    main.appendChild(box);
  }

  function drawClear(main, s) {
    var box = el('section', 'card clear');
    box.appendChild(el('h2', null, 'all clear'));
    box.appendChild(el('p', null, s.decided >= s.card_limit ? 'that is five decisions. the rest can wait.' : 'nothing needs you right now.'));
    var running = s.all_clear.still_running;
    if (running.length) {
      box.appendChild(el('div', 'count', 'still running'));
      var ul = el('ul');
      running.forEach(function (line) { ul.appendChild(el('li', null, line)); });
      box.appendChild(ul);
    } else {
      box.appendChild(el('div', 'count', 'nothing is running right now'));
    }
    main.appendChild(box);
  }

  function draw() {
    var s = last;
    if (!s) return;
    document.getElementById('where').textContent = 'front office, ' + s.workspace_name;
    document.getElementById('target').textContent = s.strip.line;
    var pct = s.strip.goal ? Math.min(100, Math.round(100 * s.strip.landed / s.strip.goal)) : 0;
    document.getElementById('bar').style.width = pct + '%';
    var team = document.getElementById('team');
    team.textContent = '';
    s.team.forEach(function (m) {
      var c = el('div', 'who ' + m.tone, m.initials);
      c.title = m.name + ': ' + m.status;
      c.setAttribute('aria-label', m.name + ', ' + m.status);
      team.appendChild(c);
    });
    var main = document.getElementById('main');
    main.textContent = '';
    if (s.error) main.appendChild(el('p', 'count', 'could not read the task list: ' + s.error));
    if (s.card && !(view === 'oldest' && !s.card.jobs)) drawCard(main, s);
    else drawClear(main, s);
    if (pendingReply) {
      var a = s.actions.filter(function (x) { return x.id === pendingReply; })[0];
      if (a) say(a.line, a.status !== 'running');
    }
    document.getElementById('live').textContent = s.live;
  }

  function refresh() {
    return api('/state').then(function (s) {
      if (s.status !== 200) { document.getElementById('target').textContent = 'this link stopped working. start gm phone again on the mac.'; return; }
      if (!s.card || s.card.id !== 'review') view = 'card';
      last = s;
      draw();
    }).catch(function () {
      document.getElementById('live').textContent = 'cannot reach the mac right now. retrying.';
    });
  }

  refresh();
  setInterval(refresh, 5000);
})();
</script>
</body>
</html>
`;
}

module.exports = { phonePage };
