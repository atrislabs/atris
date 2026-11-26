const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { PAGE_RULES, checkPage, ruleSheet } = require('../lib/page-rules');
const { scanText } = require('../lib/slop-kinds');

const page = (body, css = '', head = '') => `<!doctype html><html><head>${head}<style>${css}</style></head><body>${body}</body></html>`;
const fired = (html) => new Set(checkPage(html, 'page.html').findings.map((f) => f.rule));

// For every rule: a page that shows the problem, and a twin that shows the same thing written
// another way (renamed classes, a div with a shadow, an svg for an arrow, a font alias, and so on).
const CASES = {
  'page-subtitle': [
    page('<h1>Leads</h1><p>Every lead in one place</p><ul><li>Maria</li></ul>'),
    page('<section><div class="x1"><h2>Leads</h2><span>Every lead you have, sorted by date</span></div><table><tr><td>Maria</td></tr></table></section>'),
  ],
  'page-explanatory': [
    page('<main><h2>Leads</h2><table><tr><td>Maria</td></tr></table><p>This page shows every lead.</p></main>'),
    page('<main><table><tr><td>Maria</td></tr></table><div class="tbl-cap">Tap a row to open the person</div></main>'),
  ],
  'page-word-quiet': [page('<p>It runs quietly in the background.</p>'), page('<p>A <em>quiet</em> helper for your inbox</p>')],
  'page-word-real': [page('<p>Results for real teams</p>'), page('<p>Built on <b>Real</b> work from your week</p>')],
  'page-two-word-sentence': [
    page('<p>Ship it. Then rest well tonight.</p>'),
    page('<p><span class="k">No noise</span>. Your morning starts with the work.</p>'),
  ],
  'page-dot-separator': [
    page('<p>Austin · Texas</p>'),
    page('<ul class="m"><li>Austin</li><li>Texas</li></ul>', '.m li + li::before { content: "\\00b7"; margin: 0 6px; }'),
  ],
  'page-button-arrow': [
    page('<button>Start →</button>'),
    page('<a href="/s" class="go">Start <svg width="12" height="12"><path d="M0 0h12"/></svg></a>', '.go { padding: 8px 12px; background: #123; color: #fff; }'),
  ],
  'page-sparkle': [page('<p>✨ New this week</p>'), page('<button><i data-lucide="sparkles"></i> Write it</button>')],
  'page-label-above-heading': [
    page('<section><span class="eyebrow">New</span><h2>Leads</h2><p>Maria, Austin, booked for Tuesday at noon.</p></section>'),
    page('<section><div class="k2"><b>Pricing</b></div><h1>Plans</h1></section>'),
  ],
  'page-headline-accent': [
    page('<h1>Your <em>calm</em> inbox</h1>'),
    page('<h1>Your <span class="k">calm</span> inbox</h1>', '.k { font-family: Georgia, serif; }'),
  ],
  'page-numbered-sections': [
    page('<h2>01 Plan</h2><p>We write the plan with you.</p><h2>02 Build</h2><p>We build it.</p>'),
    page('<div class="r"><small>1</small><h3>Plan</h3></div><div class="r"><small>2</small><h3>Build</h3></div>'),
  ],
  'page-all-caps': [
    page('<p style="text-transform: uppercase">New leads</p>'),
    page('<p class="m">New leads <b>TODAY</b></p>'),
  ],
  'page-emoji-icon': [page('<h3>🚀 Launch</h3>'), page('<ul><li><span>📅</span> Calendar</li></ul>')],
  'page-placeholder': [page('<p>Lorem ipsum dolor sit amet.</p>'), page('<div><span>Description goes</span> here</div>')],
  'page-unsourced-number': [
    page('<div class="stat"><b>40%</b><span>faster replies</span></div>'),
    page('<dl><dt>Replies</dt><dd>3x</dd></dl>'),
  ],
  'page-card-grid': [
    page('<div class="grid"><div class="card"><h3>Leads</h3><p>a</p></div><div class="card"><h3>Notes</h3><p>b</p></div><div class="card"><h3>Mail</h3><p>c</p></div></div>', '.grid { display: grid; }'),
    page('<section><article><svg width="16"></svg><p>Leads</p></article><article><svg width="16"></svg><p>Notes</p></article><article><svg width="16"></svg><p>Mail</p></article></section>'),
  ],
  'page-card-in-card': [
    page('<div class="card" style="border: 1px solid #ddd; padding: 16px"><div class="card" style="border: 1px solid #ddd; padding: 8px">Inner</div></div>'),
    page('<div class="shadow rounded p-4"><div class="bg-gray-50 rounded-lg p-2">Inner</div></div>'),
  ],
  'page-left-border': [
    page('<div class="due">Due Friday</div>', '.due { border-left: 4px solid #e11d48; padding: 8px; }'),
    page('<div class="x">Due Friday</div>', '.x { position: relative; } .x::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: #e11d48; }'),
  ],
  'page-looping-motion': [
    page('<span class="d"></span>', '.d { animation: pulse 2s infinite; }'),
    page('<svg><circle r="4"><animate attributeName="r" values="4;6;4" dur="1s" repeatCount="indefinite"/></circle></svg>'),
  ],
  'page-scroll-fade': [
    page('<section data-aos="fade-up">Hi</section>'),
    page('<section class="s1">Hi</section><script>new IntersectionObserver((es) => es.forEach((e) => e.target.classList.add("on"))).observe(document.querySelector(".s1"));</script>'),
  ],
  'page-glow': [
    page('<div class="blob"></div><p>Hi</p>', '.blob { filter: blur(80px); background: #a78bfa; }'),
    page('<header class="top">Hi</header>', '.top { box-shadow: 0 0 60px rgba(168, 85, 247, 0.5); }'),
  ],
  'page-glass': [page('<nav class="n">Hi</nav>', '.n { backdrop-filter: blur(12px); }'), page('<nav class="backdrop-blur-md">Hi</nav>')],
  'page-gradient-text': [
    page('<h1>Hi</h1>', 'h1 { background: linear-gradient(90deg, #f0f, #0ff); -webkit-background-clip: text; color: transparent; }'),
    page('<svg><defs><linearGradient id="g"></linearGradient></defs><text fill="url(#g)">Hi</text></svg>'),
  ],
  'page-banned-font': [
    page('<p>Hi</p>', 'body { font-family: Inter, sans-serif; }'),
    page('<p class="d">Hi</p>', '@font-face { font-family: "Display"; src: url(/f/PlayfairDisplay-Regular.woff2); } .d { font-family: Display; }'),
  ],
  'page-noise': [
    page('<svg><filter id="n"><feTurbulence baseFrequency="0.8"/></filter></svg>'),
    page('<div class="bg">Hi</div>', '.bg { background-image: url(/img/grain.png); }'),
  ],
};

