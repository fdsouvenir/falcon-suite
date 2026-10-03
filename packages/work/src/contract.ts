import { defineFeatureContract } from 'openclaw/plugin-sdk/feature-contract';

// Operations are added with the store (docs/work-commands.md).
export const contract = defineFeatureContract({
	pluginId: 'falcon-work',
	operations: {},
	events: {}
});
