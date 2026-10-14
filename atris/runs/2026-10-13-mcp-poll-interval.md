# Short MCP retry polling

MCP now honors the existing positive finite design poll interval setting, keeping the production default. The test child uses 25ms. Original assertions remain, with exactly three permanent failure attempts now required. Only test/mcp.test.js changed among test files.

Plan: measure -> shorten real poll waits -> preserve retry assertions -> repeat -> review -> commit and push.

Files: mcp/atris-mcp/index.mjs, test/mcp.test.js, atris/MAP.md, atris/refs/MAP-NOTES.md, atris/TODO.md (task rendering), atris/team/auto-improver/logs/2026-10-13.md, atris/runs/2026-10-13-mcp-poll-interval.md.

Verify: node --test test/mcp.test.js
All six real-process invocations exited 0, pass 16, fail 0. Frozen verify: git diff --check, exit 0, no output.

Before duration_ms: 13722.825875, 13873.517875, 13749.038042
After duration_ms: 1701.497542, 1737.754625, 1743.298708
Median: 13749.038042ms -> 1737.754625ms, 87.4% faster. Runs overlapped within each group; wall timings are observational, not a performance threshold. Each baseline retry case took about 6.1s; afterward each took about 0.13s.

Output from six bare node --test invocations (stdout redirected to /tmp/ai-timing/mcp-poll-{before,after}-{1,2,3}.log; no pipeline):

## Before 1
```text
✔ atris mcp initialize echoes a known version and reports the package version (101.601416ms)
✔ atris mcp initialize falls back for an unknown version (82.899791ms)
✔ atris mcp returns method not found for an unknown request (87.915041ms)
✔ atris mcp returns parse error for malformed input (81.302958ms)
✔ atris mcp skips blank lines without a parse error (81.689334ms)
✔ atris mcp does not respond to notifications (79.876083ms)
✔ atris mcp returns a tool error for a missing required argument (82.331792ms)
✔ atris package keeps its zero-dependency promise (0.174ms)
✔ atris mcp lists the three design tools over stdio (78.479584ms)
✔ atris mcp tools/call runs design_search against the mocked api (91.860625ms)
✔ atris mcp answers ping while a design call is pending (84.5585ms)
✔ atris mcp writes a pending call response after stdin closes (286.316291ms)
✔ atris mcp drops a cancelled call response (290.10425ms)
✔ atris mcp tools/call rides out transient poll failures (6091.094708ms)
✔ atris mcp tools/call error names the job id and poll path (6085.68125ms)
✔ atris mcp tools/call gives a plain message on an empty api body (82.077958ms)
ℹ tests 16
ℹ suites 0
ℹ pass 16
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 13722.825875
```

## Before 2
```text
✔ atris mcp initialize echoes a known version and reports the package version (143.31225ms)
✔ atris mcp initialize falls back for an unknown version (109.033416ms)
✔ atris mcp returns method not found for an unknown request (93.951042ms)
✔ atris mcp returns parse error for malformed input (84.285084ms)
✔ atris mcp skips blank lines without a parse error (87.956ms)
✔ atris mcp does not respond to notifications (80.086834ms)
✔ atris mcp returns a tool error for a missing required argument (83.807583ms)
✔ atris package keeps its zero-dependency promise (0.267ms)
✔ atris mcp lists the three design tools over stdio (86.854958ms)
✔ atris mcp tools/call runs design_search against the mocked api (93.340584ms)
✔ atris mcp answers ping while a design call is pending (92.460875ms)
✔ atris mcp writes a pending call response after stdin closes (291.674125ms)
✔ atris mcp drops a cancelled call response (287.866625ms)
✔ atris mcp tools/call rides out transient poll failures (6086.20275ms)
✔ atris mcp tools/call error names the job id and poll path (6108.666875ms)
✔ atris mcp tools/call gives a plain message on an empty api body (99.550042ms)
ℹ tests 16
ℹ suites 0
ℹ pass 16
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 13873.517875
```

