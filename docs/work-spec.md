# Falcon Work — specification (rewrite, draft)

Status: **draft for Fred's review**, 2026-11-03. Replaces the Work 5 specification of 2026-10-01.
It records the decisions from the 2026-11-03 rethink; open points are in §11.

## 1. Purpose

Falcon Work is a **pane of glass**: open it and catch up in thirty seconds on everything your
agents have been doing for you, what is in motion, and what is waiting on you.

**It fills itself in.** Nobody, neither the person nor the agent, has to keep it up to date. A
background **clerk** reads conversations after they happen and writes the record. Agents can still
correct the record through their tools, and the person corrects it by talking to an agent. Nobody
is required to do either.

Why the rewrite: under Work 5 the agent was expected to keep the record itself, helped by per-turn
hooks. In practice none of it filled in. From Oct 22 to Nov 3, 131 of 178 turns that left outcomes
were never filed, and Work created no Tasks on its own. The per-turn record keeper saw one turn at
a time, so it could never tell one piece of work from the next. Its writer also failed on every
call, because naming a model counts as a model override that plugins are not granted. The data
model and the store were sound; how records got into them was wrong.

## 2. Vocabulary

| Word          | What it is                                                                                        | Ends?                 |
| ------------- | ------------------------------------------------------------------------------------------------- | --------------------- |
| **Job**       | An ongoing duty an agent carries out ("watch the support inbox and draft a reply to everything"). | No (paused, retired)  |
| **Project**   | A bounded outcome that takes several deliverables, reached through ordered Milestones.            | Yes                   |
| **Milestone** | A checkpoint in one Project, with an observable success condition.                                | Yes                   |
| **Task**      | One deliverable with a definition of done. Standalone, or part of exactly one Project or Job.     | Yes                   |
| **Question**  | Something the agent needs to know from the person.                                                | When answered         |
| **Decision**  | A choice the person has to make between options.                                                  | When decided          |
| **Finding**   | Something learned that is worth keeping, with evidence.                                           | Retracted, superseded |

Every Job, Project and Task carries a **status line**: one plain sentence, written by the clerk,
saying where it stands ("Parsing done; 2 decisions open on the import step").

**Choosing between them.** A Task is one thing you could tick off in a sentence. If saying what
"done" means takes a list, or the work spans days with checkpoints, it is a Project. If it never
finishes, it is a Job. Getting this wrong at first is cheap: the clerk turns a Task that grows a
second deliverable into a Project, keeping its history, and folds a Project that turns out to be one
deliverable back into a Task.

**Removed:** Areas, Objectives, KPIs and Objective reviews, Asks, discussion sessions, and
Warnings as a separate concept. "Needs you" is simply the open Questions and Decisions.

## 3. The clerk

The clerk is how the record gets written. It is part of the plugin, not an OpenClaw agent: no
entry in the Agents list, no session of its own, no tools. It works as a **cascade**:

1. **Judge.** The Office's decision model (Jev) answers small typed questions about what just
   happened, in one bundled request per event.
2. **Decide.** Code turns those answers into actions through explicit truth tables (§3.3).
3. **Write.** Only when the answers call for new words, or leave a question unsettled, does a
   language model (the **writer**) draft them.
4. **Check.** Jev checks what the writer proposed before Work applies it.

Jev makes judgments; code makes decisions. Routine filing (which item this belongs to, whether it
is finished, where it now stands, whether the person is needed) is done by Jev and code, and can be
measured. The writer is called for what only it can do: a title and done-when for new work, a
Project's shape, and cases Jev leaves unsettled. This follows the TypeSafe integration guidance
(`typesafe-ai/skills`, `skills/typesafe-ai/SKILL.md`).

### 3.1 Events

