# Golden Path Papercuts

### Papercut: global npm install still prints no first command

- Found: 2026-07-02
- Task: CLI-827
- Evidence: In a clean temp HOME and isolated npm prefix, `npm install -g atris-3.32.0.tgz` printed only `added 1 package in 256ms`.
- Why it hurts: a zero-knowledge user has no printed next command after install, so the walk still depends on knowing to try `atris` or `atris init`.
- Desired fix: fresh tarball install output, or the unavoidable first visible command after install, gives one copy-paste next command.

### Papercut: init prompt has no non-interactive continuation command

- Found: 2026-07-02
- Task: CLI-828
- Evidence: In a clean toy repo, `atris init` exited 0 after printing `Answer in one sentence` and a `>` prompt, but did not print a command to continue when stdin was not interactive.
- Why it hurts: the walk depends on knowing how to answer or rerun the context gatherer; the CLI output does not provide a copy-paste next step.
- Desired fix: non-interactive `atris init` ends with one runnable next command, or detects that no TTY is available and prints exactly how to answer later.
