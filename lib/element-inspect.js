'use strict';

// Local web inspector for Element (inspired by vercel/board's `vb inspect` + Paradigm's
// decision inbox and loss-curve UI). Zero third-party dependencies, localhost-only (127.0.0.1),
// reading and writing the exact same local Element store as the CLI.

const http = require('http');
const feed = require('./feed-core');
const room = require('./feed-room');
const ops = require('./element-ops');
const cmds = require('./element-commands');
const sched = require('./element-schedules');

const MAX_BODY = 64 * 1024;

function isAllowedOrigin(origin) {
  if (!origin) return true;
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(String(origin).trim());
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new feed.FeedError(413, 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); } catch { reject(new feed.FeedError(400, 'invalid json body')); }
    });
    req.on('error', reject);
  });
}

function stateSnapshot(root, { env = process.env } = {}) {
  const listed = feed.listCards(root, { filter: 'all', limit: 30, env });
  const curve = ops.loadCurve(root, { limit: 60, window: 10 });
  const commands = cmds.listCommands(root).commands;
  const schedules = sched.listSchedules(root).schedules;
  return {
    version: feed.FEED_VERSION,
    goal: listed.theme ? listed.theme.text : '',
    counts: listed.counts,
    cards: listed.cards,
    curve: { sparkline: curve.sparkline, summary: curve.summary, points: curve.points.slice(-30) },
    commands,
    schedules,
  };
}

function renderHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Atris Element</title>
<style>
  :root { --bg:#0d0e11; --surface:#15171c; --border:#252831; --text:#eef0f4; --muted:#8f96a6; --accent:#4ade80; --warn:#f59e0b; --danger:#f87171; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  header { position:sticky; top:0; z-index:2; background:rgba(13,14,17,0.92); backdrop-filter:blur(8px); border-bottom:1px solid var(--border); padding:14px 20px; display:flex; align-items:center; justify-content:space-between; gap:16px; }
  h1 { margin:0; font-size:16px; font-weight:600; letter-spacing:0.01em; }
  .goal { color:var(--muted); font-size:13px; margin-top:2px; }
  .counts { display:flex; gap:14px; font-variant-numeric:tabular-nums; color:var(--muted); font-size:13px; }
  .counts b { color:var(--text); }
  main { max-width:1100px; margin:0 auto; padding:20px; display:grid; grid-template-columns:minmax(0,1fr) 320px; gap:20px; }
  @media (max-width:860px) { main { grid-template-columns:1fr; } }
  .panel { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:16px; margin-bottom:14px; }
  .composer { display:flex; gap:8px; }
  input, button { font:inherit; border-radius:7px; border:1px solid var(--border); background:#101216; color:var(--text); padding:8px 11px; }
  input { flex:1; min-width:0; }
  button { cursor:pointer; font-weight:500; }
  button:hover { border-color:#444b5b; }
  button.primary { background:#183324; border-color:#285e3e; color:var(--accent); }
  button.danger { background:#2f1719; border-color:#5b262a; color:var(--danger); }
  .card { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:16px; margin-bottom:12px; }
  .card-head { display:flex; justify-content:space-between; color:var(--muted); font-size:12px; margin-bottom:6px; }
  .badge { padding:2px 7px; border-radius:999px; font-size:11px; border:1px solid var(--border); }
  .badge.decide { color:var(--accent); border-color:#285e3e; }
  .card-title { font-size:15px; font-weight:600; margin:0 0 6px; }
  .card-why { color:var(--muted); margin:0 0 10px; }
  .actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:10px; }
  .replies { margin-top:10px; padding-top:8px; border-top:1px solid var(--border); font-size:13px; color:#cfd4df; }
  .reply { margin:4px 0; }
  .reply b { color:var(--text); font-weight:600; }
  .reply-form { display:flex; gap:6px; margin-top:10px; }
  .side-title { font-size:12px; text-transform:uppercase; letter-spacing:0.06em; color:var(--muted); margin:0 0 10px; }
  .metric-grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; font-variant-numeric:tabular-nums; }
  .metric { background:#101216; border:1px solid var(--border); border-radius:8px; padding:8px 10px; }
  .metric .k { color:var(--muted); font-size:11px; }
  .metric .v { font-size:15px; font-weight:600; margin-top:2px; }
  .cmd-row { display:flex; justify-content:space-between; align-items:center; gap:8px; padding:6px 0; border-bottom:1px solid var(--border); }
  .cmd-row:last-child { border-bottom:none; }
  .muted { color:var(--muted); font-size:12px; }
  svg.curve { width:100%; height:64px; display:block; margin:10px 0; background:#101216; border:1px solid var(--border); border-radius:8px; }
</style>
</head>
<body>
<header>
  <div>
    <h1>Atris Element</h1>
    <div id="goal" class="goal"></div>
  </div>
  <div id="counts" class="counts"></div>
</header>
<main>
  <section>
    <div class="panel">
      <form id="postForm" class="composer">
        <input id="postInput" placeholder="Post a note or @member ask to the swarm..." autocomplete="off">
        <button type="submit" class="primary">Post</button>
      </form>
    </div>
    <div id="feed"></div>
  </section>
  <aside>
    <div class="panel">
      <div class="side-title">Loss Curve</div>
      <div id="curve"></div>
    </div>
    <div class="panel">
      <div class="side-title">Slash Workflows</div>
      <div id="commands"></div>
    </div>
    <div class="panel">
      <div class="side-title">Schedules</div>
      <div id="schedules"></div>
    </div>
  </aside>
</main>
<script>
async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  return res.json();
}
function esc(s) { return String(s || '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
function curveSvg(points) {
  const vals = (points || []).map((p) => p.rolling_loss).filter((v) => typeof v === 'number');
  if (vals.length < 2) return '<div class="muted">Not enough scored runs yet.</div>';
  const w = 280, h = 64, pad = 6;
  const pts = vals.map((v, i) => {
    const x = pad + (i / (vals.length - 1)) * (w - pad * 2);
    const y = pad + v * (h - pad * 2);
    return x.toFixed(1) + ',' + y.toFixed(1);
  }).join(' ');
  return '<svg class="curve" viewBox="0 0 ' + w + ' ' + h + '"><polyline fill="none" stroke="#4ade80" stroke-width="2" points="' + pts + '"/></svg>';
}
async function refresh() {
  const data = await api('/api/state');
  document.getElementById('goal').textContent = data.goal || 'No goal set yet';
  const c = data.counts || {};
  document.getElementById('counts').innerHTML =
    '<span><b>' + (c.needs_decision || 0) + '</b> waiting</span>' +
    '<span><b>' + (c.working || 0) + '</b> working</span>' +
    '<span><b>' + (c.done_today || 0) + '</b> done</span>';
  const feedEl = document.getElementById('feed');
  if (!data.cards || !data.cards.length) {
    feedEl.innerHTML = '<div class="panel muted">Clear. Nothing waiting right now.</div>';
  } else {
    feedEl.innerHTML = data.cards.map((card) => {
      const badge = card.needs_decision ? '<span class="badge decide">needs decision</span>' : '<span class="badge">' + esc(card.state) + '</span>';
      const replies = (card.replies || []).map((r) => '<div class="reply"><b>' + esc(r.author && r.author.name) + ':</b> ' + esc(r.text) + '</div>').join('');
      const btns = card.needs_decision
        ? '<button class="primary" onclick="act(\\'yes\\',\\'' + esc(card.id) + '\\')">Yes</button><button class="danger" onclick="act(\\'no\\',\\'' + esc(card.id) + '\\')">No</button><button onclick="act(\\'pass\\',\\'' + esc(card.id) + '\\')">Pass</button>'
        : '<button onclick="act(\\'pass\\',\\'' + esc(card.id) + '\\')">Pass</button><button class="danger" onclick="act(\\'no\\',\\'' + esc(card.id) + '\\')">Dismiss</button>';
      return '<div class="card">' +
        '<div class="card-head"><span>@' + esc(card.author && card.author.name || 'team') + '</span>' + badge + '</div>' +
        '<div class="card-title">' + esc(card.title) + '</div>' +
        (card.why ? '<p class="card-why">' + esc(card.why) + '</p>' : '') +
        (card.body ? '<p class="card-why">' + esc(card.body) + '</p>' : '') +
        '<div class="actions">' + btns + '</div>' +
        (replies ? '<div class="replies">' + replies + '</div>' : '') +
        '<form class="reply-form" onsubmit="sendReply(event,\\'' + esc(card.id) + '\\')"><input placeholder="Reply in thread..."><button type="submit">Reply</button></form>' +
      '</div>';
    }).join('');
  }
  const s = (data.curve && data.curve.summary) || {};
  document.getElementById('curve').innerHTML = curveSvg(data.curve && data.curve.points) +
    '<div class="metric-grid">' +
      '<div class="metric"><div class="k">Rolling loss</div><div class="v">' + (s.latest_rolling_loss == null ? 'n/a' : s.latest_rolling_loss.toFixed(2)) + '</div></div>' +
      '<div class="metric"><div class="k">Trend</div><div class="v">' + esc(s.trend || 'n/a') + '</div></div>' +
      '<div class="metric"><div class="k">Spend</div><div class="v">$' + Number(s.total_spend_usd || 0).toFixed(2) + '</div></div>' +
      '<div class="metric"><div class="k">Bottleneck</div><div class="v">' + esc(s.top_bottleneck || 'none') + '</div></div>' +
    '</div>';
  document.getElementById('commands').innerHTML = (data.commands || []).map((cmd) =>
    '<div class="cmd-row"><div><b>/' + esc(cmd.name) + '</b><div class="muted">' + esc(cmd.description || cmd.command) + '</div></div><button onclick="runCmd(\\'' + esc(cmd.name) + '\\')">Run</button></div>'
  ).join('') || '<div class="muted">No commands.</div>';
  const scheds = data.schedules || [];
  document.getElementById('schedules').innerHTML = (scheds.length
    ? scheds.map((sc) => '<div class="cmd-row"><div><b>@' + esc(sc.to) + '</b> every ' + esc(sc.every) + '<div class="muted">' + esc(sc.message) + '</div></div></div>').join('')
    : '<div class="muted">No repeating schedules.</div>') +
    '<div class="actions"><button onclick="tickSched()">Tick due</button></div>';
}
async function act(kind, cardId) { await api('/api/decide', { kind, card_id: cardId }); refresh(); }
async function sendReply(ev, cardId) { ev.preventDefault(); const inp = ev.target.querySelector('input'); const text = inp.value.trim(); if (!text) return; inp.value = ''; await api('/api/reply', { card_id: cardId, text }); refresh(); }
async function runCmd(name) { await api('/api/run', { name }); refresh(); }
async function tickSched() { await api('/api/schedule/tick', {}); refresh(); }
document.getElementById('postForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const inp = document.getElementById('postInput');
  const text = inp.value.trim();
  if (!text) return;
  inp.value = '';
  await api('/api/post', { text });
  refresh();
});
refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`;
}

function createHandler(root, { env = process.env, deps = {} } = {}) {
  return async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = url.pathname;
    if (!isAllowedOrigin(req.headers.origin)) {
      sendJson(res, 403, { ok: false, error: 'origin not allowed' });
      return;
    }

    try {
      if (req.method === 'GET' && pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(renderHtml());
        return;
      }
      if (req.method === 'GET' && pathname === '/api/state') {
        sendJson(res, 200, stateSnapshot(root, { env }));
        return;
      }
      if (req.method === 'POST' && pathname === '/api/post') {
        const body = await readJsonBody(req);
        const out = ops.postIdempotent(root, { text: body.text, as: body.as || null, idKey: body.id || null, env, deps });
        sendJson(res, 200, out);
        return;
      }
      if (req.method === 'POST' && pathname === '/api/reply') {
        const body = await readJsonBody(req);
        const out = room.reply(root, body.card_id, body.text, { as: body.as || undefined, env, deps });
        sendJson(res, 200, out);
        return;
      }
      if (req.method === 'POST' && pathname === '/api/decide') {
        const body = await readJsonBody(req);
        const cardId = body.card_id;
        if (!cardId) throw new feed.FeedError(400, 'card_id is required');
        let out;
        if (body.kind === 'yes') out = feed.decide(root, cardId, 'approve', { note: body.note, env, deps });
        else if (body.kind === 'no') out = feed.dismissCards(root, [cardId], { env, deps });
        else if (body.kind === 'pass') out = feed.passCards(root, [cardId], { env });
        else throw new feed.FeedError(400, 'kind must be yes, no or pass');
        sendJson(res, 200, out);
        return;
      }
      if (req.method === 'POST' && pathname === '/api/run') {
        const body = await readJsonBody(req);
        const out = await cmds.runSlashCommand(root, body.name, { cardId: body.card_id || null, as: body.as || null, env, deps });
        sendJson(res, 200, out);
        return;
      }
      if (req.method === 'POST' && pathname === '/api/schedule/tick') {
        const out = sched.tickSchedules(root, { env, deps });
        sendJson(res, 200, out);
        return;
      }
      sendJson(res, 404, { ok: false, error: 'not found' });
    } catch (caught) {
      const known = feed.asFeedError(caught);
      if (known) sendJson(res, known.status || 400, { ok: false, error: known.toJSON() });
      else sendJson(res, 500, { ok: false, error: String(caught && caught.message || caught) });
    }
  };
}

function startInspector(root, { port = 4100, host = '127.0.0.1', env = process.env, deps = {} } = {}) {
  const server = http.createServer(createHandler(root, { env, deps }));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const boundPort = typeof addr === 'object' && addr ? addr.port : port;
      resolve({
        server,
        host,
        port: boundPort,
        url: `http://${host}:${boundPort}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

module.exports = { startInspector };