const prose = (topic) => [
  `Every ${topic} week starts with the same list. Maria checks the open jobs, calls the two people who asked for a quote and writes down what each one needs before Thursday.`,
  `The list lives in one sheet that the whole office can open. When a job closes she moves the row to the done tab so the next person sees only the work that is left.`,
  `Most weeks this takes about twenty minutes on Monday morning. The rest of the week she spends on the jobs themselves and on the calls that come in after lunch.`,
].map((p) => `<p>${p}</p>`).join('');

// Clean pages that must pass every rule.
const CONTROLS = {
  article: page(`<article><h1>How the office runs its week</h1>
<section><h2>Monday</h2>${prose('Monday')}</section>
<section><h2>Midweek</h2>${prose('midweek')}<blockquote>We keep the list short so it gets read.</blockquote></section>
<section><h2>Friday</h2>${prose('Friday')}</section></article>`, 'body { font-family: Interstate, Georgia, serif; } blockquote { margin: 1em 2em; }'),
  pricing: page(`<main><h2>Plans</h2><table><thead><tr><th>Plan</th><th>Price</th><th>Seats</th></tr></thead>
<tbody><tr><td>Starter</td><td>$20 a month</td><td>1</td></tr><tr><td>Business</td><td>$50 a month</td><td>5</td></tr>
<tr><td>Max</td><td>$200 a month</td><td>20</td></tr></tbody></table></main>`, 'td, th { border-bottom: 1px solid #ddd; padding: 8px; } table { border-collapse: collapse; }'),
  report: page(`<main><h1>October follow-ups</h1><section><h2>Replies</h2>
<div class="figure"><b>42%</b><span>reply rate</span><cite>Source: mail export, October 31</cite></div>
<table><tr><th>Week</th><th>Sent</th><th>Replies</th></tr><tr><td>1</td><td>40</td><td>17</td></tr><tr><td>2</td><td>38</td><td>15</td></tr></table>
<p>Replies came from owners who had a booking that week, as the table shows by week.</p></section></main>`, '.figure { box-shadow: 0 1px 2px rgba(0,0,0,.08); border-radius: 8px; padding: 12px; }'),
  form: page(`<main><h2>Ask for a quote</h2><form><label for="e">Email</label><input id="e" type="email" placeholder="you@shop.com">
<label for="m">What needs fixing</label><textarea id="m"></textarea><button type="submit">Send</button></form></main>`, 'input, textarea { border: 1px solid #ccc; border-radius: 4px; padding: 6px; }'),
  realEstate: page(`<main><h1>Maria Lopez, Austin homes</h1><section><h2>Listings</h2>
<p>Maria has sold real estate in Austin since 2011 and knows the east side street by street. Her listings update in real-time and buyers get real time alerts when a price drops.</p>
<p>Call the office to book a walk through on any open house this weekend.</p></section></main>`),
  prices: page(`<main><section><h2>Plans for 2026</h2><p>Prices hold for the whole year and there is nothing to sign.</p><p>You can change plans any month from the billing page.</p></section>
<section><h2>Starter at $20 a month</h2><p>One seat and the weekly receipt in your inbox each Friday.</p><p>Most solo shops start here and move up when a second person joins.</p></section></main>`),
};

