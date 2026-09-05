---
validator: backend-independent-validator
executed_by: Codex independent review context
independent: true
decision: block
reviewed_diff_sha256: 61de36fc15d3c08c393e2e458e86a56234a165e8c756167866970164c3c1673e
scope: commands/pack.js, lib/pack-capabilities.js, test/pack-run.test.js
evidence_class: local fixtures and simulated runners
---

# Finished-code independent review

The ordinary recovery path and the repaired lost-event checks pass, but one contradictory history is still accepted. I did not author, execute implementation work, or repair either author's product changes. No commit or push was performed.

## Blocking finding

**Medium: recorded shell use is accepted under a file-only launch ceiling.** In `lib/pack-capabilities.js`, `pairPackFileEffects` recognizes Bash as a known tool and skips non-file `used` and `failed` events. `requireExactToolCeiling` validates the declared launch ceiling, but `assessPackRecoveryJournal` never rejects actual recorded tools outside that ceiling. A journal with pack.write-only launch grants, a `used` Bash event carrying host.shell, and a terminal nonzero exit therefore passes assessment with zero protected files. Its generated summary openly lists Bash in usedTools. This is contradictory authoritative history and may represent untracked shell effects; the bounded plan requires refusal of prior shell effects and contradictory histories before launch. It is not a demonstrated ordinary-run shell escape, but it fails the explicit corrupt-history acceptance contract.

Reproduction used actual exported receipt creation, append, summary, and assessment functions; no Bash command, model, or customer action was executed. Temporary evidence: `/var/folders/p2/s2tg3j6n1v9bwsbcqrjxnvnh0000gn/T/pack-final-independent-gmJUeQ`.

Run from the reviewed repository:

```sh
node <<'NODE'
const fs = require('fs'), os = require('os'), path = require('path');
const c = require('./lib/pack-capabilities');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-final-independent-'));
const root = path.join(dir, 'pack'); fs.mkdirSync(root);
const manifest = { slug: 'review', version: '0.1.0' };
const policy = c.resolvePackCapabilityPolicy(['pack.write']);
const r = c.beginPackRunReceipt(root, manifest, policy, { receiptDir: path.join(dir, 'receipts') });
c.appendReceiptEvent(r.eventsPath, { event: 'used', tool: 'Bash', capability: 'host.shell', at: new Date().toISOString() });
c.appendReceiptEvent(r.eventsPath, { event: 'exit', status: 1, signal: null, at: new Date().toISOString() });
c.finalizePackRunReceipt(r.receiptPath, r.eventsPath);
console.log(c.assessPackRecoveryJournal({ packDir: root, manifest, policy, parentReceiptPath: r.receiptPath }).protectedFiles);
NODE
```

Observed: exit 0, `[]`. Expected: refusal. Validate recorded used/failed tools against the granted ceiling and refuse Bash effects even if launch metadata claims shell was unavailable. Cover both used and failed shell events before runner invocation; keep ordinary denied-tool attempts usable because a denial is not proof of an effect.

## Exact checks

- `node --test test/pack-run.test.js test/pack-safety.test.js test/pack.test.js test/config-guard.test.js`, executed unpiped: exit 0, 188 passed, 0 failed, 0 skipped; duration 4287.395291 ms.
- `git diff --check`: exit 0, no whitespace errors.
- SHA-256 above computed with Python hashlib over exact bytes from `git diff -- commands/pack.js lib/pack-capabilities.js test/pack-run.test.js`.
- Independent inline Node diagnostic above: exit 0, contradictory shell history accepted. Exit 0 means the diagnostic completed, not acceptance.

## Direct inspection and positive evidence

Read the owner plan, prior two review receipts, role bundle, repository instructions, completed command/library diff, and recovery regression tests. Inspected flag presence handling, assessment-before-claim ordering, runner receipt callback before process exit, exclusive claim creation, unchanged lifecycle classifier, identity pairing, file hash/inode checks, inherited protection, mutation pre-hook ordering, journal privacy, and the owner's final journal-derived effect/protection comparison.

The final comparison recomputes both fileEffects and merged protection independently from events, so it rejects the prior lost-completion, lost-pending, emptied-summary, and emptied-inherited cases without treating an honestly empty chain as corrupt. Required suite exercises real temporary file edits and hooks: repeated completed edits deny, another file proceeds, transitive paths remain protected, failed absent effects can resolve, pending or changed effects refuse, inode/hardlink cases refuse or deny, and journal write failures yield pre-hook exit 2. Claims are linked before a simulated process.exit and cannot be reused. These are meaningful local proofs, not prompt-only assertions.

## Limits

No live Claude session, external services, credentials, production data, deployment, or customer action. Tests simulate runners while using real local files and hooks. Review does not establish general exactly-once execution, machine power-loss durability, or safety against concurrent external filesystem tampering. In-root receipt overrides cannot back recovery; recovery placement checks and mutation guards enforce that boundary. Independent re-review is required after repair before landing.
