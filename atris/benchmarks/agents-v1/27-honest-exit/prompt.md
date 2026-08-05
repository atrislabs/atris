tool.js is a small task list cli with two subcommands: add and list.

when it is given an unknown subcommand it prints an error to stderr but
still exits 0, so scripts calling it never notice the failure.

make an unknown subcommand exit with a nonzero code while still printing
the error to stderr.

the happy paths must not change: `node tool.js add widget` and
`node tool.js list` must keep their current output and keep exiting 0.
