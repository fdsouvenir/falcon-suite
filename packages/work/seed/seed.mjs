// Seed an evaluation database with real work Verl did for Fred, 2026-08 to 2026-10-01.
// Sources: Verl's daily memory notes (2026-09-17 … 2026-10-01) and the 4.x Work database.
// Where a status had to be reconstructed rather than read, the record says so.
//   node seed.mjs [out.db]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open } from './lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const w = open(process.argv[2] ?? path.join(here, 'work-seed.db'), path.join(here, '..', 'schema.sql'));
const FRED = 'person:fred';
const s = (ref, label, kind = 'ref') => ({ kind, ref, label: label ?? ref });

// ── Objectives ────────────────────────────────────────────────────────────────────────────────
// Only the first is in Fred's own words (Google Recorder note, 2026-08-19). The other two are
// inferred from the work itself and are here for Fred to rewrite or delete.
const oRevenue = w.objective({
	title: 'Home AI Solutions reaches $10K monthly revenue',
	statement:
		'Home AI Solutions sustains at least $10,000 in monthly revenue for two consecutive months.',
	rank: 1,
	at: '2026-08-19T17:00:00Z',
	kpis: [{ name: 'Monthly revenue', unit: 'USD', target: 10000 }],
	reviews: [
		{
			at: '2026-10-01T14:00:00Z',
			moved: 'Nothing. No Work serving this Objective has recorded activity since it was set on 2026-08-19.',
			stalled:
				'Every recorded hour in the last six weeks went to the Fredbot Platform and to running me. The Territory Engine is waiting on one Question (Territory 1) that has been open since early September.',
			proposed:
				'Decide the first concrete step: answer the Territory 1 Question, or have me draft the pilot offer so the thesis milestone can move.',
			sources: [s('activity:2026-08-19..2026-10-01', 'Recorded activity, 2026-08-19 to 2026-10-01')]
		}
	]
});
const oPlatform = w.objective({
	title: 'Fredbot runs customer Offices on its own platform',
	statement:
		'[Inferred by Verl, needs Fred\'s wording] Fredbot Platform hosts, operates and recovers customer Offices without hand-holding, so the business can sell them.',
	rank: 2,
	at: '2026-09-10T00:00:00Z',
	autonomy: 'act',
	limits:
		'No spending, no customer-facing messages, no destructive changes to Platform-01 without Fred\'s approval.',
	kpis: [
		{ name: 'Customer Offices live', unit: 'offices', target: 1, readings: [{ value: 0, at: '2026-10-01T00:00:00Z', source: 'building inventory: test Offices only' }] },
		{ name: 'Days since last failed nightly backup', unit: 'days', target: 30, readings: [
			{ value: 0, at: '2026-09-23T12:00:00Z', source: 'prune night failure, issue #325' },
			{ value: 8, at: '2026-10-01T12:00:00Z', source: 'backup lifecycle reports' }
		] }
	],
	reviews: [
		{
			at: '2026-10-01T14:00:00Z',
			moved:
				'Platform-01 qualification: off-host backups, alerts and certificate renewal running since 09-17. Backend 2.0 architecture settled (D37–D40, then Secret Manager on 09-27). Job Dispatcher installed idle on management-test (09-30).',
			stalled:
				'Stamping a reproducible template is deferred until Fred buys a server for Platform-02. GitHub OAuth refresh has needed a reconnect since 09-25.',
			proposed: 'Finish NOC-backend → API authentication, then run the first real Job end to end.',
			sources: [s('fredbot-backend#271'), s('fredbot-backend#378'), s('fredbot-backend#330')]
		}
	]
});
const oCareer = w.objective({
	title: 'Land a role at a frontier AI lab',
	statement:
		'[Inferred by Verl from the open applications, needs Fred\'s wording] Fred is hired into an applied-AI role at OpenAI or Anthropic.',
	rank: 3,
	at: '2026-09-08T00:00:00Z'
});

// ── Areas ─────────────────────────────────────────────────────────────────────────────────────
// 4.x had 12, including two "General" and one that was also a Project. Merged here.
const aPlatform = w.area({ title: 'Fredbot Platform', description: 'Platform-01, Buildings, Offices and the Backend that runs them.' });
const aVerl = w.area({ title: 'Verl', description: 'Keeping me running: gateway health, memory, models, credentials, automations, context files.' });
const aCore = w.area({ title: 'Core Improvements', description: 'Upstream OpenClaw: patches, PRs and issues Fred cares about.' });
const aHome = w.area({ title: 'Home', description: 'House systems: Home Assistant, cold plunge, lighting, climate, voice.' });
const aFinance = w.area({ title: 'Finances', description: 'Personal accounts, bills and the condo treasurer role.' });
const aPersonal = w.area({ title: 'Personal', description: 'Fred\'s own errands, career, family and leisure.' });
const aMarketing = w.area({ title: 'Marketing', description: 'Getting customers for Fred\'s businesses: sites, funnels, territory sales.' });
const aBetting = w.area({ title: 'Betting', description: 'NCAAB and MLB analytics and gameday operations (4.x had three Areas for this).' });

