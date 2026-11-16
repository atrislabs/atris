'use strict';

// atris nexus import <file.csv>, with every backend call faked. No real list is read or
// changed. Only made-up people appear here, in files made in a temporary folder that is
// removed when the tests end.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { nexusCommand } = require('../commands/nexus');
const { parseCsv, readPeople } = require('../commands/nexus-import');

const NOW = new Date(2026, 10, 16, 21);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-import-test-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

let count = 0;
function file(text, name = `people-${++count}.csv`) {
  const target = path.join(dir, name);
  fs.writeFileSync(target, text);
  return target;
}

// LinkedIn's own file: note lines (one in quotes, over several lines) above the header row.
const LINKEDIN = [
  'Notes:',
  '"When exporting your connection data, you may notice that some of the email addresses are missing.',
  'You can check or change this setting here: https://www.linkedin.com/psettings/privacy/email"',
  '',
  'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
  'Rae,Sample,https://www.linkedin.com/in/rae-sample,rae@example.com,Sample Co,Founder,15 Nov 2026',
  'Bo,Example,https://www.linkedin.com/in/bo-example,,"Example, Inc.",Designer,14 Nov 2026',
  ',,https://www.linkedin.com/in/private-person,,,,13 Nov 2026',
  'Rae,Sample,https://www.linkedin.com/in/rae-sample/,rae@example.com,Sample Co,Founder,15 Nov 2026',
  'Dee,Stand-In,https://www.linkedin.com/in/dee-stand-in,dee@example.com,Stand-In Ltd,,12 Nov 2026',
  '',
].join('\n');
const PRIVATE = ['Rae', 'Sample', 'Bo Example', 'Example, Inc.', 'Stand-In', 'rae@example.com', 'dee@example.com', 'Founder', 'Designer'];

function backend({ imported, fail } = {}) {
  const state = { calls: [], imports: [] };
  const request = async (pathname, options = {}) => {
    assert.ok(options.token, 'every call carries the login token');
    const method = options.method || 'GET';
    state.calls.push({ method, path: pathname, retries: options.retries });
    if (method === 'POST' && pathname === '/nexus/import') {
      state.imports.push(options.body);
      if (fail && fail(state.imports.length)) return { ok: false, status: 500, data: {} };
      const nodes = options.body.nodes.length;
      const answer = imported ? imported(options.body, state.imports.length) : {
        created: nodes - 1, matched: 1, skipped: 0, ties_added: 0, touches_added: 0,
        skipped_reasons: {}, skipped_examples: [{ at: 0, name: 'Name That Must Not Print', reason: 'no name' }], conflicts: [],
      };
      return { ok: true, status: 200, data: answer };
    }
    return { ok: false, status: 404, data: { detail: 'Not Found' } };
  };
  return { state, request };
}

async function run(args, server = backend(), deps = {}) {
  const out = [];
  const errs = [];
  const code = await nexusCommand(args, {
    log: (line) => out.push(String(line)),
    err: (line) => errs.push(String(line)),
    getToken: async () => ({ token: 'tok' }),
    apiRequestJson: server.request,
    now: () => NOW,
    ...deps,
  });
  return { code, out: out.join('\n'), err: errs.join('\n'), server };
}

test('a dry run on LinkedIn Connections.csv prints counts only, sends nothing and does not even sign in', async () => {
  const server = backend();
  const { code, out, err } = await run(['import', file(LINKEDIN, 'Connections.csv')], server, { getToken: async () => { throw new Error('a dry run never signs in'); } });
  assert.equal(code, 0, err);
  assert.match(out, /Read 5 rows from .*Connections\.csv\./);
  assert.match(out, /^4 have a name\.$/m);
  assert.match(out, /^3 people would be sent \(1 repeat within the file left out\)\.$/m);
  assert.match(out, /Columns found: name \(First Name \+ Last Name\), email \(Email Address\), company \(Company\), title \(Position\), linkedin \(URL\)./);
  assert.match(out, /Dry run: nothing was sent\. To send them: atris nexus import .*Connections\.csv --yes/);
  for (const secret of PRIVATE) assert.ok(!(out + err).includes(secret), `the dry run never prints ${secret}`);
  assert.equal(server.state.calls.length, 0, 'a dry run makes no call at all');
});

