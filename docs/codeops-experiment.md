# Measure a CodeOps lesson

Choose one improvement from the cloud team's recent engineering jobs. The improver selects a lesson, names the outcome it expects to change, cites the records that led to its choice, and sees the earlier scored results.

```sh
atris computer codeops experiment choose
```

To reuse a choice already made on this computer, `adopt <cloud-execution> <excerpts.json>` checks that the exact `lesson` and `metric` excerpts occur in its completed response. Adoption identifies the source execution. The operator selects its excerpts.

Freeze a suite of distinct work items with an independent answer key for each. Select the cases before seeing results. Pin the worker and model, include an unaffected control, and add a plausible unrelated instruction as a placebo when testing whether the choice of lesson matters. Use a real model available on the business computer.

```json
{
  "worker": "openai",
  "model": "<installed-model>",
  "scoring": "blind",
  "placebo": "<unrelated advice>",
  "cases": [
    {"id":"case-a","kind":"target","repo":"owner/repo","task":"<bounded job and source snapshot>","expected":"<independent pass criteria>"},
    {"id":"case-b","kind":"control","repo":"owner/repo","task":"<unrelated job>","expected":"<independent pass criteria>"}
  ]
}
```

```sh
atris computer codeops experiment freeze <choice> suite.json
atris computer codeops experiment run <trial>
atris computer codeops experiment judge <trial>
atris computer codeops experiment show <trial>
```

`freeze` publishes the plan digest to the business computer before execution. The full plan, answer keys and original responses stay in a private local folder under `~/.atris/codeops-experiments/<business-id>/<workspace-id>`. Run and judge from the machine that froze the suite. The result remains available to later choices from any machine with access to that workspace.

`run` sends each work item in a fresh session on the business computer, changing only the advice and randomizing the order of the arms. `run <trial> --max 1` starts at most one new arm. Repeating the command observes existing executions and continues. Calls to the business computer use its usual model and compute charges. This path tests responses to work items using supplied source material. A proposal score measures proposal quality. A separate implementation test can measure patch success.

In blind mode, `judge` sends anonymized answers and frozen rubrics to an independent session. Set the reviewer with `--worker` and `--model` when needed. Every accepted label has a reason. Independent packets keep large batches within the chat limit. `packet <trial>` exports those same anonymous work items for inspection. For exact JSON answers, use `"scoring":"exact"`. The coordinator compares results to the frozen JSON values without a reader.

The report gives each arm's observed and assigned counts, paired wins, losses and ties, and control regressions. Missing outcomes, tool use, resumed context, model mismatch or incomplete provenance prevent a verified win. A win describes the sampled jobs. A larger claim needs an independently chosen decision rule and enough matched tasks.

To attach a separately graded observation, use `observation <trial> <graded-packet.json>` with the exported packet's `hash` in `packet`, a named `reader` and `labels` containing each opaque `key`, boolean `pass` and evidence-based `reason`. It can carry `repo_by_case` groupings for old suites and a separately reported `follow_up` containing `observation` and `source_sha256`. This records an externally graded observation with its source digest. Its strict verdict stays inconclusive.

For a lesson implemented in code, `implementation <choice> <comparison.json>` links an independently executed comparison to the original selection. Supply `scope`, `metric`, `measured_at`, `measured_by` and one case per actual comparison with `id`, `repo`, binary `baseline` and `candidate` outcomes and the `gate_before` and `gate_after` decisions. Use `sources` to name the original baseline, candidate, results and other evidence files relative to the report. The CLI hashes the files before upload. An optional `real_check` can carry the original run URL, counts and revision identifiers.

The report identifies the independent measurer. Recording the report derives totals from its cases and preserves source fingerprints. The command does not execute the source programs. The next choice receives the comparison as executed code evidence alongside previous prompt trials.
