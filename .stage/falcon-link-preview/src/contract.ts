import { Type } from 'typebox';
import { defineFeatureContract } from 'openclaw/plugin-sdk/feature-contract';
import { PLUGIN_ID } from './identity.js';
import { PROVIDER_IDS } from './providers/ui.js';
const provider = Type.Unsafe<string>(Type.Union(PROVIDER_IDS.map((id) => Type.Literal(id))));
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
			description: 'Read integration tool, version and operator-provisioning status.',
			input: obj({}),
			output: Type.Unknown(),
			tool: { name: 'falcon_link_status', label: 'Read integration status' }
		},
		accounts: {
			kind: 'query',
			description:
				'Read account identity, human/agent owner, purpose, connection state and selected, recorded or granted scopes. With account_id, returns the CLI arguments and storage environment for that account (for hubspot also a command_prefix that selects the account); the CLIs are on the normal PATH and the keyring password variables are already present in the command environment.',
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
				permissions: Type.Array(Type.String({ maxLength: 64 }), {
					minItems: 0,
					maxItems: 64,
					uniqueItems: true
				}),
				email: Type.Optional(Type.String({ maxLength: 254 }))
			}),
			output: Type.Unknown()
		},
		viewer: {
			kind: 'query',
			description: 'Read the signed-in profile ID of the person using the Link page.',
			input: obj({}),
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
			description:
				'Complete a sign-in with what the person pasted: the address shown after Google sign-in, or the code HubSpot showed.',
			input: obj({
				id: Type.String({ maxLength: 64 }),
				redirect: Type.String({ maxLength: 8192 })
			}),
			output: Type.Unknown()
		},
		connect_key: {
			kind: 'action',
			description:
				'Connect an account with a pasted service key, verified with the provider. The key is kept only in that account’s own CLI settings and never returned.',
			input: obj({
				account_id: Type.Optional(Type.String({ maxLength: 64 })),
				provider,
				owner,
				purpose,
				key: Type.String({ minLength: 1, maxLength: 1024 })
			}),
			output: Type.Unknown()
		},
		skills: {
			kind: 'action',
			description:
				"Install, update or remove the integration's official agent skills in OpenClaw's shared skills directory. Removal affects only skills Link installed.",
			input: obj({
				provider,
				action: Type.Union([Type.Literal('install'), Type.Literal('remove')])
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
		remove: {
			kind: 'action',
			description:
				'Remove this account’s saved sign-in from its CLI store and delete it from Link. Does not revoke provider consent.',
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
				'Install or update the CLI from its published source with checksum verification (a self-updating CLI updates itself); preserve existing tools and credentials.',
			input: obj({ provider }),
			output: Type.Unknown()
		}
	}
});