## Before 3
```text
✔ atris mcp initialize echoes a known version and reports the package version (103.117541ms)
✔ atris mcp initialize falls back for an unknown version (83.35075ms)
✔ atris mcp returns method not found for an unknown request (82.537833ms)
✔ atris mcp returns parse error for malformed input (75.776083ms)
✔ atris mcp skips blank lines without a parse error (76.833792ms)
✔ atris mcp does not respond to notifications (75.509416ms)
✔ atris mcp returns a tool error for a missing required argument (75.73275ms)
✔ atris package keeps its zero-dependency promise (0.148292ms)
✔ atris mcp lists the three design tools over stdio (74.379834ms)
✔ atris mcp tools/call runs design_search against the mocked api (82.101167ms)
✔ atris mcp answers ping while a design call is pending (81.372708ms)
✔ atris mcp writes a pending call response after stdin closes (281.459459ms)
✔ atris mcp drops a cancelled call response (295.409916ms)
✔ atris mcp tools/call rides out transient poll failures (6102.19875ms)
✔ atris mcp tools/call error names the job id and poll path (6120.114375ms)
✔ atris mcp tools/call gives a plain message on an empty api body (98.342125ms)
ℹ tests 16
ℹ suites 0
ℹ pass 16
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 13749.038042
```

## After 1
```text
✔ atris mcp initialize echoes a known version and reports the package version (75.991917ms)
✔ atris mcp initialize falls back for an unknown version (74.021333ms)
✔ atris mcp returns method not found for an unknown request (73.060125ms)
✔ atris mcp returns parse error for malformed input (74.758875ms)
✔ atris mcp skips blank lines without a parse error (75.694333ms)
✔ atris mcp does not respond to notifications (74.548458ms)
✔ atris mcp returns a tool error for a missing required argument (75.399375ms)
✔ atris package keeps its zero-dependency promise (0.159167ms)
✔ atris mcp lists the three design tools over stdio (75.079042ms)
✔ atris mcp tools/call runs design_search against the mocked api (82.867125ms)
✔ atris mcp answers ping while a design call is pending (80.148584ms)
✔ atris mcp writes a pending call response after stdin closes (280.230416ms)
✔ atris mcp drops a cancelled call response (280.109292ms)
✔ atris mcp tools/call rides out transient poll failures (133.460083ms)
✔ atris mcp tools/call error names the job id and poll path (134.597833ms)
✔ atris mcp tools/call gives a plain message on an empty api body (80.008667ms)
ℹ tests 16
ℹ suites 0
ℹ pass 16
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1701.497542
```

## After 2
```text
✔ atris mcp initialize echoes a known version and reports the package version (76.773375ms)
✔ atris mcp initialize falls back for an unknown version (75.101208ms)
✔ atris mcp returns method not found for an unknown request (76.281541ms)
✔ atris mcp returns parse error for malformed input (75.709167ms)
✔ atris mcp skips blank lines without a parse error (73.64875ms)
✔ atris mcp does not respond to notifications (77.664042ms)
✔ atris mcp returns a tool error for a missing required argument (75.689083ms)
✔ atris package keeps its zero-dependency promise (0.147167ms)
✔ atris mcp lists the three design tools over stdio (76.667166ms)
✔ atris mcp tools/call runs design_search against the mocked api (86.514959ms)
✔ atris mcp answers ping while a design call is pending (83.759458ms)
✔ atris mcp writes a pending call response after stdin closes (281.242542ms)
✔ atris mcp drops a cancelled call response (288.484208ms)
✔ atris mcp tools/call rides out transient poll failures (135.658ms)
✔ atris mcp tools/call error names the job id and poll path (137.688791ms)
✔ atris mcp tools/call gives a plain message on an empty api body (85.508208ms)
ℹ tests 16
ℹ suites 0
ℹ pass 16
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1737.754625
```

## After 3
```text
✔ atris mcp initialize echoes a known version and reports the package version (76.666917ms)
✔ atris mcp initialize falls back for an unknown version (76.417584ms)
✔ atris mcp returns method not found for an unknown request (77.51725ms)
✔ atris mcp returns parse error for malformed input (77.450125ms)
✔ atris mcp skips blank lines without a parse error (78.692625ms)
✔ atris mcp does not respond to notifications (81.324958ms)
✔ atris mcp returns a tool error for a missing required argument (78.885042ms)
✔ atris package keeps its zero-dependency promise (0.169917ms)
✔ atris mcp lists the three design tools over stdio (80.511583ms)
✔ atris mcp tools/call runs design_search against the mocked api (88.116083ms)
✔ atris mcp answers ping while a design call is pending (82.678542ms)
✔ atris mcp writes a pending call response after stdin closes (282.632042ms)
✔ atris mcp drops a cancelled call response (281.833667ms)
✔ atris mcp tools/call rides out transient poll failures (133.374417ms)
✔ atris mcp tools/call error names the job id and poll path (132.511625ms)
✔ atris mcp tools/call gives a plain message on an empty api body (81.480458ms)
ℹ tests 16
ℹ suites 0
ℹ pass 16
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1743.298708
```

next_push: inspect the slow commands test and isolate one repeated external probe without removing command coverage.
layer: capabilities
