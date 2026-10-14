# atris today: 3.68.4 through 3.68.8

dispatch with `--ignite` now starts the chosen member working on your request.
```sh
atris member dispatch "fix one failing test" --ignite
```

members work in their own copy of the repo and commit and push their own branch, so their edits stay separate from yours.
```sh
atris member run executor "fix one failing test" --ignite
```

each member writes live progress to `~/.atris/progress/<member>.log`; the board shows who is working, quiet, or done.
```sh
atris member board --watch
```

apps can read a starting snapshot and then live progress updates as one json object per line.
```sh
atris member board --json --follow
```

export puts your active team members inside claude code, cursor, and codex as agents those tools can call.
```sh
atris member export
```

the scoreboard shows today's github contributions, your streak, and this repo's commits split between you and members across branches.
```sh
atris scoreboard
```

short jobs are proven, hours-long runs are being tested now.