| Event                                                                                                               | What runs                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Turn ended** (`agent_end`)                                                                                        | The hook only records the turn and enqueues it. A few seconds later, on the plugin service's scheduler, Jev judges the turn (§3.2) and code acts on the answers. |
| **The person sent a message** (seen in `before_prompt_build`)                                                       | Jev checks whether it answers an open Question or Decision (§3.2), and code records the answer at once.                                                          |
| **Session idle** (10 minutes with no new turn, no run in progress), **before compaction**, **session end or reset** | The writer runs for the session, but only if a turn left work for it (§3.3).                                                                                     |
| **Nightly**                                                                                                         | A sweep for anything missed, then a tidy-up of open items (§3.2).                                                                                                |
| **Catch-up** on first start (§8)                                                                                    | Each turn in each session is judged, then the writer runs where it is needed.                                                                                    |

Running the judging on the service scheduler, not inside the hook, keeps model calls out of the
turn's own authority window. Calls made from inside hooks failed there under Work 5 ("caller
authority is no longer active").

### 3.2 Questions

All question wording, criteria and thresholds live in one module with the evaluation harness in
`eval/`, under a versioned rubric, as in Work 5. Each question asks for **one judgment** a person
could make at a glance. Questions that share state go in one request. Questions that only matter in
some cases are asked anyway in the same request, and code reads them only when it needs them.

**The state** for a turn is: the person's message (if a person started it) with who sent it; the
agent's reply; the outcomes the hooks noted (commits, pushes, PRs, releases, installs, messages
sent, files written, config changes); the reply split into pieces (sentences and list items, code
removed); and the session's **candidate items**. These are the open Jobs, Projects and Tasks
already linked to this session, plus the automation's Job if one started it, at most eight, each
with title, status line and done-when. Names, not ids.

**At the end of a turn** (yes/no unless marked):

- `work_asked` — Does `request` ask the agent to do a piece of work?
- `work_reported` — Does `reply` report that a piece of work was finished or delivered?
- `work_planned` — Does `reply` lay out several steps of work still to come?
- `needs_person` — Does `reply` ask the person for something the work cannot continue without?
- `waits_outside` — Does `reply` say the work is waiting on something other than the person (a
  third party, a system, a date)?
- `new_work` — Does `request` ask for a piece of work that is none of the items in `candidates`?
- `any_item` — Is this exchange part of the work on any of the items in `candidates`? This is the
  companion question for "nothing fits".
- per candidate `c`: `about.c` — Is this exchange part of the work on `candidates.c`? and `done.c` —
  Does this exchange show that `candidates.c.done_when` is met?
- per piece `p`: `asks.p` — Is `pieces.p` part of what `reply` asks the person to give, decide or
  do? (measured: F1 0.84) and `stands.p` — Does `pieces.p` say where the work now stands?
- per open Question or Decision `q` for the person: `repeats.q` — Does `reply` ask for the same
  thing as `open.q`?

**When the person sends a message**, per open Question `q`: `answers.q` — Does `message` answer
`open.q`? (measured: precision 1.00, recall 0.82). Per open Decision `d`: `decides.d` — Does
`message` choose one of `open.d`'s options? and the Choice `option.d` — which one?

**Checking the writer**, per proposed new item `n` and each open item `o`: `same.n.o` — Is
`proposed.n` the same piece of work as `open.o`? Per proposed completion, `done.c` on the evidence.
Per proposed Question, `needs_person` on the pieces it came from.

**Nightly**, per open item with no activity for 3 days, over its last timeline entries:
`finished` — Do these entries show the work was finished? and `dropped` — Do these entries show
the work was dropped or no longer wanted?

### 3.3 Decisions in code

Thresholds start at Jev's guidance: **at least 0.7 is yes, at most 0.3 is no**, and anything
between is **unsettled**. Confidence is never used as the gate. Every action below records the
answers it acted on.

**End of a turn:**