test('--dry-run is the same as the default, and wins over --yes', async () => {
  const server = backend();
  const same = await run(['import', file(LINKEDIN), '--dry-run'], server);
  assert.equal(same.code, 0);
  assert.match(same.out, /Dry run: nothing was sent\./);
  const both = await run(['import', file(LINKEDIN), '--dry-run', '--yes'], server);
  assert.equal(both.code, 0);
  assert.match(both.out, /Dry run: nothing was sent\./);
  assert.equal(server.state.calls.length, 0);
});

test('--json on a dry run is counts and header words only', async () => {
  const server = backend();
  const { code, out } = await run(['import', '--json', file(LINKEDIN)], server);
  assert.equal(code, 0);
  const data = JSON.parse(out);
  assert.equal(data.ok, true);
  assert.equal(data.dry_run, true);
  assert.equal(data.sent, false);
  assert.equal(data.rows_read, 5);
  assert.equal(data.rows_with_name, 4);
  assert.equal(data.would_send, 3);
  assert.equal(data.repeats_in_file, 1);
  assert.deepEqual(data.columns, { name: 'First Name + Last Name', email: 'Email Address', company: 'Company', title: 'Position', linkedin: 'URL' });
  for (const secret of PRIVATE) assert.ok(!out.includes(secret), `the JSON never holds ${secret}`);
  assert.equal(server.state.calls.length, 0);
});

test('--yes sends the people in the request body to /nexus/import, once, and prints counts only', async () => {
  const server = backend();
  const { code, out, err } = await run(['import', file(LINKEDIN), '--yes'], server);
  assert.equal(code, 0, err);
  assert.deepEqual(server.state.calls, [{ method: 'POST', path: '/nexus/import', retries: 0 }]);
  const body = server.state.imports[0];
  assert.deepEqual(body.edges, []);
  assert.deepEqual(body.nodes, [
    { t: 'p', n: 'Rae Sample', title: 'Founder', co: 'Sample Co', email: 'rae@example.com', links: ['https://www.linkedin.com/in/rae-sample'] },
    { t: 'p', n: 'Bo Example', title: 'Designer', co: 'Example, Inc.', links: ['https://www.linkedin.com/in/bo-example'] },
    { t: 'p', n: 'Dee Stand-In', co: 'Stand-In Ltd', email: 'dee@example.com', links: ['https://www.linkedin.com/in/dee-stand-in'] },
  ]);
  assert.match(out, /^Sent 3 people: 2 new, 1 already there\.$/m);
  assert.ok(!out.includes('Name That Must Not Print'), 'the store\'s skipped examples carry names and are dropped');
  for (const secret of PRIVATE) assert.ok(!(out + err).includes(secret), `the answer never prints ${secret}`);
});

test('--yes --json prints the counts the store gave, with no examples and no names', async () => {
  const server = backend({
    imported: () => ({ created: 2, matched: 0, skipped: 1, ties_added: 0, touches_added: 0, skipped_reasons: { 'could not save': 1 }, skipped_examples: [{ at: 2, name: 'Name That Must Not Print', reason: 'could not save' }], conflicts: [{ at: 1, person_id: 'x', email: 'secret@example.com' }] }),
  });
  const { code, out } = await run(['import', file(LINKEDIN), '--yes', '--json'], server);
  assert.equal(code, 0);
  const data = JSON.parse(out);
  assert.equal(data.ok, true);
  assert.equal(data.sent, true);
  assert.equal(data.sent_count, 3);
  assert.equal(data.created, 2);
  assert.equal(data.skipped, 1);
  assert.equal(data.conflicts, 1);
  assert.deepEqual(data.skipped_reasons, { 'could not save': 1 });
  assert.ok(!out.includes('Name That Must Not Print') && !out.includes('secret@example.com'));
});

