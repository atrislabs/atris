---
name: security-audit
description: "Security guidance and full codebase audits through the sentinel. Use for security questions, focused reviews of a file or change, vulnerability triage, or a full audit. Run `atris sentinel` only when someone asks to audit a codebase, wants a full or end-to-end review, or asks for report files. Triggers on security audit, find vulnerabilities, pen test the code, is this safe, sentinel, security review."
version: 1.0.0
tags:
  - security
  - audit
  - sentinel
  - review
---

# Security audit

Find holes that cross a real trust boundary, then give the owner the source evidence, the priority, and the smallest fix. Source first, read-only, defensive.

The method is adapted from cloudflare/security-audit-skill (MIT). Atris runs it on its own engines with a deterministic map, a cross-model verifier, and runs that add up.

## Two modes

Guidance mode is the default. For a question, one file, one diff, or one suspected bug, use the rules below in the current conversation. Do not start a full run or write report files.

Full audit mode is for "audit this repo", "full security review", or "give me a report". Run:

```
atris sentinel --plan          # free: how many areas, what the budget buys
atris sentinel                 # standard run, budget 20 engine calls
atris sentinel src/api --deep  # deeper, narrower
atris sentinel status          # last run's landing
```

If the request could mean either, ask one question before starting a full run.

## The rule for every candidate

Name all six, or it is not a finding:

One. The lower-trust person and what they start with.

Two. The value or action they control.

Three. The control that should stop them, with its file and line.

Four. The exact path after that control, entry to sink.

Five. Who or what gets hurt.

Six. The concrete result: a wrong record, a command run, a token sent somewhere, a file written outside its folder.

## Three verdicts

- confirmed: the full trace holds in source, nothing visible stops it, and a model that did not find it agrees. Only confirmed gets a severity.
- needs_validation: the trace holds, but one fact outside the code decides it (a proxy rule, a deploy setting, who can write a file). Name that fact and a safe check. No severity.
- rejected: the source disproves it. Name the line.

## Severity

- critical: unauthenticated code execution, full data-store access, or takeover of any account.
- high: an explicit control fully defeated with real consequences (auth bypass, cross-tenant read or write, authenticated code execution).
- medium: a real boundary crossed with a small blast radius or rare preconditions.
- low: non-secret internals exposed, or a lot of effort for little gain.
- overall never exceeds impact. If you cannot say the damage, it is lower than it feels.

## Do not report

- A missing best practice with nobody hurt. That is a hardening note.
- A second missing layer when the first layer already stops it.
- The same person hurting only themselves.
- A crash called code execution, or ordinary load called an outage.
- Guesses about deploy, proxy, browser, or provider behavior not in the repo. Use needs_validation.

## Safety

Read-only. Never run target code, contact deployed systems, use real credentials, or test availability against anything shared. Dummy data only. Stop at the smallest result that proves the point.

## For the team

The sentinel member (`atris/team/sentinel/MEMBER.md`) owns nightly runs. A confirmed high or critical finding becomes a builder task with the fingerprint in the title. Reports live in `~/.atris/security-audit/<repo>/run-<N>/`, never in the repo.