test('every rule has a failing page and a twin, and a twin that hides the problem is still caught', () => {
  for (const rule of PAGE_RULES) {
    const pair = CASES[rule.id];
    assert.ok(pair && pair.length === 2, `${rule.id} has no failing page and twin`);
    assert.ok(fired(pair[0]).has(rule.id), `${rule.id} missed its failing page`);
    assert.ok(fired(pair[1]).has(rule.id), `${rule.id} missed its twin`);
  }
  assert.deepEqual(Object.keys(CASES).sort(), PAGE_RULES.map((r) => r.id).sort());
});

test('clean pages pass every rule, so a rule that rejects everything fails here', () => {
  for (const [name, html] of Object.entries(CONTROLS)) {
    const res = checkPage(html, `${name}.html`);
    assert.deepEqual(res.findings.map((f) => `${f.rule}:${f.line} ${f.text}`), [], name);
    assert.equal(res.results.length, PAGE_RULES.length);
    assert.ok(res.results.every((r) => r.ok === true));
  }
});

test('a switched-off rule is skipped and reported as off', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'page-rules-'));
  try {
    fs.mkdirSync(path.join(dir, '.atris'));
    fs.writeFileSync(path.join(dir, '.atris', 'slop.rules.json'), JSON.stringify({ off: ['page-glass'] }));
    const res = checkPage(CASES['page-glass'][0], 'p.html', { root: dir });
    assert.deepEqual(res.off, ['page-glass']);
    assert.ok(!res.findings.some((f) => f.rule === 'page-glass'));
    assert.deepEqual(res.results.find((r) => r.id === 'page-glass'), { id: 'page-glass', ok: null, off: true });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the screen kind runs page rules on html once, and keeps the old rules elsewhere', () => {
  const html = page('<h1>Leads</h1><p class="subtitle">Everything you need in one place</p>');
  const rules = scanText(html, 'page.html', 'screen').findings.map((f) => f.rule);
  assert.ok(rules.includes('page-subtitle'));
  assert.ok(!rules.includes('screen-subtitle'));
  assert.ok(scanText('<Header title="Leads" subtitle="Everything you need in one place" />', 'Page.tsx', 'screen').findings.some((f) => f.rule === 'screen-subtitle'));
  const groups = ruleSheet();
  assert.deepEqual(Object.keys(groups).sort(), ['look', 'shape', 'words']);
});

test('broken markup never throws', () => {
  for (const bad of ['', '<div', '<p>a<b>c</p></div></span>', '<style>.a{color:', '<<>>&#xZZ;']) {
    assert.equal(checkPage(bad, 'x.html').results.length, PAGE_RULES.length);
  }
});
