npm test fails after a branch merge.

the code in report.js is correct: version 0.2.0 deliberately changed the
status separator, see CHANGELOG.md. the merge brought back a test that
still expects the old 0.1.0 format.

make npm test pass by bringing the test in line with the current contract.

do not change report.js. do not revert the code to the old format. do not
delete the test or its assertion.
