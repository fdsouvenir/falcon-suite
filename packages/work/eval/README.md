# Decision-gate evaluation

## Falcon Work 2.0 clerk (2026-11-04)

`clerk_jev.mjs` runs the clerk's end-of-turn questions (`src/clerk/questions.ts`, one request per
turn, exactly as the plugin sends them) over labelled real turns; `clerk_score.mjs` scores each
question at the spec's thresholds (yes at 0.7 or above, no at 0.3 or below) and the actions spec §3.3
takes. Packets and labels are private and live outside the repository.

Set: 177 person-started turns from 21 sessions on Fred's Gateway (Oct 21 – Nov 3), 142 after
removing duplicates; 89 labelled clear (the rest flagged unclear by the labellers and reported
separately). Gold labels were written by three independent model labellers from `LABELLING.md`
before any Jev answer existed. Candidates for each turn are the items earlier turns worked on (as if
the record were perfect so far) plus two decoy items from other sessions.

Rubric `falcon-work-clerk-2026-11-04c`, Jev 1.13.0 (median 98 ms per turn):

| Action (spec §3.3)        | Right                          | Wrong | Not taken (left to the writer) |
| ------------------------- | ------------------------------ | ----- | ------------------------------ |
| File under an open item   | 43                             | 6     | 1                              |
| Recognise new work        | 14                             | 1     | 16                             |
| Raise Needs you           | 20                             | 2     | 16                             |
| Complete an item (done)   | all 124 candidate checks right |       |                                |
| Status line picked        | 40                             | 5     | —                              |
| Decoy items filed against | 0                              | —     | —                              |

64% of turns still mark the session for the writer, mostly because a question is unsettled. The
writer runs once per session at idle, not per turn. Jev 1.14.0 was not better on this set (decoys
1 false match, 9 wrong filings), so the plugin keeps the Office's configured model.

Rounds: (a) first wording; (b) the previous exchange added to the state, `only_conversation` dropped
(code derives it), clearer `work_planned` and `waits_outside` criteria, closed items removed from
candidates; (c) `new_work` added. Weak questions that drive no action on their own:
`work_planned` (40% precision; it only sends a session to the writer) and `waits_outside` (67%).

Measures decision-model gates for Falcon Work (and the current text-matching fallback) against
hand-labelled agent turns, by the Work action each gate would take.

- `gates.json` — the gates. `left_waiting` (end of turn: is the agent left waiting on the person?)
  has the full rubric, written to the `typesafe-evaluate` conventions, and a `compact` variant that
  fits Laya's option budget (192–256 tokens shared by all options).
- `synthetic.json` — hand-written hard cases (code, quotes, rhetorical questions, offers, other
  languages, needs buried mid-reply). Real turns come from a private corpus and are not committed.
- `build.mjs` — builds the evaluation set (turns, segments, gold labels).
- `gate_run.py` — runs a gate over the set with Laya (`model:max_len:head_max_len` per run).
- `gate_jev.mjs` — runs a gate over the set with hosted Jev (`JEV_KEY_ENTRY` names the vault entry).
- `gate2_jev.mjs`, `gate2_score.mjs` — gate `answers_open_item` (does the person's message answer an open Question or Decision?) on Jev, and its scorer.
- `extract_jev.mjs`, `extract_score.mjs` — gate `asked_for` (which pieces of a reply are the ask?) on Jev, scored against the sentence labels and the text extractor.
- `battery_jev.mjs` — the plugin's own end-of-turn battery on Jev, scored with the same scorers as the separate gates.
- `gate_score.mjs` — scores runs by outcome: precision/recall of "something lands under Needs
  you", and how often the right action is chosen.
- `segment.mjs`, `laya_run.py`, `score.mjs` — the first, sentence-level experiment (kept for
  comparison; superseded by the gate).
