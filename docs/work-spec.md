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

| Word          | What it is                                                                                   | Ends?                          |
| ------------- | -------------------------------------------------------------------------------------------- | ------------------------------ |
| **Objective** | A north star the human constantly wants progress toward.                                     | Only when the human says so    |
| **KPI**       | An optional measure of an Objective, with a target.                                          | With its Objective             |
| **Area**      | A standing responsibility that has to keep running.                                          | No (can be retired)            |
| **Project**   | A bounded outcome, reached through ordered Milestones.                                       | Yes                            |
| **Milestone** | A checkpoint inside one Project, with an observable success condition.                       | Yes                            |
| **Task**      | One piece of executable work with a definition of done.                                      | Yes                            |
| **Question**  | Missing knowledge that someone has to supply.                                                | When answered                  |
| **Decision**  | A choice between options that a named decider has to make.                                   | When decided                   |
| **Finding**   | Something learned that is worth keeping.                                                     | Can be retracted or superseded |
| **Ask**       | A pending request for one specific person's or agent's input, delivered into a conversation. | When answered                  |
| **Warning**   | Something the plugin noticed from the data itself that needs attention (§11).                | When the condition clears      |

Parts of a Task: **Definition** (title, description, done-when), **Plan** (how it will be done),
**Result** (what was produced, with evidence). Relationships: **serves**, **depends on**,
**placement** (which Area or Project something lives in), **milestone association**, **targets**
(what a Question, Decision or Finding is about).

## 3. Objective

An Objective is the _why_. Projects and Tasks link to the Objectives they **serve**. Upkeep in an
Area may serve no Objective; that is normal, and the human can see the split.

Fields:

- `title` — short and scannable: "The consultancy reaches 20 retained clients".
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
- _(Follow-on)_ Each source on a Result says how far it can be trusted: **reported** by the agent,
  **captured** by the hooks (§10), or **verified** by the plugin checking it exists (a commit in
  the repository, a published release, a reachable URL). The human sees at a glance how much of a
  "done" rests on the agent's word.

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
- **Answering in the Work tab:** a text field and **Answer** submit immediately, recorded as the
  human's answer with `confirmed` confidence; a brief Undo follows, and a later answer can replace
  it with history kept. When the agent recorded a hypothesis, **Use <agent>'s hypothesis** records
  that hypothesis as the human's confirmed answer, attributed to the human as accepting it. With a
  session, **Discuss in session** opens it.

**Decision** — a choice with consequences.

- `prompt`, `options` (two or more: label, summary, risks, trade-offs), `recommendation`
  (option + rationale), `deciders`, `consequence_of_no_decision`.
- `pending` → `decided` (option, decider, rationale) · `deferred` (until a date) · `withdrawn`
  · `superseded` (by another Decision). Rationale is required when an agent decides and
  optional when a human does.
- **Deciding in the Work tab:** clicking an option selects it (it does not decide); a row then
  offers an optional "Why?" and **Decide**. The recommended option is labelled, not preselected.
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
- **Always shown in the Work tab** under "Needs you". If it has a session (§9), it is also posted
  there and discussed there.
- It can be answered from the Work tab or in its session; either way the answer is recorded once.
- Answering it resubmits the underlying command, which is revalidated; nothing is half-applied
  while waiting.

## 9. Sessions

OpenClaw owns sessions. Work relates to them in two separate ways.

**Where the work happened** — automatic history. Every session in which an agent worked on a Task,
or raised a Question, Decision or Finding, is captured by the hooks in §10 as evidence on that
object. There can be many; nobody sets them by hand, and they are never edited.

**Where it is discussed** — one optional session per **Objective, Project, Task and Ask**.

- The agent may set it when it creates the object. The human can set, change or remove it from the
  Work tab. The human's choice always wins, and every change records who made it.
- What it means: an Objective's daily review is posted there; a Project or Task is worked and
  talked about there; an Ask is posted there.