| Answers                                                                                                | Action                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `work_asked` no, `work_reported` no and no outcomes                                                    | Nothing is filed. The turn counts on the session's linked items, if any.                                                               |
| `any_item` yes, one or more `about.c` yes                                                              | File the turn's timeline entry and outcomes under each such item. If a `stands.p` is yes, the best one becomes the item's status line. |
| …and `done.c` yes and `work_reported` yes                                                              | Complete it. The result is the reporting pieces, with the outcomes as evidence. With no such piece, the writer writes the result.      |
| (`work_asked` or `work_reported` yes, or outcomes present) and (`new_work` yes, or every `about.c` no) | New work: mark the session for the writer.                                                                                             |
| `work_planned` yes                                                                                     | Mark the session for the writer (it may be a Project with Milestones).                                                                 |
| `needs_person` yes, the session's work is an item, and no `repeats.q` is yes                           | Raise a Question now: its text is the pieces with `asks.p` yes, and its session is this one. Mark the item waiting on the person.      |
| `needs_person` yes and some `repeats.q` yes                                                            | Link this session to that Question; raise nothing new.                                                                                 |
| `waits_outside` yes                                                                                    | Mark the item waiting; the reason is the `stands.p` piece.                                                                             |
| `any_item` or any `about.c` unsettled                                                                  | Mark the session for the writer.                                                                                                       |

**When the person sends a message:** `answers.q` yes records the message as the answer.
`decides.d` yes records the chosen option if its probability is at least 0.7. Anything else waits
for the writer.

**Checking the writer:** `same.n.o` yes turns a proposed new item into an update of `o`. A proposed
completion or Question whose check is not yes is dropped and logged.

**Nightly:** `finished` yes or `dropped` yes marks the item for the writer to close, with the reason.

Every combination has an outcome. When nothing above matches, the turn is filed under the
session's single linked item if there is one, and otherwise marked for the writer.

### 3.4 The writer

The writer runs on the session agent's own model through `api.runtime.subagent.complete`: one
tool-free call, with no Work model setting and no override. It receives only what it needs: the
conversation since the session's checkpoint (`readSessionTranscriptVisibleMessageDelta`), the
outcomes, the candidate items Jev scored above 0.3, and why it was called. It returns a list of
**edits**:

- create or reshape a Job, Project, Milestone or Task; attach a Task to a Project or Job;
- a title, description and done-when for new work; a plan; a result;
- a status line where Jev found no piece that says where things stand;
- a Question or Decision Jev's pieces could not express; withdraw one the conversation made moot;
- a Finding;
- the session's timeline sentence where Jev's filing left none.

Edits go through the Jev check (§3.3), then through the same store commands the tools use.

### 3.5 Rules

- **One deliverable, one Task.** A session that did three things produces three Tasks, not one
  umbrella Task.
- **Update before creating.** Jev's routing and the `same` check enforce it.
- **Jobs file themselves.** A session started by an automation linked to a Job puts its work under
  that Job without asking.
- **Entries made by people and agents win.** Work never overwrites a field a person or agent set
  after Work last wrote it; it can only add to it. Everything Work writes is marked as written by
  Work.
- **Never acts.** The clerk only reads conversations and writes records. It sends no messages,
  wakes no agent and changes no conversation.
- **Corrections are labels.** When a person or agent changes something Work wrote, the change and
  the answers behind the original are logged as a labelled example for the evaluation set.

### 3.6 Checkpoints, failure and fallback

- A checkpoint per session (the last transcript entry read) is committed in the same transaction
  as the edits. A writer pass that fails leaves the checkpoint unmoved and is retried at the next
  trigger, up to three times, before the session is left for the nightly sweep.
- A failed Jev call is an error, never a "no". The turn is marked for the writer.
- Edits are validated individually; an invalid one is dropped and logged.
- Judging and writing run on a service-scheduler queue, newest first, within the plugin's
  background budget.
- **Without a decision model**, every marked session goes to the writer at idle and the Jev check
  is skipped. Work still fills itself in, more slowly and at higher cost.

## 4. Data model

One private SQLite database per Gateway, append-only event log of every command (actor, time,
before/after), optimistic versions and idempotency keys as before.

Kept from Work 5: `project`, `milestone`, `task` with `task_definition`, `task_plan` and
`task_result` (immutable revisions), `question`, `answer`, `decision`, `finding`, `link`,
`timeline_entry`, `event`, `receipt`.

