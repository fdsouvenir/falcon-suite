import { Type } from 'typebox';
import { defineFeatureContract } from 'openclaw/plugin-sdk/feature-contract';
import { PLUGIN_ID } from './identity.js';

// Browser-safe: shared by the plugin backend, the agent tools and the native UI.
// The command names below must match the store's commands (a test checks this).
export const COMMAND_NAMES = [
	'create_objective edit_objective rank_objectives set_autonomy pause_objective resume_objective achieve_objective retire_objective',
	'add_kpi edit_kpi remove_kpi record_kpi_reading write_review',
	'create_area edit_area retire_area',
	'create_project edit_project move_project abandon_project resume_project add_milestone plan_project edit_milestone reorder_milestones achieve_milestone reopen_milestone serve unserve set_session',
	'create_task create_task_from_activity attach_activity revise_definition revise_plan ready unready assign start wait resume record_result complete reopen abandon move_task detach_from_milestone depend undepend',
	'raise_question add_hypothesis answer accept_hypothesis withdraw_question raise_decision revise_decision decide defer_decision withdraw_decision supersede_decision record_finding retract_finding supersede_finding dismiss_ask'
]
	.join(' ')
	.split(' ');

export const VIEWS = [
	// Screen projections for the Control UI.
	'overview',
	'areas',
	'project',
	'objective',
	'feed',
	'panel',
	// Agent and general reads.
	'brief',
	'needs_you',
	'objectives',
	'get',
	'list',
	'activity',
	'warnings',
	'help'
] as const;
export const KINDS = [
	'objective',
	'kpi',
	'area',
	'project',
	'milestone',
	'task',
	'question',
	'decision',
	'finding',
	'ask'
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

export const contract = defineFeatureContract({
	pluginId: PLUGIN_ID,
	operations: {
		read: {
			kind: 'query',
			description:
				'Read Falcon Work. view: brief (your Tasks, answers, warnings) · needs_you · objectives · get (id) · list (kind + filters) · activity · warnings · help (command: the full input of one falcon_work command).',
			input: Type.Object(
				{
					view: Lit(VIEWS),
					id: Type.Optional(Id),
					kind: Type.Optional(Lit(KINDS)),
					command: Type.Optional(Type.String({ maxLength: 64 })),
					filters: Type.Optional(
						Type.Object(
							{
								area: Type.Optional(Id),
								project: Type.Optional(Id),
								objective: Type.Optional(Id),
								status: Type.Optional(Type.String({ maxLength: 32 })),
								agent: Type.Optional(Type.String({ maxLength: 160 })),
								text: Type.Optional(Type.String({ maxLength: 200 })),
								untracked: Type.Optional(Type.Boolean()),
								include_inactive: Type.Optional(Type.Boolean()),
								limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
								offset: Type.Optional(Type.Integer({ minimum: 0 })),
								before: Type.Optional(Type.Integer({ minimum: 1 })),
								feed: Type.Optional(Lit(['all', 'changes', 'activity', 'untracked']))
							},
							{ additionalProperties: false }
						)
					)
				},
				{ additionalProperties: false }
			),
			output: Type.Unknown(),
			tool: { name: 'falcon_work_read', label: 'Read Falcon Work' }
		},
		do: {
			kind: 'action',
			description: `Any other change to Falcon Work (Objectives, KPIs, Areas, editing or moving things, answering and deciding): one command per call, as {command, id?, expected_version?, input}. falcon_work_read view=help command=<name> gives a command's input. Commands: ${COMMAND_NAMES.join(', ')}.`,
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
			description:
				'Plan a Project in Falcon Work: a Project is an outcome with ordered Milestones, each reached through Tasks. Give project (an existing Project id) to add Milestones and Tasks to it, or new_project to create one with its plan. Tasks can depend on each other by key. All or nothing.',
			input: Type.Object(
				{
					project: Type.Optional(
						Type.String({ maxLength: 128, ...d('Existing Project to add to') })
					),
					new_project: Type.Optional(
						Type.Object(
							{
								title: Str(240, 'The Project'),
								outcome: Str(12000, 'What will be true when it is done'),
								area: Type.String({ maxLength: 128, ...d('Area it belongs to') }),
								serves: Type.Optional(Ids('Objectives it moves forward')),
								decision: Type.Optional(
									Type.String({
										maxLength: 128,
										...d(
											'A decided Decision approving it, when it serves an Objective set to propose'
										)
									})
								)
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
			description:
				'Track a Task in Falcon Work: a unit of work with a definition of done, placed in an Area or a Project (Milestone). action create (title, description, done_when, area or project, milestone?, depends_on?, start?) · start · wait (waiting_for, waiting_on: who or what it waits on, resume_when, follow_up_at?) · resume · complete (result, evidence: at least one source) · abandon (reason?).',
			input: Type.Object(
				{
					action: Lit(['create', 'start', 'wait', 'resume', 'complete', 'abandon']),
					id: Type.Optional(Type.String({ maxLength: 128, ...d('The Task, except for create') })),
					title: Type.Optional(Str(240, 'create: what the Task achieves')),
					description: Type.Optional(Str(12000, 'create: what it involves')),
					done_when: Type.Optional(Str(12000, 'create: how anyone can tell it is done')),
					area: Type.Optional(Type.String({ maxLength: 128, ...d('create: its Area…') })),
					project: Type.Optional(Type.String({ maxLength: 128, ...d('create: …or its Project') })),
					milestone: Type.Optional(
						Type.String({ maxLength: 128, ...d('create: Milestone in that Project') })
					),
					serves: Type.Optional(Ids('create: Objectives it moves forward')),
					decision: Type.Optional(
						Type.String({
							maxLength: 128,
							...d('create: approving Decision, for propose Objectives')
						})
					),
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
		ask: {
			kind: 'action',
			description:
				'Ask the person in Falcon Work. Unlike asking in chat, it stays under Needs you until they answer or decide, survives this conversation, and the answer comes back to you in your brief. kind question: things you need to know; pass questions[] to ask several at once, one per thing, so each can be answered on its own (prompt, impact, hypothesis = your best guess, which they can accept). kind decision: a choice for them to make (prompt, options, recommendation, consequence_of_no_decision). about: ids of what it concerns. holds: Tasks that cannot go on until it is answered; they wait on the person asked.',
			input: Type.Object(
				{
					kind: Lit(['question', 'decision']),
					questions: Type.Optional(
						Type.Array(
							Type.Object(
								{
									prompt: Str(2000, 'One thing you need to know'),
									impact: Str(2000, 'Why the answer matters'),
									hypothesis: Type.Optional(Str(12000, 'Your best guess, which they can accept'))
								},
								{ additionalProperties: false }
							),
							{ minItems: 1, maxItems: 20, ...d('question: several Questions at once') }
						)
					),
					prompt: Type.Optional(Str(2000, 'The question, or the choice to make')),
					impact: Type.Optional(Str(2000, 'question: why the answer matters')),
					hypothesis: Type.Optional(Str(12000, 'question: your best guess, which they can accept')),
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
					about: Type.Optional(Ids('Tasks, Projects, Milestones or Objectives it concerns')),
					holds: Type.Optional(Ids('Tasks that wait on the person asked until this is answered'))
				},
				{ additionalProperties: false }
			),
			output: Type.Unknown(),
			tool: { name: 'falcon_work_ask', label: 'Ask the person' }
		},
		finding: {
			kind: 'action',
			description:
				'Record a Finding in Falcon Work: something learned that others should rely on, with evidence.',
			input: Type.Object(
				{
					conclusion: Str(12000, 'What was learned'),
					confidence: Lit(['tentative', 'supported', 'confirmed']),
					evidence: Sources,
					about: Type.Optional(Ids('Tasks, Projects, Milestones or Objectives it concerns'))
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
