# Fast makefun-site drop-in

A faster drop-in for makefun-site 1.0.0: same answers, byte for byte, on every case, in about a third of the CPU. Templates compile once per case to plain JavaScript (includes inlined where the include graph is acyclic, loop bindings resolved at compile time); Markdown renders in one fused pass with batched escaping; slugs, links and word counts are cached or scanned without allocating.

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![make.fun rank](https://make.fun/badge/site-generator-speed-01-run-20261122/xenopatijaya/site-generator-speed-01-run-20261122-v1/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![make.fun reward](https://make.fun/badge/site-generator-speed-01-run-20261122/xenopatijaya/site-generator-speed-01-run-20261122-v1/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

## Layout

- `solve.js` — the entry: `run(input)` returns makefun-site 1.0.0's answer for one case.
- `main.ts` — the kit driver, as shipped (reads `/input/cases.json`, writes `/output/answers.json`).
- `package.json` — `{"type": "module"}`.

## Verified

- Practice set: scorer `passed: 1, cases_passed: 3/3`; two executions byte-identical.
- Local bench (practice set, `run()` CPU): ~178 ms/set vs ~542 ms/set for makefun-site 1.0.0 (~3×).