test('a plain CSV with its own header words: quotes, line breaks inside quotes, a byte order mark and CRLF', async () => {
  const csv = '﻿"Full Name","E-mail","Organization","Job Title","Location","LinkedIn Profile","Website"\r\n'
    + '"Rae Sample","rae@example.com","Sample Co","Founder, CEO","Austin, TX","linkedin.com/in/rae-sample","https://sample.example"\r\n'
    + '"Bo ""B"" Example","not an address","","Designer\nand writer","","",""\r\n';
  const server = backend();
  const { code, out } = await run(['import', file(csv), '--yes'], server);
  assert.equal(code, 0, out);
  assert.deepEqual(server.state.imports[0].nodes, [
    { t: 'p', n: 'Rae Sample', title: 'Founder, CEO', co: 'Sample Co', city: 'Austin, TX', email: 'rae@example.com', links: ['linkedin.com/in/rae-sample', 'https://sample.example'] },
    { t: 'p', n: 'Bo "B" Example', title: 'Designer and writer' },
  ]);
});

test('column guessing from header words, in any order, with one column never used twice', () => {
  const got = readPeople('Company Name,Name,Mail,Role,City,URL\nSample Co,Rae Sample,rae@example.com,Founder,Austin,https://www.linkedin.com/in/rae-sample\n');
  assert.deepEqual(got.columns, { name: 'Name', email: 'Mail', company: 'Company Name', title: 'Role', city: 'City', linkedin: 'URL' });
  assert.deepEqual(got.people[0], { t: 'p', n: 'Rae Sample', title: 'Founder', co: 'Sample Co', city: 'Austin', email: 'rae@example.com', links: ['https://www.linkedin.com/in/rae-sample'] });
  const first = readPeople('first,surname,employer\nRae,Sample,Sample Co\n');
  assert.equal(first.people[0].n, 'Rae Sample');
  assert.equal(first.people[0].co, 'Sample Co');
  const only = readPeople('Name\nRae Sample\n');
  assert.equal(only.people.length, 1);
});

test('other delimiters: a semicolon file and a tab file read the same way', () => {
  assert.equal(readPeople('Name;Email;Company\nRae Sample;rae@example.com;Sample Co\n').people[0].co, 'Sample Co');
  assert.equal(readPeople('Name\tEmail\tCompany\nRae Sample\trae@example.com\tSample Co\n').people[0].email, 'rae@example.com');
});

test('repeats inside the file are left out only when an email, a LinkedIn link or a name with a company agree; two people sharing a name are both sent', () => {
  const got = readPeople([
    'Name,Email,Company,URL',
    'Rae Sample,rae@example.com,,',
    'R. Sample,RAE@example.com,,',
    'Bo Example,,Example Inc,',
    'Bo Example,,example inc,',
    'Sam Same,,,https://www.linkedin.com/in/sam-one',
    'Sam Same,,,https://www.linkedin.com/in/sam-two',
    'Pat Plain,,,',
    'Pat Plain,,,',
  ].join('\n'));
  assert.equal(got.read, 8);
  assert.equal(got.named, 8);
  assert.deepEqual(got.people.map((p) => p.n), ['Rae Sample', 'Bo Example', 'Sam Same', 'Sam Same', 'Pat Plain', 'Pat Plain']);
  assert.equal(got.repeats, 2);
});

test('a file with no name column is refused with the header words it needs, and nothing is sent', async () => {
  const server = backend();
  const { code, err } = await run(['import', file('Email,Company\nrae@example.com,Sample Co\n'), '--yes'], server);
  assert.equal(code, 1);
  assert.match(err, /could not find a header row with a name column/);
  assert.ok(!err.includes('rae@example.com'));
  assert.equal(server.state.calls.length, 0);
  const json = await run(['import', '--json', file('Email,Company\nrae@example.com,Sample Co\n')], server);
  assert.equal(JSON.parse(json.out).ok, false);
});

test('a missing file, a folder, no file and two files each stop with one plain line', async () => {
  const server = backend();
  const missing = await run(['import', path.join(dir, 'nope.csv')], server);
  assert.equal(missing.code, 2);
  assert.match(missing.err, /No file at /);
  const folder = await run(['import', dir], server);
  assert.equal(folder.code, 2);
  assert.match(folder.err, /is not a file/);
  const none = await run(['import'], server);
  assert.equal(none.code, 2);
  assert.match(none.err, /needs a CSV file/);
  const two = await run(['import', file(LINKEDIN), file(LINKEDIN)], server);
  assert.equal(two.code, 2);
  assert.match(two.err, /takes one file/);
  assert.equal(server.state.calls.length, 0);
});

