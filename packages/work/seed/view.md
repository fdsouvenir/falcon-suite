# Work — seeded view

_Generated from `work-seed.db`. This is the Work tab's content rendered as text (spec §11)._

## 1. Objectives

### #1 Home AI Solutions reaches $10K monthly revenue — _active_

> Home AI Solutions sustains at least $10,000 in monthly revenue for two consecutive months.

Owner: fred · Autonomy: **propose** · Last progress: **none since it was set on 2026-08-19**

| KPI | Latest | Target | Readings |
| --- | --- | --- | --- |
| Monthly revenue | _unmeasured_ | ≥ 10000 USD | 0 |

**Latest review** (2026-10-01, verl)
- Moved: Nothing. No Work serving this Objective has recorded activity since it was set on 2026-08-19.
- Stalled: Every recorded hour in the last six weeks went to the Fredbot Platform and to running me. The Territory Engine is waiting on one Question (Territory 1) that has been open since early September.
- Proposed: Decide the first concrete step: answer the Territory 1 Question, or have me draft the pilot offer so the thesis milestone can move.
- Sources: Recorded activity, 2026-08-19 to 2026-10-01

Serving it:
- Project **Home AI Solutions: first paid pilot** — open · 0/0 Tasks completed
- Project **Territory Engine** — open · 0/2 Tasks completed

### #2 Fredbot runs customer Offices on its own platform — _active_

