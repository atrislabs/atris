'use strict';

const prim = require('../lib/experiment-primitive');
const { apiRequestJson } = require('../utils/api');
const { ensureFreshCredentials } = require('../utils/auth');
const { NOT_LOGGED_IN, tokenFrom } = require('../lib/developer-api');

function takeFlag(args, flag) {
  const idx = args.indexOf(flag);
  if (idx < 0) return null;
  const val = args[idx + 1];
  args.splice(idx, val !== undefined && !val.startsWith('--') ? 2 : 1);
  return val === undefined || val.startsWith('--') ? true : val;
}

function hasFlag(args, flag) {
  const idx = args.indexOf(flag);
  if (idx < 0) return false;
  args.splice(idx, 1);
  return true;
}

function parseScope(raw) {
  if (!raw || typeof raw !== 'string') return { scopeType: 'loop', scopeId: 'general' };
  const colon = raw.indexOf(':');
  if (colon < 0) return { scopeType: raw.trim(), scopeId: 'general' };
  return { scopeType: raw.slice(0, colon).trim(), scopeId: raw.slice(colon + 1).trim() || 'general' };
}

function experimentCommand(subcommand, ...rawArgs) {
  const args = [...rawArgs];
  const jsonOut = hasFlag(args, '--json');
  const root = process.cwd();

  const emit = (payload, textLines) => {
    if (jsonOut) console.log(JSON.stringify(payload, null, 2));
    else textLines.forEach((line) => console.log(line));
  };

  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.log([
      'atris experiment — shared hypothesis + sample-gate primitive',
      '',
      '  atris experiment propose "<guess>" [--scope <type>:<id>] [--loop <name>] [--min-n 5] [--proposed] [--ref <r>]',
      '  atris experiment list [--scope <type>] [--status <s>] [--loop <name>]',
      '  atris experiment score <id> [--sample <n>] [--rate <r>]',
      '  atris experiment compare <id1> <id2> [...]',
      '  atris experiment decide <id> <accepted|discarded|superseded> [--learned "..."] [--value <n>] [--force]',
      '  atris experiment sync [--scope <type>] [--push-only] [--dry-run] [--json]',
    ].join('\n'));
    return;
  }

  try {
    if (subcommand === 'propose') {
      const scopeRaw = takeFlag(args, '--scope');
      const loop = takeFlag(args, '--loop');
      const minN = takeFlag(args, '--min-n') || prim.DEFAULT_MIN_N;
      const ref = takeFlag(args, '--ref');
      const proposed = hasFlag(args, '--proposed');
      const guess = args.join(' ').trim();
      const { scopeType, scopeId } = parseScope(scopeRaw);
      const res = prim.propose({
        root,
        scopeType,
        scopeId,
        guess,
        loop,
        minN,
        status: proposed ? 'proposed' : 'running',
        ref,
      });
      const e = res.experiment;
      emit(res, [`✓ ${e.id.slice(0, 8)} [${e.status}] (${e.scope_type}:${e.scope_id}) ${e.guess}`]);
      return;
    }

    if (subcommand === 'list') {
      const scopeType = takeFlag(args, '--scope');
      const status = takeFlag(args, '--status');
      const loop = takeFlag(args, '--loop');
      const experiments = prim.list({ root, scopeType, status, loop });
      emit(
        { experiments },
        experiments.length
          ? experiments.map((e) => `${e.id.slice(0, 8)}  ${e.status.padEnd(10)}  ${e.sample}/${e.min_n}  ${e.scope_type}:${e.scope_id}  ${e.guess}`)
          : ['No experiments yet.']
      );
      return;
    }

    if (subcommand === 'score') {
      const sample = takeFlag(args, '--sample');
      const rate = takeFlag(args, '--rate');
      const id = args[0];
      const res = prim.score({ root, id, sample, rate });
      const e = res.experiment;
      emit(res, [`✓ ${e.id.slice(0, 8)} sample ${e.sample}/${e.min_n} ready=${e.ready_to_decide}`]);
      return;
    }

    if (subcommand === 'compare') {
      const res = prim.compare({ root, ids: args });
      emit(res, [
        ...res.experiments.map((e) => `${e.id === res.best ? '*' : ' '} ${e.id.slice(0, 8)}  ${e.sample}/${e.min_n}  rate=${e.rates?.primary_rate ?? 'n/a'}  ${e.guess}`),
        res.best ? `Winner: ${res.best.slice(0, 8)}` : 'No winner past min_n yet.',
      ]);
      return;
    }

    if (subcommand === 'decide') {
      const learned = takeFlag(args, '--learned');
      const value = takeFlag(args, '--value');
      const force = hasFlag(args, '--force');
      const [id, decision] = args;
      const res = prim.decide({ root, id, decision, learned, value, force });
      const e = res.experiment;
      emit(res, [`✓ ${e.id.slice(0, 8)} -> ${e.status}${e.learned ? ` (${e.learned})` : ''}`]);
      return;
    }

    if (subcommand === 'sync') {
      const scopeType = takeFlag(args, '--scope');
      const pushOnly = hasFlag(args, '--push-only');
      const dryRun = hasFlag(args, '--dry-run');
      return (async () => {
        try {
          const creds = await ensureFreshCredentials();
          const token = tokenFrom(creds);
          if (!token) throw new Error(NOT_LOGGED_IN);
          const res = await prim.syncCloud({
            root,
            scopeType,
            pushOnly,
            dryRun,
            request: apiRequestJson,
            token,
          });
          const prefix = res.dry_run ? '[dry-run] ' : '';
          emit(res, [
            `${prefix}✓ synced experiments: pushed=${res.pushed} scored=${res.scored} decided=${res.decided} pulled=${res.pulled} updated=${res.updated} (total=${res.total})`,
          ]);
        } catch (err) {
          console.error(`✗ ${err.message || err}`);
          process.exitCode = 1;
        }
      })();
    }

    console.error(`Unknown subcommand: ${subcommand}`);
    process.exitCode = 1;
  } catch (err) {
    console.error(`✗ ${err.message || err}`);
    process.exitCode = 1;
  }
}

module.exports = { experimentCommand };
