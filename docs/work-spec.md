# Falcon Work 5 — specification (draft)

Status: **draft for Fred's review**, 2026-10-01. Nothing here is implemented.

## 1. Purpose

Work is where an agent is **made to record what it is doing**, in a structure that gives the human
**one pane of glass** over everything their agents are doing for them, and why.

Two things follow from that, and every rule below serves one of them:

1. **The record keeps itself.** An agent that has to remember to report will not, and nudging it
   mid-work does not change that. Work writes the record from what actually happens (§10, The
   record keeper): it files each turn's outcomes under the right Task, opens Tasks for new work and
   completes them when their done-when is met. The agent can still record and correct through its
   tools, and its entries win; it is never required to.
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
  item must be explicitly abandoned too or detached into the Area as standalone Work. Only a person
  abandons a Project, choosing for each unfinished Task in the same step; an agent that thinks a
  Project should go raises a Decision.

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
- **Starting requires an accountable agent.** At most one agent is accountable per Task. Work assumes one
  agent per Office: an agent cannot take a Task assigned to another agent; a person can reassign
  it. Handover between agents waits for real multi-agent use (§15.9).
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

- Created for a Question or Decision addressed to a human.
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

> **Deferred (Fred, 2026-10-07; §15.8).** Discussion sessions, Add to Work, live session state and
> the Session mismatch Warning are not part of 5.0. Sessions drift between subjects and one
> subject has several sessions, so a fixed link adds little: the agent records and updates Work
> as the conversation goes, the `task_fit` gate (§10) places each turn's work, and the automatic
> history above answers "where was this done?". The store's existing `session` fields stay;
> nothing new is built on them. The rest of this section describes the deferred design.

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

| OpenClaw hook                                                     | What Work does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `before_prompt_build`                                             | Injects a **short** live brief instead of a schema: active Objectives by rank, where work lives (active Areas and their open Projects, with the Objectives they serve and their current Milestone), the agent's in-progress Tasks, Questions/Decisions answered since its last turn, what is waiting on it. The static guidance only says what Work is (the person's view of the agent's work, and its vocabulary) and that the person's request goes ahead if Work fails; behaviour comes from the tools, which are named for intents (plan a Project, track a Task, ask the person, record a Finding) and describe themselves. Rules in the prompt were tried and got applied literally past their intent (commands §1). |
| `after_tool_call`                                                 | Notes the turn's **outcomes** in memory (see The record keeper). Raw tool calls are never stored: OpenClaw's session transcript already holds them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `before_agent_finalize`                                           | Changes no Task explains get one more pass where the runtime allows it (OpenClaw does not grant one after side effects, so on many turns only the automatic capture applies). On turns the person started, gate **left_waiting** (below) decides whether the reply leaves the agent waiting on the person; if so Work records it as a Question addressed to them ("Asked in chat"), sets the in-progress Task waiting when an action is needed, and the agent's next brief asks it to refine or withdraw the capture.                                                                                                                                                                                                      |
| `before_tool_call` _(strict mode, per agent, **off by default**)_ | Refuses tools that change things until the agent has a Task in progress.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

### The record keeper

_Settled with Fred 2026-10-10 (§15.10)._ Work writes the record itself, after every turn in any
session — the person's, a subagent's, or an automation's.

- **Outcomes, not tool calls.** During a turn Work notes only what left a mark outside the chat:
  commits, pushes, pull requests, releases and publishes, installs and deploys, messages sent,
  files written (grouped by repository or folder), config changes and other external writes. Reads,
  searches, listings and test runs are not outcomes. Nothing about the tool calls themselves is
  kept: each entry links to its session and turn, and OpenClaw's transcript (with its own
  retention) holds the detail.
- **Which Task.** Each session has its own current Task: the one it started, or Work filed it
  under. A subagent works under its parent's. At the end of a turn with outcomes, or one the person
  started, one decision batch answers: continues the session's Task / belongs to another open Task /
  new work / not work, and whether that Task's done-when is now met.
