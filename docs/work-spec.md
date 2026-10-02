# Falcon Work 5 — specification (draft)

Status: **draft for Fred's review**, 2026-10-01. Nothing here is implemented.

## 1. Purpose

Work is where an agent is **made to record what it is doing**, in a structure that gives the human
**one pane of glass** over everything their agents are doing for them, and why.

Two things follow from that, and every rule below serves one of them:

1. **The record is enforced, not requested.** An agent that has to remember to report will not.
   The plugin uses OpenClaw's runtime hooks to require the record and to capture the evidence of
   what actually happened. The agent writes only what needs judgment: intent, definition of done,
   decisions, findings, results.
2. **The structure matches how people delegate.** People hand their agent standing
   responsibilities, bounded efforts with checkpoints, individual tasks, and long-running aims they
   want progress on. The agent runs into unknowns, makes choices someone may need to approve, and
   learns things worth keeping. Each of those has a home.

Work is **gateway-scoped and shared**: every person and agent on a Gateway sees the same Work.
Per-person permissioning may come later and is out of scope here.

## 2. Vocabulary

These are the only domain words. The UI, the agent tool and this document use them exactly.

| Word | What it is | Ends? |
| --- | --- | --- |
| **Objective** | A north star the human constantly wants progress toward. | Only when the human says so |
| **KPI** | An optional measure of an Objective, with a target. | With its Objective |
| **Area** | A standing responsibility that has to keep running. | No (can be retired) |
| **Project** | A bounded outcome, reached through ordered Milestones. | Yes |
| **Milestone** | A checkpoint inside one Project, with an observable success condition. | Yes |
| **Task** | One piece of executable work with a definition of done. | Yes |
| **Question** | Missing knowledge that someone has to supply. | When answered |
| **Decision** | A choice between options that a named decider has to make. | When decided |
| **Finding** | Something learned that is worth keeping. | Can be retracted or superseded |
| **Ask** | A pending request for one specific person's or agent's input, delivered into a conversation. | When answered |

Parts of a Task: **Definition** (title, description, done-when), **Plan** (how it will be done),
**Result** (what was produced, with evidence). Relationships: **serves**, **depends on**,
**placement** (which Area or Project something lives in), **milestone association**, **targets**
(what a Question, Decision or Finding is about).

## 3. Objective

An Objective is the *why*. Projects and Tasks link to the Objectives they **serve**. Upkeep in an
Area may serve no Objective; that is normal, and the human can see the split.

Fields:

- `title` — short and scannable: "Home AI Solutions reaches $10K monthly revenue".
- `statement` — what success looks like and why it matters, in the human's words.
- `rank` — explicit order among active Objectives, so trade-offs are visible. Unique among active.
- `status` — `active` · `paused` · `achieved` · `retired`. Only a human changes it.
- `autonomy` — `propose` (default) or `act`.
  - **propose**: the agent suggests next steps as a Decision addressed to the human. Accepting it
    creates the Project or Tasks.
  - **act**: the agent may create and do Work toward the Objective without asking, inside the
    written `limits` (for example "no spending, no messages to customers"). Everything is still
    recorded.
- `limits` — required when autonomy is `act`.
- `owner` — the accountable human.

**KPIs** (optional, zero or more per Objective): `name`, `unit`, `direction` (up/down/hold),
`target`, optional `target_date`, and an append-only list of **readings** (`value`, `at`,
`source`). A KPI with no readings is visibly unmeasured, not zero.

**Reviews**: the agent periodically writes a review of each active Objective: what moved, what did
not and why, what it proposes next. A review cites the Work and sources it rests on and is
immutable once written. Reviews are **daily by default**; the schedule is an OpenClaw automation,
and Work never schedules anything itself. A review with proposals creates Decisions addressed to the owner.

## 4. Area

A standing responsibility: Home, Finances, Fredbot Platform. It never completes.

- `title`, `description` (what is in and out of this responsibility), `status` `active`/`retired`.
- `accountable_human` — the person escalations in this Area go to. Defaults to the Gateway owner.
- Every Project and every Task not in a Project is **placed** in exactly one Area. Moving
  placement is an audited command with a reason.

