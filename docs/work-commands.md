# Falcon Work 2.0 — command list

Status: **matches the 2.0 code** on branch `work-2.0`, 2026-11-04. Companion to
[work-spec.md](work-spec.md); uses its vocabulary only.

## 1. Who calls these

Work writes its record itself (spec §3): the clerk calls these commands as **Work**
(`work:clerk`). Agents call them through their tools only when the person asks them to change the
record; people's and agents' entries win over Work's (§3 below). The Control UI is read-only and
calls no commands.

Every command runs the same way, whoever calls it: validated against its input schema, committed
atomically, logged as an immutable event (actor, time, object, version), and idempotent by key — a
retried tool call reuses the tool call's id, and a clerk action uses a key built from the turn or
session pass. `expected_version` is optional optimistic locking for any command on an object.

Outcomes: `committed`, `committed_with_warnings`, `noop` (nothing to change, including a Work write
blocked by §3), or `rejected` with a `code`, a `reason` and the commands to try `next`.

## 2. Tools

Agents see Work as tools named for what they want to do. Each tool's description says that Work
keeps its own record and that the tool is for changes the person asks for.

- **`falcon_work_read`** — `view`: `home` (Needs you, the board, what happened; optional
  `since`) · `project`, `task`, `job` (`id`) · `search` (`text`) · `get` (any id) · `needs_you`
  (`cursor`) · `board` (`column`: `moving`, `waiting` or `done`; `cursor`) · `help` (`command`: one
  command's full input). Never changes anything. Long lists come a page at a time as
  `{items, total, next}`; pass `next` as `cursor` for the following page.
- **`falcon_work_plan`** — create a Project with its Milestones and Tasks (`new_project`), or add
  Milestones and Tasks to one (`project`).
- **`falcon_work_task`** — `create` (standalone, or `project` / `milestone` / `job`; `start` to start
  it at once), `start`, `wait`, `resume`, `complete` (result and evidence), `abandon`.
- **`falcon_work_job`** — `create` (title, instructions, automations), `edit`, `pause`, `resume`,
  `retire`, `link_automation`, `unlink_automation`.
- **`falcon_work_ask`** — Questions (`questions[]` for several) or a Decision for the person; they
  show under Needs you with a link to the conversation that asked. `holds` names Tasks that wait
  until it is answered.
- **`falcon_work_finding`** — a Finding with evidence.
- **`falcon_work`** — any command below, one per call: `{command, id?, expected_version?, input}`.

Tools record the calling session against what they create or start, so the item's page links to
it.

## 3. Who wins

Descriptive fields — a Job's title and instructions, a Project's title and outcome, a Task's title,
description and done-when, and every status line — remember who last wrote them. When Work writes
a field that a person or agent wrote, the write is skipped (`noop`). People and agents always
overwrite. Status changes (start, wait, complete…) are facts and are not blocked.

## 4. Jobs

| Command             | On  | Input                                                   | Does                                                                     |
| ------------------- | --- | ------------------------------------------------------- | ------------------------------------------------------------------------ |
| `create_job`        | —   | title, instructions, agent?, automations?, status_line? | Create an ongoing duty; link the OpenClaw automations that run it.       |
| `edit_job`          | job | title?, instructions?, reason?                          | Change its title or instructions.                                        |
| `pause_job`         | job | reason?                                                 | Pause it (it shows as waiting: "Paused").                                |
| `resume_job`        | job | reason?                                                 | Resume a paused Job.                                                     |
| `retire_job`        | job | reason?                                                 | Retire it; it leaves the board.                                          |
| `link_automation`   | job | id, name?                                               | Runs of that automation are filed under the Job. One Job per automation. |
| `unlink_automation` | job | id                                                      | Remove an automation.                                                    |

## 5. Projects and Milestones

| Command              | On        | Input                                                     | Does                                                                                       |
| -------------------- | --------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `create_project`     | —         | title, outcome, agent?, status_line?, milestones?, tasks? | Create a Project, optionally with its whole plan.                                          |
| `edit_project`       | project   | title?, outcome?, reason?                                 | Change its title or outcome.                                                               |
| `abandon_project`    | project   | reason, dispositions?                                     | Abandon it, choosing for each unfinished Task: `abandon` or `detach` (becomes standalone). |
| `resume_project`     | project   | reason                                                    | Resume an abandoned Project.                                                               |
| `add_milestone`      | project   | title, success_condition, position?                       | Add a Milestone.                                                                           |
| `plan_project`       | project   | milestones?, tasks?                                       | Add Milestones and Tasks in one step; Tasks name each other by `key` in `depends_on`.      |
| `edit_milestone`     | milestone | title?, success_condition?                                | Change a Milestone.                                                                        |
| `reorder_milestones` | project   | order                                                     | Set the order (every Milestone exactly once).                                              |
| `achieve_milestone`  | milestone | basis, sources                                            | Mark it achieved. Refused while its Tasks are unfinished.                                  |
| `reopen_milestone`   | milestone | reason                                                    | Reopen it.                                                                                 |

A Project is finished when every Milestone is achieved and no Task is open; it then shows under
Done this week.

## 6. Tasks

| Command                    | On   | Input                                                                                               | Does                                                                               |
| -------------------------- | ---- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `create_task`              | —    | title, description, done_when, project?, milestone?, job?, depends_on?, agent?, plan?, status_line? | Create a Task: standalone, in a Project (and Milestone), or in a Job — never both. |
| `create_task_from_entries` | —    | as `create_task`, plus entries                                                                      | Create a Task and move history entries under it.                                   |
| `file_entries`             | task | entries                                                                                             | Move history entries under this Task.                                              |
| `revise_definition`        | task | title?, description?, done_when?, reason?                                                           | New revision of the definition (§3 applies per field).                             |
| `revise_plan`              | task | content, reason?                                                                                    | New Plan revision.                                                                 |
| `ready` / `unready`        | task | —                                                                                                   | Open ↔ ready.                                                                      |
| `assign`                   | task | agent                                                                                               | Make an agent accountable. Only a person takes a Task from another agent.          |
| `start`                    | task | claim?                                                                                              | In progress; needs an accountable agent (`claim` assigns the calling agent).       |
| `wait`                     | task | waiting_for, waiting_on {kind: agent/person/work/external, ref}, resume_when, follow_up_at?         | Waiting; shows in the Waiting column with who or what it waits on.                 |
| `resume`                   | task | —                                                                                                   | Back to the state before waiting.                                                  |
| `record_result`            | task | content, sources                                                                                    | Record a Result without completing.                                                |
| `complete`                 | task | result? or content + sources                                                                        | Complete with a Result.                                                            |
| `reopen`                   | task | reason                                                                                              | Reopen a finished Task.                                                            |
| `abandon`                  | task | reason                                                                                              | Abandon (reversible).                                                              |
| `detach_from_milestone`    | task | reason                                                                                              | Keep it in the Project, outside any Milestone.                                     |
| `depend` / `undepend`      | task | on                                                                                                  | Dependencies warn, never block; cycles are refused.                                |

## 7. The record

| Command              | On   | Input                               | Does                                                                                             |
| -------------------- | ---- | ----------------------------------- | ------------------------------------------------------------------------------------------------ |
| `set_status_line`    | —    | item, status_line                   | One sentence on where a Job, Project or Task stands now (§3 applies).                            |
| `attach_task`        | task | project?, milestone?, job?, reason? | Move a Task under a Project or Job, or make it standalone by giving neither.                     |
| `promote_to_project` | task | title?, outcome                     | A Task that grew a second deliverable becomes a Project; the Task and its sessions move into it. |
| `record_entry`       | —    | item, summary, session?, outcomes?  | One line of history under a Job, Project or Task.                                                |

## 8. Questions, Decisions and Findings

Open Questions answerable by the person and pending Decisions they decide are **Needs you**. Each
can carry the `session` it came from; the page links to it.

| Command              | On       | Input                                                                                     | Does                                              |
| -------------------- | -------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `raise_question`     | —        | prompt, impact, answerable_by, targets?, hypothesis?, session?                            | Something the person needs to tell the agent.     |
| `add_hypothesis`     | question | text                                                                                      | The agent's best guess, shown as a guess.         |
| `answer`             | question | answer, confidence?, sources?                                                             | Answer (the clerk records answers given in chat). |
| `accept_hypothesis`  | question | —                                                                                         | People only: accept the guess as the answer.      |
| `withdraw_question`  | question | reason                                                                                    | No longer matters.                                |
| `raise_decision`     | —        | prompt, options, recommendation, deciders, consequence_of_no_decision, targets?, session? | A choice for the person.                          |
| `revise_decision`    | decision | the body, reason                                                                          | Revise while pending.                             |
| `decide`             | decision | option, rationale?                                                                        | Decide (agents give a rationale).                 |
| `defer_decision`     | decision | until, reason                                                                             | Out of Needs you until the date.                  |
| `withdraw_decision`  | decision | reason                                                                                    | No longer needed.                                 |
| `supersede_decision` | decision | successor, reason                                                                         | Replaced by another.                              |
| `record_finding`     | —        | conclusion, confidence, sources, targets?                                                 | Something learned, with evidence.                 |
| `retract_finding`    | finding  | reason                                                                                    | It turned out wrong.                              |
| `supersede_finding`  | finding  | successor, reason                                                                         | Replaced by a newer Finding.                      |

`targets` name what a Question, Decision or Finding is about: `{kind: job | project | milestone |
task, id}`.

## 9. Removed in 2.0

Objectives, KPIs and reviews; Areas (`create_area`, `move_project`, `move_task` — use
`attach_task`); `serve` / `unserve`; discussion sessions (`set_session`); Asks (`dismiss_ask`).