// ── Fredbot Platform: Platform-01 hardening ──────────────────────────────────────────────────
const platform = w.project({
	title: 'Configure, test and stamp the Platform template',
	outcome: 'Platform-01 is secured and qualified, and a reproducible Platform baseline exists.',
	area: aPlatform,
	serves: [oPlatform],
	at: '2026-09-10T00:00:00Z',
	milestones: [
		{
			title: 'Contain exposure and establish private administration',
			success_condition: 'No public admin surface on Platform-01; administration only over NetBird.',
			achieved: {
				at: '2026-09-16T17:00:00Z',
				basis: '[Reconstructed] NetBird architecture approved 09-10 and S4 work proceeded on 09-17, which required this stage.',
				sources: [s('notes:2026-09-17', 'Daily notes 2026-09-17')]
			}
		},
		{ key: 'qualify', title: 'Qualify Platform-01 for operation', success_condition: 'Backups, alerts, renewal and recovery are proven on the real host.' },
		{ key: 'stamp', title: 'Stamp and reproduce the Platform baseline', success_condition: 'A second Platform is built from the stamped template and passes the same qualification.' }
	]
});
const tBackups = w.task({
	project: platform.id, milestone: platform.ms.qualify, status: 'completed', serves: [oPlatform],
	title: 'Run off-host backups for Platform-01',
	description: 'S4: daily and monthly backup generations published off-host with a locked retention.',
	done_when: 'A daily generation is committed off-host and locked, the timer is enabled, and failure alerts fire.',
	at: '2026-09-16T17:00:00Z',
	result: {
		at: '2026-09-17T22:00:00Z',
		content: 'daily-20260917 (7.65 GB) committed and locked 30 days; daily timer enabled; failure alert on. Monthly checks deferred by Fred.',
		sources: [s('fredbot-backend#271', 'Issue #271 comment 5716662103'), s('release:0.1.0-s4.10')]
	},
	activity: [
		{ kind: 'release', summary: 'Released lifecycle 0.1.0-s4.8', ref: 'CI 35180448156', at: '2026-09-17T15:00:00Z' },
		{ kind: 'release', summary: 'Released s4.9; install failed on template allowlist', ref: 'CI 35246337353', at: '2026-09-17T19:00:00Z' },
		{ kind: 'release', summary: 'Released corrected s4.10', ref: 'CI 35248793703', at: '2026-09-17T20:00:00Z' },
		{ kind: 'command', summary: 'Committed and locked daily-20260917', at: '2026-09-17T22:00:00Z' }
	]
});
w.task({
	project: platform.id, milestone: platform.ms.qualify, status: 'completed', serves: [oPlatform],
	title: 'Alert on Platform-01 health',
	description: 'Telemetry pipeline with alert policies that reach Fred.',
	done_when: 'A real alert incident opens and closes and the mail is received.',
	at: '2026-09-16T17:00:00Z',
	result: {
		at: '2026-09-17T18:00:00Z',
		content: 'Fluent Bit 5.1.2 and OTel 0.160.0 active; real incident opened and closed with mail received; log replay 176/176; 35 policies. Metrics are not lossless (360 points dropped).',
		sources: [s('fredbot-backend#271', 'Issue #271 comment 5716955803')]
	},
	activity: [{ kind: 'config', summary: 'Disabled the 20h early-warning policy with Fred\'s approval', at: '2026-09-17T18:09:00Z' }]
});
w.task({
	project: platform.id, milestone: platform.ms.qualify, status: 'completed', serves: [oPlatform],
	title: 'Commission certificate renewal',
	description: 'Automatic certificate renewal with schedule and alerting.',
	done_when: 'Renewal is commissioned, scheduled and alerting, with the current expiry recorded.',
	at: '2026-09-17T00:00:00Z',
	result: { at: '2026-09-17T21:00:00Z', content: 'Release .11 commissioned renewal as normal-not-due; schedules and alert on; certificate expires Dec 12.', sources: [s('commit:d338cf57c843')] }
});
const tRecovery = w.task({
	project: platform.id, milestone: platform.ms.qualify, status: 'completed', serves: [oPlatform],
	title: 'Qualify boot and recovery',
	description: 'S5: prove normal boot, rollback and bad-kernel recovery on Platform-01.',
	done_when: 'Each required recovery path is exercised on the real host and passes.',
	revisions: [{ at: '2026-09-17T21:36:00Z', reason: 'Fred waived the dead-disk and damaged-system tests.', done_when: 'Normal boot, rollback and bad-kernel recovery pass on the real host.' }],
	at: '2026-09-17T00:00:00Z',
	result: { at: '2026-09-17T23:00:00Z', content: 'Normal boot, rollback and bad-kernel recovery passed.', sources: [s('commit:19d694b', 'Telemetry .12 (19d694b)')] }
});
w.decision({
	prompt: 'Run the dead-disk and damaged-system recovery tests on Platform-01?',
	options: [
		{ id: 'run', label: 'Run them now', risks: 'Destructive on the only production host.' },
		{ id: 'waive', label: 'Waive them for Platform-01', tradeoffs: 'Recovery from those failures stays unproven.' }
	],
	recommendation: { option: 'waive', rationale: 'There is no second host to fail over to yet.' },
	consequence: 'S5 cannot close.',
	at: '2026-09-17T21:00:00Z',
	decided: { at: '2026-09-17T21:36:00Z', option: 'waive', rationale: 'Waived by Fred at 16:36.' },
	targets: [['task', tRecovery]]
});
w.task({
	project: platform.id, milestone: platform.ms.qualify, status: 'completed', serves: [oPlatform],
	title: 'Fix spool headroom before publication',
	description: 'Publication needs about 63 GiB free; the lifecycle did not check before starting.',
	done_when: 'A nightly run after the fix exits 0 and the generation completes.',
	at: '2026-09-21T00:00:00Z',
	result: { at: '2026-09-22T12:00:00Z', content: 's4.14 shipped; the 09-22 run exited 0 and daily-20260922 completed.', sources: [s('fredbot-backend#317', 'PR #317 (5084887)'), s('fredbot-backend#318', 'Docs PR #318')] }
});
w.task({
	project: platform.id, milestone: platform.ms.qualify, status: 'open', serves: [oPlatform], agent: null,
	title: 'Re-evaluate the backup lifecycle after the prune failure',
	description: 'The 09-23 prune night failed; Fred authorized deleting four commissioning spools. The prune deadline is hard-capped at 300 s (issue #303).',
	done_when: 'Issues #303 and #325 are resolved and a week of nightly runs succeed.',
	at: '2026-09-23T15:00:00Z'
});
w.task({
	project: platform.id, milestone: platform.ms.stamp, status: 'waiting', serves: [oPlatform],
	title: 'Build and stamp the provisional Platform template',
	description: 'Package the qualified baseline and build Platform-02 from it.',
	done_when: 'Platform-02 is built from the template and passes qualification.',
	at: '2026-09-16T17:00:00Z', updated: '2026-09-17T19:39:00Z',
	wait: { for: 'Fred deferred this until he buys a server for Platform-02.', kind: 'person', ref: FRED, resume_when: 'Fred has the Platform-02 hardware.' }
});
w.finding({
	conclusion: 'The OTel persistent queue does not make metrics lossless: 360 points were dropped during qualification.',
	sources: [s('fredbot-backend#271', 'Issue #271 comment 5716955803')],
	at: '2026-09-17T18:00:00Z', targets: [['project', platform.id]]
});

