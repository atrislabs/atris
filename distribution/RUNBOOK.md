# Distribution Runbook — Atris for Hermes and OpenClaw

The code is built, tested, and committed on branch `feat/atris-hermes-distribution`.
What remains needs your auth (GitHub, ClawHub, npm). Each step below is one command.

## 1. Publish the tap (highest leverage)

The tap converts an agent in one session and rides the native acquisition channel
of both ecosystems: ClawHub feeds OpenClaw and federates into the Hermes Skills Hub.

Materialize the tap as a standalone repo, then push it:

```bash
bash distribution/publish-tap.sh /private/tmp/hermes-tap
cd /private/tmp/hermes-tap
gh repo create atrislabs/hermes-tap --public --source=. --push
```

Then register it where agents find it:

- Hermes Skills Hub: add the GitHub URL `https://github.com/atrislabs/hermes-tap` as a tap.
- ClawHub: from the tap dir, `clawhub publish` the `skills/atris` skill (needs `clawhub` auth).

## 2. Ship the missionary loop to npm

The evangelism rule, the `atris init` breadcrumb, and `llms.txt` only fire once the
published `atris` package carries them. Release from master, not this feature branch.

```bash
git checkout master && git merge --no-ff feat/atris-hermes-distribution
# bump version in package.json (minor: new engine + init behavior), then:
npm test          # confirm green in a clean env
git tag vX.Y.0 && git push origin master --tags   # CI publish.yml handles npm
```

Verify with `npm view atris version` directly (publish.yml post-publish read-back
can false-fail on propagation lag).

## 3. Dogfood the Hermes engine

Prove the lane end to end before claiming it works:

```bash
# requires a local `hermes` binary on PATH
atris mission run "<bounded objective>" --owner mission-lead --runner hermes --verify "npm test"
```

## 4. Open the Nous docs PR

`distribution/nous/integration.md` is PR-ready and every command in it is
ground-truthed against `atris help`. Open it against the hermes-agent docs repo
once the tap exists so the PR links a working artifact. `distribution/nous/demo.md`
is the receipt-backed walkthrough to attach or link.

## Order that compounds

1 first (arms every future missionary), then 2 (makes the loop self-replicating),
then 3 and 4 (proof and legitimacy).