Changed:

- `task`: drop `area_id`; add `job_id`. A Task has a `project_id`, a `job_id`, or neither, never
  both. Add `status_line` and `status_line_at`. Drop `session_set_by`.
- `project`: drop `area_id`; add `status_line` and `status_line_at`. Drop `session_key` and
  `session_set_by`.
- `question`, `decision`: add `session_key`, the session the item came from (the most recent one if
  it came up in several).

New:

- `job` — `id`, `title`, `instructions`, `status` (`active` · `paused` · `retired`), `agent`,
  `status_line`, `status_line_at`, `created_at`, `version`.
- `job_automation` — `job_id`, `automation_id`: the OpenClaw automations that run the Job. Work
  never schedules anything itself.
- `task_session` — `task_id`, `session_key`, `first_seen_at`, `last_seen_at`: where a Task's work
  happened. It feeds "3 sessions" and the session chips.
- `clerk_checkpoint` — `session_key`, `agent_id`, `last_entry_id`, `last_entry_at`, `attempts`,
  `updated_at`.
- `written_by` — which fields of which objects the clerk last wrote, and when, so the precedence
  rule in §3.3 can be enforced.

Removed: `area`, `objective`, `kpi`, `kpi_reading`, `review`, `ask`, `session_task`,
`session_parent`, `work_recorded`.

## 5. Agent interface

Agents get no rules in the prompt and no per-turn brief. Work's tools stay available for when the
person tells the agent to change something ("move that under the catalog Project", "that's done"):

- `falcon_work_read` — read anything (home, an item, search).
- `falcon_work_plan` — create or extend a Project with Milestones and Tasks.
- `falcon_work_task` — create, start, wait, resume, complete or abandon a Task.
- `falcon_work_job` — create, edit, pause, resume or retire a Job, and link its automations.
- `falcon_work_ask` — raise a Question or Decision for the person.
- `falcon_work_finding` — record a Finding.
- `falcon_work` — any other command.

Everything an agent writes through a tool counts as an agent entry (§3.3).

## 6. Pages

Work is a native Control UI page, read-only apart from dismissing an ask on Needs you. The other
interactive elements are session chips and titles (they open that session), links to Work items,
the Back link, search, filters and expanders. To act on something you go back to its session or
start a new one. Mockups: Stitch
project _Falcon Work 5_, with copies in `media/preview/work-home-2026-11-03/`.

### Home (screen `a0c126201da946a4b5c0224b02d9ed5b`)

Title and "Since you were here …" line, with search. Then three stacked sections:

1. **Needs you** (screen `02f1af63a3d8490f8c912433a7d916b8`) — the open Questions and Decisions
   grouped by the session they came from, newest session first, in one dense accordion with
   All / Questions / Decisions and agent filters. A collapsed session is one row: agent, session
   title (opens the session), its newest ask, count and age. The newest session starts open; an open
   session lists its asks one per line (Q or D, the item it concerns, the question, age) and shows 5
   before "+N more". Eight sessions show before "Show N older sessions". There are no Answer or
   Decide buttons; each ask has a **Dismiss** (×), which withdraws it. A session that no longer
   exists is greyed and offers **Dismiss all**, since nothing else can clear its asks.
2. **Everything in motion** — a three-column board: **Moving**, **Waiting**, **Done this week**.
   Each Job and each Project is one card with its Tasks inside, and only standalone Tasks get their
   own card. A card shows its type, title, status line, current Milestone for a Project, and a
   footer with sessions, last activity and agent. Items in Needs you are not repeated on the board.
3. **What happened since your last visit** — a bulleted list with a thin guide line, newest first:
   one sentence per entry with a muted attribution ("— William, 2h ago").

### Project (screen `d1748493de7e44c09c1451548ef189e1`)

Header (kind, title, status line, meta), then Needs you for this Project, Milestones as a stepper
(achieved, current, upcoming) with their Tasks, and What happened. Side column: Outcome, Sessions,
Findings.