// ── Fredbot Platform: Backend 2.0 and the Job Dispatcher ─────────────────────────────────────
const backend = w.project({
	title: 'Backend 2.0: Job Dispatcher first build',
	outcome: 'The Job Dispatcher runs a real Job end to end on the management Building, under the Backend 2.0 design.',
	area: aPlatform,
	serves: [oPlatform],
	at: '2026-09-19T00:00:00Z',
	milestones: [
		{
			title: 'Architecture decisions settled',
			success_condition: 'Verb kinds, system contract, data store and secrets are decided and in the spec.',
			achieved: { at: '2026-09-27T13:36:00Z', basis: 'D37–D40 accepted by 09-21 (design.19); secret store superseded by Google Secret Manager on 09-27.', sources: [s('fredbot-backend#330', 'Issue #330 comment 5856337412'), s('fredbot-backend#289')] }
		},
		{
			key: 'idle', title: 'Dispatcher installed on the management Building',
			success_condition: 'An idle Dispatcher release is installed on management-test and healthy.',
			achieved: { at: '2026-09-30T22:00:00Z', basis: 'Release 20260930-idle-5771a1b9f68b installed on VM1003 (management-test).', sources: [s('fredbot-backend#378', 'Issue #378 comment 5920950345')] }
		},
		{ key: 'job', title: 'First real Job runs end to end', success_condition: 'A Job is accepted, gated by Jev, executed and reported back with a completion report.' }
	]
});
w.task({
	project: backend.id, milestone: backend.ms.idle, status: 'completed', serves: [oPlatform],
	title: 'Bootstrap Firestore for the Dispatcher',
	description: 'Create the dispatcher-staging Firestore with the central directory (D5).',
	done_when: 'The bootstrap checks pass against dispatcher-staging.',
	at: '2026-09-28T00:00:00Z',
	result: { at: '2026-09-28T17:00:00Z', content: 'dispatcher-staging bootstrapped; 60 checks pass.', sources: [s('commit:5be4a2d')] }
});
w.task({
	project: backend.id, milestone: backend.ms.idle, status: 'completed', serves: [oPlatform],
	title: 'Prepare building-903 as management-test',
	description: 'VM 1003 as the dedicated management Building VM (D4).',
	done_when: 'VM1003 is reachable over NetBird and renamed management-test.',
	at: '2026-09-29T00:00:00Z',
	result: { at: '2026-09-30T18:00:00Z', content: 'VM1003 prepared and renamed management-test.', sources: [s('fredbot-backend#378')] }
});
const tNocAuth = w.task({
	project: backend.id, milestone: backend.ms.job, status: 'in_progress', serves: [oPlatform],
	title: 'Authenticate the NOC backend to the API independently of Verl',
	description: 'Permanent NOC-backend → API authentication that does not route through my session.',
	done_when: 'The NOC backend calls the API with its own credential and the call is audited.',
	at: '2026-10-01T15:00:00Z',
	activity: [{ kind: 'session', summary: 'Worker 70823ee0 implementing NOC-backend authentication', at: '2026-10-01T16:00:00Z' }]
});
w.task({
	project: backend.id, milestone: backend.ms.job, status: 'waiting', serves: [oPlatform],
	title: 'Reconnect GitHub OAuth for the Building Manager',
	description: 'The GitHub OAuth refresh failed on 09-25; the Building Manager candidate (PR #361) cannot publish until it is reconnected.',
	done_when: 'GitHub OAuth refreshes cleanly and PR #361 can be updated.',
	at: '2026-09-25T20:00:00Z',
	wait: { for: 'Only an operator can reconnect the GitHub OAuth grant.', kind: 'person', ref: FRED, resume_when: 'Fred has reconnected GitHub in the operator settings.', follow_up_at: '2026-10-02T14:00:00Z' }
});
w.task({
	project: backend.id, milestone: backend.ms.job, status: 'open', serves: [oPlatform], depends_on: [tNocAuth],
	title: 'Run the first real Job through the Dispatcher',
	description: 'One Job, Jev gate per invocation, completion report on every turn.',
	done_when: 'The Job completes and its completion report is recorded.',
	at: '2026-09-30T00:00:00Z'
});
w.decision({
	prompt: 'What kinds of verbs does Backend 2.0 have?',
	options: [
		{ id: 'two', label: 'Agentic and component verbs' },
		{ id: 'three', label: 'Agentic, component and scripted verbs' }
	],
	recommendation: { option: 'three', rationale: 'Scripted verbs cover deterministic multi-step work without an agent.' },
	consequence: 'Component contracts cannot be written.',
	at: '2026-09-19T18:00:00Z',
	decided: { at: '2026-09-20T18:00:00Z', option: 'three', rationale: 'D37 accepted agentic/component on 09-19; Fred added scripted (D38) on 09-20.' },
	targets: [['project', backend.id]]
});
w.decision({
	prompt: 'Where do Backend 2.0 secrets live, and how much can an attempt reach?',
	options: [
		{ id: 'cfss', label: 'Cloudflare Secrets Store (D40)' },
		{ id: 'gsm', label: 'Google Cloud Secret Manager, full target-object access for the attempt, agent discretion' }
	],
	recommendation: { option: 'gsm', rationale: 'Matches the Cloud Run + Firestore choice and SecretRef-only access.' },
	consequence: 'The Dispatcher cannot hold credentials.',
	at: '2026-09-26T18:00:00Z',
	decided: { at: '2026-09-27T13:36:00Z', option: 'gsm', rationale: 'Fred accepted at 08:36; supersedes the D40 store choice.' },
	targets: [['project', backend.id]]
});
w.decision({
	prompt: 'Is the Job Dispatcher a migration of the old backend or a first build?',
	options: [{ id: 'migrate', label: 'Migration' }, { id: 'first', label: 'First build' }],
	recommendation: { option: 'first', rationale: 'Nothing in the old backend matches the new contracts.' },
	consequence: 'Planning stays split between two shapes.',
	at: '2026-09-28T14:00:00Z',
	decided: { at: '2026-09-28T15:00:00Z', option: 'first', rationale: 'Fred: "Job Dispatcher is the FIRST BUILD, not migration".' },
	targets: [['project', backend.id]]
});
w.finding({
	conclusion: 'The reference Office template still grants operator.admin, contrary to D44.',
	sources: [s('fredbot-backend#330', 'Issue #330 audit comment 5851150351')],
	at: '2026-09-26T18:00:00Z', targets: [['project', backend.id]]
});
w.finding({
	conclusion: 'The sole executor runs on platform-01, so platform-01 cannot repair itself through it.',
	sources: [s('fredbot-backend#330', 'Issue #330 audit comment 5851547806')],
	at: '2026-09-26T18:00:00Z', targets: [['project', backend.id]]
});

