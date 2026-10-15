## Keep ignored personal files during cleanup

Decision needed: which ignored files may cleanup discard?

Recommendation: keep a finished folder when it contains ignored files outside an explicitly reviewed list of generated caches. Start with no exceptions until that list is approved. Preview and apply must name the same reason for keeping it, and an unreadable listing must keep the folder too.

The failure mode is silent loss: ordinary Git status hides ignored files, so cleanup can erase personal notes while calling the folder clean. The existing backup also skips ignored files. Do not solve this by copying every ignored file into receipts, because those files can contain private values.

Cost: the read-only survey found ignored entries in 108 of 117 registered folders. A blanket keep rule would retain those folders; the count alone does not prove that any entry is disposable.

Safeguard before implementation: one shared check used by ordinary cleanup, member tidy, and land reap, with real preview and apply tests proving ignored note bytes survive. Keep autopilot's newly created test folders separate from pre-existing personal folders.

Evidence: atris/receipts/work-folder-ignored-files-2026-10-15.txt contains actual removal reproductions for all three paths. No deletion behavior has changed.

reply: keep all ignored files / propose exact disposable paths
