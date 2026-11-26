# What the coordination campaign learned

On November 26, 2026 the campaign tested local Atris, Fleet and the SQLite-backed Swarlo service. The original November 19 handoff already had one correctly attributed result on each destination. A successful handoff established that delivery was possible. Fresh retries exposed a different failure.

| Round | Observation | Decision |
| --- | --- | --- |
| Baseline on both unchanged checkouts | 3 of 11 passed. The judge counted four false acceptances, four misses and zero setup errors. | Freeze the cases. Preserve independent sends and accept a fix only after inspecting the receivers. |
| Element candidate with original Swarlo | 6 of 11 passed. The card reused its completion, while the old hub lacked a receipt-capable route. | Keep the Element change and continue the receiver work. |
| Both candidates | 11 of 11 passed. Two simultaneous completions ran one verifier. Two deliberate identical messages with different keys produced two replies. One linked result survived a service restart on its original card and thread. | Challenge the positive reading with an unseen failure. |
| Independent challenge | A late completion initially consumed a reopened task when the same reviewer claimed it again. A tagged worker could also complete before claiming the card. | Return a generation identifier in the normal handoff and reject obsolete or unclaimed completion before running the check. After correction, the old command was refused and the same proof on the explicitly new claim succeeded. |
| Lost acknowledgement | The receiver committed a Fleet report, the connection dropped, and the receiver restarted. Fleet's retry returned the original result ID. The thread of work retained one result from the original reviewer. | Preserve the intent key across transport attempts. Return a failing CLI status when the receiver cannot confirm the write. |
| Receiver rollback | After interruption before receipt insertion, the receiver contained zero results and zero replies and the original claim was open. Eight separate writers then produced one result and one receipt. | Keep the visible effect, related claim changes and receipt in the same transaction. Check current membership before looking up a stored receipt. |

The frozen judge classifies wrong effects and missing legitimate effects separately. Its SHA-256 is `a6a2dcca8ccf96ab36e3069df461a4de0425dfde6f2537bb57e1c5ab88dfb91f`. It runs without models, production credentials or real recipient data. The acknowledgement challenge initially received a validation error because its test proxy dropped the HTTP request body. That was a fixture error. The corrected proxy forwards the body and drops only the response after the real receiver commits.

## How to use the result

Use the completion command returned by the claim. Persist a different message key for each intended delivery, even if the text matches. Reuse that key after a lost response. A changed payload under the same key is a conflict. A worker interrupted during an arbitrary external check may leave its outcome uncertain. Inspect it before requesting another check.

The measured zero false acceptances and zero misses describe these cases on the local SQLite implementation. The older unkeyed Swarlo interface treats each call as a fresh send. Other receiver implementations must implement the same contract or refuse keyed writes. Managed backend results have separate retry tests. This campaign did not release a hosted service.