test('a typo in a flag never sends: --yes takes no value and unknown flags are refused', async () => {
  const server = backend();
  const value = await run(['import', file(LINKEDIN), '--yes=no'], server);
  assert.equal(value.code, 2);
  assert.match(value.err, /--yes takes no value/);
  const typo = await run(['import', file(LINKEDIN), '--yess'], server);
  assert.equal(typo.code, 2);
  assert.match(typo.err, /does not take --yess/);
  assert.equal(server.state.calls.length, 0);
});

test('--yes with no one signed in sends nothing', async () => {
  const server = backend();
  const { code, err } = await run(['import', file(LINKEDIN), '--yes'], server, { getToken: async () => ({ token: '' }) });
  assert.equal(code, 1);
  assert.match(err, /[Ss]ign in|atris login/);
  assert.equal(server.state.calls.length, 0);
});

test('a big file goes in batches of 500, the counts add up, and a failure says how many went before it', async () => {
  const rows = ['Name,Email'];
  for (let i = 0; i < 1203; i++) rows.push(`Person ${i},p${i}@example.com`);
  const big = file(rows.join('\n'));

  const ok = backend({ imported: (body) => ({ created: body.nodes.length, matched: 0, skipped: 0, ties_added: 0, touches_added: 0, skipped_reasons: {}, skipped_examples: [], conflicts: [] }) });
  const done = await run(['import', big, '--yes'], ok);
  assert.equal(done.code, 0, done.err);
  assert.deepEqual(ok.state.imports.map((b) => b.nodes.length), [500, 500, 203]);
  assert.match(done.out, /Sent 1203 people: 1203 new, 0 already there\./);

  const broken = backend({ fail: (n) => n === 2, imported: (body) => ({ created: body.nodes.length, matched: 0, skipped: 0, skipped_reasons: {}, conflicts: [] }) });
  const stopped = await run(['import', big, '--yes'], broken);
  assert.equal(stopped.code, 1);
  assert.match(stopped.err, /500 people were sent before it stopped\. Running the same command again is safe/);
  assert.equal(broken.state.imports.length, 2);
});

test('skipped rows are counted by reason, never by name', async () => {
  const server = backend({ imported: () => ({ created: 1, matched: 1, skipped: 1, skipped_reasons: { 'could not save': 1 }, skipped_examples: [{ at: 2, name: 'Name That Must Not Print', reason: 'could not save' }], conflicts: [{ at: 0 }] }) });
  const { out } = await run(['import', file(LINKEDIN), '--yes'], server);
  assert.match(out, /Sent 3 people: 1 new, 1 already there, 1 skipped\./);
  assert.match(out, /Skipped because: could not save 1\./);
  assert.match(out, /1 person had an email or LinkedIn already on another card and was not merged\./);
  assert.ok(!out.includes('Name That Must Not Print'));
});

test('a locked plan stops with the plan line', async () => {
  const server = { state: { calls: [] }, request: async () => ({ ok: false, status: 402, data: { detail: 'plan' } }) };
  const { code, err } = await run(['import', file(LINKEDIN), '--yes'], server);
  assert.equal(code, 1);
  assert.match(err, /Nexus needs a paid plan/);
});

test('--yes on a file where no row has a name sends nothing', async () => {
  const server = backend();
  const { code, out } = await run(['import', file('Name,Email\n,a@example.com\n  ,b@example.com\n'), '--yes'], server);
  assert.equal(code, 0);
  assert.match(out, /Nothing to send: no row has a name\./);
  assert.equal(server.state.calls.length, 0);
});

test('bring-over is still the way to send the saved list, and import is a separate way for a file on this computer', async () => {
  const help = await run(['--help']);
  assert.match(help.out, /atris nexus bring-over\s+send your saved list to the store/);
  assert.match(help.out, /atris nexus import <file\.csv>/);
  assert.match(help.out, /atris nexus capture "<any text>"/);
});

test('the CSV reader keeps quoted commas, doubled quotes and a last line with no line break', () => {
  assert.deepEqual(parseCsv('a,"b,c","d ""e"" f"\n1,2,3'), [['a', 'b,c', 'd "e" f'], ['1', '2', '3']]);
  assert.deepEqual(parseCsv('﻿a,b\r\n\r\nc,d\r\n'), [['a', 'b'], [''], ['c', 'd']]);
});