Area versus Project: if it would make sense to say "this is done", it is a Project. If it is
"keep this healthy", it is an Area. Area versus Objective: an Area is upkeep; an Objective is
direction.

## 5. Project and Milestone

A Project is a bounded outcome placed in one Area, optionally serving Objectives.

- `title`, `outcome` (what exists when it is done), `area`, `accountable_human`, `serves[]`.
- Status is **derived**, never set: `open`, `completed` (all Milestones achieved), `abandoned`.
- Abandoning is reversible (resume) and never silently changes unfinished Work: each unfinished
  item must be explicitly abandoned too or detached into the Area as standalone Work.

A Milestone belongs to one Project, in order.

- `title`, `success_condition` (observable), `order`, `status` `open`/`achieved`.
- **Achieving** records a `basis` (why the success condition is met) and at least one source.
- **Closure guard**: a Milestone cannot be achieved while associated Work is unfinished. Finish
  it, or detach it with a reason. Reopening an achieved Milestone reopens a completed Project.

There is no Phase, no project-level plan object and no "next item" pointer. The ordered
Milestones and their associated Work are the plan.

## 6. Task

The unit of executable work, including code, configuration, data, infrastructure and errands.

### Definition

`title` (scannable action), `description` (context, scope, constraints), `done_when` (observable
finish line). Definitions are **immutable revisions**: revising creates a new revision with a
reason; the Task points at the current one. Revising a finished Task requires reopening it first.

### Lifecycle

`open` → `ready` → `in_progress` → `completed`, plus `waiting` and `abandoned`.

- `open`/`ready` is routine grooming and needs no reason.
- **Starting requires an accountable agent.** At most one agent is accountable per Task. Taking a
  Task assigned to another agent goes through an Ask to that agent.
- **Waiting** requires `waiting_for` (a sentence) and `waiting_on` (typed: an agent, a person, a
  Work object, or something external), plus `resume_when` and optional `follow_up_at`. Resuming
  restores the prior state.
- **Completing** requires a Result. Repeat completion is a no-op. Further work means reopening.
- **Blocked** is not a status. It is derived from typed causes: unfinished dependencies, open
  Questions targeting the Task, pending Decisions targeting it, pending Asks, waiting.

### Plan and Result

- A **Plan** is optional narrative: approach, steps, risks, validation. Immutable revisions,
  pinned to the Definition revision it was written for.
- A **Result** is what was produced. It carries prose and **at least one source** (commit,
  release, file, URL, message, reading). It pins the current Definition. A Result may be recorded
  before completion (for review or handoff); completion accepts one.
- When a Definition is revised, earlier Plans and Results are shown as written for an older
  definition; they are never silently re-pinned.

### Dependencies

`depends_on` records expected order. It **warns, it never blocks**: starting or completing with
an unfinished dependency is recorded truthfully with a warning. Cycles are rejected.

### Approval of consequential steps

When a step needs the human's go-ahead (a DNS change, a payment, a message sent on their
behalf), the agent creates a **Decision** targeting the Task, with the human as decider. The Task
is derived blocked until it is decided. This replaces the 4.x change-control boundary and
`revise_change`, which are removed.

Work records approval; it does not enforce it at runtime. OpenClaw's exec approvals and tool
policy are the only runtime gate, and Work never claims otherwise.

## 7. Question, Decision, Finding

All three may **target** Objectives, Projects, Milestones or Tasks, and may be placed in an Area
or Project.

**Question** — missing knowledge.
- `prompt`, `impact` (what is held up), `answerable_by` (people/agents).
- `open` → `answered` (answer, confidence `tentative`/`supported`/`confirmed`, sources) or
  `withdrawn` (reason). An answer can be superseded by a later answer; history is kept.
- An agent may record a **hypothesis** while waiting; it is shown as such, never as the answer.

