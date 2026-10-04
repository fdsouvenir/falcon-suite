# Falcon Work 5 — command list (draft)

Status: **draft for Fred's review**, 2026-10-03. Companion to [work-spec.md](work-spec.md); uses its
vocabulary only. Every button in the Stitch screens (`.stitch/screens/`) maps to a command below
(§8).

## 1. One tool, two verbs

Agents use one tool, `falcon_work`, with two actions:

- **`read`** — compact projections (§3). Never changes anything.
- **`do`** — exactly one command (§4–§6), validated, committed atomically, logged as an event.

The Control UI calls the same commands through the same validation. There is no second path.

**Keeping the agent's context small.** 4.x put every command's full schema in the system prompt on
every turn. Work 5 does not. The tool description lists command names with one line each; the full
input shape of any command is available on demand (`read help <command>`). What the agent sees every
turn is the short brief from the `before_prompt_build` hook (spec §10), not a schema.

## 2. Every command

**Input envelope**

| Field              | Required                           | Notes                                                                                                                                                          |
| ------------------ | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command`          | yes                                | Name from this document.                                                                                                                                       |
| `id`               | for commands on an existing object |                                                                                                                                                                |
| `expected_version` | UI: yes · agent: optional          | When given, a stale version is rejected with the current state. When an agent omits it, the command applies to the current version and the event records that. |
| `idempotency_key`  | no                                 | Defaults to the OpenClaw tool-call id, so an agent retry never double-applies. The UI sends its own.                                                           |
| `input`            | yes (may be `{}`)                  | The command's fields.                                                                                                                                          |

**Outcomes** — every command returns one of:

| Outcome                   | Meaning                                                                                                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `committed`               | Done. Returns the object's new version.                                                                                                                                     |
| `committed_with_warnings` | Done, with warnings the actor should know (e.g. started with an unfinished dependency).                                                                                     |
| `noop`                    | Already in that state (e.g. completing a completed Task). Nothing written.                                                                                                  |
| `input_required`          | Cannot proceed without someone's input. Returns what is needed; where it is another person or agent, an **Ask** is created. Nothing half-applied.                           |
| `rejected`                | Not allowed or not valid. Returns the reason and the commands that would make it possible (e.g. "Milestone has 1 unfinished Task: complete it or `detach_from_milestone`"). |

**Who may do what.** Humans may run every command. Agents may run every command **except** the
ones marked _human only_. An agent may only `decide` a Decision it is listed as a decider on, and
only `answer` a Question it is listed as able to answer.

## 3. Reads

| Read             | Returns                                                                                                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `brief`          | The calling agent's brief: active Objectives by rank with last progress, its in-progress and waiting Tasks, Questions/Decisions answered since its last turn, Warnings on its Work. The same text the hook injects. |
| `needs_you`      | For a person (default: the caller): Questions, Decisions and Asks addressed to them, and Warnings, oldest first.                                                                                                    |
| `objectives`     | Active Objectives by rank: KPIs, latest review, serving Projects/Tasks with counts, last progress. Paused/achieved/retired on request.                                                                              |
| `get <id>`       | One object in full: current fields, revisions, links, Results, Questions/Decisions/Findings about it, recent history. Long collections page.                                                                        |
| `list`           | Objects of one kind with filters: `area`, `project`, `objective`, `status`, `agent`, `text`; paged.                                                                                                                 |
| `activity`       | The feed: changes, captured activity, untracked activity; filters as `list`; paged.                                                                                                                                 |
| `warnings`       | Current Warnings, optionally for one object or agent.                                                                                                                                                               |
| `help <command>` | The full input shape of one command.                                                                                                                                                                                |

## 4. Objectives, KPIs, Areas

| Command                                                                           | Who          | Input                                                             | Effect / guard                                                                                         |
| --------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `create_objective`                                                                | _human only_ | `title`, `statement`, `rank?`, `autonomy?`, `limits?`, `session?` | Active Objective. Agents propose new Objectives as a Decision instead.                                 |
| `edit_objective`                                                                  | _human only_ | `title?`, `statement?`                                            | New version.                                                                                           |
| `rank_objectives`                                                                 | _human only_ | ordered list of active Objective ids                              | Ranks must be complete and unique.                                                                     |
| `set_autonomy`                                                                    | _human only_ | `autonomy`, `limits` (required for `act`)                         |                                                                                                        |
| `pause_objective` · `resume_objective` · `achieve_objective` · `retire_objective` | _human only_ | `reason?`                                                         | Leaving `active` frees its rank.                                                                       |
| `add_kpi` · `edit_kpi` · `remove_kpi`                                             | _human only_ | `name`, `unit`, `direction`, `target`, `target_date?`             | Removing keeps readings in history.                                                                    |
| `record_kpi_reading`                                                              | anyone       | `kpi`, `value`, `at`, `source`                                    | Append-only.                                                                                           |
| `write_review`                                                                    | agent        | `moved`, `stalled`, `proposed?`, `sources[]≥1`                    | Agents only; immutable. Proposals are raised separately with `raise_decision` targeting the Objective. |
| `create_area`                                                                     | anyone       | `title`, `description`, `accountable_human?`                      |                                                                                                        |
| `edit_area`                                                                       | anyone       | `title?`, `description?`, `accountable_human?`                    |                                                                                                        |
| `retire_area`                                                                     | _human only_ | `reason`                                                          | Rejected while it holds unfinished Work.                                                               |

## 5. Projects, Milestones, Tasks

### Projects and Milestones

| Command                            | Who    | Input                                                                                                            | Effect / guard                                                                                                                                                                                  |
| ---------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create_project`                   | anyone | `title`, `outcome`, `area`, `serves[]?`, `decision?`, `milestones[]?` (`title`, `success_condition`), `session?` | An agent creating Work that serves a _propose_ Objective must pass `decision`: a decided Decision targeting that Objective. Otherwise `rejected` (`proposal_required`, next: `raise_decision`). |
| `edit_project`                     | anyone | `title?`, `outcome?`, `reason`                                                                                   |                                                                                                                                                                                                 |
| `move_project`                     | anyone | `area`, `reason`                                                                                                 | Placement change, audited.                                                                                                                                                                      |
| `abandon_project`                  | anyone | `reason`, `dispositions?` (Task id → `abandon`·`detach`)                                                         | Each unfinished Task needs a disposition. Missing ones → `input_required`, one Ask per Task to the Project's accountable person; nothing applied.                                               |
| `resume_project`                   | anyone | `reason`                                                                                                         |                                                                                                                                                                                                 |
| `add_milestone` · `edit_milestone` | anyone | `title`, `success_condition`, `position?`                                                                        |                                                                                                                                                                                                 |
| `reorder_milestones`               | anyone | ordered ids                                                                                                      |                                                                                                                                                                                                 |
| `achieve_milestone`                | anyone | `basis`, `sources[]≥1`                                                                                           | **Closure guard**: rejected while associated Work is unfinished, naming each item.                                                                                                              |
| `reopen_milestone`                 | anyone | `reason`                                                                                                         | Reopens a completed Project.                                                                                                                                                                    |