// ── Verl: keeping me running ─────────────────────────────────────────────────────────────────
const tMemory = w.task({
	area: aVerl, status: 'completed',
	title: 'Raise the gateway memory ceiling',
	description: 'Delegated builds, llama-server and Chrome share the gateway\'s 7G/8G cgroup; the gateway stalled and was OOM-killed on 09-19.',
	done_when: 'A persistent higher ceiling is in place and the gateway survives a delegated build.',
	at: '2026-09-19T17:37:00Z',
	result: { at: '2026-09-20T19:18:00Z', content: 'Transient 10G/11G on 09-19, made persistent on 09-20 under Fred\'s delegation correction.', sources: [s('file:resources.conf.bak-20260920-1415', 'resources.conf (backup kept)')] },
	activity: [
		{ kind: 'config', summary: 'Applied transient 10G/11G memory ceiling', at: '2026-09-20T03:46:00Z' },
		{ kind: 'config', summary: 'Made memory ceiling persistent', at: '2026-09-20T19:18:00Z' }
	]
});
w.question({
	prompt: 'May I raise the gateway\'s memory ceiling above 8G?',
	impact: 'The gateway keeps stalling during delegated builds.',
	at: '2026-09-19T18:05:00Z',
	answer: { at: '2026-09-20T18:50:00Z', text: 'Yes; Fred delegated this kind of fix to me.', confidence: 'confirmed', sources: [s('notes:2026-09-20')] },
	targets: [['task', tMemory]]
});
const tCron = w.task({
	area: aVerl, status: 'in_progress',
	title: 'Fix cron exec admission failures',
	description: 'Two automations fail exec admission (upstream #142271/#145753).',
	done_when: 'Both automations run their exec steps for a week without admission failures.',
	at: '2026-09-20T15:00:00Z',
	result: { at: '2026-09-20T20:00:00Z', content: 'Diagnosis written; proposed --clear-tools on the two jobs.', sources: [s('file:artifacts/cron-exec-admission-20260920/REPORT.md')] }
});
w.decision({
	prompt: 'Apply --clear-tools to the two failing automations?',
	options: [
		{ id: 'apply', label: 'Apply --clear-tools', tradeoffs: 'Those automations lose tool access they do not use.' },
		{ id: 'wait', label: 'Wait for the upstream fix', risks: 'The jobs keep failing until it ships.' }
	],
	recommendation: { option: 'apply', rationale: 'Neither job needs tools; the fix is reversible.' },
	consequence: 'Two automations keep failing nightly.',
	at: '2026-09-20T20:00:00Z',
	targets: [['task', tCron]],
	ask: 'agent:main:dashboard:2faf394d'
});
w.question({
	prompt: 'Which model should I fall back to when Anthropic session limits black me out?',
	impact: 'During a limit blackout I stop working entirely, as on 09-21.',
	hypothesis: 'openai/gpt-5.5 as a single fallback leg.',
	at: '2026-09-21T16:00:00Z',
	ask: 'agent:main:dashboard:2faf394d'
});
w.task({
	area: aVerl, status: 'completed',
	title: 'Audit and recycle Cloudflare credentials',
	description: 'Test all eight Cloudflare vault entries and recycle the ones that fail.',
	done_when: 'Every remaining entry is verified working and failures are in the recycle bin.',
	at: '2026-09-17T14:00:00Z',
	result: { at: '2026-09-17T18:00:00Z', content: 'Five failing entries recycled; master key renamed; token creator verified; two fredbot.link DNS tokens created, expiring 2027-09-17.', sources: [s('file:artifacts/cloudflare-credential-audit-20260917/')] }
});
w.task({
	area: aVerl, status: 'completed',
	title: 'Trim USER.md below the load limit',
	description: '5,395 characters were being truncated when USER.md loaded.',
	done_when: 'USER.md loads untruncated and the prior text is preserved.',
	at: '2026-09-24T14:00:00Z',
	result: { at: '2026-09-24T15:00:00Z', content: 'Trimmed with Fred\'s approval; full prior text kept in the daily note.', sources: [s('notes:2026-09-24')] }
});
w.question({
	prompt: 'Did you authorize the "OpenClaw GitHub Tools" OAuth app?',
	impact: 'If not, it is an unexplained grant on your GitHub account.',
	at: '2026-09-17T16:00:00Z',
	ask: true
});

