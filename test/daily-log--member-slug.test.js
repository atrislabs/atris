const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { memberSlug } = require('../lib/daily-log');

// memberSlug only reads the disk under the root it is given, so each test
// builds its own throwaway workspace in the OS temp dir and never touches HOME.
function makeWorkspace(members) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-slug-'));
  for (const [slug, withMemberFile] of Object.entries(members)) {
    const dir = path.join(root, 'atris', 'team', slug);
    fs.mkdirSync(dir, { recursive: true });
    if (withMemberFile) fs.writeFileSync(path.join(dir, 'MEMBER.md'), `# ${slug}\n`, 'utf8');
  }
  return root;
}

test('memberSlug returns the trimmed slug when the member has a MEMBER.md', () => {
  const root = makeWorkspace({ ada: true, 'web.dev_2-x': true });
  try {
    assert.strictEqual(memberSlug(root, 'ada'), 'ada');
    assert.strictEqual(memberSlug(root, '  ada\t'), 'ada');
    assert.strictEqual(memberSlug(root, 'web.dev_2-x'), 'web.dev_2-x');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('memberSlug returns null for unknown, unsafe, or empty names', () => {
  const root = makeWorkspace({ ada: true, bare: false });
  try {
    // A well-formed name with no team folder is unknown.
    assert.strictEqual(memberSlug(root, 'ghost'), null);
    // A team folder with no MEMBER.md does not count as a member.
    assert.strictEqual(memberSlug(root, 'bare'), null);
    // Path-shaped names are rejected by the character check, even though
    // this path would resolve to the real ada/MEMBER.md on disk.
    assert.strictEqual(memberSlug(root, '../team/ada'), null);
    assert.strictEqual(memberSlug(root, 'ada/../ada'), null);
    assert.strictEqual(memberSlug(root, 'ada evil'), null);
    // Empty and missing input never reach the disk check.
    assert.strictEqual(memberSlug(root, ''), null);
    assert.strictEqual(memberSlug(root, '   '), null);
    assert.strictEqual(memberSlug(root, undefined), null);
    assert.strictEqual(memberSlug(root, null), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
