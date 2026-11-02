# Red Team round 3 fixtures

Copied from `reviews/rt-repro/round3/` (local review folder).

- `d1-refresh`: DELETE then re-INSERT of a CASCADE parent. CASCADE-LOSS, exit 1.
- `d2-replace`: INSERT OR REPLACE on a CASCADE parent. CASCADE-LOSS with REPLACE advice, exit 1.
- `d3-grandchild`: net DELETE through two CASCADE levels. Two CASCADE-DELETE warnings, exit 0.