// ── Core Improvements: upstream OpenClaw ─────────────────────────────────────────────────────
w.task({
	area: aCore, status: 'waiting',
	title: 'Route Portals through the gateway listener',
	description: 'Patch first, PR later (Fred). Build 2026.9.5-1 carries the fix.',
	done_when: 'The patched build is installed and Portals load through the gateway; the PR is filed upstream.',
	at: '2026-09-19T15:00:00Z', updated: '2026-09-20T20:00:00Z',
	result: { at: '2026-09-20T20:00:00Z', content: 'Patched build 2026.9.5-1 built with tarball and README; not installed.', sources: [s('commit:2498a85cb95'), s('file:workspace/projects/openclaw-portals-routed/')] },
	wait: { for: 'Fred wants to test the patched build himself before it is installed.', kind: 'person', ref: FRED, resume_when: 'Fred has tested 2026.9.5-1.', follow_up_at: '2026-10-03T14:00:00Z' }
});
w.finding({
	conclusion: 'The double-system-prompt problem Fred cares about has no open upstream PR since #138707; #140487, #137134 and #137124 only see bot re-reviews.',
	sources: [s('openclaw#138707'), s('openclaw#137124')],
	at: '2026-09-25T13:00:00Z'
});

// ── Home: cold plunge ────────────────────────────────────────────────────────────────────────
const plunge = w.project({
	title: 'Reactive cold plunge controller',
	outcome: 'The plunge holds the requested temperature by reacting to the tub sensor, with a 35.0 freeze floor.',
	area: aHome,
	at: '2026-09-18T15:00:00Z',
	milestones: [
		{ key: 'v4', title: 'Reactive v4 controller live', success_condition: 'v4 runs on Home Assistant and stays inside its window for a night.',
			achieved: { at: '2026-09-19T05:00:00Z', basis: 'v4.0.0 deployed; v4.0.1 fixed the out-of-window run Fred caught.', sources: [s('commit:b84f5aa'), s('file:/config/change-v4-backup-20260918T204626-0500/')] } },
		{ key: 'floor', title: 'Freeze floor at 35.0', success_condition: 'The controller never targets below 36 and never lets the water fall below 35.0.',
			achieved: { at: '2026-09-19T16:00:00Z', basis: 'v4.1.0 deployed with freeze floor 35 and target minimum 36; 57 tests.', sources: [s('repo:cold-plunge-controller v4.1.0')] } }
	]
});
w.task({
	project: plunge.id, milestone: plunge.ms.v4, status: 'completed',
	title: 'Rewrite the plunge controller to react to the tub sensor',
	description: 'Fred rejected the 30-day model design and specified a reactive controller.',
	done_when: 'v4 is deployed with tests and a Home Assistant backup taken first.',
	at: '2026-09-18T15:00:00Z',
	result: { at: '2026-09-19T04:51:00Z', content: 'v4.0.0 deployed, then v4.0.1 (median capacity, MIN_NET_RATE 0.5) after Fred caught a run outside the window.', sources: [s('commit:f6daeec'), s('commit:b84f5aa')] }
});
w.task({
	project: plunge.id, milestone: plunge.ms.floor, status: 'completed',
	title: 'Set the freeze floor to 35.0',
	description: 'Fred: "I want to plunge at as low as 36, let\'s say 35.0 is the floor."',
	done_when: 'v4.1.0 deployed with the floor and its tests passing.',
	at: '2026-09-19T14:00:00Z',
	result: { at: '2026-09-19T16:00:00Z', content: 'v4.1.0 deployed; 57 tests pass.', sources: [s('repo:cold-plunge-controller v4.1.0')] }
});
w.finding({
	conclusion: 'Home Assistant overwrites registry edits made while Core is running when it shuts down; stop Core before editing the registry.',
	sources: [s('notes:2026-09-18')],
	at: '2026-09-18T22:00:00Z', targets: [['project', plunge.id]]
});

