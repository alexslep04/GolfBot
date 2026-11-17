# Golfbot audit for draft 1.2.0

Audit date: 2026-11-16. Checkout: feat/golf-1.2.0, redesign baseline 9dc2150.

## Objective and history

The objective is still score gap: `margin(game) = game.score(0) - game.score(1)`.
Seat 1 (Golfbot) maximizes it; seat 0 minimizes it. This rewards both lowering
Golfbot's score and denying the opponent a low score. The same objective was
introduced in ea39208 (public-information lookahead).

`git diff 8d46263 9dc2150 -- bot.py` is empty. The redesign changed `game.py`
target eligibility after drawing to permit any own card, including face-down
cards. Search obtains those legal targets from the engine; it does not keep a
separate obsolete visible-only draw rule. Subsequent pre-redesign bot changes
added scoring-state copies, final-turn queues, and a one-second expansion limit;
they did not replace the score-gap objective.

## Characterization

Run `python -B -m unittest discover -s tests -p test_bot.py`.
The existing nine tests pass, covering denial of an opponent column pair,
preserving a score divisor, hidden-information invariance, deck conservation,
retained locks, final-reveal queues, special decisions, refill, and four all-rule
smoke deals. No bot source or tests were changed: no regression was demonstrated.

Run `python -B -m benchmarks.bot_strength --deals 4`.
The current one-second search policy was compared to the legacy greedy engine
policy on seeds 0-3, alternating starting seats and using matching opening deals.

| Seed | Legacy margin | Search margin |
| --- | ---: | ---: |
| 0 | -10 | 13 |
| 1 | 4 | 9 |
| 2 | -5 | 23 |
| 3 | 29 | 13 |

Legacy: 2/4 wins, mean margin +4.5. Search: 4/4 wins, mean margin +14.5.
Elapsed time: 10.17 seconds. Positive margins favor seat 1. This is a small
characterization, not a statistically reliable strength claim; search was worse
on seed 3. The benchmark uses default rules and bypasses worker-pool overload
fallbacks, so it does not measure strength under concurrency or every modifier.

The same benchmark was also run with `8d46263:game.py` (the pre-redesign
engine) loaded in memory, keeping the current bot and benchmark harness. Legacy
margins remained -10, 4, -5, 29. Search margins were 4, 13, 18, 19: 4/4 wins,
mean +13.5, 10.50 seconds. The current engine's mean +14.5 gives no evidence of
a loss of strength in this sample. This is a controlled engine comparison, not a
reconstruction of the entire historical server or worker environment. The
one-second deadline can also introduce machine-load variation.

## Host integration

- Mount `/golf` and scope its cookies and HTML base URL to `/golf/`.
- Redirect legacy `/Golfgame` paths in the server, preserving path suffix,
  query string, and POST method/body. Tunnel ingress deliberately allows both.
- Updated account/subpath tests require that server work before they pass.
- Update the hardcoded current-release assertion in `tests/test_patch111.py`
  from 1.1.2 to 1.2.0 and expect the prepended version list (1.2.0, 1.1.2,
  1.1.1), while preserving checks for older notes and saved history.
- Run account checks using the project's dependency environment; the system
  Python used here lacks `google.oauth2` from google-auth.
- Before eventual deployment, restart sharing to regenerate ingress config.
  No tunnel setup, DNS change, deployment, or commit was performed in this audit.

Draft release notes describe the host's planned 1.2.0 features; they do not claim
a bot fix. Docker now includes the imported `patches.py` release module and the new
`progression.py`, `practice_save.py`, and `avatars.py` server dependencies.

Final integration rerun after the host completed routing: 39 tests ran; 37
passed, including all five subpath tests. The remaining error is missing
`google.oauth2`; the remaining failure is the old hardcoded patch/version-list
expectation in `tests/test_patch111.py`. An earlier transient indentation error
in host-owned server edits was resolved before this final rerun.

Final tunnel suite: 7/7 passed. Bot suite: 9/9 passed. Release-history check
confirmed the entire older PATCH_NOTES list is unchanged after prepending 1.2.0.
Owned tracked files pass `git diff --check`.
