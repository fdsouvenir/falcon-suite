import { Type } from 'typebox';
import { defineFeatureContract } from 'openclaw/plugin-sdk/feature-contract';
import { PLUGIN_ID } from './identity.js';
const provider = Type.Union([Type.Literal('google'), Type.Literal('microsoft')]);
const owner = Type.Object(
	{
		kind: Type.Union([Type.Literal('human'), Type.Literal('agent')]),
		id: Type.String({ minLength: 1, maxLength: 128 }),
		name: Type.String({ minLength: 1, maxLength: 80 })
	},
	{ additionalProperties: false }
);
const purpose = Type.Object(
	{
		kind: Type.Union([Type.Literal('work'), Type.Literal('personal'), Type.Literal('other')]),
		label: Type.Optional(Type.String({ maxLength: 40 }))
	},
	{ additionalProperties: false }
);
const obj = <T extends Record<string, any>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });
export const contract = defineFeatureContract({
	pluginId: PLUGIN_ID,
	events: {},
	operations: {
		status: {
			kind: 'query',
			description:
				'Read integration tool and operator-provisioning readiness. Connection permissions are technical facts, not agent operating instructions.',
			input: obj({}),
			output: Type.Unknown(),
			tool: { name: 'falcon_link_status', label: 'Read integration status' }
		},
		accounts: {
			kind: 'query',
			description:
				'Read account identity, human/agent owner, purpose, connection state and requested versus verified granted scopes. Pass account_id to obtain CLI arguments and storage environment; run the normal PATH CLI with that environment, preserving inherited keyring password variables. Never print passwords. Connection capabilities do not grant behavioral authority. Does not change AGENTS.md.',
			input: obj({ account_id: Type.Optional(Type.String({ maxLength: 64 })) }),
			output: Type.Unknown(),
			tool: { name: 'falcon_link_accounts', label: 'Read account facts' }
		},
		start: {
			kind: 'action',
			description: 'Start provider sign-in from the signed-in customer UI.',
			input: obj({
				account_id: Type.Optional(Type.String({ maxLength: 64 })),
				provider,
				owner,
				purpose,
				permissions: Type.Array(Type.String({ maxLength: 32 }), {
					minItems: 1,
					maxItems: 12,
					uniqueItems: true
				}),
				email: Type.Optional(Type.String({ maxLength: 254 })),
				audience: Type.Optional(Type.Union([Type.Literal('consumer'), Type.Literal('enterprise')]))
			}),
			output: Type.Unknown()
		},
		login: {
			kind: 'query',
			description: 'Read this signed-in person’s pending login.',
			input: obj({ id: Type.String({ maxLength: 64 }) }),
			output: Type.Unknown()
		},
		finish: {
			kind: 'action',
			description: 'Complete the Google CLI remote sign-in.',
			input: obj({
				id: Type.String({ maxLength: 64 }),
				redirect: Type.String({ maxLength: 8192 })
			}),
			output: Type.Unknown()
		},
		cancel: {
			kind: 'action',
			description: 'Cancel pending sign-in.',
			input: obj({ id: Type.String({ maxLength: 64 }) }),
			output: Type.Unknown()
		},
		check: {
			kind: 'action',
			description: 'Read-only live provider identity check.',
			input: obj({ account_id: Type.String({ maxLength: 64 }) }),
			output: Type.Unknown()
		},
		disconnect: {
			kind: 'action',
			description: 'Remove this account’s local CLI credentials. Does not revoke provider consent.',
			input: obj({ account_id: Type.String({ maxLength: 64 }) }),
			output: Type.Unknown()
		},
		metadata: {
			kind: 'action',
			description: 'Change the selected owner and purpose without altering provider permissions.',
			input: obj({ account_id: Type.String({ maxLength: 64 }), owner, purpose }),
			output: Type.Unknown()
		},
		install: {
			kind: 'action',
			description:
				'Install or update the CLI from its latest GitHub release with checksum verification; preserve existing tools and credentials.',
			input: obj({ provider }),
			output: Type.Unknown()
		}
	}
});