### Tasks

| Command                     | Who    | Input                                                                                                                                              | Effect / guard                                                                                                                                                                                    |
| --------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create_task`               | anyone | `title`, `description`, `done_when`, `area` _or_ `project`, `milestone?`, `serves[]?`, `decision?`, `depends_on[]?`, `agent?`, `session?`, `plan?` | Starts `open`. Same _propose_-Objective rule as `create_project`.                                                                                                                                 |
| `create_task_from_session`  | anyone | `session`                                                                                                                                          | "Add to Work": a plugin flow, not a store command. The plugin reads the session from OpenClaw, shows a draft (title, description, discussion session) for confirmation, then calls `create_task`. |
| `create_task_from_activity` | anyone | `activity[]`, then as `create_task`                                                                                                                | Attaches the untracked activity to the new Task.                                                                                                                                                  |
| `attach_activity`           | anyone | `task`, `activity[]`                                                                                                                               | Explains untracked activity with an existing Task.                                                                                                                                                |
| `revise_definition`         | anyone | `title?`, `description?`, `done_when?`, `reason`                                                                                                   | Rejected on finished Tasks (reopen first). Older Plans/Results are shown as for the old Definition.                                                                                               |
| `revise_plan`               | anyone | `content`, `reason?`                                                                                                                               | New Plan revision pinned to the current Definition.                                                                                                                                               |
| `ready` · `unready`         | anyone | —                                                                                                                                                  | No reason needed.                                                                                                                                                                                 |
| `assign`                    | anyone | `agent`                                                                                                                                            | Assigned to another agent already → `input_required`, Ask to that agent.                                                                                                                          |
| `start`                     | anyone | `claim?`                                                                                                                                           | Needs an accountable agent; `claim: true` assigns the caller. Unfinished dependencies → `committed_with_warnings`.                                                                                |
| `wait`                      | anyone | `waiting_for`, `waiting_on` {`kind`: agent·person·work·external, `ref`}, `resume_when`, `follow_up_at?`                                            | Prior state remembered.                                                                                                                                                                           |
| `resume`                    | anyone | —                                                                                                                                                  | Restores the prior state.                                                                                                                                                                         |
| `record_result`             | anyone | `content`, `sources[]≥1`                                                                                                                           | Immutable, pinned to the current Definition. Not yet accepted.                                                                                                                                    |
| `complete`                  | anyone | `result` (id) _or_ `content` + `sources[]≥1`                                                                                                       | Accepts the Result. Repeat → `noop`.                                                                                                                                                              |
| `reopen`                    | anyone | `reason`                                                                                                                                           |                                                                                                                                                                                                   |
| `abandon`                   | anyone | `reason`                                                                                                                                           | Reversible with `reopen`.                                                                                                                                                                         |
| `move_task`                 | anyone | `area` _or_ `project`, `milestone?`, `reason`                                                                                                      |                                                                                                                                                                                                   |
| `detach_from_milestone`     | anyone | `reason`                                                                                                                                           | Used to satisfy the closure guard.                                                                                                                                                                |
| `depend` · `undepend`       | anyone | `on` (Task id)                                                                                                                                     | Cycles rejected.                                                                                                                                                                                  |

### Shared by Objectives, Projects and Tasks

| Command             | Who    | Input                                                 | Effect / guard                                                                                                  |
| ------------------- | ------ | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `serve` · `unserve` | anyone | `kind` (project·task), `id`, `objective`, `decision?` | Same _propose_-Objective rule.                                                                                  |
| `set_session`       | anyone | `kind`, `id`, `session` or `null`                     | Objectives, Projects, Tasks, Asks. A person's choice can only be changed by a person. Recorded with who set it. |

## 6. Questions, Decisions, Findings, Asks

| Command              | Who               | Input                                                                                                                                                                           | Effect / guard                                                                                  |
| -------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `raise_question`     | anyone            | `prompt`, `impact`, `answerable_by[]`, `targets[]?`, `hypothesis?`                                                                                                              | Creates an Ask for each human in `answerable_by`.                                               |
| `add_hypothesis`     | anyone            | `text`, `sources[]?`                                                                                                                                                            | Shown as a hypothesis, never as the answer.                                                     |
| `answer`             | anyone answerable | `answer`, `confidence?`, `sources[]?`                                                                                                                                           | Humans default to `confirmed`. A later answer supersedes, history kept. Resolves the Ask.       |
| `accept_hypothesis`  | human answerable  | —                                                                                                                                                                               | "Use <agent>'s hypothesis": records it as the human's confirmed answer.                         |
| `withdraw_question`  | anyone            | `reason`                                                                                                                                                                        |                                                                                                 |
| `raise_decision`     | anyone            | `prompt`, `options[]≥2` (`id`, `label`, `summary?`, `risks?`, `tradeoffs?`), `recommendation` {`option`, `rationale`}, `deciders[]`, `consequence_of_no_decision`, `targets[]?` | Creates an Ask for each human decider. Targeting a Task makes it derived-blocked until decided. |
| `revise_decision`    | anyone            | as `raise_decision`, `reason`                                                                                                                                                   | Only while pending.                                                                             |
| `decide`             | deciders          | `option`, `rationale` (agents: required · humans: optional)                                                                                                                     | Resolves the Asks.                                                                              |
| `defer_decision`     | deciders          | `until`, `reason`                                                                                                                                                               |                                                                                                 |
| `withdraw_decision`  | anyone            | `reason`                                                                                                                                                                        |                                                                                                 |
| `supersede_decision` | anyone            | `successor`, `reason`                                                                                                                                                           |                                                                                                 |
| `record_finding`     | anyone            | `conclusion`, `confidence`, `sources[]≥1`, `targets[]?`                                                                                                                         |                                                                                                 |
| `retract_finding`    | anyone            | `reason`                                                                                                                                                                        |                                                                                                 |
| `supersede_finding`  | anyone            | `successor`, `reason`                                                                                                                                                           |                                                                                                 |
| `dismiss_ask`        | anyone            | `reason`                                                                                                                                                                        | The underlying Question/Decision stays open.                                                    |

Asks are created by the commands above, never directly. Answering or deciding resolves them.

## 7. Written by the plugin, not by commands

These have no command; the plugin writes them so nobody has to report them (spec §10–§11):

- **Activity** from `after_tool_call` — attached to the agent's in-progress Task, or recorded as
  untracked.
- **Session links** — every session that touched an object, as history.
- **Warnings** — computed from Work's data and session state; they clear themselves.
- **The brief** — computed for `before_prompt_build`.
- **The end-of-turn nudge** — `before_agent_finalize`, not a write at all.

## 8. Screens → commands

| Screen                          | Control                                 | Command                                                               |
| ------------------------------- | --------------------------------------- | --------------------------------------------------------------------- |
| Overview · Needs you            | Answer (text)                           | `answer`                                                              |
|                                 | Use Verl's hypothesis                   | `accept_hypothesis`                                                   |
|                                 | Option + Decide                         | `decide`                                                              |
|                                 | Discuss in session                      | opens the session (no command)                                        |
| Overview · Untracked / Activity | Create Task from this                   | `create_task_from_activity`                                           |
| Header                          | New → Task / Project / Objective / Area | `create_task` · `create_project` · `create_objective` · `create_area` |
| Objectives tab                  | drag to reorder                         | `rank_objectives`                                                     |
| Objective page                  | Edit · Pause · Retire                   | `edit_objective` · `pause_objective` · `retire_objective`             |
|                                 | Add reading · + KPI                     | `record_kpi_reading` · `add_kpi`                                      |
|                                 | Allow Verl to act…                      | `set_autonomy`                                                        |
|                                 | Link a Project or Task                  | `serve`                                                               |
| Areas & Projects                | + Area · New Project                    | `create_area` · `create_project`                                      |
| Project page                    | Edit · Change session · Abandon         | `edit_project` · `set_session` · `abandon_project`                    |
|                                 | Mark achieved                           | `achieve_milestone` (disabled while the guard holds)                  |
| Task panel                      | Edit · Wait… · Abandon                  | `revise_definition` · `wait` · `abandon`                              |
| Session header                  | Add to Work                             | `create_task_from_session`                                            |

## 9. Removed from 4.x

`revise_change`, `authorize`, `revoke_authorization`, `review_target`, `reaffirm_plan`,
`reaffirm_dependency`, `checkpoint`, `edit_question`, `place`, `associate`/`dissociate`,
`archive`/`restore` — replaced by the commands above or dropped with the concepts they served
(change control, review targets, archive state).

## 10. Settled with Fred (2026-10-03)

1. Agents cannot create, rank or change Objectives; they propose them as Decisions, and need a
   decided Decision before creating Work toward a _propose_ Objective.
2. `expected_version` is optional for agents and always sent by the UI.
3. Retiring an Area is human only, and only when it holds no unfinished Work.