// ── Finances ─────────────────────────────────────────────────────────────────────────────────
w.task({
	area: aFinance, status: 'completed',
	title: 'Put the Chase payment on the calendar',
	description: 'Payment marker for the card ending 2249.',
	done_when: 'A calendar event exists on the due date.',
	at: '2026-09-16T15:00:00Z',
	result: { at: '2026-09-16T16:00:00Z', content: 'Marker created for October 9.', sources: [s('gcal:u43j2ess0fu9o6sl869nsc4fe8', 'Calendar event, Oct 9')] }
});
const condo = w.project({
	title: 'Condo treasurer 2026 setup',
	outcome: 'The condo books are current, reconciled and visible on a dashboard.',
	area: aFinance,
	at: '2026-08-20T00:00:00Z',
	milestones: [{ key: 'books', title: 'Books reconciled through September', success_condition: 'Every 2026 transaction is categorized and explained.' }]
});
w.task({
	project: condo.id, milestone: condo.ms.books, status: 'waiting',
	title: 'Find out what the two April reimbursements covered',
	description: 'Two April reimbursements have no explanation in the ledger.',
	done_when: 'Both are categorized with Adrien\'s explanation recorded.',
	at: '2026-09-01T00:00:00Z',
	wait: { for: 'Adrien has to say what the two reimbursements were for.', kind: 'person', ref: 'person:adrien', resume_when: 'Adrien replies.', follow_up_at: '2026-10-03T14:00:00Z' }
});
w.task({
	area: aFinance, status: 'in_progress',
	title: 'Restore Schwab CLI authentication',
	description: 'The Schwab CLI refresh token lapsed.',
	done_when: 'schwab-cli reads balances again.',
	at: '2026-09-05T00:00:00Z'
});

