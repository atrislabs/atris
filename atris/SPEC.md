# Atris spec

> Draft written by an agent from the repo's own history on 2026-11-19, for Keshav to rewrite in his own words. Agents may only add examples to the Wall of shame.

## North stars

1. **A win counts only when it is checked.** A skipped check, a partial fallback or a mocked run is not proof. Say what was not checked.
2. **Plain words for people and agents.** Every line a person or an agent reads gets the same care. Spend every token on purpose.
3. **Delete before you add.** Try the change that removes or merges code first. Net negative lines are a win.
4. **Fast is the feature.** Measure the time above the model's own time and drive it down.
5. **The person's time is the scarce thing.** Agents keep going without waiting. Only money, people and security wait for a yes.

## Wall of shame

Each heading is a mistake this repo has made more than once. `atris code-review` gives every change one reviewer per heading that applies.

### Over-testing (checked by CI, 2 examples)

A change may not add more net test lines than source lines.

- **Generated line tests** (2026-10-23): a mutation run wrote one test file per surviving line, 43 lines each, in commits named "Catch a missed break in <file> line <n>". 1,225 such commits; 1,017 of the repo's 2,633 test files are these. Each pins one line, not a behavior.
- **Tests twice the size of the code** (2026-09-01 to 2026-11-19): net 273,548 test lines against 145,011 source lines.

### Arbitrary limits (always reviewed, 3 examples)

A cap, timeout or retry budget that no real limit requires. Tests sized to the cap pass. Real work crosses it after release.

- **Round cap** (2026-11-17, 6eca5c355): one round per 5 minutes stopped 3-hour member runs after 36 rounds, about 1.5 hours in.
- **Usage warning as a stop** (2026-11-17, 94c82d88a): Claude's 75 percent warning paused a three hour run after 25 minutes.
- **Test reach cap** (2026-11-17, 8c7086af9): pull request checks run at most 40 test files per source file and 2 minutes of test time. Still present; no measured reason recorded.

### Word matching for judgment (always reviewed, 3 examples)

Deciding what something means by spotting words in it. Read the structure or ask a model, never a word list.

- **Approval guard held on bans** (2026-11-17, fcd1cdbb9): a member was held because its mission said "never send". The guard saw the word, not the ask.
- **Approval guard and double negatives** (2026-11-17, 51861b783): "never close without emailing" and "if there is no reply send" read wrong.
- **Hidden word unlocks a job** (2026-11-13, a7db494af): a locked job could turn an agent on by putting the word help or status in a flag.

### Status that lies (always reviewed, 4 examples)

A screen or record that says running, waiting or done when it is not. Show the real state and the real reason.

- **Dead runner shown as waiting** (2026-11-17, 0e1fc312d).
- **Silent round stop** (2026-11-17, ddff73590): three runs stopped early and still read running. Nothing said why.
- **Silent model swap** (2026-11-15, cdbfe8dec): a named Claude model could run as Haiku without saying so.
- **Asked-for model shown as the one that ran** (2026-11-19, #2055): `atris doctor --live` printed the requested model when the tool did not say which ran. Caught by `atris code-review` before landing.

### Fake proof (always reviewed, 2 examples)

Counting something as checked when the check did not really run.

- **Skipped check counted as proof** (2026-11-16, a49266761): a check that skipped itself because it opens the app read as passing.
- **Partial fallback counted as proof** (2026-11-17, 3930458c9).

### Sprawl (always reviewed, 3 examples)

A new command, flag or file when an existing one could own it.

- **219 command files and a 4,305 line entry file** (2026-11-19): `bin/atris.js` routes, prints help and holds logic for every command.
- **Dead command** (until 2026-11-19): `atris code-review` pointed at a Python review engine no project had. It always failed.
- **Second agent guide** (2026-11-19, #2055): a new SETUP.md repeated FOR_AGENTS.md, which already ships and is already copied into every project. Caught by `atris code-review` before landing.