### Task (screen `835d96e8fdc24f1c96bafa5c0b5b1dde`)

Header, then Done when, Plan, What happened with evidence chips (commit, file, PR), and Result.
Side column: Sessions, what it belongs to, open Questions.

### Job (screen `38fee52fcc2340b5aa5e5ce4ca929e69`)

Header, then Needs you, Open tasks, Done this week (collapsed) and What happened. Side column:
Instructions, and Automations with their triggers and last run.

The Objectives, Areas & Projects and Activity tabs are removed.

## 7. Hooks

- `after_tool_call` notes the turn's outcomes in memory, as in Work 5.
- `agent_end` stores the turn and its outcomes against the session, enqueues the turn for judging
  and arms the idle timer. It makes no model calls itself.
- `before_compaction` and `session_end` trigger a writer pass when the session is marked.
- `before_prompt_build` only observes: it takes the person's message for the turn and the answer
  check, and returns nothing. Work adds nothing to the agent's prompt.

## 8. Install and catch-up

- **Clean database.** The new version starts empty. An existing `work.db` is renamed
  `work.db.before-2` and left in place; nothing is migrated.
- **Automatic catch-up.** The plugin service starts the catch-up when the Gateway loads the plugin,
  whether or not anyone opens the page. It queues every session with activity in the **last 14
  days**, newest first, judges each turn and runs the writer where it is needed (§3.1). It resumes after a restart from the
  checkpoints.
- **Progress on the page.** While catch-up runs, the home page shows "Catching up on your work:
  18 of 54 sessions read", and cards appear as they are found.

## 9. Feasibility (spike, 2026-11-03)

A throwaway plugin on Alpha (OpenClaw 2026.10.4) ran these from its service, at start and from the
scheduler, with no user request behind them:

- `runtime.agent.session.listSessionEntries` listed sessions (11 in 14 days).
- `readVisibleSessionTranscriptMessageEntries` read a 91-entry transcript in under 75 ms.
- `runtime.subagent.complete` and `runtime.llm.complete`, with no model named, answered in 1–3 s
  for about $0.0006 per call.

A second throwaway plugin called `runtime.decisions.evaluate` (Jev 1.13) from its service, at start
and from the scheduler: status `ok` in 770 ms on the first call and 102 ms on the second. It judged
the last turn of a real session (the person asked "what does that mean?" and the agent explained),
answering `work_asked` 0.09, `needs_person` 0.03, and the unsettled `work_reported` 0.52 and
`only_conversation` 0.46. Under §3.3 that turn goes to the writer. Answers like these are why the
questions are measured before release (§11).

Not usable by this plugin: `gateway.readSessionFacts` (bundled or trusted official plugins only)
and `subagent.getSessionMessages` (only sessions the plugin created). Notes:
`~/.tmp/openclaw-spikes/work-clerk-background/README.md`.

## 10. Not in Work

Scheduling (OpenClaw automations own it), sending or waking anything, transcripts (OpenClaw owns
sessions; Work links to them), tags or categories, Objectives and metrics, runtime permission
enforcement.

## 11. Open points

0. **Measured (2026-11-04).** 89 clear labelled real turns, Jev 1.13: filing under an open item 43
   right and 6 wrong; new work 14 right and 1 wrong; Needs you 20 right and 2 wrong; done-when
   checks all right; status line a correct piece 40 of 45; decoys never matched. 64% of turns still
   go to the writer. Details: `packages/work/eval/README.md`.
1. **Measure further.** The new questions in §3.2 need labelled real turns: start from the
   Work 5 corpus in `eval/`, reuse `asks.p` and `answers.q` as measured, and tune the thresholds in
   §3.3 on cases kept apart from the test set. The writer's edits need the same treatment: one Task
   per deliverable, update-before-create, and a Needs you that only shows what is really waiting.
2. **Release numbering.** Published Work is `1.0.0`. This is a breaking change, so it ships as the
   next major version.
3. **`docs/work-commands.md`** — rewritten for 2.0 (2026-11-04).