// ── Personal ─────────────────────────────────────────────────────────────────────────────────
const openai = w.project({
	title: 'Apply: OpenAI Forward Deployed Engineer (SF)',
	outcome: 'A tailored, truthful application is submitted.',
	area: aPersonal,
	serves: [oCareer],
	at: '2026-09-08T00:00:00Z',
	milestones: [{ key: 'submit', title: 'Application submitted', success_condition: 'OpenAI confirms receipt.' }]
});
w.task({
	project: openai.id, milestone: openai.ms.submit, status: 'in_progress', serves: [oCareer],
	title: 'Revise the résumé and application packet',
	description: 'Tailor to the FDE role without overstating anything.',
	done_when: 'Fred approves the final résumé and packet.',
	at: '2026-09-08T00:00:00Z'
});
w.task({
	project: openai.id, milestone: openai.ms.submit, status: 'waiting', serves: [oCareer],
	title: 'Add impact numbers for the TDL submission',
	description: 'The packet cites the TDL submission but has no outcome numbers.',
	done_when: 'The packet states sourced impact numbers, or the claim is removed.',
	at: '2026-09-08T00:00:00Z',
	wait: { for: 'Only Fred has the TDL outcome numbers.', kind: 'person', ref: FRED, resume_when: 'Fred supplies the numbers or says to drop the claim.' }
});
w.task({
	area: aPersonal, status: 'completed',
	title: 'Advise on the Shough + Lemon for Deebo + Allgeier trade',
	description: 'ESPN league 309524 trade offer.',
	done_when: 'Fred has a recommendation with reasoning.',
	at: '2026-09-24T15:00:00Z',
	result: { at: '2026-09-24T16:00:00Z', content: 'Lean accept. Note: the ESPN cookies on hand are Michael\'s, not Fred\'s.', sources: [s('notes:2026-09-24')] }
});