> [Inferred by Verl, needs Fred's wording] Fredbot Platform hosts, operates and recovers customer Offices without hand-holding, so the business can sell them.

Owner: fred · Autonomy: **act** (limits: No spending, no customer-facing messages, no destructive changes to Platform-01 without Fred's approval.) · Last progress: **2026-09-30 (1 days ago)**

| KPI | Latest | Target | Readings |
| --- | --- | --- | --- |
| Customer Offices live | 0 offices (2026-10-01) | ≥ 1 offices | 1 |
| Days since last failed nightly backup | 8 days (2026-10-01) | ≥ 30 days | 2 |

**Latest review** (2026-10-01, verl)
- Moved: Platform-01 qualification: off-host backups, alerts and certificate renewal running since 09-17. Backend 2.0 architecture settled (D37–D40, then Secret Manager on 09-27). Job Dispatcher installed idle on management-test (09-30).
- Stalled: Stamping a reproducible template is deferred until Fred buys a server for Platform-02. GitHub OAuth refresh has needed a reconnect since 09-25.
- Proposed: Finish NOC-backend → API authentication, then run the first real Job end to end.
- Sources: fredbot-backend#271; fredbot-backend#378; fredbot-backend#330

Serving it:
- Project **Configure, test and stamp the Platform template** — open · 5/7 Tasks completed
- Project **Backend 2.0: Job Dispatcher first build** — open · 2/5 Tasks completed

### #3 Land a role at a frontier AI lab — _active_

> [Inferred by Verl from the open applications, needs Fred's wording] Fred is hired into an applied-AI role at OpenAI or Anthropic.

Owner: fred · Autonomy: **propose** · Last progress: **none since it was set on 2026-09-08**

Serving it:
- Project **Apply: OpenAI Forward Deployed Engineer (SF)** — open · 0/2 Tasks completed

## 2. Needs you

- **Decision** (2026-09-08): Install sharp into the global OpenClaw install? · _Work tab only_
  - Options: Install it · Skip; keep sending images as attachments
  - Recommended: Install it — Small, reversible, and fixes image attachments.
  - If nobody decides: Image attachments stay broken.
- **Decision** (2026-09-20): Apply --clear-tools to the two failing automations? · _posted to session “cron exec admission rejected — diagnosis” (from its Task)_
  - Options: Apply --clear-tools · Wait for the upstream fix
  - Recommended: Apply --clear-tools — Neither job needs tools; the fix is reversible.
  - If nobody decides: Two automations keep failing nightly.
- **Decision** (2026-10-01): What should I do next for Home AI Solutions? · _posted to session “Falcon Dash”_
  - Options: Draft the thesis and pilot offer for your review · Wait for Territory 1 and push the Territory Engine · Pause this Objective while the Platform is the priority
  - Recommended: Draft the thesis and pilot offer for your review — It needs nothing from you to start and unblocks the first two milestones.
  - If nobody decides: The Objective stays at zero progress; it has had no activity for six weeks.
- **Question** (2026-09-02): Which area is Territory 1? · _Work tab only_
  - Holding up: The whole Territory Engine is held on this answer.
- **Question** (2026-09-17): Did you authorize the "OpenClaw GitHub Tools" OAuth app? · _Work tab only_
  - Holding up: If not, it is an unexplained grant on your GitHub account.
- **Question** (2026-09-21): Which model should I fall back to when Anthropic session limits black me out? · _posted to session “Falcon Dash”_
  - Holding up: During a limit blackout I stop working entirely, as on 09-21.
  - Agent's hypothesis meanwhile: openai/gpt-5.5 as a single fallback leg.

## 3. Now — in progress

- **verl** — Authenticate the NOC backend to the API independently of Verl · session “Build Fredbot Backend 2.0 Manager”
- **verl** — Fix cron exec admission failures · session “cron exec admission rejected — diagnosis” _(blocked: pending Decision: Apply --clear-tools to the two failing automations?)_
- **verl** — Revise the résumé and application packet · session “OpenAI application watch” (from Project)
- **verl** — Restore Schwab CLI authentication

## 4. Waiting

- Build and stamp the provisional Platform template — waiting on **fred** (person)
  - Fred deferred this until he buys a server for Platform-02.
  - Resume when: Fred has the Platform-02 hardware.
- Add impact numbers for the TDL submission — waiting on **fred** (person) · session “OpenAI application watch” (from Project)
  - Only Fred has the TDL outcome numbers.
  - Resume when: Fred supplies the numbers or says to drop the claim.
- Reconnect GitHub OAuth for the Building Manager — waiting on **fred** (person) · session “Building Manager + Job Dispatcher” (from Project)
  - Only an operator can reconnect the GitHub OAuth grant.
  - Resume when: Fred has reconnected GitHub in the operator settings. · follow up 2026-10-02
- Route Portals through the gateway listener — waiting on **fred** (person) · session “Portal Fix”
  - Fred wants to test the patched build himself before it is installed.
  - Resume when: Fred has tested 2026.9.5-1. · follow up 2026-10-03
- Find out what the two April reimbursements covered — waiting on **adrien** (person)
  - Adrien has to say what the two reimbursements were for.
  - Resume when: Adrien replies. · follow up 2026-10-03

## 5. Recently completed

- **Prepare building-903 as management-test** (2026-09-30, verl) · session “Building Manager + Job Dispatcher” (from Project)
  - Result: VM1003 prepared and renamed management-test.
  - Evidence: fredbot-backend#378
- **Bootstrap Firestore for the Dispatcher** (2026-09-28, verl) · session “Building Manager + Job Dispatcher” (from Project)
  - Result: dispatcher-staging bootstrapped; 60 checks pass.
  - Evidence: commit:5be4a2d
- **Advise on the Shough + Lemon for Deebo + Allgeier trade** (2026-09-24, verl) · session “ESPN Fantasy”
  - Result: Lean accept. Note: the ESPN cookies on hand are Michael's, not Fred's.
  - Evidence: notes:2026-09-24
- **Trim USER.md below the load limit** (2026-09-24, verl)
  - Result: Trimmed with Fred's approval; full prior text kept in the daily note.
  - Evidence: notes:2026-09-24
- **Fix spool headroom before publication** (2026-09-22, verl)
  - Result: s4.14 shipped; the 09-22 run exited 0 and daily-20260922 completed.
  - Evidence: PR #317 (5084887); Docs PR #318
- **Raise the gateway memory ceiling** (2026-09-20, verl)
  - Result: Transient 10G/11G on 09-19, made persistent on 09-20 under Fred's delegation correction.
  - Evidence: resources.conf (backup kept)
- **Set the freeze floor to 35.0** (2026-09-19, verl) · session “Cold plunge cooling system troubleshooting” (from Project)
  - Result: v4.1.0 deployed; 57 tests pass.
  - Evidence: repo:cold-plunge-controller v4.1.0
- **Rewrite the plunge controller to react to the tub sensor** (2026-09-19, verl) · session “Cold plunge cooling system troubleshooting” (from Project)
  - Result: v4.0.0 deployed, then v4.0.1 (median capacity, MIN_NET_RATE 0.5) after Fred caught a run outside the window.
  - Evidence: commit:f6daeec; commit:b84f5aa
- **Qualify boot and recovery** (2026-09-17, verl)
  - Result: Normal boot, rollback and bad-kernel recovery passed.
  - Evidence: Telemetry .12 (19d694b)
- **Run off-host backups for Platform-01** (2026-09-17, verl)
  - Result: daily-20260917 (7.65 GB) committed and locked 30 days; daily timer enabled; failure alert on. Monthly checks deferred by Fred.
  - Evidence: Issue #271 comment 5716662103; release:0.1.0-s4.10
- **Commission certificate renewal** (2026-09-17, verl)
  - Result: Release .11 commissioned renewal as normal-not-due; schedules and alert on; certificate expires Dec 12.
  - Evidence: commit:d338cf57c843
- **Alert on Platform-01 health** (2026-09-17, verl)
  - Result: Fluent Bit 5.1.2 and OTel 0.160.0 active; real incident opened and closed with mail received; log replay 176/176; 35 policies. Metrics are not lossless (360 points dropped).
  - Evidence: Issue #271 comment 5716955803
- **Audit and recycle Cloudflare credentials** (2026-09-17, verl)
  - Result: Five failing entries recycled; master key renamed; token creator verified; two fredbot.link DNS tokens created, expiring 2027-09-17.
  - Evidence: file:artifacts/cloudflare-credential-audit-20260917/
- **Put the Chase payment on the calendar** (2026-09-16, verl)
  - Result: Marker created for October 9.
  - Evidence: Calendar event, Oct 9

## 6. Untracked activity

- 2026-09-27 verl · file: Changed USER.md to send images as attachments
- 2026-09-24 verl · config: Refreshed 14 Cloudflare skills and added the cloudflare-docs MCP (6dc7604)
- 2026-09-22 verl · command: Restarted the gateway and replayed completions
- 2026-09-21 verl · config: Edited the Morning Brief automation prompt (automation 13e4d317)

## 7. Areas and Projects

### Betting

_NCAAB and MLB analytics and gameday operations (4.x had three Areas for this)._ — accountable: fred

- [abandoned] Run the August 6 ESPN morning ingestion

### Core Improvements

_Upstream OpenClaw: patches, PRs and issues Fred cares about._ — accountable: fred

- [waiting] Route Portals through the gateway listener

### Finances

_Personal accounts, bills and the condo treasurer role._ — accountable: fred

- **Project: Condo treasurer 2026 setup** — open
  - Outcome: The condo books are current, reconciled and visible on a dashboard.
  - Milestone 1. Books reconciled through September — open
    - [waiting] Find out what the two April reimbursements covered
- [in_progress] Restore Schwab CLI authentication
- [completed] Put the Chase payment on the calendar

### Fredbot Platform

_Platform-01, Buildings, Offices and the Backend that runs them._ — accountable: fred

- **Project: Configure, test and stamp the Platform template** — open
  - Outcome: Platform-01 is secured and qualified, and a reproducible Platform baseline exists.
  - Milestone 1. Contain exposure and establish private administration — achieved
  - Milestone 2. Qualify Platform-01 for operation — open
    - [completed] Run off-host backups for Platform-01
    - [completed] Alert on Platform-01 health
    - [completed] Commission certificate renewal
    - [completed] Qualify boot and recovery
    - [completed] Fix spool headroom before publication
    - [open] Re-evaluate the backup lifecycle after the prune failure
  - Milestone 3. Stamp and reproduce the Platform baseline — open
    - [waiting] Build and stamp the provisional Platform template
- **Project: Backend 2.0: Job Dispatcher first build** — open · session “Building Manager + Job Dispatcher”
  - Outcome: The Job Dispatcher runs a real Job end to end on the management Building, under the Backend 2.0 design.
  - Milestone 1. Architecture decisions settled — achieved
  - Milestone 2. Dispatcher installed on the management Building — achieved
    - [completed] Bootstrap Firestore for the Dispatcher
    - [completed] Prepare building-903 as management-test
  - Milestone 3. First real Job runs end to end — open
    - [in_progress] Authenticate the NOC backend to the API independently of Verl
    - [waiting] Reconnect GitHub OAuth for the Building Manager
    - [open] Run the first real Job through the Dispatcher

### Home

_House systems: Home Assistant, cold plunge, lighting, climate, voice._ — accountable: fred

- **Project: Reactive cold plunge controller** — completed · session “Cold plunge cooling system troubleshooting”
  - Outcome: The plunge holds the requested temperature by reacting to the tub sensor, with a 35.0 freeze floor.
  - Milestone 1. Reactive v4 controller live — achieved
    - [completed] Rewrite the plunge controller to react to the tub sensor
  - Milestone 2. Freeze floor at 35.0 — achieved
    - [completed] Set the freeze floor to 35.0

### Marketing

_Getting customers for Fred's businesses: sites, funnels, territory sales._ — accountable: fred

- **Project: Home AI Solutions: first paid pilot** — open
  - Outcome: One customer pays for a Home AI Solutions pilot.
  - Milestone 1. Thesis written — open
  - Milestone 2. Offer defined — open
  - Milestone 3. First paid pilot — open
- **Project: Territory Engine** — open
  - Outcome: Fred selects an area and sells door to door with generated lists and scripts.
  - Milestone 1. Territory 1 ready to sell — open
    - [ready] Build the household list for Territory 1
    - [ready] Plan the walking route for Territory 1

### Personal

_Fred's own errands, career, family and leisure._ — accountable: fred

- **Project: Apply: OpenAI Forward Deployed Engineer (SF)** — open · session “OpenAI application watch”
  - Outcome: A tailored, truthful application is submitted.
  - Milestone 1. Application submitted — open
    - [in_progress] Revise the résumé and application packet
    - [waiting] Add impact numbers for the TDL submission
- [completed] Advise on the Shough + Lemon for Deebo + Allgeier trade

### Verl

_Keeping me running: gateway health, memory, models, credentials, automations, context files._ — accountable: fred

- [ready] Install the sharp optional dependency
- [completed] Audit and recycle Cloudflare credentials
- [completed] Raise the gateway memory ceiling
- [in_progress] Fix cron exec admission failures
- [completed] Trim USER.md below the load limit

## Findings and settled Decisions

- **Finding** (supported, 2026-09-26): The reference Office template still grants operator.admin, contrary to D44. — _Issue #330 audit comment 5851150351_
- **Finding** (supported, 2026-09-26): The sole executor runs on platform-01, so platform-01 cannot repair itself through it. — _Issue #330 audit comment 5851547806_
- **Finding** (supported, 2026-09-25): The double-system-prompt problem Fred cares about has no open upstream PR since #138707; #140487, #137134 and #137124 only see bot re-reviews. — _openclaw#138707; openclaw#137124_
- **Finding** (supported, 2026-09-18): Home Assistant overwrites registry edits made while Core is running when it shuts down; stop Core before editing the registry. — _notes:2026-09-18_
- **Finding** (supported, 2026-09-17): The OTel persistent queue does not make metrics lossless: 360 points were dropped during qualification. — _Issue #271 comment 5716955803_
- **Decision** (2026-09-28, fred): Is the Job Dispatcher a migration of the old backend or a first build? → **First build**. Fred: "Job Dispatcher is the FIRST BUILD, not migration".
- **Decision** (2026-09-27, fred): Where do Backend 2.0 secrets live, and how much can an attempt reach? → **Google Cloud Secret Manager, full target-object access for the attempt, agent discretion**. Fred accepted at 08:36; supersedes the D40 store choice.
- **Decision** (2026-09-20, fred): What kinds of verbs does Backend 2.0 have? → **Agentic, component and scripted verbs**. D37 accepted agentic/component on 09-19; Fred added scripted (D38) on 09-20.
- **Decision** (2026-09-17, fred): Run the dead-disk and damaged-system recovery tests on Platform-01? → **Waive them for Platform-01**. Waived by Fred at 16:36.
- **Answered** (2026-09-20): May I raise the gateway's memory ceiling above 8G? → Yes; Fred delegated this kind of fix to me.
