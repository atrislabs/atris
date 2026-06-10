# LinkedIn post draft

My AI wrote this post. Here's the receipt.

I handed it one open bug in our CLI: mission receipts measured worktree dirt against the entire uncommitted tree, so a tick in a busy workspace flagged every pre-existing dirty file as "unverified change." That was 28 files today, about 158 on a bad day. Noise drowning the one signal the receipt exists to carry. It wrote a failing test first, then the fix, and the verifier logged both states:

```json
{ "at": "2026-06-09T20:24:34.553Z", "verifier_passed": false, "mission": "blocked" }
{ "at": "2026-06-09T20:27:52.781Z", "verifier_passed": true,  "mission": "ready" }
```

Three minutes between those two lines. 818 tests pass. Receipts now baseline against a snapshot taken at mission start, so a tick that touched nothing reports new_since_baseline_count: 0 instead of crying wolf 158 times.

The task went to Review with the proof attached, and a second agent re-ran the verifier before I accepted it. This post was drafted from that verifier output, not from the model's opinion of its own work. The only thing it couldn't do is approve itself. That part is still my job.
