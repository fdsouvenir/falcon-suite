import { Type } from 'typebox';
import { defineFeatureContract } from 'openclaw/plugin-sdk/feature-contract';
import { PLUGIN_ID } from './identity.js';

// Browser-safe: shared by the plugin backend, the agent tools and the native UI.
// The command names below must match the store's commands (a test checks this).
export const COMMAND_NAMES = [
	'create_job edit_job pause_job resume_job retire_job link_automation unlink_automation',
	'create_project edit_project abandon_project resume_project add_milestone plan_project edit_milestone reorder_milestones achieve_milestone reopen_milestone',
	'create_task create_task_from_entries file_entries revise_definition revise_plan ready unready assign start wait resume record_result complete reopen abandon detach_from_milestone depend undepend',
	'set_status_line attach_task promote_to_project record_entry',
	'raise_question add_hypothesis answer accept_hypothesis withdraw_question raise_decision revise_decision decide defer_decision withdraw_decision supersede_decision record_finding retract_finding supersede_finding'
]
	.join(' ')
	.split(' ');

export const VIEWS = [
	'home',
	'project',
	'task',
	'job',
	'search',
	'get',
	'needs_you',
	'board',
	'help'
] as const;

const Lit = (values: readonly string[]) => Type.Union(values.map((v) => Type.Literal(v)));
const Id = Type.String({ maxLength: 128 });
const d = (description: string) => ({ description });
const Str = (max: number, description: string) =>
	Type.String({ minLength: 1, maxLength: max, description });
const Ids = (description: string) => Type.Array(Id, { maxItems: 50, description });
const Sources = Type.Array(
	Type.Object(
		{
			ref: Type.String({ minLength: 1, maxLength: 4096, ...d('commit, PR, URL, file path, …') }),
			label: Type.Optional(Type.String({ maxLength: 1000 }))
		},
		{ additionalProperties: false }
	),
	{ maxItems: 50, ...d('Evidence') }
);
const PlanTask = {
	key: Type.Optional(Str(64, 'A short name other Tasks in this plan use in depends_on')),
	title: Str(240, 'What the Task achieves'),
	description: Str(12000, 'What it involves'),
	done_when: Str(12000, 'How anyone can tell it is done'),
	depends_on: Type.Optional(
		Type.Array(Type.String({ maxLength: 128 }), {
			maxItems: 50,
			...d('Keys of Tasks in this plan, or ids of existing Tasks')
		})
	),
	agent: Type.Optional(Type.String({ maxLength: 160, ...d('agent:<id> accountable for it') })),
	plan: Type.Optional(Str(12000, 'How it will be done, if known'))
};
const PlanMilestone = Type.Object(
	{
		title: Str(240, 'The checkpoint'),
		success_condition: Str(12000, 'What must be true to call it achieved'),
		tasks: Type.Optional(
			Type.Array(Type.Object(PlanTask, { additionalProperties: false }), { maxItems: 100 })
		)
	},
	{ additionalProperties: false }
);

const NOTE =
	'Falcon Work keeps its own record from conversations; use these tools only when the person asks you to change it.';

