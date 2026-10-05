import { Type } from 'typebox';
import { defineFeatureContract } from 'openclaw/plugin-sdk/feature-contract';
import { PLUGIN_ID } from './identity.js';

// Browser-safe: shared by the plugin backend, the agent tools and the native UI.
// The command names below must match the store's commands (a test checks this).
export const COMMAND_NAMES = [
	'create_objective edit_objective rank_objectives set_autonomy pause_objective resume_objective achieve_objective retire_objective',
	'add_kpi edit_kpi remove_kpi record_kpi_reading write_review',
	'create_area edit_area retire_area',
	'create_project edit_project move_project abandon_project resume_project add_milestone edit_milestone reorder_milestones achieve_milestone reopen_milestone serve unserve set_session',
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
			description: `Change Falcon Work: exactly one command per call, as {command, id?, expected_version?, input}. Get any command's input with falcon_work_read view=help. Commands: ${COMMAND_NAMES.join(', ')}.`,
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
		}
	},
	events: {
		changed: Type.Object({ at: Type.String() }, { additionalProperties: false })
	}
});
