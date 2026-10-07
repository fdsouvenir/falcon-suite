# Decision-gate evaluation

Measures decision-model gates for Falcon Work (and the current text-matching fallback) against
hand-labelled agent turns, by the Work action each gate would take.

- `gates.json` — the gates. `left_waiting` (end of turn: is the agent left waiting on the person?)
  has the full rubric, written to the `typesafe-evaluate` conventions, and a `compact` variant that
  fits Laya's option budget (192–256 tokens shared by all options).
- `synthetic.json` — hand-written hard cases (code, quotes, rhetorical questions, offers, other
  languages, needs buried mid-reply). Real turns come from a private corpus and are not committed.
- `build.mjs` — builds the evaluation set (turns, segments, gold labels).
- `gate_run.py` — runs a gate over the set with Laya (`model:max_len:head_max_len` per run).
- `gate_score.mjs` — scores runs by outcome: precision/recall of "something lands under Needs
  you", and how often the right action is chosen.
- `segment.mjs`, `laya_run.py`, `score.mjs` — the first, sentence-level experiment (kept for
  comparison; superseded by the gate).
