// atris security-review — deterministic secrets / PII / privacy scan (no LLM).
//
// "Is this workspace safe to commit, publish, or hand to an autonomous loop?"
// Answers it with facts: file:line + rule + severity. Exit 1 on a HIGH finding,
// so it drops into the autopilot/mission/CI verification gate. `--json` emits a
// SOC 2 evidence artifact. Scans git-tracked files by default (what is exposed
// is what is committed), or a path you pass.
//
// Usage:
//   atris security-review                 scan tracked files (default)
//   atris security-review src/            scan a path
//   atris security-review --staged        scan staged changes (pre-commit gate)
//   atris security-review --json          machine output for CI / the loop
//   atris security-review --strict        also fail on MEDIUM (PII/paths)
//   atris security-review hook            install a pre-commit gate
//
// Exit code: 0 = clean, 1 = findings at/over the fail threshold, 2 = bad usage.

const fs = require('fs');
const path = require('path');
const { runScan, RULES } = require('../lib/security-scan');

const ICON = { high: '✗', medium: '!', low: '·', privacy: '✗', secret: '✗', pii: '!' };
const SEV_ORDER = { high: 0, medium: 1, low: 2 };

function securityReviewCommand(argv = []) {
  const sub = argv[0];
  if (sub === 'help' || argv.includes('-h') || argv.includes('--help')) return printHelp();
  if (sub === 'rules') return printRules();
  if (sub === 'hook' || sub === 'install-hook') return installHook();

  const json = argv.includes('--json');
  const quiet = argv.includes('--quiet');
  const strict = argv.includes('--strict');
  const staged = argv.includes('--staged');
  const paths = argv.filter((a) => !a.startsWith('-') && a !== 'scan');
  const root = process.cwd();

  let result;
  try {
    result = runScan({ root, paths, staged });
  } catch (e) {
    console.error(`security-review: ${e.message}`);
    return 2;
  }

  const { findings, counts, scanned } = result;
  findings.sort((a, b) => (SEV_ORDER[a.sev] - SEV_ORDER[b.sev]) || a.file.localeCompare(b.file) || (a.line - b.line));
  const failThreshold = strict ? ['high', 'medium'] : ['high'];
  const failing = findings.filter((f) => failThreshold.includes(f.sev)).length;

  if (json) {
    console.log(JSON.stringify({
      ok: failing === 0,
      scanned,
      counts,
      fail_threshold: strict ? 'medium' : 'high',
      findings,
      generated_for: 'soc2-evidence',
    }, null, 2));
    return failing ? 1 : 0;
  }

  if (!quiet) {
    console.log('\n  ◉ atris security review');
    if (!findings.length) {
      console.log(`\n  ✓ clean — no secrets, PII, or sensitive files in ${scanned} tracked file${scanned === 1 ? '' : 's'}\n`);
      return 0;
    }
    console.log('');
    const w = Math.max(...findings.map((f) => `${f.file}${f.line ? ':' + f.line : ''}`.length));
    for (const f of findings) {
      const loc = `${f.file}${f.line ? ':' + f.line : ''}`.padEnd(w);
      console.log(`  ${ICON[f.sev] || '·'} ${f.sev.toUpperCase().padEnd(6)} ${loc}  ${f.rule.padEnd(22)} ${f.why}`);
    }
  }
  console.log(`\n  ${counts.high || 0} high · ${counts.medium || 0} medium · ${counts.low || 0} low across ${scanned} file${scanned === 1 ? '' : 's'}`);
  if (failing) {
    console.log(`  ${failing} finding${failing === 1 ? '' : 's'} at/over the ${strict ? 'MEDIUM' : 'HIGH'} threshold · exit 1`);
    console.log('  fix or suppress (trailing `atris-allow-secret`), then re-run.\n');
  } else {
    console.log(`  no findings at the ${strict ? 'MEDIUM' : 'HIGH'} threshold · exit 0\n`);
  }
  return failing ? 1 : 0;
}

function printRules() {
  console.log('\n  atris security-review — deterministic rules:\n');
  for (const r of RULES) console.log(`  ${r.sev.toUpperCase().padEnd(6)} ${r.cat.padEnd(8)} ${r.id.padEnd(22)} ${r.why}`);
  console.log(`\n  ${RULES.length} rules + tracked-sensitive-file check. Suppress a line with a trailing \`atris-allow-secret\`.\n`);
  return 0;
}

function installHook() {
  const root = process.cwd();
  const hookDir = path.join(root, '.git', 'hooks');
  try {
    fs.mkdirSync(hookDir, { recursive: true });
    const hookPath = path.join(hookDir, 'pre-commit');
    const marker = '# atris security gate';
    let content = '';
    try { content = fs.readFileSync(hookPath, 'utf8'); } catch {}
    if (content.includes(marker)) { console.log(`\n  already installed: ${path.relative(root, hookPath)}\n`); return 0; }
    if (!content) content = '#!/bin/sh\n';
    if (!content.endsWith('\n')) content += '\n';
    content += `\n${marker}\nif command -v atris >/dev/null 2>&1; then atris security-review --staged --quiet || exit 1; fi\n`;
    fs.writeFileSync(hookPath, content);
    fs.chmodSync(hookPath, 0o755);
    console.log(`\n  ✓ security pre-commit gate installed: ${path.relative(root, hookPath)}\n    every commit now runs: atris security-review --staged\n`);
    return 0;
  } catch (e) { console.error(`  ${e.message}`); return 2; }
}

function printHelp() {
  console.log(`
  atris security-review — deterministic secrets / PII / privacy scan (no LLM)

    atris security-review            scan git-tracked files (default)
    atris security-review <path>     scan a file or dir
    atris security-review --staged   scan staged changes (pre-commit gate)
    atris security-review --strict   also fail on MEDIUM (PII / personal paths)
    atris security-review --json     machine output / SOC 2 evidence artifact
    atris security-review rules       list the active detectors
    atris security-review hook        install a pre-commit gate

  Scans for hardcoded secrets, API keys, personal data, and tracked sensitive
  files. exit 0 = clean, 1 = found. Wire into the autopilot/mission gate and CI.
`);
  return 0;
}

module.exports = { securityReviewCommand };
