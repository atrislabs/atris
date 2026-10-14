# atris members: three words

members are helpers that work in their own copy of the repo.

you only need three words to use them: run, wake, and sleep.

## run

hand over one job, and atris picks the right member and starts it.
```sh
atris member run "fix one failing test"
```

## wake

keep members working on their own, each one pulling the next task that fits.
```sh
atris member wake 5
```

or wake just the members you name.
```sh
atris member wake navigator executor
```

## sleep

stop the members that are awake.
```sh
atris member sleep --all
```

## watching them work

the board shows who is working, quiet, or done, and keeps refreshing.
```sh
atris member board --watch
```

each member also writes its steps to its own log as it goes.
```sh
tail -f ~/.atris/progress/executor.log
```

## good to know

each member commits and pushes its own branch, so its edits stay apart from yours.

the older words still work as aliases: dispatch and go do what run does, and up does what wake does.

run with a job, wake with a number or names, and up need the release after 3.68.9.

apps can follow the board as one json object per line.
```sh
atris member board --json --follow
```

export puts your members inside claude code, cursor, and codex as agents those tools can call.
```sh
atris member export
```

short jobs are proven, hours-long runs are being tested now.
