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

The Work page is native Control UI. Turn on **Settings → Labs → Custom plugin UI**
(`gateway.controlUi.experimental.customPlugins: true`). The tools and recording work without it.

Requires OpenClaw 2026.9.6 or later. Data is kept in a private SQLite database in the Gateway's
state directory (`falcon-work/work.db`).

## Source

[github.com/fdsouvenir/falcon-suite](https://github.com/fdsouvenir/falcon-suite) — licensed
CC BY-NC 4.0.
