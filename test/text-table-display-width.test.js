'use strict';

// Terminal tables count columns the way a terminal draws them, so a team
// writing in any language, or with emoji, still gets a square box at 80.

const test = require('node:test');
const assert = require('node:assert/strict');

const { clipText, displayWidth, renderTable, wrapText } = require('../lib/text-table');
const { teamBox } = require('../lib/gm-bet');

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const clusters = text => Array.from(SEGMENTER.segment(text), part => part.segment);

const CJK = '界'.repeat(32);
const ZWJ = '👩‍💻 writes code, 🧑🏽‍🔬 runs the lab, 👨‍👩‍👧 looks after the whole team every day';
const ACCENT = 'café owner who keeps the résumé file and the crème brûlée list up to date';
const MIXED = '界面を作る 👩‍💻 café Ａ full width 🇺🇸 flag ❤️ and plain words to wrap';

// the display column of every character matching `marks` on a line
function columnsOf(line, marks) {
  const out = [];
  let col = 0;
  for (const cluster of clusters(line)) {
    if (marks.test(cluster)) out.push(col);
    col += displayWidth(cluster);
  }
  return out;
}

// every line exactly `width` columns, and every divider under the top rule's
function assertSquare(text, width, what) {
  const lines = text.split('\n');
  for (const line of lines) assert.equal(displayWidth(line), width, `${what} is ${displayWidth(line)} wide: ${line}`);
  const rule = columnsOf(lines[0], /^[┌┬┐]$/);
  for (const line of lines.slice(1)) assert.deepEqual(columnsOf(line, /^[│├┼┤└┴┘]$/), rule, `${what} dividers moved: ${line}`);
}

// the role column's pieces, put back together, are the whole role with no
// cluster split or lost
function roleBack(text) {
  return text.split('\n').slice(3, -1).map(line => line.split('│')[2].trim()).join(' ');
}
const sameClusters = (a, b) => assert.deepEqual(clusters(a.replace(/ /g, '')), clusters(b.replace(/ /g, '')));

test('display width counts terminal columns: wide 2, joiners and marks 0, a joined emoji 2', () => {
  assert.equal(displayWidth('界'), 2);
  assert.equal(displayWidth('Ａ'), 2, 'fullwidth');
  assert.equal(displayWidth('ｱ'), 1, 'halfwidth stays 1');
  assert.equal(displayWidth('한'), 2);
  assert.equal(displayWidth('👩‍💻'), 2, 'an emoji joined with U+200D is one cluster');
  assert.equal(displayWidth('👨‍👩‍👧'), 2);
  assert.equal(displayWidth('👍🏽'), 2, 'a skin tone joins its emoji');
  assert.equal(displayWidth('🇺🇸'), 2, 'a flag is one cluster');
  assert.equal(displayWidth('❤️'), 2, 'U+FE0F asks for the emoji');
  assert.equal(displayWidth('❤'), 1);
  assert.equal(displayWidth('café'), 4, 'a combining accent takes no column');
  assert.equal(displayWidth('‍'), 0);
  assert.equal(displayWidth('plain words'), 11);
});

test('a cut and a wrap never split a cluster', () => {
  assert.equal(clipText('👩‍💻👩‍💻👩‍💻', 4), '👩‍💻…');
  assert.equal(clipText(CJK, 9), `${'界'.repeat(4)}…`);
  assert.equal(clipText('café au lait', 5), 'café…');
  assert.deepEqual(wrapText('界'.repeat(5), 4), ['界界', '界界', '界']);
  assert.deepEqual(wrapText('👩‍💻👩‍💻👩‍💻', 4), ['👩‍💻👩‍💻', '👩‍💻']);
  for (const line of wrapText(MIXED, 12)) assert.ok(displayWidth(line) <= 12, line);
});

test('the team box stays exactly 80 columns at 80 with CJK, a joined emoji, a combining accent, and a mixed row', () => {
  const cases = [
    ['CJK', [{ member: 'builder', status: 'idle' }], { role: CJK, ovr: '91', engine: 'claude opus 5.5' }, CJK],
    ['emoji ZWJ', [{ member: 'builder', status: 'idle' }], { role: ZWJ, ovr: '91', engine: 'claude opus 5.5' }, ZWJ],
    ['combining accent', [{ member: 'builder', status: 'idle' }], { role: ACCENT, ovr: '91', engine: 'claude opus 5.5' }, ACCENT],
    ['mixed row', [{ member: '界面', status: '進行中 👍🏽 working on it' }], { role: MIXED, ovr: 'new', engine: 'codex gpt-6.1-sol' }, MIXED],
  ];
  for (const [what, rows, cell, role] of cases) {
    const box = teamBox(rows, new Map([[rows[0].member, cell]]), { width: 80 });
    assert.ok(box, `${what}: the box draws`);
    assertSquare(box, 80, what);
    sameClusters(roleBack(box), role);
  }
});

test('the plain table lines up its columns in terminal columns too', () => {
  const text = renderTable([{ header: 'member' }, { header: 'role' }], [['界面', 'designs'], ['👩‍💻', 'codes'], ['café', 'brews']], { width: 80 });
  // the column where the second cell starts, after the first cell and its gap
  const starts = text.split('\n').map((line) => {
    const m = /^(.*?\S)( {2,})\S/u.exec(line);
    return displayWidth(m[1] + m[2]);
  });
  assert.deepEqual(starts, [8, 8, 8, 8], text);
});
