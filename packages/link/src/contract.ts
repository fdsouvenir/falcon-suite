import { Type } from 'typebox';
import { defineFeatureContract } from 'openclaw/plugin-sdk/feature-contract';
import { PLUGIN_ID } from './identity.js';

export const contract = defineFeatureContract({
	pluginId: PLUGIN_ID,
	events: {},
	operations: {
		status: {
			kind: 'query',
			description:
				'Read Falcon Link integration status. Only Google CLI version is probed; accounts, setup and updates remain unverified. Never starts login or changes installed tools.',
			input: Type.Object({}, { additionalProperties: false }),
			output: Type.Unknown(),
			tool: { name: 'falcon_link_status', label: 'Read integration status' }
		}
	}
});