- **Fallback:** a Task with no session uses its Project's. An Ask with no session uses the session
  of what it is about: the Task it hands over, or the Task or Project its Question or Decision
  targets (which may in turn fall back to the Project's). So linking a Project to a thread puts
  all of its Tasks and Asks there unless one says otherwise.
- Questions, Decisions and Findings have no discussion session of their own: Questions and
  Decisions are discussed through their Ask, and Findings are reference material.
- A session that no longer exists stays visible as missing; it is never silently dropped or
  replaced.

**Add to Work.** From any session's header, the human (or the agent) can turn the conversation
into a Task: titled from the session's label or opening prompt, its description seeded from the
conversation, and its discussion session set to that session. The session header then shows the
linked Task, so a conversation and its Work open from each other.

**Live session state.** Wherever a discussion session is shown, its current state is shown with
it — running, idle, done, failed, missing — kept current by OpenClaw's completion hooks and a
periodic check. Work **never changes a Task's status to match its session**: the status is what was
recorded. A mismatch becomes a Warning (§11) instead.

## 10. Enforcement and evidence

This is what makes Work a record rather than a diary.

| OpenClaw hook                                                     | What Work does                                                                                                                                                                                                                 |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `before_prompt_build`                                             | Injects a **short** live brief instead of a schema: active Objectives by rank, the agent's in-progress Tasks, Questions/Decisions answered since its last turn, what is waiting on it.                                         |
| `after_tool_call`                                                 | Attaches what the agent actually did — command run, file changed, message sent, commit made, session link — to its in-progress Task. With no in-progress Task, it is recorded as **untracked activity**, visible to the human. |
| `before_agent_finalize`                                           | If the turn changed something and touched no Work, asks the model for one more pass to record it.                                                                                                                              |
| `before_tool_call` _(strict mode, per agent, **off by default**)_ | Refuses tools that change things until the agent has a Task in progress.                                                                                                                                                       |

What counts as work: any tool call that changes something (files, commands, outgoing messages,
config, external APIs). Chat-only turns and read-only tool use are exempt.

Evidence captured by hooks is stored as activity on the Task with its source; the agent never has
to restate it. Results cite it.

## 11. Warnings

Warnings are computed by the plugin from Work's own data and session state. They need nobody to
report anything, which is the point: they catch what the record should say but doesn't. Each
names the object, what is wrong and since when, and clears itself when the condition no longer
holds.

| Warning                    | Condition (thresholds configurable)                                                            |
| -------------------------- | ---------------------------------------------------------------------------------------------- |
| Stalled Task               | In progress with no recorded activity for 48 hours.                                            |
| Session mismatch           | In progress, but its discussion session has been idle for 48 hours, has failed, or is missing. |
| Follow-up overdue          | Waiting past its `follow_up_at`.                                                               |
| Unanswered                 | A Question or Decision open for more than 7 days.                                              |
| Objective without progress | An active Objective with no completed serving Task for 7 days.                                 |
| Untracked activity         | Activity no Task explains, in the last 24 hours.                                               |
| Milestone ready            | Every associated Task is finished but the Milestone is not achieved.                           |

Warnings appear in **Needs you** and feed the agent's daily Objective review.

## 12. The human's view

The Work tab in the Control UI answers, at a glance. Its **Overview** is calm: one line per item,
nothing listed twice, and acting happens in the side panel, not on the page.

1. **Summary** — one sentence: what is waiting on you, and what the agents are working on.
2. **Needs you** — only what you can act on, oldest first, grouped by what you do: **Decide**
   (Decisions you decide, with the agent's recommendation), **Answer** (Questions you can answer,
   with the agent's hypothesis), **Do** (Tasks waiting on you, and Asks to take over a Task). A
   Task waiting on you that one of your Decisions or Questions already covers is not listed again.
   Age replaces the matching Warnings: an old item's age turns to a warning colour, and an overdue
   follow-up shows as "overdue".
3. **Happening now** — Tasks in progress, waiting (on whom; "waiting on your decision" when it is
   covered above) and ready.
4. **Heads up** — the remaining Warnings (§11), quietly: Objectives without progress, stalled
   Tasks, untracked activity, Milestones ready to mark achieved.
5. **Objectives** — each active Objective by rank with its first KPI and last progress (the full
   view, with reviews and serving Work, is the Objectives tab).
6. **Recently completed** — the latest finished Tasks; the rest is in Activity.
7. **Areas and Projects** — the browsable structure, with derived status and Milestone progress.

A Decision opens in the side panel with its options (risks and tradeoffs), the recommendation
preselected, the agent's reasoning, an optional "Why?", **Decide**, and what happens if nobody
decides. A Question shows why it matters, the agent's hypothesis with **Use its guess**, or your
own answer. Both show what they are for.

**Navigation.** Areas are a row of filter chips under the tabs ("All" by default, grouping
Projects under Area headings), never a second sidebar. Objectives, Projects and Areas open as full
pages with a breadcrumb and Back. Tasks, Questions, Decisions and Findings open in a side panel
over the current page, with "Open as page". Session chips open the session; evidence chips open
the commit, PR or file. A Project page shows its header (status, serves, accountable, session with
live state; Edit, Change session, Abandon), outcome, ordered Milestones with their Tasks and
achievement basis — **Mark achieved** is disabled with the reason while the closure guard holds —
the Questions, Decisions and Findings about it, and its history.

**Look.** Work is a native Control UI page that looks built in: it uses only the Control UI's
theme variables, fonts and full-width page layout, with no palette, fonts or page frame of its
own, and the host's own components (dialogs, pickers, agent avatars, session summaries) wherever
they exist. It follows light/dark mode and any theme the human picks. The sidebar icon is
`listChecks`. Screens are designed in Stitch first, starting from the Control UI's theme.

_(Follow-on)_ The same views are available as native widgets the agent can pin to a session
dashboard — **Needs you**, **Objective progress**, a single **Task** or **Project** — so the view
reaches into the sessions where the work happens.

## 13. Persistence and agent interface

- One private SQLite database per Gateway. Immutable revisions for Definitions, Plans, Results,
  KPI readings and reviews. Append-only event log of every command: actor, time, before/after.
- Optimistic versions on every mutable object; idempotency keys on every command.
- One agent tool, `falcon_work`, with typed commands and compact read projections. Exact command
  list follows this spec once the model is agreed.
- _(Follow-on)_ Durable event subscriptions with a read position, so an agent or automation
  resumes without missing or double-reading changes (for example "a Question you raised was
  answered"). The brief in §10 is built from these.

## 14. Not in Work

Schedules and recurrence (OpenClaw automations own them) · Tags (Area and Project are the only
classification) · Phases · standalone Change Requests, Reviews or Blockers · documents and files ·
transcripts (OpenClaw owns sessions; Work links to them) · runtime permission enforcement.

## 15. Settled with Fred (2026-10-02)

1. Strict mode is off by default; the end-of-turn nudge is the baseline.
2. Asks always appear in the Work tab. Objectives, Projects, Tasks and Asks can each have one
   discussion session, set by the agent at creation or by the human in the UI (§9).
3. Objective reviews run daily by default.
4. No effort-share metric. Objectives show when they last made progress instead.
5. Work stays separate from OpenClaw's Workboard. From it Work takes: Add to Work from a session,
   live session state, and Warnings (5.0); evidence trust levels, dashboard widgets and durable
   event subscriptions (follow-on).
6. Work's sidebar icon is `listChecks`. The UI is designed in Stitch first, on OpenClaw's own
   theme. The `falcon_work` command list waits until the UI design is settled.
7. Answering a Question submits immediately (with Undo); "Use <agent>'s hypothesis" accepts the
   hypothesis as the human's answer. Choosing a Decision option only selects it; Decide commits,
   with an optional reason when a human decides.
