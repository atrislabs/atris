cli.js crashes when scanning a file that has no headings, such as
empty.md (a zero-byte file).

fix scan.js so cli.js exits 0 on empty or heading-less input, and so it
reports "lastLevel": null in that case instead of crashing.

keep npm test green.
