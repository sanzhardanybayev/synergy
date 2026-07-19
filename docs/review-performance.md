# Review analysis performance

Synergy gates a representative warm scope review at a median of at most 210 seconds and no
single run above 240 seconds. The benchmark separates capture, the recorded agent-analysis
interval, publication, and preview readiness so regressions remain attributable.

The `analysis-set --json` result includes monotonic `timings` for parsing, derivation,
validation, atomic publication, preview resolution, and total command time. These timings expose
tool overhead without conflating it with the durable snapshot-to-finalization interval.

## Measurement modes

- **Fixture replay** runs the normal CLI capture, `analysis-set --json`, and preview-readiness
  flow five times. Its `agentAnalysis` phase comes from the previously measured wall-clock
  interval between the capture command returning and the `analysis-set` command starting; it
  excludes publication because the harness measures publication separately. Replay does not
  execute or time a live model.
- **Dogfood** is the authoritative end-to-end measurement. Record the agent-analysis interval
  described above from each real agent session, then use those measured intervals in the replay
  fixture. Do not fabricate, estimate, or copy latency values between runs.

Keep five independent pending review inputs in one fixture. Each input must capture its own
revision because a finalized Synergy revision is immutable. For the representative dogfood,
use approximately 15 TypeScript files and 3,000 captured text lines. Aim for 20–30 useful units;
if the CLI guidance or semantic boundaries produce a count outside that range, record why.

## Fixture shape

```json
{
  "schemaVersion": 1,
  "runs": [
    {
      "label": "warm run 1",
      "createArgs": ["--scope", "fixtures/review-performance/run-1"],
      "analysisBodyFile": "analysis/run-1.json",
      "agentAnalysisMs": 0
    }
  ]
}
```

The example is structural only: replace the zero with that run's measured interval from capture
completion to the start of `analysis-set`, and provide exactly five run entries. Never report the
example as performance evidence.
Paths in `analysisBodyFile` resolve relative to the fixture JSON. The five selectors must resolve
to independent pending revisions; the harness rejects a resumed finalized revision.

Run the gate against a built CLI:

```bash
pnpm build:runtime
node scripts/benchmark-review-analysis.mjs \
  --fixture /absolute/path/to/replay.json \
  --root /absolute/path/to/dogfood-repository
```

The harness emits JSON with every run's `capture`, `agentAnalysis`, `publication`,
`previewReadiness`, and `total` phase in milliseconds. It exits nonzero when the five-run median
exceeds 210,000 ms or the maximum exceeds 240,000 ms.

## Five-run dogfood record

Complete this section only with observed runs. Until then it is intentionally a blank evidence
template, not a performance claim.

- Environment: _pending_
- Revision: _pending_
- Scope: _pending; target approximately 15 TypeScript files / 3,000 lines_
- Unit count: _pending for each run; explain any result outside guidance_
- Median: _pending_
- Maximum: _pending_

| Run | capture | agentAnalysis | publication | previewReadiness | total | Unit count |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | pending | pending | pending | pending | pending | pending |
| 2 | pending | pending | pending | pending | pending | pending |
| 3 | pending | pending | pending | pending | pending | pending |
| 4 | pending | pending | pending | pending | pending | pending |
| 5 | pending | pending | pending | pending | pending | pending |
