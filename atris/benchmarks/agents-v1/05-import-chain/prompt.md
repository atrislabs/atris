three entry modules exist at the workspace root: app-a.js, app-b.js, and
app-c.js.

exactly one of them transitively imports emitter-core.js, either directly
or through a file that it requires.

do not edit source files.

write answers.json at the workspace root with exactly this shape:

{"module":"app-x.js"}
