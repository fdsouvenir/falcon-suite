# Falcon Work

**A record of what your agents do, why, and what needs you** — for [OpenClaw](https://openclaw.ai).

Your agents do real work for you. Falcon Work makes them record it, in a structure that gives you
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
- **Recording is enforced, not requested.** What the agent actually does is captured automatically
  and attached to its Task; if a turn changes things no Task explains, the agent is sent back to
  record it. Anything left unexplained shows as untracked activity.
- **Warnings** that need nobody to report them: stalled Tasks, overdue follow-ups, unanswered
  questions, Objectives without progress.
- A native **Work** page in the Control UI that follows your theme, light or dark.

Agents get two tools: `falcon_work_read` and `falcon_work`.

## Install

```sh
openclaw plugins install clawhub:@fdsouvenir/falcon-work
```

Then allow two settings:

- **The agent's brief and the end-of-turn nudge** need conversation access, which OpenClaw requires
  you to grant to plugins you install yourself:
  `openclaw config set plugins.entries.falcon-work.hooks.allowConversationAccess true`
  Without it, the tools and activity capture still work, but the agent gets no brief and no nudge.
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
