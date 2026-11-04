# Falcon Work

**What your agents are doing for you, kept from your conversations** — for
[OpenClaw](https://openclaw.ai).

Open Falcon Work and catch up in thirty seconds: what needs you, what is in motion, and what
happened since you last looked. Nobody fills it in. A background clerk reads your agents'
conversations after they happen and keeps the record itself.

## What you see

- **Needs you** — the questions and choices your agents are waiting on, each with a link back to
  the conversation where it came up. Answer there; Work notices.
- **Everything in motion** — a board of Moving, Waiting and Done this week. Each **Job** (an ongoing
  duty, like watching a support inbox) and each **Project** (an outcome with Milestones) is one card;
  standalone **Tasks** get their own. Every card says where it stands in one sentence.
- **What happened since your last visit** — one line per thing that moved.
- A page for every Job, Project and Task: its status, Milestones or plan, history with evidence
  (commits, files, pull requests), and the conversations it happened in.

## How it keeps itself up to date

After each turn, Work asks your Office's **decision model** (OpenClaw's `decisionModel` role, for
example TypeSafe Jev) small yes/no questions — is this about an open item, is it finished, does the
agent need you — and acts on the answers in code. What those answers cannot settle, a short call to
the agent's own model writes, once the conversation goes quiet. Work then checks that writing with
the decision model before saving it. Nothing is ever sent, and no conversation is changed.

On first start, Work reads the last 14 days of conversations and fills itself in; the page shows
its progress. Your agents can still change the record when you ask them to, and what you or they
write always wins over what Work wrote.

## Install

```sh
openclaw plugins install clawhub:@fdsouvenir/falcon-work
```

Then allow two settings:

- **Reading completed turns** needs conversation access, which OpenClaw requires you to grant to
  plugins you install yourself:
  `openclaw config set plugins.entries.falcon-work.hooks.allowConversationAccess true`
- **The Work page** is native Control UI: turn on **Settings → Labs → Custom plugin UI**
  (`gateway.controlUi.experimental.customPlugins: true`).

Recommended: **a decision model** (`agents.defaults.decisionModel`, e.g. `typesafe/jev-1.13.0`).
Without one, Work still fills itself in, using only the agent's model, more slowly and at higher
cost.

Requires OpenClaw 2026.10.4 or later.

**Upgrading from 1.x:** 2.0 starts with a clean record. Your old database is kept untouched as
`falcon-work/work.db.before-2`, and Work catches up from your conversations instead.

## What Work keeps on your Gateway

Everything stays in the Gateway's state directory, in `falcon-work/`, readable only by the Gateway:

- `work.db` — your Jobs, Projects, Tasks, Questions, Decisions, Findings and their history, in a
  private SQLite database. Raw tool calls and transcripts are not copied; Work links to the
  conversation.
- `decisions.jsonl` — each judgment Work asked for and what it did, so the judgments can be
  reviewed. It rotates at 5 MB and keeps one older file.

Model calls send bounded excerpts of a conversation to your configured decision model and to the
agent's own model provider.

## Source

[github.com/fdsouvenir/falcon-suite](https://github.com/fdsouvenir/falcon-suite) — licensed
CC BY-NC 4.0.
