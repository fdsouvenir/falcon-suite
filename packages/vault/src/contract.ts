import { Type } from 'typebox';
import { defineFeatureContract } from 'openclaw/plugin-sdk/feature-contract';
import { PLUGIN_ID } from './identity.js';
import { FIELDS } from './store/paths.js';

// Browser-safe: shared by the plugin backend, the agent tool and the native UI (spec §10).
// Only `agent` has a tool. Reveal, copy and every write a person makes are Control UI operations
// with no tool declaration, so no agent can reach them.

export const EDIT_COMMANDS = [
	'create_entry',
	'update_entry',
	'recycle_entry',
	'delete_forever',
	'fill_request',
	'dismiss_request',
	'create_group',
	'rename_group',
	'move_group',
	'delete_group'
] as const;

const Lit = (values: readonly string[]) => Type.Union(values.map((v) => Type.Literal(v)));
const d = (description: string) => ({ description });
const Text = (max: number, description: string) => Type.String({ maxLength: max, description });
const Path = Type.String({ maxLength: 1024, ...d('Full path: Group/Sub/Title') });
const Uuid = Type.String({ maxLength: 64, ...d('Which entry, when several share a path') });

export const contract = defineFeatureContract({
	pluginId: PLUGIN_ID,
	operations: {
		agent: {
			kind: 'action',
			description:
				'Falcon Vault, the password manager config credentials come from. You never receive a password or notes value from it, in any form; credentials reach OpenClaw through config references. action list (group?, search?): groups and entries with username, URL, which fields are set, and the config reference. get (path): one entry, plus where OpenClaw config uses it. store (title, group?, username?, password, url?, notes?): save a credential you already hold, for example one you chose when signing up; create-only, fails if the path exists, and the result never repeats the value. request (title, group?, username?, url?, notes?, reason): ask the person for a credential only they have; it waits under Needs a value in the Vault tab, and you are told in this session when it is filled. You cannot edit, move, rename or remove entries.',
			input: Type.Object(
				{
					action: Lit(['list', 'get', 'store', 'request']),
					path: Type.Optional(Path),
					group: Type.Optional(
						Text(
							1024,
							'list: only under this group · store/request: the group (created if missing)'
						)
					),
					search: Type.Optional(Text(200, 'list: text in a path, username or URL')),
					title: Type.Optional(Text(240, 'store/request: the entry title')),
					username: Type.Optional(Text(1000, 'store/request')),
					password: Type.Optional(Text(10_000, 'store: the password you already hold')),
					url: Type.Optional(Text(2000, 'store/request')),
					notes: Type.Optional(Text(20_000, 'store/request: what it is for; never a secret')),
					reason: Type.Optional(Text(500, 'request: one line on why you need it'))
				},
				{ additionalProperties: false }
			),
			output: Type.Unknown(),
			tool: { name: 'falcon_vault', label: 'Falcon Vault' }
		},
		browse: {
			kind: 'query',
			description:
				'The Vault tab: overview (group tree and counts) · list (group, scope, search) · entry (path) · history (path, actor, action).',
			input: Type.Object(
				{
					view: Lit(['overview', 'list', 'entry', 'history']),
					group: Type.Optional(Type.String({ maxLength: 1024 })),
					scope: Type.Optional(Lit(['all', 'group', 'needs', 'recycle'])),
					search: Type.Optional(Type.String({ maxLength: 200 })),
					path: Type.Optional(Path),
					uuid: Type.Optional(Uuid),
					actor: Type.Optional(Type.String({ maxLength: 200 })),
					action: Type.Optional(Type.String({ maxLength: 64 })),
					before: Type.Optional(Type.Integer({ minimum: 1 })),
					limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 }))
				},
				{ additionalProperties: false }
			),
			output: Type.Unknown()
		},
		reveal: {
			kind: 'action',
			description: 'A person reveals or copies one field of one entry (spec §6).',
			input: Type.Object(
				{
					path: Path,
					uuid: Type.Optional(Uuid),
					field: Lit(FIELDS),
					purpose: Lit(['reveal', 'copy'])
				},
				{ additionalProperties: false }
			),
			output: Type.Unknown()
		},
		edit: {
			kind: 'action',
			description: 'A person changes the Vault: entries, groups and Requests.',
			input: Type.Object(
				{
					command: Lit(EDIT_COMMANDS),
					path: Type.Optional(Path),
					uuid: Type.Optional(Uuid),
					fields: Type.Optional(
						Type.Object(
							{
								title: Type.Optional(Type.String({ maxLength: 240 })),
								group: Type.Optional(Type.String({ maxLength: 1024 })),
								username: Type.Optional(Type.String({ maxLength: 1000 })),
								password: Type.Optional(Type.String({ maxLength: 10_000 })),
								url: Type.Optional(Type.String({ maxLength: 2000 })),
								notes: Type.Optional(Type.String({ maxLength: 20_000 }))
							},
							{ additionalProperties: false }
						)
					),
					parent: Type.Optional(
						Type.String({ maxLength: 1024, ...d('Group path; "" is the top') })
					),
					name: Type.Optional(Type.String({ maxLength: 240 })),
					idempotency_key: Type.Optional(Type.String({ minLength: 1, maxLength: 128 }))
				},
				{ additionalProperties: false }
			),
			output: Type.Unknown()
		}
	},
	events: {
		changed: Type.Object({ at: Type.String() }, { additionalProperties: false })
	}
});