**Decision** — a choice with consequences.
- `prompt`, `options` (two or more: label, summary, risks, trade-offs), `recommendation`
  (option + rationale), `deciders`, `consequence_of_no_decision`.
- `pending` → `decided` (option, rationale, decider) · `deferred` (until a date) · `withdrawn`
  · `superseded` (by another Decision).
- Uses: approval of consequential steps (§6), agent proposals toward an Objective (§3), and
  genuine design choices.

**Finding** — something learned.
- `conclusion`, `confidence`, at least one source.
- `current` → `retracted` (reason) or `superseded` (by another Finding).

## 8. Ask

An Ask is the delivery mechanism, not a kind of Work. It records that one specific person or agent
has been asked for input about one subject.

- Created for: a Question or Decision addressed to a human; a Task handover to another agent;
  each unfinished item during Project abandonment.
- **Always shown in the Work tab** under "Needs you".
- **Optionally linked to one OpenClaw session.** The agent may link it when creating the Ask; the
  human can link, change or remove the session from the Work tab. A linked Ask is posted into that
  session, and the discussion about it happens there. Whether to link, and to which session, is
  the agent's judgement; the human's choice always wins. Every link change is recorded with who
  made it.
- It can be answered from the Work tab or in its linked session; either way the answer is
  recorded once.
- Answering it resubmits the underlying command, which is revalidated; nothing is half-applied
  while waiting.

## 9. Enforcement and evidence

This is what makes Work a record rather than a diary.

| OpenClaw hook | What Work does |
| --- | --- |
| `before_prompt_build` | Injects a **short** live brief instead of a schema: active Objectives by rank, the agent's in-progress Tasks, Questions/Decisions answered since its last turn, what is waiting on it. |
| `after_tool_call` | Attaches what the agent actually did — command run, file changed, message sent, commit made, session link — to its in-progress Task. With no in-progress Task, it is recorded as **untracked activity**, visible to the human. |
| `before_agent_finalize` | If the turn changed something and touched no Work, asks the model for one more pass to record it. |
| `before_tool_call` *(strict mode, per agent, **off by default**)* | Refuses tools that change things until the agent has a Task in progress. |

What counts as work: any tool call that changes something (files, commands, outgoing messages,
config, external APIs). Chat-only turns and read-only tool use are exempt.

Evidence captured by hooks is stored as activity on the Task with its source; the agent never has
to restate it. Results cite it.

## 10. The human's view

The Work tab in the Control UI answers, at a glance:

1. **Objectives** — each active Objective by rank: KPI readings against target, latest review,
   Work in flight serving it, and when it last made progress (the most recent completed Task
   serving it).
2. **Needs you** — Questions, Decisions and Asks addressed to you, oldest first.
3. **Now** — what each agent has in progress.
4. **Waiting** — Tasks waiting, on whom, and which follow-ups are due.
5. **Recently completed** — with Results and their evidence.
6. **Untracked activity** — things agents did that no Task explains.
7. **Areas and Projects** — the browsable structure, with derived status and Milestone progress.

## 11. Persistence and agent interface

- One private SQLite database per Gateway. Immutable revisions for Definitions, Plans, Results,
  KPI readings and reviews. Append-only event log of every command: actor, time, before/after.
- Optimistic versions on every mutable object; idempotency keys on every command.
- One agent tool, `falcon_work`, with typed commands and compact read projections. Exact command
  list follows this spec once the model is agreed.

## 12. Not in Work

Schedules and recurrence (OpenClaw automations own them) · Tags (Area and Project are the only
classification) · Phases · standalone Change Requests, Reviews or Blockers · documents and files ·
transcripts (OpenClaw owns sessions; Work links to them) · runtime permission enforcement.

## 13. Settled with Fred (2026-10-02)

1. Strict mode is off by default; the end-of-turn nudge is the baseline.
2. Asks always appear in the Work tab. An Ask can be linked to an OpenClaw session by the agent
   when it is created, and the human can set or change that link in the UI.
3. Objective reviews run daily by default.
4. No effort-share metric. Objectives show when they last made progress instead.