- **Writing it.** The Office's utility model (OpenClaw's `utilityModel` role) writes what the
  decision model cannot: the turn's one-sentence summary; for new work, a Task with title,
  description, done-when and its place (Area or Project, Milestone); for a met done-when, the
  Result. Work then commits it as **recorded by Work**, with the outcomes as evidence.
- **One Task per piece of work.** A session doing several things produces several Tasks, not one
  umbrella Task (Fred: the provisioning session should have been five).
- **The agent and the person stay in charge.** The agent's own Work calls take precedence over the
  record keeper for that turn; the person can edit, merge or move anything, and everything Work
  wrote is marked as such.
- **Without the models** outcomes are still filed under the session's current Task; with no
  current Task they wait as **unfiled work** (a Warning) until something files them.

**Timeline.** A Task's history is its timeline: one entry per outcome-bearing turn, showing the
outcomes as chips (commit, PR, file, message) and opening to that turn's summary. Turns on the
Task that changed nothing outside the chat fold into one line ("3 turns of discussion"). The
Activity tab is every Task's timeline, newest first.

### Decision gates

Work asks the Office's decision model (OpenClaw's `decisionModel` role, e.g. TypeSafe Jev) typed questions in **one batch per event** — the end of a turn the person started, and each message they send — including speculative questions whose answers only matter on some branches (TypeSafe's "speculative fan-out"). A routing table turns answers into Work actions. Questions measured against labelled turns act; new ones run in **shadow**: their answers are written to `decisions.jsonl` in Work's data folder with what they would have done, so they can be reviewed and labelled before they are promoted. Measured: bundling changed 5 of 133 borderline turns (2 better, 2 worse) against separate calls. Gates run only on turns the person started (`trigger` user, input provenance `external_user`), never on heartbeats, scheduled jobs or messages from other sessions. Without a decision model they do nothing and the agent gets a reminder in its next brief instead. Rubrics live in `src/plugin/gates.ts`, are measured in `eval/` against labelled turns, and a test keeps the two identical.

| Gate                  | When                                                           | Outcome → action                                                                                                                                                                  | Measured (Jev 1.13)                                                               |
| --------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **left_waiting**      | End of a person-started turn where nothing was raised in Work  | needs answer / decision / action → a Question to the person (and the Task waiting, for an action); offer or nothing → nothing. Threshold 0.5.                                     | 40 held-out turns: right action 35/40, every real ask caught but one              |
| **asked_for**         | Right after left_waiting finds something                       | per sentence or list item of the reply: part of the ask? The picked pieces become the captured Question's text; the sentence-based text extractor is the fallback. Threshold 0.8. | 58 asking turns, 1,069 pieces: F1 0.84, precision 0.88 (text extractor 0.73)      |
| **answers_open_item** | When the person sends a message and something is open for them | per open Question: answered → record the message as the answer; per open Decision: an option → decide. Threshold 0.7.                                                             | 42 real replies + 8 Decision cases: precision 1.00, recall 0.82, no decoy matched |

In shadow (logged, not acted on): end of turn — `work_request` (track / one-off / chat), `plan_in_chat`, `promise` (the agent committed to later work), `task_done` (the in-progress Task's done-when is met), `task_fit` (which in-progress Task the work belongs to), `already_open` (the ask repeats a Question already open for the person — the log names it, so duplicates can be measured before Work links instead of re-asking); person's message — `message_kind` (answers / new request / correction / chat).

## 11. Warnings

Warnings are computed by the plugin from Work's own data and session state. They need nobody to
report anything, which is the point: they catch what the record should say but doesn't. Each
names the object, what is wrong and since when, and clears itself when the condition no longer
holds.

| Warning                           | Condition (thresholds configurable)                                                            |
| --------------------------------- | ---------------------------------------------------------------------------------------------- |
| Stalled Task                      | In progress with no timeline entry for 48 hours.                                               |
| Session mismatch _(deferred, §9)_ | In progress, but its discussion session has been idle for 48 hours, has failed, or is missing. |
| Follow-up overdue                 | Waiting past its `follow_up_at`.                                                               |
| Unanswered                        | A Question or Decision open for more than 7 days.                                              |
| Objective without progress        | An active Objective with no completed serving Task for 7 days.                                 |
| Unfiled work                      | Outcomes the record keeper could not file under a Task.                                        |
| Milestone ready                   | Every associated Task is finished but the Milestone is not achieved.                           |

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
   Tasks, unfiled work, Milestones ready to mark achieved.
5. **Objectives** — each active Objective by rank with its first KPI and last progress (the full
   view, with reviews and serving Work, is the Objectives tab).
6. **Recently completed** — the latest finished Tasks; the rest is in Activity.
7. **Areas and Projects** — the browsable structure, with derived status and Milestone progress.

A Decision opens in the side panel with its options (risks and tradeoffs), the recommendation
preselected, the agent's reasoning, an optional "Why?", **Decide**, and what happens if nobody
decides. A Question shows why it matters, the agent's hypothesis with **Use its guess**, or your
own answer. Both show what they are for.

**Navigation.** Areas are a row of filter chips under the tabs ("All" by default, grouping
Projects under Area headings), never a second sidebar. The Areas & Projects tab is a list,
not detail (Fred, 2026-10-10): one row per Project — outcome, current Milestone, Tasks done, a pill
only when it is waiting on you or stalled, last activity — opening the Project page; open Tasks
that sit directly in an Area fold into one row under it ("2 Tasks outside a Project"). Objectives, Projects and Areas open as full
pages with a breadcrumb and Back. Tasks, Questions, Decisions and Findings open in a side panel
over the current page, with "Open as page". Session chips open the session; evidence chips open
the commit, PR or file. A Project page shows its header (status, serves, accountable, session with
live state; Edit, Change session, Abandon), outcome, ordered Milestones with their Tasks and
achievement basis — **Mark achieved** is disabled with the reason while the closure guard holds —
the Questions, Decisions and Findings about it, and its history. An Objective page shows its
header (rank, owner, session), statement, KPIs, latest review and what serves it: each Project
with its Tasks under their Milestones, and Tasks serving it directly. Its side column shows its
Decisions and Questions only when there are any, its Autonomy, and a folded History.

**Saying what things are.** Every page names its kind above its title in small caps (Objective,
Project, Area), and every Project card and Decision or Question card names its kind too. A rank is
written "Rank 2", never "#2". Every list says what it holds (Tasks, Other Tasks, Decisions…), and
rows in mixed lists (Needs you) carry their kind. A Task row shows one status pill — open, ready,
blocked, waiting or in progress — with why (what it depends on, whom it waits on, the follow-up
date) as a quiet line under its title.

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
- Agent tools named for intents, plus `falcon_work` for every other typed command and compact
  read projections (commands §1).
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
8. _(2026-10-07)_ Discussion sessions are deferred (§9): no Add to Work, live session state or
   Session mismatch Warning in 5.0; this supersedes the session parts of items 2 and 5. "Where the
   work happened" history stays and should cover Tasks, Questions, Decisions and Findings.
9. _(2026-10-07)_ One agent per Office is assumed. Agents do not abandon Projects or take other
   agents' Tasks; a person does both. Multi-agent handover is revisited once there are real
   multi-agent scenarios.
10. _(2026-10-10)_ Work writes the record itself (§10, The record keeper): the agent is not required
    to, and its own entries win. One Task per piece of work. A Task's history is a timeline of
    outcomes, each opening to its turn summary; turns without outcomes fold. Raw tool calls are not
    stored by Work; entries link to the session transcript. Supersedes enforcement by nudging and
    the untracked-activity feed.