// ── Marketing: what serves the revenue Objective ─────────────────────────────────────────────
const has = w.project({
	title: 'Home AI Solutions: first paid pilot',
	outcome: 'One customer pays for a Home AI Solutions pilot.',
	area: aMarketing,
	serves: [oRevenue],
	at: '2026-08-19T17:00:00Z',
	milestones: [
		{ title: 'Thesis written', success_condition: 'A one-page thesis Fred agrees with.' },
		{ title: 'Offer defined', success_condition: 'A priced pilot offer with scope.' },
		{ title: 'First paid pilot', success_condition: 'Payment received for a pilot.' }
	]
});
const territory = w.project({
	title: 'Territory Engine',
	outcome: 'Fred selects an area and sells door to door with generated lists and scripts.',
	area: aMarketing,
	serves: [oRevenue],
	at: '2026-09-01T00:00:00Z',
	milestones: [{ key: 't1', title: 'Territory 1 ready to sell', success_condition: 'Lists, route and pitch exist for Territory 1.' }]
});
const tT1a = w.task({
	project: territory.id, milestone: territory.ms.t1, status: 'ready', serves: [oRevenue],
	title: 'Build the household list for Territory 1',
	description: 'Generate the target household list for the chosen territory.',
	done_when: 'A deduplicated list exists for Territory 1.',
	at: '2026-09-02T00:00:00Z'
});
const tT1b = w.task({
	project: territory.id, milestone: territory.ms.t1, status: 'ready', serves: [oRevenue], depends_on: [tT1a],
	title: 'Plan the walking route for Territory 1',
	description: 'Order the list into walkable sessions.',
	done_when: 'Routes for the first three sessions exist.',
	at: '2026-09-02T00:00:00Z'
});
w.question({
	prompt: 'Which area is Territory 1?',
	impact: 'The whole Territory Engine is held on this answer.',
	at: '2026-09-02T00:00:00Z',
	targets: [['task', tT1a], ['task', tT1b], ['project', territory.id]],
	ask: true
});
w.decision({
	prompt: 'What should I do next for Home AI Solutions?',
	options: [
		{ id: 'thesis', label: 'Draft the thesis and pilot offer for your review' },
		{ id: 'territory', label: 'Wait for Territory 1 and push the Territory Engine' },
		{ id: 'pause', label: 'Pause this Objective while the Platform is the priority' }
	],
	recommendation: { option: 'thesis', rationale: 'It needs nothing from you to start and unblocks the first two milestones.' },
	consequence: 'The Objective stays at zero progress; it has had no activity for six weeks.',
	at: '2026-10-01T14:00:00Z',
	targets: [['objective', oRevenue], ['project', has.id]],
	ask: 'agent:main:dashboard:2faf394d'
});

// ── Betting (stale in 4.x) ───────────────────────────────────────────────────────────────────
w.task({
	area: aBetting, status: 'abandoned', abandoned_by: 'agent:verl',
	title: 'Run the August 6 ESPN morning ingestion',
	description: 'One-off ingestion run left in progress since August.',
	done_when: 'The August 6 data is ingested.',
	at: '2026-08-06T12:00:00Z', updated: '2026-10-01T14:00:00Z'
});

// ── Approval for a consequential step (replaces 4.x "Approve/Defer" decisions) ───────────────
const tSharp = w.task({
	area: aVerl, status: 'ready',
	title: 'Install the sharp optional dependency',
	description: 'Image attachments in OpenClaw need sharp; it is an optional dependency of the global install.',
	done_when: 'An image attachment renders in chat.',
	at: '2026-09-08T00:00:00Z'
});
w.decision({
	prompt: 'Install sharp into the global OpenClaw install?',
	options: [
		{ id: 'install', label: 'Install it', risks: 'Native module; reinstall needed on Node upgrades.' },
		{ id: 'skip', label: 'Skip; keep sending images as attachments' }
	],
	recommendation: { option: 'install', rationale: 'Small, reversible, and fixes image attachments.' },
	consequence: 'Image attachments stay broken.',
	at: '2026-09-08T00:00:00Z',
	targets: [['task', tSharp]]
});

// ── Untracked activity: things I did that no Task explains ───────────────────────────────────
w.untracked({ at: '2026-09-21T15:00:00Z', kind: 'config', summary: 'Edited the Morning Brief automation prompt', ref: 'automation 13e4d317' });
w.untracked({ at: '2026-09-22T13:00:00Z', kind: 'command', summary: 'Restarted the gateway and replayed completions' });
w.untracked({ at: '2026-09-24T17:00:00Z', kind: 'config', summary: 'Refreshed 14 Cloudflare skills and added the cloudflare-docs MCP', ref: '6dc7604' });
w.untracked({ at: '2026-09-27T16:00:00Z', kind: 'file', summary: 'Changed USER.md to send images as attachments' });

w.db.close();
console.error('seeded');
