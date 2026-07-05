count how many CLI commands this toy router actually registers at runtime.

commands are registered by calling `register(name, handler)` from registry.js.
only count a registration that is actually reachable when cli.js runs: a
call that is commented out, or sits inside dead code that never executes,
does not count.

do not edit source files.

write answers.json at the workspace root with exactly this shape:

{"count":123}
