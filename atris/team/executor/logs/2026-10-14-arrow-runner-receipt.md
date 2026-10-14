# Arrow runner recording receipt

- changed: the launch guard follows known same-file runner arguments into parenthesized const/let arrow functions, including indented helpers, async arrows, concise bodies, and copied profile members.
- files: test/engine-resource.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/team/executor/logs/2026-10-14.md, and this receipt.
- plan: arrow runner argument -> launching function -> nearby recording -> repository scan.
- red first: the first new arrow assertion failed with exit 1 before the implementation, returning no missing launches.
- real surface: `node --test --test-name-pattern='every engine started through' test/engine-resource.test.js` rejected a temporary source file at commands/engine-arrow-recording-probe.js:2 program, exit 1. The probe was removed in a finally block.
- metric: eight regression assertions; the focused repository scans see five literal launches and eight variable launches, with zero missing recordings.
- review: independent cross-model review caught missing indentation support; the fix uses the innermost containing function span. The follow-up review found no new blocker.
- limits: this is a text scan, not a JavaScript parser. Unparenthesized arrow parameters remain unsupported. Existing alias lookup can confuse an outer runner declaration with a shadowing nested parameter.
- verify: `node --test test/engine-resource.test.js test/engine-dispatch.test.js`, exit 0. Raw output: /tmp/engine-arrow-final.log.

```text
real engine launch scan: 5 launches by name, 0 unrecorded
real runner and profile launch scan: 8 engine launches through a variable, 0 unrecorded
tests 148
pass 148
fail 0
```

- whitespace: `git diff --check`, exit 0; saved task proof at atris/runs/2026-10-14-task-ecm-6-2026-10-14T21-41-13-882Z.json.
- prose: `node bin/atris.js slop detect atris/MAP.md atris/refs/MAP-NOTES.md`, exit 0, clean in both files.
- setup: brain activation and compilation both returned plan-only, exit 2; generated policy adapters were left unchanged to keep this slice bounded.
- next_push: keep outer runner declarations from overriding shadowing parameters in nested launch helpers.
- layer: capabilities