export const contract = defineFeatureContract({
	pluginId: PLUGIN_ID,
	operations: {
		read: {
			kind: 'query',
			description:
				'Read Falcon Work, the record of what your agents are doing for the person. view: home (what needs the person, what is in motion, what happened; long lists carry their first page, total and next cursor) · project, task, job (id) · search (text) · get (any id) · needs_you (cursor?: a page of open asks, newest first) · board (column: moving, waiting or done; cursor?) · help (command: the full input of one falcon_work command).',
			input: Type.Object(
				{
					view: Lit(VIEWS),
					id: Type.Optional(Id),
					text: Type.Optional(Type.String({ maxLength: 200, ...d('search: words to find') })),
					since: Type.Optional(
						Type.String({ maxLength: 64, ...d('home: show what happened after this time') })
					),
					command: Type.Optional(Type.String({ maxLength: 64 })),
					column: Type.Optional(Lit(['moving', 'waiting', 'done'])),
					cursor: Type.Optional(
						Type.String({
							maxLength: 300,
							...d('needs_you, board: the next cursor of the page before')
						})
					)
				},
				{ additionalProperties: false }
			),
			output: Type.Unknown(),
			tool: { name: 'falcon_work_read', label: 'Read Falcon Work' }
		},
		do: {
			kind: 'action',
			description: `${NOTE} Any other change to Falcon Work: one command per call, as {command, id?, expected_version?, input}. falcon_work_read view=help command=<name> gives a command's input. Commands: ${COMMAND_NAMES.join(', ')}.`,
			input: Type.Object(
				{
					command: Lit(COMMAND_NAMES),
					id: Type.Optional(Id),
					expected_version: Type.Optional(Type.Integer({ minimum: 1 })),
					idempotency_key: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
					input: Type.Optional(Type.Record(Type.String(), Type.Unknown()))
				},
				{ additionalProperties: false }
			),
			output: Type.Unknown(),
			tool: { name: 'falcon_work', label: 'Change Falcon Work' }
		},
		plan: {
			kind: 'action',
			description: `${NOTE} Plan a Project: a bounded outcome that takes several deliverables, reached through ordered Milestones, each with Tasks. Give project (an existing Project id) to add Milestones and Tasks to it, or new_project to create one with its plan. Tasks can depend on each other by key. All or nothing.`,
			input: Type.Object(
				{
					project: Type.Optional(
						Type.String({ maxLength: 128, ...d('Existing Project to add to') })
					),
					new_project: Type.Optional(
						Type.Object(
							{
								title: Str(240, 'The Project'),
								outcome: Str(12000, 'What will be true when it is done')
							},
							{ additionalProperties: false }
						)
					),
					milestones: Type.Optional(
						Type.Array(PlanMilestone, {
							maxItems: 50,
							...d('New Milestones, in order, with their Tasks')
						})
					),
					tasks: Type.Optional(
						Type.Array(
							Type.Object(
								{
									...PlanTask,
									milestone: Type.Optional(
										Type.String({ maxLength: 128, ...d('An existing Milestone of this Project') })
									)
								},
								{ additionalProperties: false }
							),
							{ maxItems: 100, ...d('Tasks outside the new Milestones') }
						)
					)
				},
				{ additionalProperties: false }
			),
			output: Type.Unknown(),
			tool: { name: 'falcon_work_plan', label: 'Plan a Project' }
		},
		task: {
			kind: 'action',
			description: `${NOTE} Track a Task: one deliverable with a definition of done, standalone or in a Project or Job. action create (title, description, done_when, project? milestone? job?, depends_on?, start?) · start · wait (waiting_for, waiting_on: who or what it waits on, resume_when, follow_up_at?) · resume · complete (result, evidence: at least one source) · abandon (reason?).`,
			input: Type.Object(
				{
					action: Lit(['create', 'start', 'wait', 'resume', 'complete', 'abandon']),
					id: Type.Optional(Type.String({ maxLength: 128, ...d('The Task, except for create') })),
					title: Type.Optional(Str(240, 'create: what the Task achieves')),
					description: Type.Optional(Str(12000, 'create: what it involves')),
					done_when: Type.Optional(Str(12000, 'create: how anyone can tell it is done')),
					project: Type.Optional(Type.String({ maxLength: 128, ...d('create: its Project…') })),
					milestone: Type.Optional(
						Type.String({ maxLength: 128, ...d('create: Milestone in that Project') })
					),
					job: Type.Optional(Type.String({ maxLength: 128, ...d('create: …or its Job') })),
					depends_on: Type.Optional(Ids('create: Tasks it needs first')),
					plan: Type.Optional(Str(12000, 'create: how it will be done')),
					start: Type.Optional(Type.Boolean({ ...d('create: start it now, as yours') })),
					waiting_for: Type.Optional(Str(12000, 'wait: what it is waiting for')),
					waiting_on: Type.Optional(
						Type.String({
							maxLength: 1000,
							...d(
								'wait: who or what it waits on: person:<id>, agent:<id>, a Task id, or a description of something external'
							)
						})
					),
					resume_when: Type.Optional(Str(12000, 'wait: what lets it continue')),
					follow_up_at: Type.Optional(
						Type.String({ maxLength: 64, ...d('wait: ISO time to check back') })
					),
					result: Type.Optional(Str(12000, 'complete: what it produced')),
					evidence: Type.Optional(Sources),
					reason: Type.Optional(Str(1000, 'abandon: why'))
				},
				{ additionalProperties: false }
			),
			output: Type.Unknown(),
			tool: { name: 'falcon_work_task', label: 'Track a Task' }
		},
		job: {
			kind: 'action',
			description: `${NOTE} Keep a Job: an ongoing duty you carry out for the person, never finished (e.g. "watch the support inbox and draft a reply to everything"). action create (title, instructions, automations?) · edit (id, title?, instructions?) · pause · resume · retire (id, reason?) · link_automation / unlink_automation (id, automation: the OpenClaw automation that runs it).`,
			input: Type.Object(
				{
					action: Lit([
						'create',
						'edit',
						'pause',
						'resume',
						'retire',
						'link_automation',
						'unlink_automation'
					]),
					id: Type.Optional(Type.String({ maxLength: 128, ...d('The Job, except for create') })),
					title: Type.Optional(Str(240, 'create, edit: the duty')),
					instructions: Type.Optional(Str(12000, 'create, edit: what to do, and any limits')),
					automations: Type.Optional(
						Type.Array(
							Type.Object(
								{ id: Str(256, 'Automation id'), name: Type.Optional(Str(240, 'Automation name')) },
								{ additionalProperties: false }
							),
							{ maxItems: 20, ...d('create: OpenClaw automations that run it') }
						)
					),
					automation: Type.Optional(
						Type.Object(
							{ id: Str(256, 'Automation id'), name: Type.Optional(Str(240, 'Automation name')) },
							{ additionalProperties: false }
						)
					),
					reason: Type.Optional(Str(1000, 'Why'))
				},
				{ additionalProperties: false }
			),
			output: Type.Unknown(),
			tool: { name: 'falcon_work_job', label: 'Keep a Job' }
		},
		ask: {
			kind: 'action',
			description: `${NOTE} Ask the person: it shows under Needs you on their Falcon Work page until answered, with a link to this conversation. kind question: things you need to know; pass questions[] to ask several at once, one per thing (prompt, impact, hypothesis = your best guess). kind decision: a choice for them to make (prompt, options, recommendation, consequence_of_no_decision). about: ids of what it concerns. holds: Tasks that cannot go on until it is answered.`,
			input: Type.Object(
				{
					kind: Lit(['question', 'decision']),
					questions: Type.Optional(
						Type.Array(
							Type.Object(
								{
									prompt: Str(2000, 'One thing you need to know'),
									impact: Str(2000, 'Why the answer matters'),
									hypothesis: Type.Optional(Str(12000, 'Your best guess'))
								},
								{ additionalProperties: false }
							),
							{ minItems: 1, maxItems: 20, ...d('question: several Questions at once') }
						)
					),
					prompt: Type.Optional(Str(2000, 'The question, or the choice to make')),
					impact: Type.Optional(Str(2000, 'question: why the answer matters')),
					hypothesis: Type.Optional(Str(12000, 'question: your best guess')),
					options: Type.Optional(
						Type.Array(
							Type.Object(
								{
									id: Str(64, 'Short option id'),
									label: Str(240, 'The option'),
									summary: Type.Optional(Str(2000, 'What it means')),
									risks: Type.Optional(Str(2000, 'Risks')),
									tradeoffs: Type.Optional(Str(2000, 'Tradeoffs'))
								},
								{ additionalProperties: false }
							),
							{ minItems: 2, maxItems: 20, ...d('decision: the options') }
						)
					),
					recommendation: Type.Optional(
						Type.Object(
							{ option: Str(64, 'Option id you recommend'), rationale: Str(2000, 'Why') },
							{ additionalProperties: false }
						)
					),
					consequence_of_no_decision: Type.Optional(
						Str(2000, 'decision: what happens if nobody decides')
					),
					to: Type.Optional(
						Ids('Who answers or decides (person:<id>); the Gateway owner by default')
					),
					about: Type.Optional(Ids('Jobs, Projects, Milestones or Tasks it concerns')),
					holds: Type.Optional(Ids('Tasks that wait on the person asked until this is answered'))
				},
				{ additionalProperties: false }
			),
			output: Type.Unknown(),
			tool: { name: 'falcon_work_ask', label: 'Ask the person' }
		},
		finding: {
			kind: 'action',
			description: `${NOTE} Record a Finding: something learned that others should rely on, with evidence.`,
			input: Type.Object(
				{
					conclusion: Str(12000, 'What was learned'),
					confidence: Lit(['tentative', 'supported', 'confirmed']),
					evidence: Sources,
					about: Type.Optional(Ids('Jobs, Projects, Milestones or Tasks it concerns'))
				},
				{ additionalProperties: false }
			),
			output: Type.Unknown(),
			tool: { name: 'falcon_work_finding', label: 'Record a Finding' }
		}
	},
	events: {
		changed: Type.Object({ at: Type.String() }, { additionalProperties: false })
	}
});
