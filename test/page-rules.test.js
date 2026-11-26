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

// Ways around each rule found by attackers (round 1), written fresh: [rule, page, should it fire].
const ATTACKS = [
  ['page-subtitle', page('<div><div><h1>Nexus</h1></div><div><p>A list of the people you talk to.</p></div></div>'), true],
  ['page-subtitle', page('<h1>Nexus<small>A list of the people you talk to</small></h1>', 'small { display: block; }'), true],
  ['page-subtitle', page('<section><h1>Nexus</h1><h3>A list of the people you talk to.</h3><a href="/s">Start</a></section>'), true],
  ['page-subtitle', page('<section><h1>Nexus</h1><hr>A list of the people you talk to.</section>'), true],
  ['page-subtitle', page('<h1>Nexus</h1><a href="/s">Start</a>', 'h1::after { content: "A list of the people you talk to"; display: block; }'), true],
  ['page-subtitle', page('<h2>Due</h2><div><p>Who needs a reply.</p><table><tr><td>Ana</td></tr></table></div>'), true],
  ['page-subtitle', page('<h2>Join</h2><p>One note a week.</p><input type="email">'), true],
  ['page-subtitle', page('<h1>Welcome back</h1><div><a class="btn" href="/in">Sign in</a></div><nav><a href="/a">Docs</a><a href="/b">Help</a></nav>'), false],
  ['page-subtitle', page('<h2>Quote</h2><form class="lead-form"><label>Email</label><input></form><h2>Month</h2><table class="summary"><tr><td>12</td></tr></table>'), false],
  ['page-subtitle', page('<h1>Board</h1><span class="vh">Updated now</span><ul><li>Ana</li></ul>', '.vh { position: absolute; width: 1px; height: 1px; clip: rect(0 0 0 0); }'), false],
  ['page-subtitle', page('<h2>Visit</h2><address>12 Oak Road</address><iframe src="/map"></iframe><h2>Plan</h2><div class="p">$50</div><div>a month</div>', '.p { font-size: 56px; }'), false],
  ['page-subtitle', page(`<h1>The leak</h1><p>${'The floor was wet again on Tuesday. Ana lifted the tiles. '.repeat(2)}</p><p>By noon the plumber had the joint out.</p>`), false],
  ['page-subtitle', page('<h2>2.4.1</h2><time>20 Nov</time><ul><li>Fixed export</li></ul><h2>Docs</h2><p>Pass a string.</p><pre>parse(s)</pre>'), false],
  ['page-subtitle', '<h2>Plans</h2><table><tr><td>1</td></tr></table>', false],
  ['page-explanatory', page('<ul><li>Ana</li></ul><div>On this page you see who is due.</div>'), true],
  ['page-explanatory', page('<ul><li>Ana</li></ul><div>Hi Sam, this page is your week.</div>'), true],
  ['page-explanatory', page('<ul><li>Ana</li></ul><div class="text-muted">Tip: drag a name to change the order.</div>'), true],
  ['page-explanatory', page('<form><input><div class="form-text">Type the address you check daily.</div></form>'), true],
  ['page-explanatory', page('<p>The following spring a frost came. This section of the orchard is closed. This site was a farm.</p>'), false],
  ['page-explanatory', page('<ul><li class="note">Call the dentist</li><li class="note">Buy pears</li></ul><a class="help-link" href="/h">Help</a><span class="bottle-cap">Caps in 28 mm</span>'), false],
  ['page-word-quiet', page('<p>It runs <span>qui</span><span>et</span>ly.</p><p>A qui&shy;et week.</p>'), true],
  ['page-word-quiet', page('<p class="q"></p><svg><text>Quietly done</text></svg>', '.q::before { content: "Quiet mode"; }'), true],
  ['page-word-quiet', page('<input placeholder="Quiet hours"><p aria-hidden="true">Done quietly.</p>'), true],
  ['page-word-quiet', page('<p class="a">Done quietly.</p><div class="row open">Quiet</div><div class="row">x</div>', '@media print { .a { display: none; } } .row::-webkit-scrollbar { display: none; } .row:not(.open) { display: none; }'), true],
  ['page-word-quiet', page('<samp class="s">It arrives quietly.</samp><iframe srcdoc="<p>quiet</p>"></iframe>', '.s { font-family: Georgia, serif; }'), true],
  ['page-word-quiet', '<html lang="ca"><body><p>El gat es queda quiet.</p></body></html>', false],
  ['page-word-real', page('<p>Real-world numbers</p><p>Built from <b>re</b>al shops</p>'), true],
  ['page-word-real', '<html lang="es"><body><p>Vimos el Palacio Real.</p></body></html>', false],
  ['page-two-word-sentence', page('<p>When they ask, say no. Always.</p><p>Fifty a month. Fast&period; Simple．</p><p>One plan. Plain.<sup>1</sup> Flat.</p>'), true],
  ['page-two-word-sentence', page('<p>Open Mon. to Fri. at Oak Rd. with Prof. Lee and J. R. Smith.</p><p>Closed Jan. 1 for the year.</p>'), false],
  ['page-two-word-sentence', '<html lang="de"><body><p>Am 3. Oktober ist der Laden zu.</p></body></html>', false],
  ['page-dot-separator', page('<p>Mon ● Tue ⋅ Wed</p>'), true],
  ['page-dot-separator', page('<div class="r"><div>Mon</div><div>·</div><div>Tue</div></div><div class="r"><span>Mon</span><i class="d"></i><span>Tue</span></div>', '.r { display: flex; } .d { width: 4px; height: 4px; border-radius: 50%; background: #888; }'), true],
  ['page-dot-separator', page('<p>El col·legi obre. The dot product a · b. CuSO4·5H2O.</p><ul><li>Bread</li><li>Rolls</li></ul>', 'li::before { content: "\\2022"; }'), false],
  ['page-button-arrow', page('<button>Next <span aria-hidden="true">→</span></button><button>Continue &rightarrow;</button>'), true],
  ['page-button-arrow', page('<a class="btn" href="/s"><span>Start <svg></svg></span></a>'), true],
  ['page-button-arrow', page('<button class="c">Next</button>', '.c::after { content: ""; width: 6px; height: 6px; border-width: 0 2px 2px 0; border-style: solid; transform: rotate(-45deg); }'), true],
  ['page-button-arrow', page('<button><span class="ms">arrow_forward</span></button><button>Go <span class="ms">arrow_forward</span></button>', '.ms { font-family: "Material Symbols Outlined"; }'), true],
  ['page-button-arrow', page('<a class="go" href="/s">Start ➡</a><div class="go" onclick="go()">Back ←</div>', '.go { padding-inline: 20px; background: #111; }'), true],
  ['page-button-arrow', page('<button class="r"><svg></svg>Continue</button>', '.r { display: flex; flex-direction: row-reverse; }'), true],
  ['page-button-arrow', page('<button>Unread <span></span></button><button>Enregistrer « Brouillons »</button><button>Mail <span class="dot"></span></button>'), false],
  ['page-sparkle', page('<h1><span aria-hidden="true">✨</span> Team</h1>'), true],
  ['page-sparkle', page('<ul><li class="n">New</li></ul>', '.n::before { content: "\\2728"; }'), true],
  ['page-sparkle', page('<p>✶ Fresh</p>'), true],
  ['page-sparkle', page('<svg class="SparklesIcon"></svg><iconify-icon icon="lucide:sparkles"></iconify-icon>'), true],
  ['page-sparkle', page('<input placeholder="✨ Describe it"><li class="x">New</li>', '.x { background: url(/i/sparkles.svg) no-repeat; }'), true],
  ['page-sparkle', page('<img src="/p/milky-way-stars.jpg" width="900" alt="The sky"><span id="magic-link-status">We sent a link.</span>'), false],
  ['page-label-above-heading', page('<header><h6 class="eyebrow">Update</h6><h1>Sync</h1></header>'), true],
  ['page-label-above-heading', page('<header><a class="pill" href="/n">New: 2.4</a><h1>Sync</h1></header>'), true],
  ['page-label-above-heading', page('<header><span>Update</span><div><h1>Sync</h1></div></header><header><img src="l.png" alt="logo"><span>Update</span><h1>Bank</h1></header>'), true],
  ['page-label-above-heading', page('<header><h1><small>Update</small>Invoices sync</h1></header>'), true],
  ['page-label-above-heading', page('<header><div><a href="/">Home</a> / <a href="/t">Tools</a></div><h1>Spades</h1></header><header><p role="status">Saved</p><h1>Settings</h1></header>'), false],
  ['page-headline-accent', page('<h1>Software for <span class="a">calm</span> teams</h1>', '.a { font: 500 1em Georgia; } h1 { .b { font-style: italic; } }'), true],
  ['page-headline-accent', page('<h1>For <span class="a">calm</span> teams</h1>', '.a { display: inline-block; transform: skewX(-12deg); }'), true],
  ['page-headline-accent', page('<h1>For <span class="font-[\'Fraunces\'] [font-style:italic]">calm</span> teams</h1>'), true],
  ['page-headline-accent', page('<h1>Read the <a href="/d">docs</a></h1><h1><span class="ms">home</span> Home</h1><h1>For <span>small teams</span></h1><blockquote class="q">Paid <span>back</span></blockquote><h2><code>strict</code></h2><h1><i>Middlemarch</i></h1>', 'a { font-family: inherit; } .ms { font-family: "Material Icons"; } .q span { font-style: italic; }'), false],
  ['page-numbered-sections', page('<section class="s"><h2>Bank</h2></section><section class="s"><h2>Match</h2></section>', '.s::before { content: counter(n, decimal-leading-zero); }'), true],
  ['page-numbered-sections', page('<h2>Step 1: Bank</h2><h2>Step 2: Match</h2>'), true],
  ['page-numbered-sections', page('<h2>① Bank</h2><h2>② Match</h2><h2>I / Bank</h2>'), true],
  ['page-numbered-sections', page('<ul><li><span class="n">01</span>Bank</li><li><span class="n">02</span>Match</li></ul>'), true],
  ['page-numbered-sections', page('<table><tr><td>01</td><td><h2>Bank</h2></td></tr><tr><td>02</td><td><h2>Match</h2></td></tr></table>'), true],
  ['page-numbered-sections', page('<p>9:00 Standup</p><p>10:00 Demo</p><h2>12 March</h2><h2>13 March</h2><h2>2.0 Apps</h2><h2>3.0 Teams</h2><div><span>1</span><span>Maya</span></div><div><span>2</span><span>Dev</span></div>'), false],
  ['page-numbered-sections', page('<h2>1. Account</h2><p>Keep it safe.</p><h2>2. Payment</h2><p>Refunds follow section 3.</p><h2>3. Refunds</h2>'), false],
  ['page-unsourced-number', page('<ul><li><strong>98%</strong><span>matched by hand</span></li></ul>'), true],
  ['page-unsourced-number', page('<div class="s"><div><div>12x</div></div><div>faster close</div></div><div class="s"><div>$48,000</div><div>saved per team</div></div>'), true],
  ['page-unsourced-number', page('<div><b>4.95</b><span>average rating</span></div><div><b>#1</b><span>tool for studios</span></div><div><b>9</b><span>out of ten agree</span></div>'), true],
  ['page-unsourced-number', page('<div data-source=""><b>98%</b><span>matched</span></div><blockquote>Great <cite>Ana</cite></blockquote>'), true],
  ['page-unsourced-number', page('<a href="/" class="hero"><h1>Cut late invoices by 40 percent</h1></a>'), true],
  ['page-unsourced-number', page('<div class="s" data-v="98%">of invoices matched</div>', '.s::before { content: attr(data-v); display: block; }'), true],
  ['page-unsourced-number', page('<div class="r"><span>Seats</span><span>25</span></div><dl><dt>Order</dt><dd>48210</dd></dl><div><span>12</span><span>Mon</span></div><div><span>Diavola</span><span>11</span></div><div><b>98%</b><span>matched</span><p>Source: Ledger survey, March</p></div>'), false],
  ['page-all-caps', page('<p>Our CIVIC plan</p><p><span>FAS</span><span>TER</span> notes</p><p>SALE50 now</p><p>TRY IT NOW</p>'), true],
  ['page-all-caps', page('<p class="k">Fifty</p><input class="k2" type="submit" value="Buy">', '.k { font: small-caps 700 20px Georgia; } :root { --c: uppercase; } .k2 { text-transform: var(--c); }'), true],
  ['page-all-caps', page('<section class="p"><h2>Plans</h2></section>', '.p { h2 { text-transform: uppercase; } } :is(h3, .tag) { color: red; }'), true],
  ['page-all-caps', page('<p class="d">on Monday the floor was wet.</p><h2 class="sc">Plans</h2><p>FAFSA and FDIC rules, chapter VIII</p>', 'p::first-letter { text-transform: uppercase; } .sc { text-transform: none; } h2 { text-transform: uppercase; }'), false],
  ['page-emoji-icon', page('<ul><li>⚙️ Settings</li><li>1️⃣ Add a list</li></ul>'), true],
  ['page-emoji-icon', page('<div>🚀 Launch a list</div><p>&#8203;🎯 Goals</p>'), true],
  ['page-emoji-icon', page('<ul><li class="r">Launch</li></ul>', '.r::before { content: "🚀 "; }'), true],
  ['page-emoji-icon', page('<table><tr><td>👍</td><td>Seen</td></tr></table><div><p class="reply">🔥</p><p class="reply">Works here too</p></div>'), false],
  ['page-placeholder', page('<p>Dolor sit amet, consectetur adipiscing elit.</p><p>Heading goes here</p>'), true],
  ['page-placeholder', page('<h2>[Company name]</h2><p>{{headline}}</p><p>Price: TBD</p>'), true],
  ['page-placeholder', page('<p>Printers used lorem ipsum since the 1500s.</p><button>Add a description</button><p>Placeholder text is not a label.</p>'), false],
  ['page-card-grid', page('<div class="g"><a href="/a"><h3>A</h3><p>x</p></a><a href="/b"><h3>B</h3><p>y</p></a><a href="/c"><h3>C</h3><p>z</p></a></div>', '.g { display: grid; } a { display: block; }'), true],
  ['page-card-grid', page('<div class="g"><div><h3>A</h3><p>x</p></div><div><h3>B</h3><p>y</p><p>w</p></div><div><h3>C</h3><p>z</p><a href="/">go</a></div></div>', '.g { display: grid; }'), true],
  ['page-card-grid', page('<div class="r"><div class="c"><h3>A</h3><p>x</p></div><div class="c"><h3>B</h3><p>y</p></div></div><div class="r"><div class="c"><h3>C</h3><p>z</p></div><div class="c"><h3>D</h3><p>w</p></div></div>', '.r { display: flex; } .c { border: 1px solid #ccc; padding: 16px; }'), true],
  ['page-card-grid', page('<fieldset class="g"><label><p><strong>Solo</strong></p><p>One seat</p></label><label><p><strong>Team</strong></p><p>Ten seats</p></label><label><p><strong>Firm</strong></p><p>All seats</p></label></fieldset>', '.g { display: grid; } label { display: block; }'), true],
  ['page-card-grid', page('<section><h2>One</h2><p>a</p></section><section><h2>Two</h2><p>b</p></section><section><h2>Three</h2><p>c</p></section><div><h3>Q?</h3><p>A.</p></div><div><h3>R?</h3><p>B.</p></div><div><h3>S?</h3><p>C.</p></div>'), false],
  ['page-card-in-card', page('<div class="o"><span class="i">Inner</span></div>', '.o { border: 0.0625rem solid #bbb; padding: 16px; } .i { display: block; border: 1px solid #bbb; border-radius: 6px; padding: 8px; }'), true],
  ['page-card-in-card', page('<a class="o" href="/"><div class="i">Inner</div></a>', '.o { display: block; border: 1px solid #bbb; padding: 16px; } .i { background-image: linear-gradient(#eee, #eee); border-radius: 6px; padding: 8px; }'), true],
  ['page-card-in-card', page('<div class="o"><div class="i">Inner</div></div>', ':is(.o, .i) { padding: 12px; border-radius: 8px; } .o { box-shadow: inset 0 0 0 1px #bbb; } .i { border-style: solid; border-color: #bbb; }'), true],
  ['page-card-in-card', page('<div class="ring-1 rounded p-4"><div class="ring-1 rounded p-2">Inner</div></div><fieldset><div class="t">Inner</div></fieldset>', '.t { border-top: 1px solid #bbb; border-right: 1px solid #bbb; border-bottom: 1px solid #bbb; border-left: 1px solid #bbb; padding: 8px; }'), true],
  ['page-card-in-card', page('<main class="m"><article class="m">Text</article></main><div class="f"><div class="t">One frame</div></div><section class="band"><form class="fm">Ask</form></section><div class="chips"><div>Billing</div></div>', '.m { background: #fff; padding: 20px; } .f { border: 1px solid #ccc; padding: 12px; } .t { border: 1px solid transparent; padding: 4px; } .band { background: #eef; padding: 40px; } .fm { border: 1px solid #ccc; padding: 12px; } .chips div { padding: 2px; border-radius: 9px; background: #eef; }'), false],
  ['page-left-border', page('<div class="n">Moved</div>', '.n { background: linear-gradient(to right, #c0392b 4px, #fafafa 4px); }'), true],
  ['page-left-border', page('<div class="n">Moved</div>', '.n { display: flex; } .n::before { content: ""; width: 4px; background: #c0392b; }'), true],
  ['page-left-border', page('<div class="n">Moved</div>', '.n { box-shadow: -4px 0 0 0 #c0392b; }'), true],
  ['page-left-border', page('<div class="n"><div class="b"></div><div>Moved</div></div>', '.n { display: grid; grid-template-columns: 4px 1fr; } .b { background: #c0392b; }'), true],
  ['page-left-border', page('<table><tr><td class="e">Standup</td></tr></table>', '.e { border-left: thick solid crimson; }'), true],
  ['page-left-border', page('<div class="n">Moved</div>', '.n { border-width: 4px; border-color: #c0392b; border-style: none none none solid; }'), true],
  ['page-left-border', page('<div class="n">Moved</div>', '.n { position: relative; } .n::after { content: ""; position: absolute; inset-block: 0; inset-inline-start: 0; inline-size: 4px; background: #c0392b; }'), true],
  ['page-left-border', page('<div class="relative before:absolute before:left-0 before:inset-y-0 before:w-1 before:bg-red-600">Moved</div><div class="border-l-[0.25rem] border-red-600">Due</div>'), true],
  ['page-left-border', page('<div class="n">Moved</div><script>document.querySelector(".n").style.borderLeft = "4px solid #c0392b";</script>'), true],
  ['page-left-border', page('<div class="n plain">Moved</div><div class="h">Col</div><div class="g">Col</div><div class="k">Col</div>', '.n { border-left: 4px solid crimson; } .n.plain { border: 0; } .h { border-left: #2b6cb0 solid 1px; } .g { border-left: 2px solid lightgray; } .k { border-left: 2px solid var(--rule); } :root { --rule: #d8d8d8; }'), false],
  ['page-looping-motion', page('<span class="r"></span>', ':root { --spin: spin 1s linear infinite; } .r { animation: var(--spin); }'), true],
  ['page-looping-motion', page('<span class="r"></span>', '.r { animation-iteration-count: calc(infinity); }'), true],
  ['page-looping-motion', page('<svg><circle><animate id="a" begin="0s;b.end" dur="1s"/><animate id="b" begin="a.end" dur="1s"/></circle></svg>'), true],
  ['page-looping-motion', page('<span class="r"></span><script>gsap.to(".r", { rotate: 360, repeat: -1 });</script>'), true],
  ['page-looping-motion', page('<span class="r"></span><script>function spin() { r.style.rotate = t++ + "deg"; requestAnimationFrame(spin); } spin();</script>'), true],
  ['page-looping-motion', page('<span class="!animate-spin"></span><marquee>Sale</marquee>'), true],
  ['page-looping-motion', page('<div class="animate-wiggle"></div>', '@theme { --animate-wiggle: wiggle 1s infinite; }'), true],
  ['page-looping-motion', page('<div class="t">Saved</div><script>// iterations: Infinity would run forever\nt.animate([], { iterations: 1 });</script>', '.t { animation: infinite-slide .5s ease-out 1 both; }'), false],
  ['page-scroll-fade', page('<section>Hi</section><script>window.onscroll = () => { s.style.opacity = 1; };</script>', 'section { opacity: 0; }'), true],
  ['page-scroll-fade', page('<section class="b">Hi</section><script>new IntersectionObserver((es) => es.forEach((e) => { e.target.className += " seen"; }));</script>', '.b { opacity: 0; }'), true],
  ['page-scroll-fade', page('<section>Hi</section>', ':root { --t: --rise; } section { view-timeline-name: --rise; animation-timeline: var(--t); }'), true],
  ['page-scroll-fade', page('<section>Hi</section><script>ScrollReveal().reveal("section");</script>'), true],
  ['page-scroll-fade', page('<nav><a href="#a">A</a></nav><section id="a">Hi</section><div class="bar"></div><p class="reveal">Answer</p><button onclick="show()">Show</button><input type="password"><button data-reveal="pw">Show</button><a data-scroll href="#a">Up</a><script>new IntersectionObserver((es) => es.forEach((e) => links.forEach((l) => l.classList.toggle("on", l.hash === "#" + e.target.id))));\naddEventListener("scroll", () => bar.style.transform = `scaleX(${scrollY})`);</script>', '.reveal { opacity: 0; } .bar { animation-timeline: scroll(); }'), false],
  ['page-glow', page('<div class="b"></div>', ':root { --soft: 90px; } .b { filter: blur(var(--soft)); }'), true],
  ['page-glow', page('<div class="b"></div><svg><filter id="s"><feGaussianBlur stdDeviation="60"/></filter></svg>', '.b { filter: url(#s); }'), true],
  ['page-glow', page('<div class="b">Hi</div>', '.b { box-shadow: 0 0 24px cyan, 0 0 28px cyan; }'), true],
  ['page-glow', page('<div class="b">Hi</div>', '.b { box-shadow: 0 30px 80px -20px rgba(124, 92, 255, .8); }'), true],
  ['page-glow', page('<div class="b">Hi</div>', '.b { box-shadow: 0 0 90px 10px dodgerblue; }'), true],
  ['page-glow', page('<img class="o" src="b.png" alt="" aria-hidden="true"><div class="!blur-3xl"></div>', 'img.o { filter: blur(90px); }'), true],
  ['page-glow', page('<div class="b"></div>', '.b { animation: in .4s 1 forwards; } @keyframes in { to { filter: BLUR(90px); } }'), true],
  ['page-glow', page('<svg><defs><radialGradient id="g"><stop offset="1" stop-opacity="0"/></radialGradient></defs><circle r="200" fill="url(#g)"/></svg>'), true],
  ['page-glow', page('<div class="c">Card</div><span class="sp">3 to 1</span><p>Hi</p>', '.c { box-shadow: 0 20px 60px rgba(16, 24, 40, .12), 0 24px 60px rgba(92, 64, 32, .14); } .sp { filter: blur(6px); } body { background: radial-gradient(#ccc 1px, transparent 1px) 0 0/16px 16px; }'), false],
  ['page-glass', page('<nav class="n">Hi</nav><script>n.style.backdropFilter = "blur(16px)";</script>'), true],
  ['page-glass', page('<nav>Hi</nav><script>const s = document.createElement("style"); s.textContent = ".n { backdrop-filter: blur(16px) }";</script>'), true],
  ['page-glass', page('<nav class="[backdrop-filter:blur(16px)]">Hi</nav>'), true],
  ['page-glass', page('<nav class="n">Hi</nav>', '.n { backdrop-filter: blur(0); }'), false],
  ['page-gradient-text', page('<h1 class="h">Hi</h1>', '.h { color: transparent; background: linear-gradient(90deg, red, blue) text; }'), true],
  ['page-gradient-text', page('<svg><g fill="url(#g)"><text>Hi</text></g></svg>'), true],
  ['page-gradient-text', page('<div class="w"><div class="t">482 builds</div></div>', '.w { background: linear-gradient(90deg, red, blue); } .t { background: #fff; mix-blend-mode: lighten; }'), true],
  ['page-banned-font', page('<p>Hi</p>', '', '<link rel="stylesheet" href="https://rsms.me/inter/inter.css">'), true],
  ['page-banned-font', page('<svg><text font-family="Inter, sans-serif">Hi</text></svg><font face="Roboto">Hi</font>'), true],
  ['page-banned-font', page('<p>Hi</p><script>new FontFace("Brand", "url(/f/InterVariable.woff2)");</script>'), true],
  ['page-banned-font', page('<p>Hi</p>', '@font-face { font-family: InterBold; src: url(f.woff2); } @import url("https://fonts.googleapis.com/css2?family=Instrument%20Serif");'), true],
  ['page-banned-font', page('<p class="font-[\'Playfair_Display\']">Hi</p>'), true],
  ['page-banned-font', page('<p>Hi</p>', ':root { --map: url("img/inter-island-map.png"); --gap: var(--inter-item-gap); } body { font-family: Interstate, serif; }'), false],
  ['page-noise', page('<div class="g"></div>', '.g { background-image: url("data:image/svg+xml;base64,PHN2Zz48ZmlsdGVyPjxmZVR1cmJ1bGVuY2UvPjwvZmlsdGVyPjwvc3ZnPg=="); }'), true],
  ['page-noise', page('<canvas id="c"></canvas><script>const d = x.createImageData(9, 9); d.data[0] = Math.random() * 255; x.putImageData(d, 0, 0);</script>'), true],
  ['page-noise', page('<img class="t" alt="" src="tile.png">', 'img.t { position: fixed; inset: 0; image-rendering: pixelated; }'), true],
  ['page-noise', page('<p>Hi</p>', 'body::before { content: ""; position: fixed; inset: 0; background: repeating-conic-gradient(#000 0 25%, #fff 0 50%) 0 0/3px 3px; }'), true],
  ['page-noise', page('<div class="noise-cancelling">On</div><span class="noise-level">Loud</span><img src="/img/grain-silo.jpg" alt="A silo"><div class="qr" role="img" aria-label="Ticket"></div><img class="px" src="s.png" alt="A level">', '.qr, .px { image-rendering: pixelated; }'), false],
];

test('every rule has a failing page and a twin, and a twin that hides the problem is still caught', () => {
  for (const rule of PAGE_RULES) {
    const pair = CASES[rule.id];
    assert.ok(pair && pair.length === 2, `${rule.id} has no failing page and twin`);
    assert.ok(fired(pair[0]).has(rule.id), `${rule.id} missed its failing page`);
    assert.ok(fired(pair[1]).has(rule.id), `${rule.id} missed its twin`);
  }
  assert.deepEqual(Object.keys(CASES).sort(), PAGE_RULES.map((r) => r.id).sort());
});

test('each way around a rule is caught, and each honest page like it passes', () => {
  const wrong = ATTACKS.filter(([rule, html, should]) => fired(html).has(rule) !== should).map(([rule, html, should]) => `${rule} should ${should ? 'fire' : 'pass'}: ${html.slice(html.indexOf('<body>') + 6, html.indexOf('<body>') + 90)}`);
  assert.deepEqual(wrong, []);
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
