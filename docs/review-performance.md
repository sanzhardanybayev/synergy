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

Observed on 2026-07-19 with five independent live agent analyses. Each run captured a separate
copy of the same representative review subsystem and produced its own payload from the immutable
snapshot; no payload was replayed or copied between runs.

- Environment: Apple Silicon macOS (Darwin 25.5.0), Node.js 24.17.0, pnpm 10.28.2
- Revision: `dbd654e347b86155abbd7f4029608583877c7ad1` (`0.13.0` runtime)
- Scope: 15 TypeScript files / 2,977 captured text lines per run
- Guidance: 20–30 sections, target 25
- Observed units: 25–30 sections in 7–8 groups; every run was within guidance
- Median conservative time-to-review-ready: at most 160,392 ms
- Maximum conservative time-to-review-ready: at most 189,213 ms

| Run | capture | agentAnalysis | publication | previewReadiness | total | Unit count |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 91 ms | 128,966 ms | 95 ms | 177 ms | ≤135,781 ms | 29 |
| 2 | ≤400 ms | 188,296 ms | ≤400 ms | 175 ms | ≤189,213 ms | 29 |
| 3 | ≤400 ms | 163,590 ms | ≤300 ms | 141 ms | ≤164,359 ms | 30 |
| 4 | 97 ms | 111,246 ms | 72 ms | 170 ms | ≤120,754 ms | 25 |
| 5 | ≤300 ms | 159,692 ms | ≤300 ms | 173 ms | ≤160,392 ms | 29 |

Runs 2, 3, and 5 recorded capture or publication in a wrapper that also read an adjacent
timestamp or checked the payload. Their command phases and totals therefore use the wrapper's
larger observed duration as a conservative upper bound. Runs 1 and 4 recorded command-only wall
times. Each total uses the persisted snapshot-to-finalization interval plus the capture bound and
preview lookup, rather than summing rounded sub-phases; this intentionally double-counts any
capture tail after the snapshot timestamp and is therefore conservative. The agents ran in
restricted sandboxes, so their post-finalization preview probe reported `previewReady: false`;
the table's preview-readiness phase is the separately observed `review open --json` process
duration against the already-running healthy preview, which returned the full immutable URL for
every revision.

The machine-readable observation record, including immutable references, timestamps,
fingerprints, payload hashes, raw phase observations, and conservative totals, is committed in
[`review-performance-runs.json`](review-performance-runs.json).
