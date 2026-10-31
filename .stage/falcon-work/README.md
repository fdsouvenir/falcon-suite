# Falcon Work

**A record of what your agents do, why, and what needs you** — for [OpenClaw](https://openclaw.ai).

Your agents do real work for you. Falcon Work records their outcomes, in a structure that gives you
one place to see everything: what they are working on, what is waiting on you, and whether it is
moving you toward what you actually care about.

## What you get

- **Objectives** — the north stars you want progress toward, ranked, with optional KPIs and a daily
  review from your agent. Each shows when it last made progress.
- **Areas, Projects and Milestones** — standing responsibilities, bounded efforts and their
  checkpoints. A Milestone cannot be marked achieved over unfinished work.
- **Tasks** with a definition of done, a Result with evidence, waiting states and dependencies.
- **Questions, Decisions and Findings** — what your agent needs from you, the choices you approve,
  and what it learned. Answer and decide right in the Work tab.
- **Recording happens after the turn.** Outcomes are filed automatically under the session's
  Task, or shown as unfiled work. Recording never reopens a turn or replaces its chat answer.
  Raw tool calls stay in OpenClaw's transcript, not in Work.
- **Warnings** that need nobody to report them: stalled Tasks, overdue follow-ups, unanswered
  questions, Objectives without progress.
- A native **Falcon Work** page in the Control UI that follows your theme, light or dark.
  Its title includes the installed release version: **Falcon Work vpreview.38** for
  `5.0.0-preview.38`, or **Falcon Work v5.0.0** for a stable release. The sidebar says
  **Falcon Work** without a version.

Agents get tools for reading Work, planning Projects, tracking Tasks, asking you and recording Findings.

## Install

```sh
openclaw plugins install clawhub:@fdsouvenir/falcon-work
```

Then allow two settings:

- **The agent's brief and completed-turn recording** need conversation access, which OpenClaw requires
  you to grant to plugins you install yourself:
  `openclaw config set plugins.entries.falcon-work.hooks.allowConversationAccess true`
  Without it, the tools and activity capture still work, but the agent gets no brief and completed-turn recording is unavailable.
- **The Work page** is native Control UI: turn on **Settings → Labs → Custom plugin UI**
  (`gateway.controlUi.experimental.customPlugins: true`).

Optional, recommended: **a decision model** (OpenClaw's `decisionModel` role, for example TypeSafe
Jev). With one, Work notices when a reply leaves the agent waiting on you and puts it under Needs
you, and records answers you give in chat against the open Question. Without one, the agent gets a
reminder in its next brief instead.

Requires OpenClaw 2026.9.6 or later.

## What Work keeps on your Gateway

Everything stays in the Gateway's state directory, in `falcon-work/`, readable only by the Gateway:

- `work.db` — your Objectives, Areas, Projects, Tasks, Questions, Decisions, Findings and their
  history, in a private SQLite database.
- `decisions.jsonl` — when a decision model is configured, each judgment Work asked it for, with
  a short excerpt of the turn it judged (up to 300 characters of your message and the last 1,000 of
  the agent's reply) and what Work did. It is there so the judgments can be reviewed. It rotates at
  5 MB and keeps one older file, so it never holds more than about 10 MB.

## Source

[github.com/fdsouvenir/falcon-suite](https://github.com/fdsouvenir/falcon-suite) — licensed
CC BY-NC 4.0.
