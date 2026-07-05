this template renderer exports one function that nothing calls: not from
another source file, not from its own tests, not from cli.js. a mention in
a comment or in NOTES.md does not count as a use.

find that export.

do not edit source files.

write answers.json at the workspace root with exactly this shape:

{"export":"name","file":"relative/path.js"}
